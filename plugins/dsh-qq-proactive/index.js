/**
 * dsh-qq-proactive —— 让小号自己先开口，而且是她自己想说的话。
 *
 * 参考 AstrBot 的 astrbot_plugin_proactive_chat：那边是「随机延迟 + 活跃时段 +
 * 静默时长 + 每日上限」的调度器，到点让模型生成一句话发出去。
 *
 * 做法：定时器到点后，把她的长期人设（@DSH_DATA@\persona\小菁.md）+ 当前时间
 * 交给模型，让它写一句「自己想说 / 想问他」的话，再通过 NapCat 发出去。
 * 连续几条的限制都在，免得变成刷屏机器人。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const name = 'qq-proactive';
export const inject = ['tools'];

const DEFAULTS = {
    enabled: true,
    apiBase: 'http://127.0.0.1:3001',
    apiToken: '',
    target: 'private:@ADMIN_QQ@',
    stateFile: 'D:\\DSH-Data\\qq\\proactive-state.json',
    // 生成用的模型网关（本机 magpie）
    gatewayBase: 'http://127.0.0.1:3425/v1',
    gatewayKey: '',
    model: 'deepseek/deepseek-flash',
    personaFile: 'D:\\DSH-Data\\persona\\小菁.md',
    checkIntervalMinutes: 10,
    activeStart: '08:30',
    activeEnd: '23:30',
    minGapMinutes: 180,
    dailyMax: 3,
    probability: 0.5,
    // 模型不可用时的兜底句子
    fallbackTemplates: ['在干嘛呢', '突然想问问你，今天过得怎么样'],
};

function renderText(text) {
    return () => [{ type: 'text', text }];
}

function minutesOf(hhmm) {
    const [h, m] = String(hhmm).split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
    return h * 60 + m;
}

function nowMinutes(date = new Date()) {
    return date.getHours() * 60 + date.getMinutes();
}

function dayKey(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function apply(ctx, rawConfig) {
    const config = { ...DEFAULTS, ...(rawConfig ?? {}) };
    if (!config.enabled) return;
    const apiBase = String(config.apiBase).replace(/\/+$/, '');
    const headers = {
        'content-type': 'application/json',
        ...(config.apiToken ? { authorization: `Bearer ${config.apiToken}` } : {}),
    };
    const gatewayHeaders = {
        'content-type': 'application/json',
        ...(config.gatewayKey ? { authorization: `Bearer ${config.gatewayKey}` } : {}),
    };

    let state = { lastSentAt: 0, day: '', count: 0, recent: [] };
    let timers = [];
    let personaCache = { text: '', at: 0 };

    async function loadState() {
        try {
            const text = await readFile(config.stateFile, 'utf8');
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === 'object') state = { ...state, ...parsed };
        } catch {
            // 首次运行没有状态文件，正常
        }
    }

    async function saveState() {
        try {
            await mkdir(dirname(config.stateFile), { recursive: true });
            await writeFile(config.stateFile, JSON.stringify(state, null, 2), 'utf8');
        } catch {
            // 写不了就算了，别让定时器炸
        }
    }

    async function persona() {
        if (personaCache.text && Date.now() - personaCache.at < 5 * 60_000) return personaCache.text;
        try {
            const text = await readFile(config.personaFile, 'utf8');
            personaCache = { text, at: Date.now() };
            return text;
        } catch {
            return '你叫小菁，说话短、自然、像真人聊天，不端着。';
        }
    }

    /** 让模型自己想一句要发的话（不是从模板里挑）。 */
    async function compose() {
        const system = await persona();
        const now = new Date();
        const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        const recent = Array.isArray(state.recent) ? state.recent.slice(-5) : [];
        const avoid = recent.length > 0 ? `\n你最近已经主动说过这些话，别重复或换个说法：\n${recent.map((r) => `- ${r}`).join('\n')}` : '';
        const prompt = [
            `现在是 ${clock}。你已经有一阵没跟他说话了，不是被叫醒，是你自己想起了他。`,
            '按你的人设，写一句你想主动发给他的话：可以是分享你刚在做的小事、一句关心、一个想问他问题、或者单纯想找他说两句。',
            '要求：只输出这一句话本身，不要引号、不要解释、不要换行，20 到 40 字，口气像你自己，别像客服。',
            avoid,
        ].join('\n');

        const response = await fetch(`${String(config.gatewayBase).replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: gatewayHeaders,
            body: JSON.stringify({
                model: config.model,
                messages: [
                    { role: 'system', content: system },
                    { role: 'user', content: prompt },
                ],
                max_tokens: 200,
                temperature: 1.0,
            }),
            signal: AbortSignal.timeout(60000),
        });
        if (!response.ok) throw new Error(`模型网关 HTTP ${response.status}`);
        const payload = await response.json();
        const text = String(payload?.choices?.[0]?.message?.content ?? '').trim().replace(/^["「『]|["」』]$/g, '');
        if (text === '') throw new Error('模型返回空内容');
        return text.split('\n')[0].slice(0, 120);
    }

    async function send(text) {
        const [kind, id] = String(config.target).split(':');
        const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg';
        const body = kind === 'group'
            ? { group_id: Number(id), message: text }
            : { user_id: Number(id), message: text };
        const response = await fetch(`${apiBase}/${action}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(20000),
        });
        const payload = await response.json().catch(() => ({}));
        if (payload.retcode !== undefined && payload.retcode !== 0) {
            throw new Error(`发送失败 retcode=${payload.retcode} ${payload.message ?? ''}`);
        }
        return payload.data ?? {};
    }

    async function recordSend(text) {
        const today = dayKey();
        const count = state.day === today ? Number(state.count || 0) : 0;
        const recent = Array.isArray(state.recent) ? [...state.recent, text].slice(-10) : [text];
        state = { ...state, lastSentAt: Date.now(), day: today, count: count + 1, recent };
        await saveState();
    }

    async function tick() {
        const now = new Date();
        const minutes = nowMinutes(now);
        const start = minutesOf(config.activeStart);
        const end = minutesOf(config.activeEnd);
        const inWindow = start <= end ? minutes >= start && minutes <= end : minutes >= start || minutes <= end;
        if (!inWindow) return;
        if (Math.random() > Number(config.probability)) return;
        const gapMs = Math.max(1, Number(config.minGapMinutes)) * 60_000;
        if (Date.now() - Number(state.lastSentAt || 0) < gapMs) return;
        const today = dayKey(now);
        const count = state.day === today ? Number(state.count || 0) : 0;
        if (count >= Number(config.dailyMax)) return;

        let text;
        try {
            text = await compose();
        } catch {
            const templates = Array.isArray(config.fallbackTemplates) && config.fallbackTemplates.length > 0
                ? config.fallbackTemplates
                : DEFAULTS.fallbackTemplates;
            text = String(templates[Math.floor(Math.random() * templates.length)]);
        }
        await send(text);
        await recordSend(text);
    }

    const startTimer = () => {
        const id = setInterval(() => {
            tick().catch(() => {});
        }, Math.max(1, Number(config.checkIntervalMinutes)) * 60_000);
        if (typeof id.unref === 'function') id.unref();
        timers.push(id);
    };

    ctx.tools.register(defineTool({
        name: 'qq_proactive_send',
        description: '主动给用户发一条 QQ 消息（立刻发，或 delay_minutes 分钟后发）。想自己说点什么时用它。',
        parameters: {
            text: { type: 'string', required: true, description: '要发的话' },
            delay_minutes: { type: 'number', description: '延迟几分钟再发，默认 0 = 立刻' },
        },
        output: { schema: { type: 'json' }, render: renderText('已发') },
        isConcurrencySafe: () => false,
        execute: async (args) => {
            const text = String(args?.text ?? '').trim();
            if (text === '') throw new Error('不能发空消息');
            const delay = Math.max(0, Number(args?.delay_minutes ?? 0) || 0);
            if (delay === 0) {
                const data = await send(text);
                await recordSend(text);
                return { ok: true, message_id: data.message_id ?? null };
            }
            const id = setTimeout(() => {
                send(text).then(() => recordSend(text)).catch(() => {});
            }, delay * 60_000);
            if (typeof id.unref === 'function') id.unref();
            timers.push(id);
            return { ok: true, scheduledInMinutes: delay };
        },
    }));

    ctx.tools.register(defineTool({
        name: 'qq_proactive_status',
        description: '看主动聊天现在的配置和状态：时段、最小间隔、今日已发、上次发送时间、最近发过的话。',
        parameters: {},
        output: { schema: { type: 'json' }, render: renderText('已读取状态') },
        isConcurrencySafe: () => true,
        execute: async () => {
            await loadState();
            const today = dayKey();
            return {
                target: config.target,
                model: config.model,
                activeStart: config.activeStart,
                activeEnd: config.activeEnd,
                minGapMinutes: config.minGapMinutes,
                dailyMax: config.dailyMax,
                todaySent: state.day === today ? state.count : 0,
                lastSentAt: state.lastSentAt ? new Date(state.lastSentAt).toISOString() : null,
                recent: state.recent ?? [],
            };
        },
    }));

    void (async () => {
        await loadState();
        startTimer();
    })();

    const dispose = () => {
        for (const timer of timers) {
            try {
                clearTimeout(timer);
                clearInterval(timer);
            } catch {
                // 已经清掉了
            }
        }
        timers = [];
    };
    if (typeof ctx.effect === 'function') ctx.effect(() => dispose);
}
