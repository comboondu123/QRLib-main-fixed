/**
 * QRLib - 核心登录逻辑
 *
 * 两条链路：
 *  1) QRLoginSession          —— PC 网页扫码登录（ptlogin2 / ptqrshow + ptqrlogin）
 *  2) MiniProgramLoginSession —— QQ 小程序开发者工具 / 小程序扫码登录
 *
 * ⭐ 关键修复（v1.1.0）：
 *  扫码成功后拿不到 code，是因为只从 ptqrlogin 返回的 jumpUrl 里找 code。
 *  真实链路是「换票据」的，必须继续往下走：
 *
 *     ptqrshow          -> qrsig
 *     ptqrlogin         -> ret=0 + jumpUrl(内含 uin / ptsigx)
 *     check_sig         -> 下发 uin / skey / p_skey
 *     oauth2.0/authorize-> 302 Location 里才带 code
 *
 *  另外扫码是跨域名多步流程，必须把每一步的 Set-Cookie 保存下来
 *  （原来的实现每次请求只带 qrsig，票据自然换不出来）。
 */

const axios = require('axios');
const { CookieJar, HashUtils, randomUUID } = require('./utils');

// 移动端/桌面端通用 UA
const ChromeUA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const XUI_ROOT = 'https://xui.ptlogin2.qq.com/';
const OAUTH_LOGIN_JUMP = 'https://graph.qq.com/oauth2.0/login_jump';
const PTLOGIN_HOST = 'ssl.ptlogin2.qq.com';
// 第三方（pt_3rd_aid）的 check_sig 走 graph 子域，部分应用仍在主域，做兜底
const CHECK_SIG_HOSTS = ['ssl.ptlogin2.graph.qq.com', 'ssl.ptlogin2.qq.com'];

const REQUEST_TIMEOUT = Number(process.env.REQUEST_TIMEOUT || 15000);
// 会话（qrsig -> cookie 容器）保留时长，二维码本身 2 分钟有效，留足余量
const SESSION_TTL = 10 * 60 * 1000;

/** 取 URL 的 host */
function hostOf(url) {
    try {
        return new URL(url).host;
    } catch (e) {
        return PTLOGIN_HOST;
    }
}

/**
 * 从 URL / 文本里提取 OAuth code
 *
 * 注意：只在「明确是回调地址」的场景下使用，并且强制长度/字符集校验，
 * 否则很容易把页面里的业务字段（例如 qq.com 首页的 city code）误判成 OAuth code。
 */
const CODE_PATTERN = /^[0-9A-Za-z._-]{16,200}$/;

function extractCode(text) {
    if (!text) return '';
    const str = String(text);
    const candidates = [];
    // 1) 查询串里的 code
    const q = /[?&]code=([^&#"'\s]+)/.exec(str);
    if (q) candidates.push(q[1]);
    // 2) hash 里的 code（部分回调把 code 放在 # 后面）
    const h = /#.*[?&]?code=([^&#"'\s]+)/.exec(str);
    if (h) candidates.push(h[1]);

    for (const raw of candidates) {
        let value = raw;
        try {
            value = decodeURIComponent(raw);
        } catch (e) {
            /* 保留原值 */
        }
        if (CODE_PATTERN.test(value)) return value;
    }
    return '';
}

/** 只记录步骤结果，不记录凭证，方便前端排查为什么 code 是空的 */
function pushStep(steps, step, extra) {
    steps.push(Object.assign({ step, at: new Date().toISOString() }, extra));
}

class QRLoginSession {
    /**
     * 各登录目标的预设参数
     */
    static Presets = {
        vip: {
            name: 'QQ会员 (VIP)',
            description: 'QQ会员官网',
            aid: '8000201',
            daid: '18',
            redirectUri: 'https://vip.qq.com/loginsuccess.html',
            referrer:
                'https://xui.ptlogin2.qq.com/cgi-bin/xlogin?appid=8000201&style=20&s_url=https%3A%2F%2Fvip.qq.com%2Floginsuccess.html&maskOpacity=60&daid=18&target=self',
        },
        qzone: {
            name: 'QQ空间 (QZone)',
            description: 'QQ空间网页版',
            aid: '549000912',
            daid: '5',
            redirectUri: 'https://qzs.qzone.qq.com/qzone/v5/loginsucc.html?para=izone',
            referrer: 'https://qzone.qq.com/',
        },
        music: {
            name: 'QQ音乐 (Music)',
            description: 'QQ音乐网页版 · OAuth code',
            aid: '716027609',
            daid: '383',
            redirectUri: 'https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https%3A%2F%2Fy.qq.com%2F',
            // 换 code 时使用的 redirect_uri（需与 client_id 注册值一致，用未编码的原始串）
            oauthRedirectUri: 'https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https://y.qq.com',
            ptThirdAid: '100497308',
            responseType: 'code',
            openapi: '1010_1030',
        },
        wegame: {
            name: 'WeGame',
            description: 'WeGame 平台',
            aid: '1600001063',
            daid: '733',
            redirectUri: 'https://www.wegame.com.cn/middle/login/third_callback.html',
            referrer: 'https://www.wegame.com.cn/',
        },
        val: {
            name: '瓦罗兰特 (VAL)',
            description: '无畏契约官网 · OAuth code',
            aid: '716027609',
            daid: '383',
            redirectUri:
                'https://val.qq.com/comm-htdocs/login/qc_redirect.html?parent_domain=https%3A%2F%2Fval.qq.com&isMiloSDK=1&isPc=1',
            oauthRedirectUri:
                'https://val.qq.com/comm-htdocs/login/qc_redirect.html?parent_domain=https://val.qq.com&isMiloSDK=1&isPc=1',
            ptThirdAid: '102059301',
            responseType: 'code',
            openapi: '1010_1030',
        },
    };

    /**
     * 会话存储：qrsig -> { jar, presetKey, createdAt }
     * 单实例内存存储即可满足需求；如需多实例部署请换成 Redis。
     */
    static sessions = new Map();

    static _pruneTimer = null;

    static _ensurePrune() {
        if (this._pruneTimer) return;
        this._pruneTimer = setInterval(() => {
            const now = Date.now();
            for (const [key, value] of this.sessions) {
                if (now - value.createdAt > SESSION_TTL) this.sessions.delete(key);
            }
        }, 60 * 1000);
        // 不阻塞进程退出
        if (typeof this._pruneTimer.unref === 'function') this._pruneTimer.unref();
    }

    static getSession(qrsig) {
        this._ensurePrune();
        return this.sessions.get(qrsig) || null;
    }

    static saveSession(qrsig, jar, presetKey) {
        this._ensurePrune();
        this.sessions.set(qrsig, { jar, presetKey, createdAt: Date.now() });
    }

    static getPreset(presetKey) {
        return this.Presets[presetKey] || this.Presets.vip;
    }

    static getU1(config) {
        return config.ptThirdAid ? OAUTH_LOGIN_JUMP : config.redirectUri;
    }

    static getReferer(config) {
        return (
            config.referrer ||
            `https://xui.ptlogin2.qq.com/cgi-bin/xlogin?appid=${config.aid}&style=20&s_url=${encodeURIComponent(
                config.redirectUri
            )}&maskOpacity=60&daid=${config.daid}&target=self`
        );
    }

    /**
     * 预置 xlogin，拿到 pt_login_sig（贴近真实浏览器行为，提高换票据成功率）
     * 失败不影响主流程
     */
    static async _prelogin(jar, config) {
        try {
            const url =
                `https://xui.ptlogin2.qq.com/cgi-bin/xlogin?appid=${config.aid}` +
                `&style=20&s_url=${encodeURIComponent(this.getU1(config))}` +
                `&maskOpacity=60&daid=${config.daid}&target=self&pt_3rd_aid=${config.ptThirdAid || ''}`;
            const res = await axios.get(url, {
                timeout: REQUEST_TIMEOUT,
                headers: { Referer: XUI_ROOT, 'User-Agent': ChromeUA },
            });
            jar.setCookies(res.headers['set-cookie'], 'xui.ptlogin2.qq.com');
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * 申请二维码
     * @param {string} presetKey
     */
    static async requestQRCode(presetKey) {
        const key = this.Presets[presetKey] ? presetKey : 'vip';
        const config = this.getPreset(key);

        const jar = new CookieJar();
        await this._prelogin(jar, config);

        const params = new URLSearchParams({
            appid: config.aid,
            e: '2',
            l: 'M',
            s: '3',
            d: '72',
            v: '4',
            t: String(Math.random()),
            daid: config.daid,
        });
        if (config.ptThirdAid) params.set('pt_3rd_aid', config.ptThirdAid);
        params.set('u1', this.getU1(config));

        const url = `https://${PTLOGIN_HOST}/ptqrshow?${params.toString()}`;

        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: REQUEST_TIMEOUT,
            headers: {
                Referer: this.getReferer(config),
                'User-Agent': ChromeUA,
                Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
                // 带上 xlogin 下发的 pt_login_sig / pt_clientip，尽量贴近真实浏览器
                Cookie: jar.headerFor(PTLOGIN_HOST),
            },
        });

        jar.setCookies(response.headers['set-cookie'], PTLOGIN_HOST);

        const qrsig = jar.get('qrsig', PTLOGIN_HOST);
        if (!qrsig) {
            throw new Error('二维码申请失败：未拿到 qrsig，通常是服务器出口 IP 被风控，请更换部署 IP 后重试');
        }

        this.saveSession(qrsig, jar, key);

        return {
            qrsig,
            qrcode: `data:image/png;base64,${Buffer.from(response.data).toString('base64')}`,
            url,
            redirectUri: config.redirectUri,
            oauthMode: Boolean(config.ptThirdAid),
            expiresIn: 120,
        };
    }

    /**
     * 轮询扫码状态
     * @param {string} qrsig
     * @param {string} presetKey
     */
    static async checkStatus(qrsig, presetKey) {
        const config = this.getPreset(presetKey);
        const session = this.getSession(qrsig);
        const jar = session ? session.jar : new CookieJar();
        if (!session) jar.setCookies([`qrsig=${qrsig}; Path=/`], PTLOGIN_HOST);

        const params = new URLSearchParams({
            ptqrtoken: String(HashUtils.hash(qrsig)),
            ptredirect: '0',
            h: '1',
            t: '1',
            g: '1',
            from_ui: '1',
            ptlang: '2052',
            action: `0-0-${Date.now()}`,
            js_ver: '20102616',
            js_type: '1',
            pt_uistyle: '40',
            aid: config.aid,
            daid: config.daid,
            has_onekey: '1',
        });
        if (config.ptThirdAid) params.set('pt_3rd_aid', config.ptThirdAid);
        params.set('u1', this.getU1(config));

        const api = `https://${PTLOGIN_HOST}/ptqrlogin?${params.toString()}`;
        let response;
        try {
            response = await axios.get(api, {
                timeout: REQUEST_TIMEOUT,
                headers: {
                    Cookie: jar.headerFor(PTLOGIN_HOST) || `qrsig=${qrsig}`,
                    Referer: XUI_ROOT,
                    'User-Agent': ChromeUA,
                },
            });
        } catch (error) {
            // QQ 直接返回 4xx/5xx，通常代表 qrsig 非法或已失效，按「失效」处理而不是抛错
            if (error.response) {
                return {
                    ret: '65',
                    msg: error.response.status === 403 ? '二维码已失效，请刷新后重试' : `状态查询失败(${error.response.status})`,
                    nickname: '',
                    jumpUrl: '',
                    jar,
                    config,
                };
            }
            throw new Error(`状态查询失败：${error.message}`);
        }

        // 把本轮下发的 cookie 存起来（成功时会下发 uin / skey / p_skey）
        jar.setCookies(response.headers['set-cookie'], PTLOGIN_HOST);
        if (session) session.jar = jar;

        const text = typeof response.data === 'string' ? response.data : String(response.data || '');
        const match = text.match(/ptuiCB\(([\s\S]*)\)/);
        if (!match) {
            throw new Error('状态查询失败：返回格式异常');
        }

        const args = [];
        const argMatcher = /'([^']*)'/g;
        let argMatch;
        while ((argMatch = argMatcher.exec(match[1])) !== null) {
            args.push(argMatch[1]);
        }

        const [ret = '', , jumpUrl = '', , msg = '', nickname = ''] = args;

        return {
            ret,
            msg,
            nickname,
            jumpUrl,
            jar,
            config,
        };
    }

    /**
     * 手动跟随跳转链，沿途收集 cookie，并尝试从 Location 中拿到 code
     */
    static async _followChain(jar, startUrl, config, steps) {
        let currentUrl = String(startUrl || '').replace(/&amp;/g, '&');
        if (!currentUrl) return { code: '', finalUrl: '', chain: [] };

        const chain = [];
        const visited = new Set([currentUrl]);

        for (let hop = 0; hop < 8; hop++) {
            const host = hostOf(currentUrl);
            let res;
            try {
                res = await axios.get(currentUrl, {
                    maxRedirects: 0,
                    validateStatus: (s) => s >= 200 && s < 400,
                    timeout: REQUEST_TIMEOUT,
                    headers: {
                        Cookie: jar.headerFor(host),
                        Referer: hop === 0 ? XUI_ROOT : `https://${host}/`,
                        'User-Agent': ChromeUA,
                    },
                });
            } catch (error) {
                pushStep(steps, 'follow_redirect', { ok: false, host, detail: error.message });
                break;
            }

            jar.setCookies(res.headers['set-cookie'], host);
            const location = res.headers.location ? new URL(res.headers.location, currentUrl).toString() : '';
            chain.push({ url: currentUrl, status: res.status, location: location || null });
            pushStep(steps, 'follow_redirect', { ok: true, host, status: res.status, next: location || null });

            const code = extractCode(location);
            if (code) return { code, finalUrl: location, chain };

            // 仅当落在 OAuth 授权域时，才尝试从响应体里找 code（避免误匹配普通页面）
            if (!location && typeof res.data === 'string' && /(^|\.)graph\.qq\.com$/i.test(host)) {
                const bodyCode = extractCode(res.data);
                if (bodyCode) return { code: bodyCode, finalUrl: currentUrl, chain };
            }

            if (!location || visited.has(location)) break;
            visited.add(location);
            currentUrl = location;
        }

        return { code: '', finalUrl: currentUrl, chain };
    }

    /**
     * 第三方（pt_3rd_aid）OAuth 换 code：
     *   check_sig 拿 p_skey -> g_tk -> POST oauth2.0/authorize -> Location.code
     */
    static async _exchangeOAuthCode(jar, config, parsed, steps) {
        const clientId = config.ptThirdAid;
        const redirectUri = config.oauthRedirectUri || config.redirectUri;
        const uin = parsed.uin || '';

        let pSkey = '';
        for (const host of CHECK_SIG_HOSTS) {
            const params = new URLSearchParams({
                uin,
                pttype: '1',
                service: 'ptqrlogin',
                nodirect: '0',
                ptsigx: parsed.ptsigx || '',
                s_url: OAUTH_LOGIN_JUMP,
                ptlang: '2052',
                ptredirect: '100',
                aid: config.aid,
                daid: config.daid,
                j_later: '0',
                low_login_hour: '0',
                regmaster: '0',
                pt_login_type: '3',
                pt_aid: '0',
                pt_aaid: '16',
                pt_light: '0',
                pt_3rd_aid: clientId,
            });
            const url = `https://${host}/check_sig?${params.toString()}`;

            try {
                const res = await axios.get(url, {
                    maxRedirects: 0,
                    validateStatus: (s) => s >= 200 && s < 400,
                    timeout: REQUEST_TIMEOUT,
                    headers: { Referer: XUI_ROOT, 'User-Agent': ChromeUA, Cookie: jar.headerFor(host) },
                });
                jar.setCookies(res.headers['set-cookie'], host);
                pSkey = jar.get('p_skey', host) || jar.get('p_skey') || '';
                pushStep(steps, 'check_sig', { ok: Boolean(pSkey), host, status: res.status });
                if (pSkey) break;
            } catch (error) {
                pushStep(steps, 'check_sig', { ok: false, host, detail: error.message });
            }
        }

        if (!pSkey) {
            return { code: '', reason: 'check_sig 未下发 p_skey（登录票据换取失败）' };
        }

        const gtk = HashUtils.getGTk(pSkey);
        const body = new URLSearchParams({
            response_type: 'code',
            client_id: clientId,
            redirect_uri: redirectUri,
            state: 'state',
            switch: '',
            from_ptlogin: '1',
            src: '1',
            update_auth: '1',
            openapi: config.openapi || '1010_1030',
            g_tk: String(gtk),
            auth_time: String(Date.now()),
            ui: randomUUID(),
        });

        try {
            const res = await axios.post('https://graph.qq.com/oauth2.0/authorize', body.toString(), {
                maxRedirects: 0,
                validateStatus: (s) => s >= 200 && s < 400,
                timeout: REQUEST_TIMEOUT,
                headers: {
                    // 授权接口需要 ptlogin2 域下发的 uin / skey / p_skey，所以带上全部 cookie
                    Cookie: jar.allHeader(),
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Referer:
                        'https://graph.qq.com/oauth2.0/show?which=Login&display=pc' +
                        `&response_type=code&client_id=${clientId}` +
                        `&redirect_uri=${encodeURIComponent(redirectUri)}&state=state&display=pc`,
                    'User-Agent': ChromeUA,
                },
            });

            jar.setCookies(res.headers['set-cookie'], 'graph.qq.com');
            const location = res.headers.location || '';
            const code = extractCode(location) || extractCode(res.data);
            const preview = typeof res.data === 'string' ? res.data.slice(0, 200) : '';
            pushStep(steps, 'oauth_authorize', {
                ok: Boolean(code),
                status: res.status,
                location: location || null,
                preview: code ? undefined : preview,
            });

            return { code, location, reason: code ? '' : 'authorize 未返回 code（通常是 client_id / redirect_uri 不匹配）' };
        } catch (error) {
            pushStep(steps, 'oauth_authorize', { ok: false, detail: error.message });
            return { code: '', reason: `authorize 请求失败：${error.message}` };
        }
    }

    /**
     * 扫码成功后的完整「换凭证」流程
     * @returns {{code:string, uin:string, skey:string, pSkey:string, cookie:string, nickname:string, reason:string, steps:Array}}
     */
    static async completeLogin(qrsig, presetKey, status) {
        const config = status.config || this.getPreset(presetKey);
        const jar = status.jar || new CookieJar();
        const steps = [];
        const jumpUrl = String(status.jumpUrl || '').replace(/&amp;/g, '&');

        // 从 jumpUrl 中解析 uin / ptsigx
        const parsed = { uin: '', ptsigx: '' };
        try {
            const u = new URL(jumpUrl);
            parsed.uin = u.searchParams.get('uin') || '';
            parsed.ptsigx = u.searchParams.get('ptsigx') || '';
        } catch (e) {
            /* 交给下面的兜底正则 */
        }
        if (!parsed.uin) {
            const m = /[?&]uin=([^&]+)/.exec(jumpUrl);
            if (m) parsed.uin = decodeURIComponent(m[1]);
        }
        if (!parsed.ptsigx) {
            const m = /[?&]ptsigx=([^&]+)/.exec(jumpUrl);
            if (m) parsed.ptsigx = decodeURIComponent(m[1]);
        }
        pushStep(steps, 'parse_jump', { ok: Boolean(jumpUrl), hasUin: Boolean(parsed.uin), hasPtsigx: Boolean(parsed.ptsigx) });

        let code = '';
        let reason = '';

        if (config.ptThirdAid) {
            // 第三方 OAuth（QQ音乐 / 无畏契约）：ptsigx 是一次性票据，
            // 必须一次性走完 check_sig -> oauth2.0/authorize 才能换到 code。
            const oauth = await this._exchangeOAuthCode(jar, config, parsed, steps);
            code = oauth.code || '';
            reason = oauth.reason || '';

            // 兜底：跟随跳转链再试一次（部分应用会直接在 Location 里回带 code）
            if (!code) {
                const followed = await this._followChain(jar, jumpUrl, config, steps);
                code = followed.code || '';
                if (code) reason = '';
            }
        } else {
            // 非 OAuth 预设不会签发 code，跟随跳转链主要是为了把 uin / skey / p_skey 收全
            const followed = await this._followChain(jar, jumpUrl, config, steps);
            code = followed.code || '';
            if (!code) reason = '该登录目标不提供 OAuth code，已返回 Cookie 凭证（uin / skey / p_skey）';
        }

        const jarObj = jar.toObject();
        const uin = parsed.uin ? String(parsed.uin).replace(/^o0*/, '').replace(/^o/, '') : '';
        const skey = jarObj.skey || '';
        const pSkey = jarObj.p_skey || '';
        // 优先使用服务端下发的原始 uin cookie 格式（形如 o0123456789）
        const uinCookie = jarObj.uin ? `uin=${jarObj.uin}` : uin ? `uin=o${uin}` : '';
        const cookieString = [uinCookie, skey ? `skey=${skey}` : '', pSkey ? `p_skey=${pSkey}` : '']
            .filter(Boolean)
            .join('; ');

        return {
            code,
            uin,
            nickname: status.nickname || '',
            skey,
            pSkey,
            cookie: cookieString,
            jumpUrl,
            reason,
            steps,
        };
    }
}

class MiniProgramLoginSession {
    static QUA = 'V1_HT5_QDT_0.70.2209190_x64_0_DEV_D';

    static Presets = {
        miniprogram: {
            name: '小程序开发 (DevTools)',
            description: 'QQ小程序开发者工具',
            appid: '', // 由调用方传入
        },
        farm: {
            name: 'QQ经典农场 (Farm)',
            description: 'QQ经典农场小程序',
            appid: '1112386029',
        },
    };

    static REQUEST_TIMEOUT = Number(process.env.REQUEST_TIMEOUT || 15000);

    static getHeaders() {
        return {
            qua: MiniProgramLoginSession.QUA,
            host: 'q.qq.com',
            accept: 'application/json',
            'content-type': 'application/json',
            'user-agent': ChromeUA,
        };
    }

    /**
     * 获取登录码（二维码内容）
     */
    static async requestLoginCode() {
        const response = await axios.get('https://q.qq.com/ide/devtoolAuth/GetLoginCode', {
            headers: this.getHeaders(),
            timeout: this.REQUEST_TIMEOUT,
        });

        const { code, data } = response.data || {};

        if (Number(code) !== 0 || !data || !data.code) {
            throw new Error(`获取登录码失败（code=${code}）`);
        }

        return {
            code: data.code,
            url: `https://h5.qzone.qq.com/qqq/code/${data.code}?_proxy=1&from=ide`,
        };
    }

    /**
     * 查询扫码状态
     * @param {string} code
     */
    static async queryStatus(code) {
        let response;
        try {
            response = await axios.get(
                `https://q.qq.com/ide/devtoolAuth/syncScanSateGetTicket?code=${encodeURIComponent(code)}`,
                { headers: this.getHeaders(), timeout: this.REQUEST_TIMEOUT }
            );
        } catch (error) {
            if (error.response && error.response.status !== 200) return { status: 'Error' };
            throw error;
        }

        if (response.status !== 200) return { status: 'Error' };

        const { code: resCode, data } = response.data || {};

        if (Number(resCode) === 0) {
            if (Number(data && data.ok) !== 1) return { status: 'Wait' };
            return { status: 'OK', ticket: data.ticket, uin: data.uin };
        }

        if (Number(resCode) === -10003) return { status: 'Used' };

        return { status: 'Error', msg: `Code: ${resCode}` };
    }

    /**
     * 用 ticket 换最终登录 code
     */
    static async getAuthCode(ticket, appid) {
        try {
            const response = await axios.post(
                'https://q.qq.com/ide/login',
                { appid, ticket },
                { headers: this.getHeaders(), timeout: this.REQUEST_TIMEOUT }
            );

            if (response.status !== 200) return '';
            return (response.data && response.data.code) || '';
        } catch (error) {
            return '';
        }
    }
}

module.exports = { QRLoginSession, MiniProgramLoginSession };
