/**
 * dsh-qq-qzone —— 用 QQ 小号发说说、看自己最近的说说。
 *
 * 对照 AstrBot 的 astrbot_plugin_qzone：那边靠 aiocqhttp 的 get_cookies
 * 拿 user.qzone.qq.com 的登录态，再打 qzone 的 CGI。这里同样两步走：
 *   1. NapCat 的 /get_cookies 取 cookies（uin / skey / p_skey）
 *   2. 用 p_skey 算 g_tk，带 cookie 打 taotao 的 CGI
 * v1 只做纯文字说说（图片上传接口很脆，先不硬塞）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'qq-qzone';
export const inject = ['tools'];

const DEFAULTS = {
    enabled: true,
    apiBase: 'http://127.0.0.1:3001',
    apiToken: '',
    domain: 'user.qzone.qq.com',
    maxTextLength: 1000,
};

const BASE_URL = 'https://user.qzone.qq.com';
const PUBLISH_URL = `${BASE_URL}/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6`;
const LIST_URL = `${BASE_URL}/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

function renderText(text) {
    return () => [{ type: 'text', text }];
}

/** qzone 的 g_tk：对 p_skey 做 djb2，再 & 0x7FFFFFFF。 */
function gtkOf(pSkey) {
    let hash = 5381;
    for (const ch of pSkey) hash = (hash * 33 + ch.codePointAt(0)) % 0xffffffff;
    return String(hash & 0x7fffffff);
}

function parseCookies(raw) {
    const out = {};
    for (const part of String(raw ?? '').split(';')) {
        const idx = part.indexOf('=');
        if (idx <= 0) continue;
        out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    }
    return out;
}

/** qzone 的 CGI 常返回 JSONP：_preloadCallback({...}) */
function parseJsonp(text) {
    const trimmed = String(text ?? '').trim().replace(/;$/, '');
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error(`说说接口返回的不是 JSON：${trimmed.slice(0, 120)}`);
    return JSON.parse(trimmed.slice(start, end + 1));
}

export function apply(ctx, rawConfig) {
    const config = { ...DEFAULTS, ...(rawConfig ?? {}) };
    if (!config.enabled) return;
    const apiBase = String(config.apiBase).replace(/\/+$/, '');
    const napcatHeaders = {
        'content-type': 'application/json',
        ...(config.apiToken ? { authorization: `Bearer ${config.apiToken}` } : {}),
    };
    let cached = null;

    async function napcat(action, body = {}) {
        const response = await fetch(`${apiBase}/${action}`, {
            method: 'POST',
            headers: napcatHeaders,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(20000),
        });
        const text = await response.text();
        let payload = {};
        try {
            payload = JSON.parse(text);
        } catch {
            throw new Error(`NapCat ${action} 返回非 JSON（HTTP ${response.status}）：${text.slice(0, 120)}`);
        }
        if (payload.retcode !== undefined && payload.retcode !== 0) {
            throw new Error(`NapCat ${action} 失败 retcode=${payload.retcode} ${payload.message ?? ''}`);
        }
        return payload.data ?? {};
    }

    async function session(force = false) {
        if (!force && cached) return cached;
        const data = await napcat('get_cookies', { domain: config.domain });
        const cookies = parseCookies(data.cookies);
        const uinText = cookies.uin ?? '';
        const uin = Number(uinText.replace(/^o/i, ''));
        if (!Number.isFinite(uin) || uin <= 0) {
            throw new Error('get_cookies 没给出 uin，确认小号在 NapCat 里在线');
        }
        const skey = cookies.skey ?? '';
        const pSkey = cookies.p_skey || skey;
        if (!pSkey) throw new Error('get_cookies 没给出 p_skey，QQ 空间登录态可能失效');
        cached = { uin, skey, pSkey, gtk: gtkOf(pSkey) };
        return cached;
    }

    function headersOf(sess) {
        return {
            'user-agent': UA,
            referer: `${BASE_URL}/${sess.uin}`,
            origin: BASE_URL,
        };
    }

    function cookieHeader(sess) {
        return `uin=o${sess.uin}; skey=${sess.skey}; p_skey=${sess.pSkey}`;
    }

    ctx.tools.register(defineTool({
        name: 'qq_qzone_publish',
        description: '用 QQ 小号发一条纯文字说说。',
        parameters: {
            text: { type: 'string', required: true, description: '说说正文' },
        },
        output: { schema: { type: 'json' }, render: renderText('说说已发出') },
        isConcurrencySafe: () => false,
        execute: async (args) => {
            const text = String(args?.text ?? '').trim();
            if (text === '') throw new Error('说说不能为空');
            if (text.length > config.maxTextLength) throw new Error(`说说超过 ${config.maxTextLength} 字`);
            const sess = await session();
            const body = new URLSearchParams({
                syn_tweet_verson: '1',
                paramstr: '1',
                who: '1',
                con: text,
                feedversion: '1',
                ver: '1',
                ugc_right: '1',
                to_sign: '0',
                hostuin: String(sess.uin),
                code_version: '1',
                format: 'json',
                qzreferrer: `${BASE_URL}/${sess.uin}`,
            });
            const response = await fetch(`${PUBLISH_URL}?g_tk=${sess.gtk}&uin=${sess.uin}`, {
                method: 'POST',
                headers: {
                    ...headersOf(sess),
                    cookie: cookieHeader(sess),
                    'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
                },
                body,
                signal: AbortSignal.timeout(30000),
            });
            const raw = await response.text();
            let payload;
            try {
                payload = parseJsonp(raw);
            } catch {
                throw new Error(`说说接口返回异常（HTTP ${response.status}）：${raw.slice(0, 160)}`);
            }
            const code = Number(payload?.code ?? payload?.ret ?? -1);
            if (code !== 0) {
                throw new Error(`发说说失败 code=${code} ${payload?.message ?? payload?.msg ?? ''}`);
            }
            return { ok: true, tid: payload?.tid ?? null, text };
        },
    }));

    ctx.tools.register(defineTool({
        name: 'qq_qzone_recent',
        description: '看 QQ 小号自己最近的说说（正文、时间、点赞/评论数）。',
        parameters: {
            limit: { type: 'number', description: '要几条，默认 5，最多 20' },
        },
        output: { schema: { type: 'json' }, render: renderText('已查看说说') },
        isConcurrencySafe: () => true,
        execute: async (args) => {
            const limit = Math.max(1, Math.min(20, Number(args?.limit ?? 5) || 5));
            let sess = await session();
            const query = new URLSearchParams({
                g_tk: sess.gtk,
                uin: String(sess.uin),
                ftype: '0',
                sort: '0',
                pos: '0',
                num: String(limit),
                replynum: '100',
                callback: '_preloadCallback',
                code_version: '1',
                format: 'json',
                need_comment: '1',
                need_private_comment: '1',
            });
            let response = await fetch(`${LIST_URL}?${query}`, {
                headers: { ...headersOf(sess), cookie: cookieHeader(sess) },
                signal: AbortSignal.timeout(30000),
            });
            let payload = parseJsonp(await response.text());
            if (Number(payload?.message ?? '') === 1 || Number(payload?.code ?? 0) !== 0) {
                // 登录态过期时重新取一次 cookie 再试
                sess = await session(true);
                const retryQuery = new URLSearchParams({ ...Object.fromEntries(query), g_tk: sess.gtk });
                response = await fetch(`${LIST_URL}?${retryQuery}`, {
                    headers: { ...headersOf(sess), cookie: cookieHeader(sess) },
                    signal: AbortSignal.timeout(30000),
                });
                payload = parseJsonp(await response.text());
            }
            const list = Array.isArray(payload?.msglist) ? payload.msglist : [];
            return {
                total: payload?.total ?? list.length,
                items: list.slice(0, limit).map((item) => ({
                    content: String(item?.content ?? '').trim(),
                    created: item?.created_time ? new Date(Number(item.created_time) * 1000).toISOString() : null,
                    likes: item?.like?.length ?? 0,
                    comments: Array.isArray(item?.commentlist) ? item.commentlist.length : 0,
                })),
            };
        },
    }));
}
