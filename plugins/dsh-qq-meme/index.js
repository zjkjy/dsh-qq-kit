/**
 * dsh-qq-meme —— 本地表情包库 + QQ 发送/收藏。
 *
 * 设计参考 AstrBot 的 astrbot_plugin_meme_manager：标签就是目录名、随机取图、
 * SHA-256 去重、近期不重复。砍掉了它的语义检索/FAISS/图床/WebUI/待审箱，
 * 只保留三件事：看标签、按标签发一张、把图收进标签。
 *
 * 目录约定：<memesDir>/<标签>/<sha256前16位>.<ext>
 * 不用数据库；加标签就在 memesDir 下新建文件夹。
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, basename } from 'node:path';
// 静态 import 在解析失败时会让整个模块静默挂掉，连一行日志都不留
// （踩过：package.json 里多写一个 exports，插件就再也注册不上）。
// 所以这里改成动态导入，把失败原因打到控制台再抛出去。
let defineTool;
try {
  ({ defineTool } = await import('@deepseek-ai/dsh-tools'));
} catch (err) {
  console.error('[qq-meme] 无法加载 @deepseek-ai/dsh-tools，插件未注册：', err);
  throw err;
}

export const name = 'qq-meme';
export const inject = ['tools', 'systemPrompt'];

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);

const DEFAULTS = {
    enabled: true,
    memesDir: 'D:\\DSH-Data\\qq\\memes',
    apiBase: 'http://127.0.0.1:3001',
    apiToken: '',
    defaultTarget: '',
    maxImageMb: 8,
    recentWindow: 12,
    // 只在 QQ 会话里注入提示词、放开工具；桌面端会话里既不提示也不许发图
    qqOnly: true,
};

const PROMPT = [
    '## 表情包',
    '你有一个本地表情包库，工具是 qq_meme_tags / qq_meme_send / qq_meme_save。',
    '- 想发图先用 qq_meme_tags 看有哪些标签，再用 qq_meme_send 挑一个标签发一张；标签名可以只写一部分。',
    '- 发图看场合，不是每条都发：好笑、撒娇、无语、被夸得开心的时候贴一张最合适；严肃话题、对方在说正事时别发。',
    '- 对方发来一张你觉得好玩的表情图时，可以用 qq_meme_save 收进表情库（自己起个贴切的标签）。',
    '- 同一轮里不要连发多张；发图之后不用再解释图是什么。',
].join('\n');

/** 每个会话最近发过的图片，用来避免连续重复。 */
const recent = new Map();

function log(message) {
    console.log(`[qq-meme] ${message}`);
}

function renderText(text) {
    return () => [{ type: 'text', text }];
}

async function listImages(directory) {
    let entries = [];
    try {
        entries = await readdir(directory, { withFileTypes: true });
    } catch {
        return [];
    }
    const files = [];
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!IMAGE_EXT.has(extname(entry.name).toLowerCase())) continue;
        files.push(join(directory, entry.name));
    }
    return files.sort();
}

async function listTags(dir) {
    let entries = [];
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return [];
    }
    const tags = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
        const files = await listImages(join(dir, entry.name));
        tags.push({ tag: entry.name, count: files.length });
    }
    return tags.sort((a, b) => b.count - a.count);
}

function hashOf(buffer) {
    return createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}

/**
 * 判断一次提示词组装 / 一次工具调用是否属于 QQ 会话。
 * 主线索是会话 id（dsh-onebot-qq 用 onebot-private-<QQ> / onebot-group-<群号>），
 * 兜底看工作目录是否落在 desktop profile 里（QQ 会话跑在那儿）。
 */
const QQ_SESSION_RE = /^onebot-(private|group)-/;
const QQ_PROFILE_CWD_RE = /[\\/]\.dsh[\\/]profiles[\\/]desktop$/i;

function isQQAgent(agent) {
    try {
        const id = agent?.session?.id;
        if (typeof id === 'string' && QQ_SESSION_RE.test(id)) return true;
        const cwd = agent?.session?.header?.cwd;
        if (typeof cwd === 'string' && QQ_PROFILE_CWD_RE.test(cwd.trim().replace(/[\\/]+$/, ''))) return true;
    } catch {
        // 拿不到会话信息时按「不是 QQ 会话」处理
    }
    return false;
}

export function apply(ctx, rawConfig) {
    const config = { ...DEFAULTS, ...(rawConfig ?? {}) };
    if (!config.enabled) return;
    const memesDir = config.memesDir;
    const apiBase = String(config.apiBase).replace(/\/+$/, '');
    const recentWindow = Math.max(0, Number(config.recentWindow) || 0);
    const maxBytes = Math.max(1, Number(config.maxImageMb) || 8) * 1024 * 1024;
    const authHeaders = config.apiToken === ''
        ? { 'content-type': 'application/json' }
        : { 'content-type': 'application/json', authorization: `Bearer ${config.apiToken}` };

    function parseTarget(raw) {
        const text = String(raw ?? config.defaultTarget ?? '').trim();
        if (text === '') throw new Error('没有目标会话：配置 defaultTarget 或在参数里传 chat_id');
        const match = /^(private|group):(\d+)$/.exec(text);
        if (match !== null) return { kind: match[1], id: match[2] };
        if (/^\d+$/.test(text)) return { kind: 'private', id: text };
        throw new Error(`无法识别的会话 "${text}"（用 private:<QQ号> 或 group:<群号>）`);
    }

    async function sendImage(target, buffer) {
        const segment = { type: 'image', data: { file: `base64://${buffer.toString('base64')}` } };
        const payload = target.kind === 'group'
            ? { group_id: target.id, message: [segment] }
            : { user_id: target.id, message: [segment] };
        const response = await fetch(`${apiBase}/send_msg`, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) throw new Error(`send_msg HTTP ${response.status}`);
        const body = await response.json().catch(() => ({}));
        if (body?.retcode !== undefined && body.retcode !== 0) {
            throw new Error(`send_msg retcode ${body.retcode}: ${body.message ?? body.wording ?? ''}`);
        }
        return body?.data?.message_id ?? null;
    }

    function ensureQQ(exec) {
        if (!config.qqOnly) return;
        if (isQQAgent(exec?.agent)) return;
        throw new Error('表情包只用于 QQ 会话；当前是桌面端会话，不发图');
    }

    try {
        ctx.systemPrompt.section({
            name: 'tools:qq-meme',
            order: 95,
            // 函数形式：每次组装提示词时才求值，只给 QQ 会话注入
            text: (assembly) => (config.qqOnly && !isQQAgent(assembly?.agent) ? '' : PROMPT),
        });
    } catch (error) {
        // 提示词注入失败不该连累工具注册
        console.error('[qq-meme] 提示词注入失败：', error);
    }

    ctx.tools.register(defineTool({
        name: 'qq_meme_tags',
        description: '列出本地表情包库的标签及每个标签的图片数量。发图前先用它挑标签。',
        parameters: {},
        output: { schema: { type: 'json' }, render: renderText('已列出标签') },
        isConcurrencySafe: () => true,
        execute: async (_args, exec) => {
            ensureQQ(exec);
            const tags = await listTags(memesDir);
            if (tags.length === 0) log(`表情库为空：${memesDir}`);
            return { dir: memesDir, total: tags.reduce((sum, t) => sum + t.count, 0), tags };
        },
    }));

    ctx.tools.register(defineTool({
        name: 'qq_meme_send',
        description: '从本地表情包库挑一张图发到 QQ（默认发给配置的目标会话）。可按标签缩小范围、按文件名关键词精确挑；会自动避开最近发过的图。',
        parameters: {
            tag: { type: 'string', description: '标签名（文件夹名）的子串，可省略' },
            keyword: { type: 'string', description: '文件名里的关键词，可省略' },
            chat_id: { type: 'string', description: '目标会话 private:<QQ号> 或 group:<群号>，省略用默认' },
        },
        output: { schema: { type: 'json' }, render: renderText('已发图') },
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
            ensureQQ(exec);
            const a = args ?? {};
            const target = parseTarget(a.chat_id);
            const tags = await listTags(memesDir);
            if (tags.length === 0) throw new Error(`表情库是空的：${memesDir}`);
            let dirs = tags.map((t) => t.tag);
            if (typeof a.tag === 'string' && a.tag !== '') {
                const hit = dirs.filter((name) => name.includes(a.tag));
                if (hit.length > 0) dirs = hit;
            }
            let files = [];
            for (const dir of dirs) files.push(...await listImages(join(memesDir, dir)));
            if (files.length === 0) throw new Error(`没有匹配的文件（标签：${dirs.join('、')}）`);
            if (typeof a.keyword === 'string' && a.keyword !== '') {
                const matched = files.filter((file) => basename(file).includes(a.keyword));
                if (matched.length > 0) files = matched;
            }
            const key = `${target.kind}:${target.id}`;
            const sent = recent.get(key) ?? [];
            const fresh = files.filter((file) => !sent.includes(file));
            const pool = fresh.length > 0 ? fresh : files;
            const chosen = pool[Math.floor(Math.random() * pool.length)];
            const info = await stat(chosen);
            if (info.size > maxBytes) throw new Error(`图片 ${(info.size / 1048576).toFixed(1)}MB 超过上限 ${config.maxImageMb}MB`);
            const buffer = await readFile(chosen);
            const messageId = await sendImage(target, buffer);
            sent.push(chosen);
            while (sent.length > recentWindow) sent.shift();
            recent.set(key, sent);
            log(`sent ${chosen} -> ${key}`);
            return { sent: true, messageId, file: chosen, tag: chosen.slice(memesDir.length + 1).split(/[\\/]/)[0], bytes: buffer.length };
        },
    }));

    ctx.tools.register(defineTool({
        name: 'qq_meme_save',
        description: '把一张图片收进本地表情包库的某个标签（来源：本地绝对路径 / http(s) URL / base64 字符串）。同内容自动去重。',
        parameters: {
            source: { type: 'string', required: true, description: '本地绝对路径 / http(s) URL / base64（可带 data: 前缀）' },
            tag: { type: 'string', description: '收进哪个标签，默认「默认」' },
        },
        output: { schema: { type: 'json' }, render: renderText('已收藏') },
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
            ensureQQ(exec);
            const a = args ?? {};
            const source = typeof a.source === 'string' ? a.source.trim() : '';
            if (source === '') throw new Error('source 必填');
            let buffer;
            let ext = '.jpg';
            if (/^https?:\/\//i.test(source)) {
                const response = await fetch(source, { signal: AbortSignal.timeout(30000) });
                if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`);
                buffer = Buffer.from(await response.arrayBuffer());
                ext = extname(new URL(source).pathname) || '.jpg';
            } else if (/^data:image\//i.test(source) || /^base64:\/\//i.test(source)) {
                const cleaned = source.replace(/^base64:\/\//i, '').replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '');
                buffer = Buffer.from(cleaned, 'base64');
            } else {
                if (!isAbsolute(source)) throw new Error('本地路径必须是绝对路径');
                buffer = await readFile(source);
                ext = extname(source) || '.jpg';
            }
            if (!IMAGE_EXT.has(ext.toLowerCase())) ext = '.jpg';
            if (buffer.length === 0) throw new Error('读取到的内容为空');
            if (buffer.length > maxBytes) throw new Error(`图片超过上限 ${config.maxImageMb}MB`);
            const safe = String(a.tag ?? '默认').replace(/[\\/:*?"<>|]/g, '_').trim() || '默认';
            const directory = join(memesDir, safe);
            await mkdir(directory, { recursive: true });
            const hash = hashOf(buffer);
            const file = join(directory, `${hash}${ext}`);
            const exists = await stat(file).then(() => true).catch(() => false);
            if (!exists) await writeFile(file, buffer);
            log(`saved ${file} (${buffer.length} bytes)`);
            return { saved: !exists, file, tag: safe, bytes: buffer.length };
        },
    }));
}
