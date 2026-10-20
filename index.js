// ==UserScript==
// @name         B站字幕 · UP主信息下方
// @namespace    https://local/bili-subtitle
// @version      1.5.0
// @description  在哔哩哔哩视频播放页的UP主信息与弹幕列表之间显示字幕（wbi 签名 API + 播放器请求嗅探双通路），支持点击跳转、跟随高亮、搜索、复制、下载
// @author       local
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/list/*
// @match        https://www.bilibili.com/bangumi/play/*
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @connect      api.bilibili.com
// @connect      aisubtitle.hdslb.com
// @connect      hdslb.com
// @connect      bilivideo.com
// @connect      bilivideo.cn
// @connect      127.0.0.1
// ==/UserScript==

/*
 * 已知前提（实测确认）：
 *   1. B 站 x/player/wbi/v2 返回的 data.need_login_subtitle === true
 *      → 未登录时字幕列表为空，必须带用户 Cookie 请求。
 *      这也是本脚本必须跑在浏览器里、而不能用服务端爬虫的原因。
 *   2. x/web-interface/nav 未登录也会返回 data.wbi_img → wbi 密钥可匿名获取。
 *   3. api.bilibili.com 对 Origin: https://www.bilibili.com 回 Access-Control-Allow-Origin
 *      且 Access-Control-Allow-Credentials: true → 页面上下文可直接带 Cookie 请求。
 *   4. 页面内嵌 window.__INITIAL_STATE__.defaultWbiKey 已含 wbi 密钥，可省掉 nav 请求；
 *      但 __INITIAL_STATE__.videoData.subtitle.list[].subtitle_url 为空字符串，
 *      所以"只读页面数据"拿不到字幕正文。
 *   5. 【关键】aisubtitle.hdslb.com 不返回任何 CORS 头
 *      → 页面上下文 fetch 字幕正文必然被拦（No 'Access-Control-Allow-Origin'）。
 *      因此必须用 GM_xmlhttpRequest 绕过 CORS，或退化为嗅探播放器自己的请求。
 *      （MV3 扩展里的等价做法是把这一步放到 background 去 fetch。）
 *
 * 关于 @grant：
 *   本脚本声明 GM_xmlhttpRequest（不能用 @grant none，否则该 API 不存在，
 *   CORS 兜底会静默失效）。为避免沙箱里读不到页面全局，
 *   所有页面级访问统一走 W = unsafeWindow || window。
 */

(function () {
    'use strict';

    const API = 'https://api.bilibili.com';
    const LOG = (...a) => console.log('%c[字幕]', 'color:#fb7299', ...a);

    // 沙箱（有 grant）下 unsafeWindow 才是真正的页面 window；
    // @grant none 或普通注入时回落到 window。
    const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
    const hasGM = typeof GM_xmlhttpRequest === 'function';
    const LOCAL_API = 'http://127.0.0.1:3211';
    const LOCAL_TOKEN = '4a47ff2b557ad51f79fa1d61cf435cb9b657d30a9793ff51a1d64a169c620b35';

    /* ======================================================================
     * 0. 网络请求层
     *    - apiGet：B 站开放接口。优先用页面 fetch（同站，Cookie 有保证，CORS 已放行），
     *              失败再用 GM_xmlhttpRequest。
     *    - cdnGet：字幕正文。必须先试 GM_xmlhttpRequest（CDN 无 CORS 头），
     *              再试页面 fetch（某些管理器/环境下可能可用）。
     * ==================================================================== */
    function gmGet(url, referer) {
        return new Promise((resolve, reject) => {
            try {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url,
                    timeout: 15000,
                    // 注意：不要设 anonymous，否则不带 Cookie
                    headers: referer ? { Referer: referer } : undefined,
                    onload: r => {
                        if (r.status >= 200 && r.status < 300) resolve(r.responseText);
                        else reject(new Error(`HTTP ${r.status}`));
                    },
                    onerror: () => reject(new Error('GM_xmlhttpRequest 网络错误')),
                    ontimeout: () => reject(new Error('GM_xmlhttpRequest 超时')),
                });
            } catch (e) { reject(e); }
        });
    }

    async function pageGet(url, referer) {
        const r = await fetch(url, {
            credentials: 'include',
            referrer: referer || location.href,
            referrerPolicy: 'strict-origin-when-cross-origin',
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
    }

    // 依次尝试给定的取法，全部失败才抛错
    async function tryAll(attempts) {
        const errs = [];
        for (const [name, fn] of attempts) {
            try { return await fn(); }
            catch (e) { errs.push(`${name}: ${e.message}`); }
        }
        throw new Error(errs.join(' / '));
    }

    const apiGetText = (url) => tryAll([
        ['页面请求', () => pageGet(url)],
        ...(hasGM ? [['GM_xmlhttpRequest', () => gmGet(url, location.href)]] : []),
    ]);

    const cdnGetText = (url) => tryAll([
        ...(hasGM ? [['GM_xmlhttpRequest', () => gmGet(url, location.href)]] : []),
        ['页面请求', () => pageGet(url)],
    ]);

    async function apiGetJson(url) {
        return JSON.parse(await apiGetText(url));
    }

    /* ======================================================================
     * 1. 小工具：MD5（w_rid 需要，crypto.subtle 不支持 MD5）
     * ==================================================================== */
    function md5(input) {
        const bytes = new TextEncoder().encode(input);
        const K = new Uint32Array(64);
        for (let i = 0; i < 64; i++) K[i] = (Math.abs(Math.sin(i + 1)) * 4294967296) | 0;

        const S = [7,12,17,22, 7,12,17,22, 7,12,17,22, 7,12,17,22,
            5,9,14,20, 5,9,14,20, 5,9,14,20, 5,9,14,20,
            4,11,16,23, 4,11,16,23, 4,11,16,23, 4,11,16,23,
            6,10,15,21, 6,10,15,21, 6,10,15,21, 6,10,15,21];

        const len = bytes.length;
        const withPad = new Uint8Array((((len + 8) >> 6) + 1) << 6);
        withPad.set(bytes);
        withPad[len] = 0x80;
        const bitLen = len * 8;
        const dv = new DataView(withPad.buffer);
        dv.setUint32(withPad.length - 8, bitLen >>> 0, true);
        dv.setUint32(withPad.length - 4, Math.floor(bitLen / 4294967296), true);

        let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
        const M = new Uint32Array(16);
        for (let off = 0; off < withPad.length; off += 64) {
            for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
            let A = a0, B = b0, C = c0, D = d0;
            for (let i = 0; i < 64; i++) {
                let F, g;
                if (i < 16)      { F = (B & C) | (~B & D);         g = i; }
                else if (i < 32) { F = (D & B) | (~D & C);         g = (5 * i + 1) % 16; }
                else if (i < 48) { F = B ^ C ^ D;                  g = (3 * i + 5) % 16; }
                else             { F = C ^ (B | ~D);               g = (7 * i) % 16; }
                F = (F + A + K[i] + M[g]) | 0;
                A = D; D = C; C = B;
                B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) | 0;
            }
            a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
        }
        const out = new Uint8Array(16), odv = new DataView(out.buffer);
        odv.setUint32(0, a0, true); odv.setUint32(4, b0, true);
        odv.setUint32(8, c0, true); odv.setUint32(12, d0, true);
        return [...out].map(b => b.toString(16).padStart(2, '0')).join('');
    }

    /* ======================================================================
     * 2. wbi 签名
     * ==================================================================== */
    const MIXIN_TAB = [46,47,18,2,53,61,20,56,37,43,59,45,34,10,31,58,3,23,32,5,
        63,16,7,9,38,57,1,60,15,29,54,62,52,28,27,0,12,4,51,35,
        6,33,24,55,11,17,26,36,30,44,50,19,14,41,21,48,40,49,39,8,
        25,13,22,42];

    const wbiCache = { mixin: null, exp: 0 };

    // wbi_img 的 URL 形如 https://i0.hdslb.com/bfs/wbi/<hash>.png
    // 密钥 = 最后一个路径段去掉扩展名（不能假设路径只有一段）
    function keyFromUrl(u) {
        if (!u) return null;
        try {
            const last = new URL(u, location.href).pathname.split('/').pop() || '';
            const m = /^([^.]+)\.[a-zA-Z]+$/.exec(last);
            return m ? m[1] : null;
        } catch { return null; }
    }

    async function ensureMixin() {
        if (wbiCache.mixin && Date.now() < wbiCache.exp) return wbiCache.mixin;
        let img = null, sub = null;

        // 优先：页面内嵌密钥，省一次网络请求
        try {
            const k = W.__INITIAL_STATE__ && W.__INITIAL_STATE__.defaultWbiKey;
            if (k && k.wbiImgKey && k.wbiSubKey) { img = k.wbiImgKey; sub = k.wbiSubKey; }
        } catch (_) { /* 沙箱里可能拿不到，忽略 */ }

        if (!img || !sub) {
            const j = await apiGetJson(`${API}/x/web-interface/nav`);
            img = keyFromUrl(j?.data?.wbi_img?.img_url || '');
            sub = keyFromUrl(j?.data?.wbi_img?.sub_url || '');
        }
        if (!img || !sub) throw new Error('无法获取 wbi 密钥');
        wbiCache.mixin = MIXIN_TAB.map(i => (img + sub)[i]).join('').slice(0, 32);
        wbiCache.exp = Date.now() + 3600e3;
        return wbiCache.mixin;
    }

    async function wbiSign(params) {
        const mixin = await ensureMixin();
        const p = {};
        for (const k in params) p[k] = String(params[k]);
        p.wts = String(Math.floor(Date.now() / 1000));
        const query = Object.keys(p).sort()
            .map(k => `${k}=${encodeURIComponent(p[k].replace(/[!'()*]/g, ''))}`)
            .join('&');
        return `${query}&w_rid=${md5(query + mixin)}`;
    }

    /* ======================================================================
     * 3. 取得 aid / cid（按 ?p= 选分 P）
     * ==================================================================== */
    function bvidFromUrl() {
        return (/\/video\/(BV[0-9A-Za-z]+)/.exec(location.pathname) || [])[1]
            || (/\/video\/(av\d+)/i.exec(location.pathname) || [])[1] || null;
    }
    function pageFromUrl() {
        const n = parseInt(new URLSearchParams(location.search).get('p') || '1', 10);
        return Number.isFinite(n) && n > 0 ? n : 1;
    }

    // 换视频判定键：完整路径 + 白名单查询参数。
    // 不能全量用 location.search —— 播放器会随进度改写 ?t=，那不是换视频；
    // 也不能只用 bvid —— 番剧/合集页没有 bvid，换集时 key 不变会导致不重载字幕。
    function routeKey() {
        const sp = new URLSearchParams(location.search);
        const kept = ['p', 'ep', 'ss'].map(k => sp.get(k) ? `${k}=${sp.get(k)}` : '').filter(Boolean);
        return location.pathname + (kept.length ? `?${kept.join('&')}` : '');
    }

    async function getIds() {
        const id = bvidFromUrl();
        if (!id) throw new Error('URL 里没有视频号');
        const key = /^BV/i.test(id) ? 'bvid' : 'aid';
        const j = await apiGetJson(`${API}/x/web-interface/view?${key}=${encodeURIComponent(id)}`);
        if (j.code !== 0) throw new Error(`view 接口失败：${j.code} ${j.message}`);
        const d = j.data;
        const p = pageFromUrl();
        const page = (d.pages || []).find(x => x.page === p) || (d.pages || [])[0] || {};
        return { aid: d.aid, bvid: d.bvid, cid: page.cid || d.cid, p, title: d.title, pages: d.pages || [] };
    }

    /* ======================================================================
     * 4. 取字幕轨道列表（方法 A）
     * ==================================================================== */
    async function listTracks(aid, cid) {
        const q = await wbiSign({ aid, cid });
        const j = await apiGetJson(`${API}/x/player/wbi/v2?${q}`);
        if (j.code !== 0) throw new Error(`字幕接口失败：${j.code} ${j.message || ''}`);
        const d = j.data || {};
        const sub = d.subtitle || {};
        // 新版字段是 subtitle.subtitles，老版是 subtitle.list
        const tracks = sub.subtitles || sub.list || [];
        return { tracks, needLogin: !!d.need_login_subtitle, isLogin: d.login_mid !== 0, raw: d };
    }

    /* ======================================================================
     * 5. 取字幕正文
     * ==================================================================== */
    function normalizeUrl(u) {
        if (!u) return '';
        if (u.startsWith('//')) return 'https:' + u;
        if (u.startsWith('/')) return location.origin + u;
        return u;
    }

    // 兼容多种字段形态（B 站/第三方/AI 字幕字段并不统一）
    function parseBody(json) {
        const arr = json?.body || json?.data?.body || json?.data?.subtitle?.body || json?.result;
        if (!Array.isArray(arr)) return [];
        const num = (v, dflt) => (typeof v === 'number' && isFinite(v) ? v : (parseFloat(v) || dflt));
        return arr.flatMap(item => {
            if (!item || typeof item !== 'object') return [];
            const start = num(item.from ?? item.start_time ?? item.start ?? item.stime, 0);
            const dur   = num(item.dur ?? item.duration ?? item.len, 0);
            const end   = num(item.to ?? item.end_time ?? item.end ?? item.etime, start + dur);
            const text  = String(item.content ?? item.text ?? (item.segs || []).map(s => s?.utf8).join('') ?? '')
                .replace(/\s+/g, ' ').trim();
            if (!text) return [];
            return [{ start, end: Math.max(end, start + 0.2), text }];
        }).sort((a, b) => a.start - b.start);
    }

    // 返回 { cues, how }，how 记录实际生效的通路，便于诊断
    async function fetchCues(subtitleUrl) {
        const u = normalizeUrl(subtitleUrl);
        if (!u) throw new Error('该轨道没有 subtitle_url');

        // 通路 1：带鉴权直接取（CORS 需 GM_xmlhttpRequest）
        try {
            return { cues: parseBody(JSON.parse(await cdnGetText(u))), how: hasGM ? 'GM_xmlhttpRequest' : '页面请求' };
        } catch (e) {
            LOG('直接取字幕正文失败：', e.message);
        }

        // 通路 2：嗅探播放器自己的请求（它请求同一个 URL，只是不受 CORS 限制）
        let cues = takeIntercepted(u);
        if (cues.length) return { cues, how: '嗅探播放器请求' };

        LOG('尝试主动点开播放器字幕菜单…');
        if (await pokePlayerSubtitleMenu()) {
            const t0 = Date.now();
            while (!cues.length && Date.now() - t0 < 8000) {
                await new Promise(r => setTimeout(r, 300));
                cues = takeIntercepted(u);
            }
            if (cues.length) return { cues, how: '嗅探播放器请求（主动触发）' };
        }

        throw new Error(
            hasGM
                ? '字幕正文获取失败：CDN 拒绝且未能从播放器嗅探到'
                : '字幕正文获取失败：CDN 无 CORS 头。请在本管理器中允许 GM_xmlhttpRequest（不要用 @grant none）'
        );
    }

    /* ======================================================================
     * 6. 方法 B：嗅探播放器自己发出的字幕请求（兜底）
     * ==================================================================== */
    const MAX_INTERCEPT = 8;
    const intercepted = [];
    (function hookNetwork() {
        const RE = /aisubtitle\.hdslb\.com\/bfs\/(ai_subtitle|subtitle)\//;
        const push = (url, text) => {
            intercepted.push({ url, text });
            while (intercepted.length > MAX_INTERCEPT) intercepted.shift();
        };
        try {
            const origFetch = W.fetch;
            W.fetch = async function (...args) {
                const res = await origFetch.apply(this, args);
                try {
                    const a0 = args[0];
                    const url = typeof a0 === 'string' ? a0 : a0 instanceof URL ? a0.href : a0?.url;
                    if (url && RE.test(url)) {
                        // 必须 clone()，否则会消费掉播放器自己要读的 body
                        res.clone().text().then(t => t && push(url, t)).catch(() => {});
                    }
                } catch (_) {}
                return res;
            };

            const XHR = W.XMLHttpRequest;
            const origOpen = XHR.prototype.open;
            XHR.prototype.open = function (m, u, ...rest) {
                try {
                    if (typeof u === 'string' && RE.test(u)) {
                        this.addEventListener('load', () => {
                            if (this.status === 200 && this.responseText) push(u, this.responseText);
                        });
                    }
                } catch (_) {}
                return origOpen.call(this, m, u, ...rest);
            };
            LOG('网络嗅探已安装');
        } catch (e) { LOG('网络 hook 安装失败', e); }
    })();

    // 主动"点开"播放器的字幕菜单，逼它发起字幕请求（B 站字幕菜单是懒挂载的）
    async function pokePlayerSubtitleMenu() {
        const waitFor = async (sel, ms) => {
            const t0 = Date.now();
            while (Date.now() - t0 < ms) {
                const el = document.querySelector(sel);
                if (el) return el;
                await new Promise(r => setTimeout(r, 200));
            }
            return null;
        };
        const box = await waitFor('.bpx-player-ctrl-subtitle-box', 4000);
        if (!box) { LOG('找不到字幕按钮 .bpx-player-ctrl-subtitle-box'); return false; }
        for (const type of ['mouseenter', 'mouseover']) {
            box.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
        }
        await new Promise(r => setTimeout(r, 400));
        const item = document.querySelector('.bpx-player-ctrl-subtitle-language-item[data-lan="ai-zh"]')
            || document.querySelector('.bpx-player-ctrl-subtitle-language-item[data-lan^="ai-"]')
            || document.querySelector('.bpx-player-ctrl-subtitle-language-item[data-lan]');
        if (!item) { LOG('找不到字幕语言项 [data-lan]'); return false; }
        for (const type of ['mousedown', 'mouseup', 'click']) {
            item.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
        }
        return true;
    }

    // 消费嗅探缓存。expectedUrl 传入当前轨道的 subtitle_url 时，
    // 优先取路径一致的正文（防止同视频其他轨道的缓存被误用）；
    // 没有同路径缓存才退回 FIFO——同视频内不会串台，跨视频残留已在换视频时清空。
    function takeIntercepted(expectedUrl) {
        let wanted = null;
        try { wanted = expectedUrl ? new URL(normalizeUrl(expectedUrl)).pathname : null; } catch (_) {}
        while (intercepted.length) {
            let hitIdx = wanted
                ? intercepted.findIndex(h => {
                    try { return new URL(h.url).pathname === wanted; } catch { return false; }
                })
                : 0;
            if (hitIdx === -1) hitIdx = 0;
            const hit = intercepted.splice(hitIdx, 1)[0];
            try {
                const cues = parseBody(JSON.parse(hit.text));
                if (cues.length) return cues;
            } catch (_) {}
        }
        return [];
    }

    /* ======================================================================
     * 7. UI：注入到弹幕列表右侧
     * ==================================================================== */
    const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .wrap {
      display: flex; flex-direction: column;
      /* 不写 max-height 上限：面板高度由用户在右上角下拉里自选，
         高度上限由宿主节点的 height 保证，.bd 始终 flex 撑满剩余空间并可滚动 */
      min-height: 260px; height: 100%;
      font: 13px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
      color: #18191c; background: #fff; border: 1px solid #e3e5e7; border-radius: 8px;
      overflow: hidden;
    }
    .hd { display:flex; align-items:center; gap:8px; padding:8px 10px;
          border-bottom:1px solid #e3e5e7; background:#f6f7f8; flex:0 0 auto; }
    /* 标题行整行可点收起；搜索行共用 .hd 但不接热区，避免点输入框时误收 */
    .hd-main { cursor:pointer; user-select:none; }
    .hd-main:hover { background:#eef0f2; }
    .hd .t { font-weight:600; font-size:15px; flex:1 1 auto; white-space:nowrap; }
    .hd .cnt { flex:0 0 auto; color:#9499a0; font-size:12px; font-variant-numeric: tabular-nums; }
    .hd .caret { flex:0 0 auto; color:#9499a0; font-size:11px; line-height:1; }
    select, input, button {
      font: inherit; color: inherit; border: 1px solid #e3e5e7;
      background:#fff; border-radius:4px; padding:2px 6px; cursor:pointer;
    }
    input[type=search] { cursor:text; flex:1 1 auto; min-width:60px; }
    /* min-height 是保险丝：任何情况下列表区都不会塌成 0 */
    .bd { flex:1 1 auto; overflow-y:auto; overscroll-behavior: contain; min-height: 160px; }
    .cue { display:flex; gap:8px; padding:5px 10px; cursor:pointer; border-left:3px solid transparent; }
    .cue:hover { background:#f1f2f3; }
    .cue.on { background:#fff0f6; border-left-color:#fb7299; }
    .cue time { flex:0 0 auto; color:#9499a0; font-variant-numeric: tabular-nums; font-size:12px; padding-top:1px; }
    .cue span { flex:1 1 auto; word-break: break-word; }
    .cue mark { background:#ffe58f; padding:0 1px; }
    .ft { flex:0 0 auto; padding:6px 10px; border-top:1px solid #e3e5e7;
          display:flex; gap:6px; align-items:center; color:#9499a0; font-size:12px;
          flex-wrap:wrap; }
    /* 语言/高度与复制下载同行：窄面板下限制宽度，长文案由浏览器截断。
       100px 是「400px · 9条」不截断的下限；底栏总宽 274px，仍在 300px 面板内。 */
    .ft select { max-width:100px; min-width:0; color:#18191c; }
    .ft .spacer { flex:1 1 auto; }
    .msg { padding:16px 12px; color:#9499a0; text-align:center; line-height:1.7; }
    .msg b { color:#fb7299; }
    .msg code { background:#f1f2f3; padding:1px 4px; border-radius:3px; font-size:11px; }
    /* 收起：只留标题栏，不再占页面高度 */
    .wrap.collapsed { min-height: 0; max-height: none; height: auto; }
    .wrap.collapsed .bd, .wrap.collapsed .ft, .wrap.collapsed .hd.searchrow { display: none; }
    .spin { display:inline-block; width:12px; height:12px; border:2px solid #fb7299;
            border-top-color:transparent; border-radius:50%; animation:sp .8s linear infinite;
            vertical-align:-2px; margin-right:6px; }
    @keyframes sp { to { transform: rotate(360deg); } }
  `;

    function fmt(sec) {
        sec = Math.max(0, Math.floor(sec));
        const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
        const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
        return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
    }

    const state = {
        cues: [], tracks: [], activeIdx: -1, query: '', follow: true, title: '', how: '',
        collapsed: false, ids: null, revision: 0, noTracks: false,
    };

    let els = null;
    let activeNode = null;   // 当前高亮的 DOM 节点（O(1) 更新，避免全量查询）
    let lastUserScroll = 0;  // 用户最近一次手动滚动列表的时间（滚动打断保护）
    let qTimer = null;       // 搜索防抖计时器
    let seekRaf = 0;         // 跳转动画的 rAF id，0 表示无动画
    let seekAnimating = false;  // 动画进行中：挂起跟随，避免列表跟着中间句乱滚

    function msg(html) {
        if (!els) return;
        els.bd.innerHTML = `<div class="msg">${html}</div>`;
        els.cnt.textContent = '—';
    }

    function buildPanel() {
        const host = document.createElement('div');
        host.id = 'bili-subtitle-panel';
        // 具体定位由 dockify()/floatify() 设置；这里只给尺寸下限
        host.style.cssText = 'min-width:300px; min-height:260px;';
        const shadow = host.attachShadow({ mode: 'open' });

        const style = document.createElement('style');
        style.textContent = CSS;

        const wrap = document.createElement('div');
        wrap.className = 'wrap';
        wrap.innerHTML = `
      <div class="hd hd-main" title="点击展开 / 收起">
        <span class="t">字幕列表</span>
        <span class="cnt">—</span>
        <span class="caret">▾</span>
      </div>
      <div class="hd searchrow">
        <input class="q" type="search" placeholder="搜索字幕…" />
        <button class="follow" title="跟随播放高亮">跟随</button>
      </div>
      <div class="bd"><div class="msg"><span class="spin"></span>正在获取字幕…</div></div>
      <div class="ft">
        <select class="lang" title="字幕轨道" hidden></select>
        <select class="hgt" title="面板高度（选择会被记住）"></select>
        <span class="spacer"></span>
        <button class="generate" hidden>生成字幕</button><button class="cancel" hidden>取消</button>
        <button class="copy">复制</button><button class="dl">下载</button></div>
    `;
        shadow.append(style, wrap);

        els = {
            host, wrap, lang: wrap.querySelector('.lang'), hgt: wrap.querySelector('.hgt'),
            q: wrap.querySelector('.q'), hd: wrap.querySelector('.hd-main'),
            follow: wrap.querySelector('.follow'), bd: wrap.querySelector('.bd'),
            cnt: wrap.querySelector('.cnt'), caret: wrap.querySelector('.caret'),
            copy: wrap.querySelector('.copy'),
            dl: wrap.querySelector('.dl'),
            generate: wrap.querySelector('.generate'), cancel: wrap.querySelector('.cancel'),
        };

        // 整行可点收起；按钮文案改成右下角箭头指示，省掉一格宽度
        const toggleCollapse = () => {
            state.collapsed = !state.collapsed;
            els.caret.textContent = state.collapsed ? '▸' : '▾';
            els.wrap.classList.toggle('collapsed', state.collapsed);
            if (MODE === 'float') floatify();
            else els.host.style.height = state.collapsed ? 'auto' : panelH + 'px';
        };
        els.hd.addEventListener('click', toggleCollapse);

        els.lang.addEventListener('change', () => loadTrack(Number(els.lang.value)));

        // 面板高度：预设档位 + 记住上次选择（localStorage，按站点持久化）
        const H_PRESETS = [260, 320, 400, 480, 560, 640, 720, 800, 900];
        const hOpts = H_PRESETS.includes(panelH)
            ? H_PRESETS
            : [...H_PRESETS, panelH].sort((a, b) => a - b);   // 恢复了非预设值时补进选项
        // 行高约 31px（13px 字号 1.6 行距 + 上下 5px 内边距），固定区（两条标题栏+底栏）约 115px，
        // 估算可见条数只作参考
        // 文案压缩成 `320px · 6条`：底栏要和语言、复制、下载挤一行，长文案会被截断
        els.hgt.innerHTML = hOpts.map(h =>
            `<option value="${h}"${h === panelH ? ' selected' : ''}>` +
            `${h}px · ${Math.max(3, Math.floor((h - 115) / 31))}条</option>`).join('');
        els.hgt.addEventListener('change', () => {
            savePanelH(Number(els.hgt.value));
            if (state.collapsed) return;                      // 收起状态下只存值，展开时再应用
            if (MODE === 'above') aboveify();
            else if (MODE === 'dock') dockify();
            else floatify();
        });
        els.generate.addEventListener('click', generateSubtitle);
        els.cancel.addEventListener('click', () => cancelGeneration(true));
        // 搜索防抖：长视频每键全量重建 7000+ 节点会卡（问题 9）
        els.q.addEventListener('input', () => {
            state.query = els.q.value.trim();
            clearTimeout(qTimer);
            qTimer = setTimeout(render, 180);
        });
        // 用户手动翻列表时记录时间，1.5 秒内自动滚动暂不打断（高亮仍更新，问题 14）
        els.bd.addEventListener('wheel', () => { lastUserScroll = Date.now(); }, { passive: true });
        els.bd.addEventListener('touchmove', () => { lastUserScroll = Date.now(); }, { passive: true });
        els.follow.addEventListener('click', () => {
            state.follow = !state.follow;
            els.follow.style.color = state.follow ? '#fb7299' : '';
        });
        els.copy.addEventListener('click', async () => {
            const txt = state.cues.map(c => `[${fmt(c.start)}] ${c.text}`).join('\n');
            try {
                if (typeof GM_setClipboard === 'function') await new Promise(resolve => GM_setClipboard(txt, 'text', resolve));
                else await navigator.clipboard.writeText(txt);
                els.copy.textContent = '已复制';
            }
            catch { els.copy.textContent = '失败'; }
            setTimeout(() => (els.copy.textContent = '复制'), 1200);
        });
        els.dl.addEventListener('click', () => {
            const txt = state.cues.map(c => `[${fmt(c.start)}] ${c.text}`).join('\n');
            const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `${(state.title || 'subtitle').replace(/[\\/:*?"<>|]/g, '_')}.txt`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 3000);
        });
        els.follow.style.color = '#fb7299';

        // 列表点击跳转（事件委托）
        els.bd.addEventListener('click', e => {
            const cue = e.target.closest('.cue');
            if (!cue) return;
            const c = state.cues[Number(cue.dataset.i)];
            if (c) seekTo(c.start, Number(cue.dataset.i));
        });

        return host;
    }

    // 转义：字幕文本要进 innerHTML，不转义会被当标签解析
    // （本次样本无特殊字符，但 AI 字幕/OCR 字幕里出现过 <unk>、&amp; 之类的脏数据）
    const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    const escHtml = s => String(s).replace(/[&<>"']/g, c => ESC_MAP[c]);

    // 在原始文本上切分、逐段转义，避免"先转义再匹配"导致实体被误命中
    function cueInnerHtml(raw, re) {
        if (!re) return escHtml(raw);
        const parts = [];
        let last = 0, m;
        re.lastIndex = 0;
        while ((m = re.exec(raw)) !== null) {
            if (m[0].length === 0) { re.lastIndex++; continue; }   // 跳过空匹配，避免插入空 <mark>
            if (m.index > last) parts.push(escHtml(raw.slice(last, m.index)));
            parts.push('<mark>' + escHtml(m[0]) + '</mark>');
            last = m.index + m[0].length;
        }
        parts.push(escHtml(raw.slice(last)));
        return parts.join('');
    }

    function render() {
        if (!els) return;
        const q = state.query.toLowerCase();
        // 保留原始下标，避免重复文本用 indexOf 找错行
        const items = state.cues
            .map((c, i) => ({ c, i }))
            .filter(({ c }) => !q || c.text.toLowerCase().includes(q));

        els.cnt.textContent = q
            ? `${items.length} / ${state.cues.length} 条`
            : `${state.cues.length} 条`;

        if (!items.length) {
            const count = els.cnt.textContent;
            msg(q ? '没有匹配的字幕' : '没有字幕'); els.cnt.textContent = count;
            return;
        }

        let hl = null;
        if (q) hl = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig');

        // 搜索结果只渲染前 800 条（搜索态本就不跟随高亮，截断无副作用），
        // 避免宽匹配一次塞进上万个节点
        const SEARCH_CAP = 800;
        const shown = q && items.length > SEARCH_CAP ? items.slice(0, SEARCH_CAP) : items;
        if (shown !== items) els.cnt.textContent = `前 ${SEARCH_CAP} / 共 ${items.length} 条`;

        els.bd.innerHTML = shown.map(({ c, i }) =>
            `<div class="cue" data-i="${i}"><time>${fmt(c.start)}</time>` +
            `<span>${cueInnerHtml(c.text, hl)}</span></div>`
        ).join('');

        // innerHTML 重建后旧引用失效
        activeNode = null;
        state.activeIdx = -1;
        verifyLayout();

        // 渲染完立刻按当前播放进度做一次初始同步（问题 1 的另一半）：
        // 重开页面恢复到中段进度、或视频暂停时，timeupdate 不会来，
        // 没有这一步列表会一直停在顶部、无高亮
        if (!state.query) {
            const v = document.querySelector('video');
            if (v) syncFollow(v, true);
        }
    }

    // 点击字幕跳转。idx 用于把列表同步滚到目标句。
    // 已缓存且距离够远：rAF 把 currentTime 逐帧推过去，画面"掠"向目标而不是瞬间切走。
    // 未缓存：直接落位 —— 插值本质是连续多次 seek，目标不在缓冲区内时每次 seek 都会
    // 重新拉流，反而比直接跳更卡。
    const SEEK_ANIM_MS = 400;
    // 目标要在缓冲区内侧 1 秒以上：贴着缓冲区边缘落位，落地瞬间就会欠载转圈，
    // 那种情况不如直接跳（跳完同样要等，但不用先演 400ms 动画）。
    function isBuffered(v, sec) {
        const b = v.buffered;
        for (let i = 0; i < b.length; i++) {
            if (sec >= b.start(i) - 0.5 && sec <= b.end(i) - 1) return true;
        }
        return false;
    }

    function seekTo(sec, idx) {
        const v = document.querySelector('video');
        if (!v) return;
        cancelAnimationFrame(seekRaf); seekRaf = 0;

        // 列表与画面同时出发：先把目标句平滑滚到中央，400ms 后一起落位
        if (!state.query && els && idx >= 0) {
            const node = els.bd.children[idx];
            if (node && node.dataset.i === String(idx)) scrollNodeIntoView(node, false);
        }

        const from = v.currentTime;
        if (!isBuffered(v, sec) || Math.abs(sec - from) < 0.3) {
            seekAnimating = false;
            v.currentTime = sec;
            v.play().catch(() => {});
            syncFollow(v, true);
            return;
        }
        seekAnimating = true;
        v.pause();               // 插值与播放会抢 currentTime，先停住
        const t0 = performance.now();
        const step = now => {
            const k = Math.min(1, (now - t0) / SEEK_ANIM_MS);
            v.currentTime = from + (sec - from) * k;
            if (k < 1) { seekRaf = requestAnimationFrame(step); return; }
            seekRaf = 0;
            seekAnimating = false;
            v.play().catch(() => {});      // 沿用原行为：跳转后总是播放
            // 不收尾成硬跳：这里只补高亮，列表继续它自己的平滑滚动（下一帧 timeupdate 会接管）
            syncFollow(v, false);
        };
        seekRaf = requestAnimationFrame(step);
    }

    // —— 跟随播放高亮 ——
    // 用 document 捕获监听：timeupdate 不冒泡，但捕获阶段祖先节点能收到，
    // 因此播放器重建 <video>（画质切换、部分恢复场景）也无需重绑。
    // 旧实现绑死单个元素且重试窗口仅 10s，元素被替换后跟随会永久失效。
    function bindFollow() {
        if (bindFollow.done) return;
        bindFollow.done = true;
        const isMainVideo = v => v instanceof HTMLVideoElement && v === document.querySelector('video');
        document.addEventListener('timeupdate', e => {
            if (isMainVideo(e.target)) syncFollow(e.target, false);
        }, true);
        // 暂停/拖进度/起播/换源时 timeupdate 不一定触发，需要主动同步一次。
        // 尤其"重开页面恢复到中段进度"：恢复进度会触发 seeked，靠它完成首次定位。
        for (const type of ['play', 'seeked', 'loadedmetadata']) {
            document.addEventListener(type, e => {
                if (isMainVideo(e.target)) syncFollow(e.target, true);
            }, true);
        }
    }

    // 计算当前句（v.currentTime 对应的下标）并同步高亮与滚动。
    // force=true：忽略 idx 未变的短路（render 重建 DOM / seek / 起播后需要强制刷新与居中）。
    function syncFollow(v, force) {
        if (!state.follow || !state.cues.length || !els || seekAnimating) return;
        const t = v.currentTime;
        let lo = 0, hi = state.cues.length - 1, idx = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (state.cues[mid].start <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
        }
        // 句间空隙：上一句已结束就不高亮（旧逻辑只看 start，空隙期残留上一句高亮）
        if (idx >= 0 && t >= state.cues[idx].end) idx = -1;

        if (!force && idx === state.activeIdx) return;
        state.activeIdx = idx;

        // O(1) 换引用：不要在 7000+ 节点上做 querySelectorAll，
        // 否则 timeupdate 每秒触发数次会明显卡顿（长视频尤其明显）
        if (activeNode) { activeNode.classList.remove('on'); activeNode = null; }
        // 搜索过滤时 DOM 下标与 cue 下标不再对应，跳过跟随
        if (idx < 0 || state.query) return;

        const node = els.bd.children[idx];
        if (!node) return;
        node.classList.add('on');
        activeNode = node;
        scrollNodeIntoView(node, force);
    }

    // 把节点滚到列表可视区中央（等价 scrollIntoView({block:'center'})，但只滚 .bd 自己，
    // 不会连带滚动页面）。instant=true 用于渲染/换轨后的首次定位（直接跳到位，
    // 避免一进页面就演一段长滚动）；播放中跨句则每句都居中，且用平滑滚动。
    // 用户手动滚过列表时 1.5 秒内不抢回：滚轮是他明确要看别处，但也不该长时间不理人。
    function scrollNodeIntoView(node, instant) {
        if (!instant && Date.now() - lastUserScroll < 1500) return;
        const bd = els.bd, r = node.getBoundingClientRect(), br = bd.getBoundingClientRect();
        const delta = (r.top + r.bottom) / 2 - (br.top + br.bottom) / 2;
        if (Math.abs(delta) < 1) return;
        // 跨屏太多时不用平滑：从列表顶部滚回当前句要飞过上千像素，看着比直接跳还晕
        const far = Math.abs(delta) > bd.clientHeight * 1.5;
        bd.scrollTo({ top: Math.max(0, bd.scrollTop + delta), behavior: instant || far ? 'auto' : 'smooth' });
    }

    /* ======================================================================
     * 本机语音识别：只在用户点击后下载音频、提交到回环地址
     * ==================================================================== */
    let generation = null;
    const currentGeneration = job => generation === job && !job.cancelled && job.revision === state.revision;

    function gmRequest(options, job) {
        return new Promise((resolve, reject) => {
            if (job?.cancelled) { reject(new Error('已取消')); return; }
            let request;
            const finish = fn => value => { job?.requests.delete(request); fn(value); };
            request = GM_xmlhttpRequest({ ...options,
                onload: finish(resolve), onerror: finish(() => reject(new Error('网络请求失败'))),
                ontimeout: finish(() => reject(new Error('请求超时'))),
                onabort: finish(() => reject(new Error('已取消'))),
            });
            job?.requests.add(request);
        });
    }

    async function localRequest(path, method = 'GET', data, job) {
        const r = await gmRequest({ method, url: LOCAL_API + path, data, timeout: 120000,
            anonymous: true,
            headers: { 'X-Local-Token': LOCAL_TOKEN,
                ...(data ? { 'Content-Type': 'application/octet-stream', 'X-Task-Id': job.id } : {}) },
        }, job);
        let result;
        try { result = JSON.parse(r.responseText); }
        catch { throw new Error('本机服务返回了无效结果'); }
        if (r.status < 200 || r.status >= 300) throw new Error(result.error || `本机服务 HTTP ${r.status}`);
        return result;
    }

    function audioUrls(data) {
        const audio = [...(data?.dash?.audio || [])].sort((a, b) => a.bandwidth - b.bandwidth)[0];
        if (!audio) throw new Error('当前视频没有可下载的独立音频');
        return [audio.baseUrl || audio.base_url, ...(audio.backupUrl || audio.backup_url || [])]
            .filter(Boolean).filter(value => {
                try {
                    const u = new URL(value);
                    return u.protocol === 'https:' && /(^|\.)bilivideo\.(com|cn)$/.test(u.hostname);
                } catch { return false; }
            });
    }

    async function downloadAudio(ids, job) {
        const params = new URLSearchParams({ bvid: ids.bvid, cid: ids.cid, qn: 16, fnval: 4048, fourk: 1 });
        const j = await apiGetJson(`${API}/x/player/playurl?${params}`);
        if (!currentGeneration(job)) throw new Error('已取消');
        if (j.code !== 0) throw new Error(`获取音频失败：${j.code} ${j.message || ''}`);
        for (const url of audioUrls(j.data)) {
            try {
                const r = await gmRequest({ method: 'GET', url, responseType: 'arraybuffer', timeout: 120000,
                    headers: { Referer: location.href },
                }, job);
                if (!currentGeneration(job)) throw new Error('已取消');
                if (r.status >= 200 && r.status < 300 && r.response?.byteLength) {
                    if (r.response.byteLength > 256 * 1024 * 1024) throw new Error('音频超过 256MB，请使用较短视频');
                    return r.response;
                }
            } catch (e) { if (job.cancelled || e.message.includes('256MB')) throw e; }
        }
        throw new Error('音频下载失败，请确认视频可正常播放后重试');
    }

    function cancelGeneration(showMessage = false) {
        const job = generation;
        if (!job) return;
        generation = null;
        job.cancelled = true;
        job.wake?.();
        for (const request of job.requests) request.abort();
        if (job.submitted) void localRequest(`/api/tasks/${job.id}`, 'DELETE').catch(() => {});
        if (els) {
            els.cancel.hidden = true; els.generate.disabled = false;
            if (showMessage) msg('已取消生成，可以重试。');
        }
    }

    async function generateSubtitle() {
        if (generation || !state.ids || !state.noTracks) return;
        const job = { id: crypto.randomUUID(), revision: state.revision, requests: new Set(), cancelled: false };
        generation = job;
        const ids = { ...state.ids };
        els.generate.disabled = true; els.cancel.hidden = false;
        const started = Date.now();
        try {
            if (!hasGM || LOCAL_TOKEN === '__' + 'LOCAL_TOKEN__') throw new Error('请使用生成的本机版脚本，并启用 GM_xmlhttpRequest');
            msg('正在连接本机识别服务…');
            let health;
            try { health = await localRequest('/api/health', 'GET', undefined, job); }
            catch (e) { throw new Error(`无法连接本机识别服务，请在项目目录运行 npm start。${e.message}`); }
            if (!health.ready) throw new Error('本机模型或识别工具未准备好，请检查安装');
            if (health.busy) throw new Error('本机正在处理其他任务，请稍后重试');
            if (!currentGeneration(job)) return;
            msg('正在获取音频…');
            const audio = await downloadAudio(ids, job);
            if (!currentGeneration(job)) return;
            msg('正在将音频交给本机服务…');
            job.submitted = true;
            await localRequest(`/api/tasks?bvid=${encodeURIComponent(ids.bvid)}&cid=${ids.cid}`, 'POST', audio, job);
            while (currentGeneration(job)) {
                const task = await localRequest(`/api/tasks/${job.id}`, 'GET', undefined, job);
                if (!currentGeneration(job)) return;
                if (task.bvid !== ids.bvid || task.cid !== String(ids.cid)) throw new Error('识别结果的视频信息不匹配');
                if (task.status === 'failed') throw new Error(task.error || '本机识别失败');
                if (task.status === 'cancelled') throw new Error('已取消');
                if (task.status === 'done') {
                    state.cues = parseBody({ result: task.cues }); state.activeIdx = -1;
                    state.how = '本机生成字幕';
                    if (!state.cues.length) { msg('未识别到有效语音，可以重试。'); return; }
                    state.noTracks = false;
                    els.lang.innerHTML = '<option>本机生成字幕</option>';
                    els.lang.hidden = false;
                    els.generate.hidden = true;
                    render();
                    return;
                }
                const stage = task.status === 'recognizing' ? '正在本机识别' : '正在准备音频';
                msg(`${stage}… 已用 ${Math.floor((Date.now() - started) / 1000)} 秒`);
                await new Promise(resolve => { const timer = setTimeout(resolve, 1000);
                    job.wake = () => { clearTimeout(timer); resolve(); }; });
            }
        } catch (e) {
            if (currentGeneration(job)) msg(`${escHtml(e.message)}<br>可以检查后重试。`);
            if (job.submitted) void localRequest(`/api/tasks/${job.id}`, 'DELETE').catch(() => {});
        } finally {
            if (generation === job) {
                generation = null; els.generate.disabled = false; els.cancel.hidden = true;
            }
        }
    }

    /* ======================================================================
     * 8. 取字幕 / 切换轨道
     * ==================================================================== */
    let loadSeq = 0;   // 同视频内轨道加载序号：快速切换轨道时只让最后一次完成的结果生效
    async function loadTrack(idx) {
        const t = state.tracks[idx];
        const revision = state.revision;
        const seq = ++loadSeq;
        if (!t) return;
        msg('<span class="spin"></span>正在获取字幕…');
        state.cues = []; state.activeIdx = -1;
        try {
            const { cues, how } = await fetchCues(t.subtitle_url);
            if (seq !== loadSeq || revision !== state.revision) return;
            state.cues = cues;
            state.how = how;
            render();
        } catch (e) {
            if (seq !== loadSeq || revision !== state.revision) return;
            LOG('轨道加载失败', e);
            msg(`取字幕失败：${e.message}`);
        }
    }

    let running = null;
    async function run() {
        const revision = state.revision;
        if (running === revision) return;
        if (!/\/video\/|\/list\/|\/bangumi\/play\//.test(location.pathname)) return;
        running = revision;
        try {
            let note = '';

            try {
                const ids = await getIds();
                if (revision !== state.revision) return;
                state.ids = ids;
                state.title = ids.title;
                const r = await listTracks(ids.aid, ids.cid);
                if (revision !== state.revision) return;
                state.tracks = r.tracks;

                if (!r.tracks.length) {
                    msg(r.needLogin
                        ? 'B 站要求<b>登录后</b>才能查询字幕。<br>请先登录 B 站再刷新。'
                        : 'B 站暂未返回可用字幕。<br>可点击“生成字幕”，在本机识别视频中的语音。');
                    state.noTracks = !r.needLogin;
                    els.generate.hidden = !state.noTracks;
                    return;
                }

                els.lang.innerHTML = r.tracks.map((t, i) =>
                    `<option value="${i}">${escHtml(t.lan_doc || t.lan)}${t.ai_type ? ' (AI)' : ''}</option>`).join('');
                els.lang.hidden = false;
                await loadTrack(0);
                return;
            } catch (e) {
                if (revision !== state.revision) return;
                LOG('API 通路失败，转嗅探兜底：', e.message);
                note = `接口取字幕失败：${e.message}`;
            }

            // API 通路整体失败：退化为纯嗅探
            let cues = takeIntercepted();
            if (!cues.length && await pokePlayerSubtitleMenu()) {
                const t0 = Date.now();
                while (!cues.length && Date.now() - t0 < 8000) {
                    await new Promise(r => setTimeout(r, 300));
                    cues = takeIntercepted();
                }
            }
            if (revision !== state.revision) return;
            if (cues.length) {
                state.cues = cues;
                state.how = '嗅探播放器请求';
                render();
            } else {
                msg(note || '没有取到字幕。<br>可以试试在播放器里手动开启一次字幕菜单。');
            }
        } catch (e) {
            if (revision !== state.revision) return;
            console.error(e);
            msg(`出错了：${e.message}`);
        } finally {
            if (running === revision) running = null;
        }
    }

    /* ======================================================================
     * 9. 挂载 / SPA 处理
     * ==================================================================== */
    // 'above' = 在 UP 主信息下方、弹幕列表整体上方插入一个独立区块（默认）。
    //           插入节点也可能影响侧栏的子节点选择器、尺寸测量或溢出裁剪。
    // 'dock'  = fixed 停靠在弹幕列表右边缘（覆盖其右侧一块）
    // 'float' = 右下角固定悬浮窗（挂在 body 下，不进入侧栏结构）
    //
    // ⚠️ 曾经有过 'inline' 模式（把 #danmukuBox 改成 flex、把弹幕列表压到 62%），
    //    已删除：.danmaku-wrap 是播放器的 auxiliary 挂载点，播放器会把弹幕列表挂进去
    //    并测量容器尺寸；挂载后再改它的宽度会让弹幕列表渲染错乱（实测已验证，
    //    禁用脚本后弹幕列表即恢复正常）。所以这里不再提供任何改动 B 站布局的选项。
    // 运行时可变：verifyLayout 兜底切到悬浮后同步更新（问题 8），
    // 否则收起/高度调整仍按 above 处理 fixed 面板，两套定位互相打架。
    let MODE = 'above';

    // 面板高度（px）：不再写死。默认 320，用户可在面板右上角下拉里调，
    // 选择写入 localStorage（键 biliSubtitlePanelHeight），下次打开自动恢复。
    // 上下限做夹取，防止手改存储把面板撑到不可用。
    // 下限 260 = .wrap 的 min-height，再低面板内容会溢出压到弹幕列表
    const PANEL_H_DEFAULT = 320, PANEL_H_MIN = 260, PANEL_H_MAX = 900;
    let panelH = PANEL_H_DEFAULT;
    try {
        const v = parseInt(localStorage.getItem('biliSubtitlePanelHeight'), 10);
        if (Number.isFinite(v)) panelH = Math.min(PANEL_H_MAX, Math.max(PANEL_H_MIN, v));
    } catch (_) { /* localStorage 不可用（隐私模式等）时用默认值 */ }
    function savePanelH(h) {
        panelH = Math.min(PANEL_H_MAX, Math.max(PANEL_H_MIN, h));
        try { localStorage.setItem('biliSubtitlePanelHeight', String(panelH)); } catch (_) {}
    }

    // 上方区块：把面板插到 #danmukuBox 前面，作为同一父容器下的独立块。
    // 只调用 insertBefore —— 不改 #danmukuBox / .danmaku-wrap 的任何样式，
    // 新增兄弟节点会占据页面高度，弹幕列表和推荐内容随之下移。
    let aboveCss = '';
    function aboveify() {
        if (!els) return;
        const box = document.getElementById('danmukuBox');
        if (!box || !box.parentElement) return;
        // 被 B 站重渲染挤掉时重新插回去（复用同一个节点，不重建，避免丢状态）
        if (els.host.nextElementSibling !== box || els.host.parentElement !== box.parentElement) {
            box.parentElement.insertBefore(els.host, box);
        }
        // 只在样式真的变化时才写，避免每帧触发样式重算
        const css =
            `display:block; position:relative; z-index:10; box-sizing:border-box;` +
            `height:${state.collapsed ? 'auto' : panelH + 'px'}; margin:0 0 10px 0;`;
        if (css !== aboveCss) { aboveCss = css; els.host.style.cssText = css; }
    }

    // 停靠模式：把面板 fixed 定位到弹幕列表右边缘，竖向上与它对齐。
    // 完全不改动 B 站 DOM —— 不碰 #danmukuBox 的 display，也不改 .danmaku-wrap 的宽度。
    let dockRaf = 0;
    function dockify() {
        if (!els) return;
        const box = document.getElementById('danmukuBox');
        if (!box) return;
        const r = box.getBoundingClientRect();
        const W = Math.min(420, Math.max(300, Math.round(r.width * 0.36)));
        const H = Math.max(240, Math.min(560, Math.round(r.height || 360)));
        els.host.style.cssText =
            `position:fixed; width:${W}px; height:${H}px; z-index:2147483600;` +
            `left:${Math.round(r.right - W - 4)}px; top:${Math.round(r.top)}px;` +
            `box-shadow:0 6px 24px rgba(0,0,0,.18); border-radius:8px;`;
        if (els.host.parentElement !== document.body) document.body.appendChild(els.host);
    }
    function scheduleDock() {
        // 只有 fixed 定位的 dock 模式需要跟随滚动；
        // above 模式在正常文档流里，靠 tick() 的 MutationObserver 处理重插即可
        if (MODE !== 'dock' || dockRaf) return;
        dockRaf = requestAnimationFrame(() => { dockRaf = 0; dockify(); });
    }

    // 悬浮模式：右下角固定窗
    function floatify() {
        if (!els) return;
        els.host.style.cssText = 'position:fixed; right:16px; bottom:16px; width:min(380px, calc(100vw - 32px)); ' +
            `height:${state.collapsed ? 'auto' : '52vh'}; ` +
            'z-index:2147483600; box-shadow:0 6px 24px rgba(0,0,0,.18); border-radius:8px;';
        if (els.host.parentElement !== document.body) document.body.appendChild(els.host);
    }

    // 布局自检：既看高度，也看**水平位置**。
    // 只查高度会漏掉"面板被挤出视口"的情况 —— 那种情况高度完全正常却看不见。
    let layoutChecked = false;
    function verifyLayout() {
        if (layoutChecked || !els) return;
        layoutChecked = true;
        requestAnimationFrame(() => {
            if (!els) return;
            const bd = els.bd, bdR = bd.getBoundingClientRect();
            const hR = els.host.getBoundingClientRect();
            const box = document.getElementById('danmukuBox');
            const boxR = box ? box.getBoundingClientRect() : null;
            const vis = bdR.bottom > 0 && bdR.top < innerHeight && bdR.right > 0 && bdR.left < innerWidth;
            LOG(`布局自检 mode=${MODE} 列表区 ${bd.clientHeight}px / ${state.cues.length} 条`);
            LOG(`  面板 rect: x=${Math.round(hR.left)} y=${Math.round(hR.top)} ` +
                `w=${Math.round(hR.width)} h=${Math.round(hR.height)}`);
            LOG(`  视口 ${innerWidth}x${innerHeight}` +
                (boxR ? ` / #danmukuBox x=${Math.round(boxR.left)} w=${Math.round(boxR.width)}` : ''));

            const tooSmall = bd.clientHeight < 80 || hR.height < 80;
            // 上方模式在正常文档流里，不需要检查视口越界（页面会把它推下去）
            const outOfView = MODE !== 'above' && (!vis ||
                hR.right < 0 || hR.left > innerWidth || hR.bottom < 0 || hR.top > innerHeight);

            if (tooSmall || outOfView) {
                LOG(`⚠️ 布局异常（高度不足=${tooSmall} 越出视口=${outOfView}），切到右下角悬浮`);
                MODE = 'float';   // 同步运行时模式，收起/高度调整此后也按悬浮处理
                floatify();
            }
        });
    }

    function pageMounted() {
        // document-end 只代表 HTML 就绪，B 站 Vue 仍可能在接管 SSR 节点。
        // 此时插入兄弟节点会打乱 hydration，导致顶部入口和懒加载图片未初始化。
        const header = W.document.getElementById('biliMainHeader');
        if (header?.__vue__?.$root?._isMounted === true) return true;
        // 番剧页没有 #biliMainHeader（问题 12，待实测验证）：
        // 退而求其次看 #app 是否已挂 Vue，避免在番剧页永远等不到挂载
        if (/^\/bangumi\//.test(location.pathname)) {
            const app = W.document.getElementById('app');
            return !!app?.__vue__;
        }
        return false;
    }

    function mount() {
        if (MODE === 'above' && !pageMounted()) {
            scheduleTick();
            return false;
        }
        const box = document.getElementById('danmukuBox');
        if (MODE !== 'float' && !box) return false;
        if (els && els.host.isConnected) return true;   // 已经在页面里了
        if (!els) buildPanel();                          // 只有首次才构建（保留状态与监听）
        // 三种模式都只操作我们自己的节点，不改动 B 站任何元素的样式
        if (MODE === 'above') aboveify();
        else if (MODE === 'dock') dockify();
        else floatify();
        return true;
    }

    let lastKey = '';
    function tick() {
        if (location.hostname !== 'www.bilibili.com') return;
        if (MODE !== 'float' && !document.getElementById('danmukuBox')) return;
        // 先确保挂载（面板被 B 站重渲染移除时会重新插回），再做换视频判断。
        // 注意不能"面板已存在就 return"—— 那样 SPA 切到下一个视频时永远不会去取新字幕。
        if (!mount()) return;

        const key = routeKey();
        if (key === lastKey) return;
        state.revision++;
        cancelGeneration();
        lastKey = key;
        state.cues = []; state.activeIdx = -1; state.query = ''; state.tracks = [];
        state.ids = null; state.noTracks = false; state.how = '';   // how 不清会残留上一视频的通路信息
        activeNode = null;           // 旧高亮节点已随 DOM 变化游离，显式清引用
        cancelAnimationFrame(seekRaf); seekRaf = 0; seekAnimating = false;  // 中断在途的跳转动画
        intercepted.length = 0;      // 丢弃上一集的嗅探缓存，防止兜底通路串台（问题 6）
        layoutChecked = false;       // 每个视频重新做一次布局自检（问题 11）
        loadSeq++;                   // 使在途的旧轨道加载结果失效（问题 7 配套）
        els.generate.hidden = true; els.cancel.hidden = true;
        if (els) { els.q.value = ''; els.lang.innerHTML = ''; els.lang.hidden = true;
            msg('<span class="spin"></span>正在获取字幕…'); }
        run();
    }

    // MutationObserver 触发非常频繁，做 300ms 防抖
    let tickTimer = null;
    const scheduleTick = () => {
        if (tickTimer) return;
        tickTimer = setTimeout(() => { tickTimer = null; tick(); }, 300);
    };

    new MutationObserver(scheduleTick)
        .observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('popstate', scheduleTick);
    window.addEventListener('pagehide', () => cancelGeneration());
    // 停靠模式靠 fixed 定位跟随弹幕列表，滚动/缩放时需要重算
    window.addEventListener('scroll', scheduleDock, { passive: true, capture: true });
    window.addEventListener('resize', scheduleDock, { passive: true });
    for (const m of ['pushState', 'replaceState']) {
        const orig = history[m];
        history[m] = function (...a) { const r = orig.apply(this, a); scheduleTick(); return r; };
    }

    LOG(hasGM ? '启动（GM_xmlhttpRequest 可用，字幕正文走免 CORS 通路）'
        : '启动（⚠️ GM_xmlhttpRequest 不可用，字幕正文只能依赖嗅探）');
    LOG(`面板模式：${MODE}（上方模式等待 B 站页面挂载完成后插入）`);
    // 文档级捕获监听一次装好，覆盖所有（含播放器重建的）video 元素
    bindFollow();
    tick();
})();
