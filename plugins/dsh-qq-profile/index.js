/**
 * dsh-qq-profile —— 改小号的昵称 / 签名 / 头像 / 在线状态。
 *
 * 对照 AstrBot 的 astrbot_plugin_qqprofile：它走 aiocqhttp 的
 * set_qq_profile / set_self_longnick / set_qq_avatar / set_online_status。
 * 这里直接打 NapCat 的 HTTP 接口，做同样的四件事，但不碰 AstrBot 的人格系统。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'qq-profile';
export const inject = ['tools'];

const DEFAULTS = {
    enabled: true,
    apiBase: 'http://127.0.0.1:3001',
    apiToken: '',
};

/** 在线状态名 → [status, ext_status]，表格抄自 AstrBot 插件，NapCat 数值一致。 */
const STATUS = {
    在线: [10, 0],
    'Q我吧': [10, 0],
    离开: [30, 0],
    忙碌: [50, 0],
    请勿打扰: [70, 0],
    隐身: [40, 0],
    听歌中: [10, 1028],
    春日限定: [10, 2037],
    一起元梦: [10, 2025],
    求星搭子: [10, 2026],
    被掏空: [10, 2014],
    今日天气: [10, 1030],
    我crush了: [10, 2019],
    爱你: [10, 2006],
    恋爱中: [10, 1051],
    好运锦鲤: [10, 1071],
    水逆退散: [10, 1201],
    嗨到飞起: [10, 1056],
    元气满满: [10, 1058],
    宝宝认证: [10, 1070],
    一言难尽: [10, 1063],
    难得糊涂: [10, 2001],
    emo中: [10, 1401],
    我太难了: [10, 1062],
    我想开了: [10, 2013],
    我没事: [10, 1052],
    想静静: [10, 1061],
    悠哉哉: [10, 1059],
    去旅行: [10, 2015],
    信号弱: [10, 1011],
    出去浪: [10, 2003],
    肝作业: [10, 2012],
    学习中: [10, 1018],
    搬砖中: [10, 2023],
    摸鱼中: [10, 1300],
    无聊中: [10, 1060],
    timi中: [10, 1027],
    睡觉中: [10, 1016],
    熬夜中: [10, 1032],
    追剧中: [10, 1021],
    有亿点冷: [10, 2050],
    一月你好: [10, 2053],
    我的电量: [10, 1000],
};

function renderText(text) {
    return () => [{ type: 'text', text }];
}

export function apply(ctx, rawConfig) {
    const config = { ...DEFAULTS, ...(rawConfig ?? {}) };
    if (!config.enabled) return;
    const apiBase = String(config.apiBase).replace(/\/+$/, '');
    const headers = {
        'content-type': 'application/json',
        ...(config.apiToken ? { authorization: `Bearer ${config.apiToken}` } : {}),
    };

    async function call(action, body = {}) {
        const response = await fetch(`${apiBase}/${action}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(20000),
        });
        const text = await response.text();
        let payload = {};
        try {
            payload = JSON.parse(text);
        } catch {
            throw new Error(`${action} 返回非 JSON（HTTP ${response.status}）：${text.slice(0, 120)}`);
        }
        if (payload.retcode !== undefined && payload.retcode !== 0) {
            throw new Error(`${action} 失败 retcode=${payload.retcode} ${payload.message ?? payload.wording ?? ''}`);
        }
        return payload.data ?? {};
    }

    ctx.tools.register(defineTool({
        name: 'qq_profile_get',
        description: '查看当前 QQ 小号的昵称与 QQ 号。',
        parameters: {},
        output: { schema: { type: 'json' }, render: renderText('已读取资料') },
        isConcurrencySafe: () => true,
        execute: async () => {
            const info = await call('get_login_info');
            return { uin: info.user_id ?? info.uin ?? null, nickname: info.nickname ?? null };
        },
    }));

    ctx.tools.register(defineTool({
        name: 'qq_profile_set_nickname',
        description: '改 QQ 小号的昵称。',
        parameters: {
            nickname: { type: 'string', required: true, description: '新昵称' },
        },
        output: { schema: { type: 'json' }, render: renderText('已改昵称') },
        isConcurrencySafe: () => false,
        execute: async (args) => {
            const nickname = String(args?.nickname ?? '').trim();
            if (nickname === '') throw new Error('昵称不能为空');
            await call('set_qq_profile', { nickname });
            return { ok: true, nickname };
        },
    }));

    ctx.tools.register(defineTool({
        name: 'qq_profile_set_signature',
        description: '改 QQ 小号的个性签名。',
        parameters: {
            text: { type: 'string', required: true, description: '新签名，最长约 200 字' },
        },
        output: { schema: { type: 'json' }, render: renderText('已改签名') },
        isConcurrencySafe: () => false,
        execute: async (args) => {
            const text = String(args?.text ?? '').trim();
            if (text === '') throw new Error('签名不能为空');
            if (text.length > 200) throw new Error('签名超过 200 字');
            await call('set_self_longnick', { longNick: text });
            return { ok: true, text };
        },
    }));

    ctx.tools.register(defineTool({
        name: 'qq_profile_set_avatar',
        description: '换 QQ 小号的头像（传本地绝对路径、http(s) 链接或 base64://）。',
        parameters: {
            file: { type: 'string', required: true, description: '图片路径 / URL / base64://' },
        },
        output: { schema: { type: 'json' }, render: renderText('已换头像') },
        isConcurrencySafe: () => false,
        execute: async (args) => {
            const file = String(args?.file ?? '').trim();
            if (file === '') throw new Error('必须给一张图');
            await call('set_qq_avatar', { file });
            return { ok: true };
        },
    }));

    ctx.tools.register(defineTool({
        name: 'qq_profile_set_status',
        description: `改 QQ 小号在线状态。可选值：${Object.keys(STATUS).join('、')}`,
        parameters: {
            status: { type: 'string', required: true, description: '状态名，必须是上面列出的之一' },
        },
        output: { schema: { type: 'json' }, render: renderText('已改状态') },
        isConcurrencySafe: () => false,
        execute: async (args) => {
            const wanted = String(args?.status ?? '').trim();
            const mapped = STATUS[wanted];
            if (!mapped) throw new Error(`不支持的状态「${wanted}」`);
            await call('set_online_status', { status: mapped[0], ext_status: mapped[1], battery_status: 0 });
            return { ok: true, status: wanted };
        },
    }));
}
