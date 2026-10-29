/**
 * dsh-qq-exec —— 只给管理员（大号）用的电脑操作通道 + 每次执行都要人工批准。
 *
 * 三件事：
 *   1. 在 QQ 会话里放一个 pc_ops 工具（读文件 / 写文件 / 列目录 / 执行命令）。
 *   2. 闸门：QQ 会话里所有会改动系统或文件的工具调用（含 pc_ops）都要批准；
 *      非管理员的 QQ 会话直接拒绝，连审批都不发（不给别人按机会）。
 *   3. 审批通过 NapCat 的 HTTP 上报（httpClients）回到本插件：管理员在大号里
 *      回复「允许 A01 / 拒绝 A01」，才真正放行；超时按拒绝处理（fail-closed）。
 *
 * 桌面端会话一律不受影响（不在 QQ 会话里就直接放行）。
 */
import { createServer } from 'node:http';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { dirname, resolve as resolvePath, isAbsolute, join } from 'node:path';

export const name = 'qq-exec';
export const inject = ['tools', 'commands'];

const DEFAULTS = {
    enabled: true,
    adminQQ: '@ADMIN_QQ@',
    // 只有 session id 形如 onebot-private-<管理员> 的会话才算「管理员的 QQ 会话」
    requirePrivateAdminSession: true,
    // 这些工具在 QQ 会话里需要批准（非管理员则直接被拒）
    gatedTools: [
        'pwsh', 'bash', 'shell', 'write', 'edit', 'apply_patch', 'run_code',
        'str_replace_editor', 'pc_ops', 'task', 'subagent',
    ],
    // 非管理员会话里连这些也一并拒绝（读写文件都算改动）
    approvalTimeoutMs: 300000,
    napcatApi: 'http://127.0.0.1:3001',
    napcatToken: '',
    listenHost: '127.0.0.1',
    listenPort: 8654,
    listenPath: '/approval',
    // push 里带的 token，防止别人往端口里乱发
    pushToken: '',
    // 审批回复主要靠轮询 get_friend_msg_history（HTTP 上报在多实例下不可靠）
    pollIntervalMs: 2000,
    logPath: '@DSH_DATA@\\qq\\exec-approval.log',
    maxDetailChars: 1200,
};

const ALLOW_WORDS = ['允许', '同意', '批准', '放行', '可以', 'ok', 'yes', 'allow'];
const DENY_WORDS = ['拒绝', '不行', '不同意', '否决', '取消', 'no', 'deny', 'reject'];

/** session id → { kind, id }，QQ 会话 id 形如 onebot-private-@ADMIN_QQ@-xxxx */
function parseQQSession(sessionId) {
    if (typeof sessionId !== 'string') return undefined;
    const m = /^onebot-(private|group)-(\d+)/.exec(sessionId);
    if (m === null) return undefined;
    return { kind: m[1], id: m[2] };
}

function summarize(value, maxChars) {
    if (value === undefined || value === null) return '(无参数)';
    if (typeof value === 'string') return clip(value, maxChars);
    if (typeof value !== 'object') return String(value);
    const keys = ['action', 'command', 'file_path', 'path', 'content', 'cwd', 'description', 'pattern', 'code'];
    const parts = [];
    for (const key of keys) {
        const item = value[key];
        if (typeof item === 'string' && item !== '') parts.push(`${key}:\n${clip(item, maxChars)}`);
    }
    if (parts.length === 0) parts.push(clip(JSON.stringify(value), maxChars));
    return parts.join('\n');
}

function clip(text, maxChars) {
    const s = String(text);
    return s.length > maxChars ? `${s.slice(0, maxChars)}…` : s;
}

function flattenMessage(message) {
    if (typeof message === 'string') return message;
    if (!Array.isArray(message)) return '';
    return message.map((seg) => (seg !== null && typeof seg === 'object' && seg.type === 'text' ? String(seg.data?.text ?? '') : '')).join('');
}

/** 只认「A01 允许」这类短回复，闲聊里的字眼不误判。 */
function classifyReply(text) {
    const cleaned = String(text).replace(/[「」『』\s，。,.!！?？、~～:：;；"“”'‘’]/g, '');
    const verdict = DENY_WORDS.some((w) => cleaned.includes(w)) ? -1 : ALLOW_WORDS.some((w) => cleaned.includes(w)) ? 1 : 0;
    const codeMatch = /A\d{1,4}/i.exec(cleaned);
    return { verdict, code: codeMatch === null ? undefined : codeMatch[0].toUpperCase() };
}

export function apply(ctx, rawConfig) {
    const config = { ...DEFAULTS, ...(rawConfig ?? {}) };
    if (config.enabled === false) return;
    const adminQQ = String(config.adminQQ ?? '').trim();
    if (adminQQ === '') {
        console.warn('[qq-exec] adminQQ 未配置，插件不生效');
        return;
    }

    const log = (message) => console.log(`[qq-exec] ${message}`);
    const warn = (message) => console.warn(`[qq-exec] ${message}`);
    const trace = (message) => {
        try {
            appendFileSync(config.logPath, `${new Date().toISOString()} ${message}\n`);
        } catch {
            /* 日志写不进去不能影响主流程 */
        }
    };

    const pending = [];
    let sequence = 0;

    async function napcatAction(action, payload) {
        if (typeof config.napcatToken !== 'string' || config.napcatToken === '') {
            throw new Error('napcatToken 为空');
        }
        const res = await fetch(`${String(config.napcatApi).replace(/\/$/, '')}/${action}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${config.napcatToken}` },
            body: JSON.stringify(payload ?? {}),
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) throw new Error(`${action} HTTP ${res.status}`);
        return await res.json().catch(() => ({}));
    }

    async function napcatSend(text) {
        if (typeof config.napcatToken !== 'string' || config.napcatToken === '') {
            throw new Error('napcatToken 为空');
        }
        const res = await fetch(`${String(config.napcatApi).replace(/\/$/, '')}/send_private_msg`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${config.napcatToken}` },
            body: JSON.stringify({ user_id: adminQQ, message: [{ type: 'text', data: { text } }] }),
            signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) throw new Error(`send_private_msg HTTP ${res.status}`);
        const payload = await res.json().catch(() => ({}));
        if (payload?.retcode !== undefined && payload.retcode !== 0) {
            throw new Error(`send_private_msg retcode ${payload.retcode}`);
        }
    }

    function requestApproval(tool, detail, signal) {
        sequence += 1;
        const code = `A${String(sequence).padStart(2, '0')}`;
        return new Promise((resolve) => {
            let settled = false;
            let poll;
            const seen = new Set();
            const entry = {
                code,
                settle(outcome, note) {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    if (poll !== undefined) clearInterval(poll);
                    const index = pending.indexOf(entry);
                    if (index >= 0) pending.splice(index, 1);
                    signal?.removeEventListener?.('abort', onAbort);
                    if (note !== undefined) log(`${code} ${note}`);
                    trace(`${code} settle=${outcome} ${note ?? ''}`);
                    resolve(outcome);
                },
            };
            const onAbort = () => entry.settle('cancelled', '请求被取消');
            const timer = setTimeout(() => entry.settle('unavailable', '超时未回复，按拒绝处理'), config.approvalTimeoutMs);
            signal?.addEventListener?.('abort', onAbort, { once: true });
            pending.push(entry);

            const text = [
                `【需要你点头 ${code}】`,
                `工具：${tool}`,
                `内容：\n${detail}`,
                '',
                `回复「/allow ${code}」放行，或「/deny ${code}」拦下。${Math.round(config.approvalTimeoutMs / 1000)} 秒不回按拒绝算。`,
                '（必须是带 / 的命令，这样回复不会变成新的一轮对话。）',
            ].join('\n');
            const startedAt = Math.floor(Date.now() / 1000) - 2;
            napcatSend(text)
                .then(() => {
                    trace(`${code} 已发送，开始轮询审批回复`);
                    poll = setInterval(() => {
                        if (settled) return;
                        void checkAdminReply();
                    }, config.pollIntervalMs);
                })
                .catch((error) => entry.settle('unavailable', `发送失败：${String(error?.message ?? error)}`));

            async function checkAdminReply() {
                let payload;
                try {
                    payload = await napcatAction('get_friend_msg_history', { user_id: adminQQ, count: 20 });
                } catch (error) {
                    trace(`${code} 拉取历史失败：${String(error?.message ?? error)}`);
                    return;
                }
                const list = payload?.data?.messages ?? [];
                for (const m of list) {
                    const id = String(m?.message_id ?? '');
                    if (id === '' || seen.has(id)) continue;
                    seen.add(id);
                    if (Number(m?.time ?? 0) < startedAt) continue;
                    const senderId = String(m?.sender?.user_id ?? m?.user_id ?? '');
                    if (senderId !== adminQQ) continue;
                    const body = flattenMessage(m?.message ?? m?.raw_message ?? '');
                    if (!body.trim().startsWith('/')) continue; // 只认斜杠命令，普通消息会进模型，不在这里消费
                    const { verdict, code: replyCode } = classifyReply(body);
                    if (verdict === 0) continue;
                    if (replyCode !== undefined && replyCode !== entry.code) {
                        trace(`${code} 收到针对 ${replyCode} 的回复，忽略：${clip(body, 40)}`);
                        continue;
                    }
                    trace(`${code} 收到回复：${clip(body, 60)}`);
                    entry.settle(verdict > 0 ? 'allowed-once' : 'rejected', `管理员回复：${clip(body, 60)}`);
                    return;
                }
            }
        });
    }

    // ── pc_ops：给 QQ 会话用的电脑操作工具（本身也要过闸门） ────────────────
    const pcOps = defineTool({
        name: 'pc_ops',
        description: [
            '在本机执行文件与环境操作（仅限管理员 QQ 会话，且每次执行都要管理员在 QQ 里批准）。',
            'action 取值：read（读文件）、write（写/覆盖文件）、append（追加）、list（列目录）、mkdir、stat、run（执行命令）。',
            '读文件用 read + path；写文件用 write + path + content；跑命令用 run + command（可选 cwd、timeoutMs）。',
            '返回纯文本结果；出错会抛出错误信息。',
        ].join('\n'),
        parameters: {
            action: { type: 'string', required: true, description: 'read | write | append | list | mkdir | stat | run' },
            path: { type: 'string', description: '目标路径（绝对或相对当前工作目录）' },
            content: { type: 'string', description: 'write/append 要写入的文本' },
            command: { type: 'string', description: 'run 时要执行的命令（走 PowerShell）' },
            cwd: { type: 'string', description: 'run 的工作目录，默认会话 cwd' },
            timeoutMs: { type: 'number', description: 'run 超时毫秒，默认 120000' },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            const action = String(args?.action ?? '');
            const cwd = exec?.agent?.session?.header?.cwd;
            const base = typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd();
            const target = args?.path === undefined ? undefined : isAbsolute(args.path) ? args.path : resolvePath(base, args.path);
            const session = parseQQSession(exec?.agent?.session?.id);
            if (session === undefined || !(session.kind === 'private' && session.id === adminQQ)) {
                throw new Error('pc_ops 只对管理员本人的私聊会话开放');
            }
            const readOnlyActions = ['read', 'list', 'stat'];
            if (!readOnlyActions.includes(action)) {
                const detail = [
                    `动作：${action}`,
                    target === undefined ? '' : `路径：${target}`,
                    action === 'run' ? `命令：${clip(String(args?.command ?? ''), 900)}` : '',
                    typeof args?.content === 'string' && args.content !== '' ? `内容：${clip(args.content, 500)}` : '',
                ].filter((line) => line !== '').join('\n');
                const outcome = await requestApproval('pc_ops', detail, undefined);
                if (outcome !== 'allowed-once') {
                    const hint = outcome === 'unavailable'
                        ? '刚刚已经问过一次了，不要再自动发第二条审批。直接把情况说给大号听，等他重新下指令。'
                        : '这条已按拒绝处理，不要自动重试。';
                    throw new Error(`没有拿到大号批准（${outcome}），这次${action}没有执行。${hint}`);
                }
            }
            switch (action) {
                case 'read':
                    return { text: await readFile(target, 'utf8') };
                case 'write':
                    await mkdir(dirname(target), { recursive: true });
                    await writeFile(target, String(args?.content ?? ''), 'utf8');
                    return { text: `已写入 ${target}（${String(args?.content ?? '').length} 字符）` };
                case 'append':
                    await mkdir(dirname(target), { recursive: true });
                    await writeFile(target, String(args?.content ?? ''), { encoding: 'utf8', flag: 'a' });
                    return { text: `已追加到 ${target}` };
                case 'list': {
                    const items = await readdir(target === undefined ? base : target, { withFileTypes: true });
                    return { text: items.map((d) => `${d.isDirectory() ? '[D]' : '   '} ${d.name}`).join('\n') };
                }
                case 'mkdir':
                    await mkdir(target, { recursive: true });
                    return { text: `已创建目录 ${target}` };
                case 'stat': {
                    const info = await stat(target);
                    return { text: JSON.stringify({ path: target, size: info.size, isDir: info.isDirectory(), mtime: info.mtime.toISOString() }) };
                }
                case 'run': {
                    const command = String(args?.command ?? '').trim();
                    if (command === '') throw new Error('run 需要 command');
                    const timeout = Number(args?.timeoutMs ?? 120000);
                    return await new Promise((resolve, reject) => {
                        execFile('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd: args?.cwd ?? base, timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
                            if (error !== null) {
                                reject(new Error(`命令失败：${error.message}\nstdout:\n${clip(stdout, 4000)}\nstderr:\n${clip(stderr, 4000)}`));
                                return;
                            }
                            resolve({ text: `exit 0\nstdout:\n${clip(stdout, 8000)}${stderr === '' ? '' : `\nstderr:\n${clip(stderr, 2000)}`}` });
                        });
                    });
                }
                default:
                    throw new Error(`未知 action：${action}`);
            }
        },
    });
    const disposeTool = ctx.tools.register(pcOps);

    // ── 斜杠命令：审批回复走命令通道，不进模型 ─────────────────────────────
    // 普通聊天消息会作为新一轮用户消息投进会话；命令由宿主直接处理，模型看不到，
    // 所以不会出现「任务做完又来一句『允许』再回一遍」的问题。
    function settleByCommand(rawInput, outcome) {
        const wanted = String(rawInput ?? '').trim().toUpperCase();
        const entry = wanted === ''
            ? pending[pending.length - 1]
            : pending.find((item) => item.code === wanted);
        if (entry === undefined) {
            return {
                kind: 'error',
                text: wanted === '' ? '当前没有待审批的请求' : `没有找到 ${wanted} 这条审批`,
            };
        }
        entry.settle(outcome, `管理员用命令处理`);
        return { kind: 'success', text: `${entry.code} 已${outcome === 'allowed-once' ? '放行' : '拒绝'}` };
    }

    ctx.commands.register({
        name: 'allow',
        description: '批准一条待审批的电脑操作（可带编号，如 /allow A01）',
        input: { hint: 'A01' },
        handler: ({ rawInput }) => settleByCommand(rawInput, 'allowed-once'),
    });
    ctx.commands.register({
        name: 'deny',
        description: '拒绝一条待审批的电脑操作（可带编号，如 /deny A01）',
        input: { hint: 'A01' },
        handler: ({ rawInput }) => settleByCommand(rawInput, 'rejected'),
    });

    // ── 闸门：只在 QQ 会话里生效，审批走 QQ，绝不弹到桌面上 ────────────────
    ctx.on('tools/pre-execute', async (exec, next) => {
        const session = parseQQSession(exec?.agent?.session?.id);
        if (session === undefined) return next(); // 桌面端会话，不管
        const toolName = String(exec?.name ?? '');
        if (toolName === pcOps.name) return next(); // pc_ops 自己管审批（读写区别对待）
        if (!config.gatedTools.includes(toolName)) return next();
        const isAdmin = session.kind === 'private' && session.id === adminQQ;
        if (!isAdmin) {
            log(`拒绝非管理员会话的工具调用：${session.kind}:${session.id} → ${toolName}`);
            return { kind: 'deny', reason: '只有管理员本人的私聊会话可以操作电脑；这条请求已拒绝。' };
        }
        // 管理员会话里也不走宿主审批（那会弹到桌面），统一改成用 pc_ops 走 QQ 确认
        return {
            kind: 'deny',
            reason: `QQ 会话里请改用 pc_ops 工具操作电脑（它会在 QQ 里向大号确认后再执行）。已拦截 ${toolName}。`,
        };
    });

    // ── 接收 NapCat 上报的消息，作为审批回答 ────────────────────────────────
    const server = createServer((request, response) => {
        if (request.method !== 'POST' || (request.url ?? '').split('?')[0] !== config.listenPath) {
            response.writeHead(404).end();
            return;
        }
        const chunks = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', () => {
            response.writeHead(204).end();
            if (typeof config.pushToken === 'string' && config.pushToken !== '') {
                const auth = request.headers.authorization ?? '';
                if (auth !== `Bearer ${config.pushToken}`) {
                    warn('上报 token 不匹配，丢弃');
                    return;
                }
            }
            let event;
            try {
                event = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
                return;
            }
            if (event?.post_type !== 'message') return;
            const sender = String(event.user_id ?? event.sender?.user_id ?? '');
            if (sender !== adminQQ) return;
            const text = flattenMessage(event.message ?? event.raw_message ?? '');
            if (pending.length === 0) return;
            const { verdict, code } = classifyReply(text);
            if (verdict === 0) return;
            const entry = (code === undefined ? undefined : pending.find((p) => p.code === code)) ?? pending[0];
            entry.settle(verdict > 0 ? 'allowed-once' : 'rejected', `管理员回复：${clip(text, 60)}`);
        });
    });
    server.on('error', (error) => warn(`审批监听失败（${config.listenHost}:${config.listenPort}）：${String(error?.message ?? error)}`));
    server.listen(config.listenPort, config.listenHost, () => log(`审批监听 ${config.listenHost}:${config.listenPort}${config.listenPath}，管理员 ${adminQQ}`));

    ctx.effect(() => () => {
        for (const entry of [...pending]) entry.settle('unavailable', '插件卸载');
        disposeTool?.();
        server.close();
    });
}
