/**
 * QRLib - 工具类
 * Cookie 处理 / Cookie 会话容器 / 哈希工具
 */

/**
 * Cookie 通用工具
 */
class CookieUtils {
    /**
     * 解析 Cookie 字符串为对象
     * @param {string} cookieStr
     */
    static parse(cookieStr) {
        if (!cookieStr) return {};
        return cookieStr.split(';').reduce((acc, curr) => {
            const idx = curr.indexOf('=');
            if (idx === -1) return acc;
            const key = curr.slice(0, idx).trim();
            const value = curr.slice(idx + 1).trim();
            if (key) acc[key] = value;
            return acc;
        }, {});
    }

    /**
     * 从 Cookie 字符串 / 数组 / 对象中取某个 key
     */
    static getValue(cookies, key) {
        if (!cookies) return null;
        if (Array.isArray(cookies)) cookies = cookies.join('; ');
        if (typeof cookies === 'object') return cookies[key] ?? null;
        const match = cookies.match(new RegExp(`(^|;\\s*)${key}=([^;]*)`));
        return match ? match[2] : null;
    }

    /**
     * 把 axios 返回的 set-cookie 统一成数组
     * Node 下 axios 已经帮我们按 cookie 切分好了，这里只做兜底
     */
    static toArray(setCookie) {
        if (!setCookie) return [];
        if (Array.isArray(setCookie)) return setCookie.filter(Boolean);
        if (typeof setCookie === 'string') return [setCookie];
        return [];
    }

    /**
     * 提取 QQ 登录后的 UIN（去掉前面的 o）
     */
    static getUin(cookies) {
        const uin =
            this.getValue(cookies, 'wxuin') ||
            this.getValue(cookies, 'ptui_loginuin') ||
            this.getValue(cookies, 'luin') ||
            this.getValue(cookies, 'uin');
        if (!uin) return null;
        // QQ 的 uin cookie 形如 o0123456789 / o123456789
        return String(uin).replace(/^o0*/, '').replace(/^o/, '');
    }
}

/**
 * 简易 Cookie 容器（带域名匹配）
 *
 * 扫码登录是跨域名的多步流程：
 *   ssl.ptlogin2.qq.com  ->  下发 qrsig
 *   ptlogin2.qq.com      ->  下发 uin / skey / p_skey
 *   graph.qq.com         ->  下发 code
 * 所以必须把每一步的 Set-Cookie 存下来，后面按域名带上。
 */
class CookieJar {
    constructor() {
        /** @type {Map<string, {name:string, value:string, domain:string}>} */
        this.store = new Map();
    }

    /**
     * 写入一组 Set-Cookie
     * @param {string[]|string} setCookie
     * @param {string} requestHost 发起请求的 host（没有 Domain 属性时作为 host-only cookie 的域名）
     */
    setCookies(setCookie, requestHost) {
        for (const raw of CookieUtils.toArray(setCookie)) {
            const parts = raw.split(';');
            const first = parts.shift() || '';
            const idx = first.indexOf('=');
            if (idx === -1) continue;
            const name = first.slice(0, idx).trim();
            const value = first.slice(idx + 1).trim();
            if (!name) continue;

            let domain = (requestHost || '').toLowerCase();
            for (const attr of parts) {
                const eq = attr.indexOf('=');
                if (eq === -1) continue;
                const attrName = attr.slice(0, eq).trim().toLowerCase();
                const attrValue = attr.slice(eq + 1).trim();
                if (attrName === 'domain' && attrValue) {
                    domain = attrValue.replace(/^\./, '').toLowerCase();
                }
            }
            this.store.set(`${domain}\u0000${name}`, { name, value, domain });
        }
        return this;
    }

    /**
     * 取某个 cookie 的值（不区分域名，取最匹配的）
     */
    get(name, host) {
        const candidates = [];
        for (const item of this.store.values()) {
            if (item.name !== name) continue;
            if (!host || this.match(item.domain, host)) candidates.push(item);
        }
        if (!candidates.length) return null;
        // 域名越精确优先级越高
        candidates.sort((a, b) => b.domain.length - a.domain.length);
        return candidates[0].value;
    }

    /**
     * 域名匹配规则：host 等于 domain，或者是其子域
     */
    match(domain, host) {
        if (!domain || !host) return false;
        const h = host.toLowerCase();
        const d = domain.toLowerCase().replace(/^\./, '');
        return h === d || h.endsWith(`.${d}`);
    }

    /**
     * 生成可发送的 Cookie 请求头
     * @param {string} host 目标 host
     */
    headerFor(host) {
        const picked = new Map();
        const items = [...this.store.values()]
            .filter((item) => this.match(item.domain, host))
            // 域名越长越精确，优先使用
            .sort((a, b) => b.domain.length - a.domain.length);

        for (const item of items) {
            if (!picked.has(item.name)) picked.set(item.name, item.value);
        }
        return [...picked.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    }

    /**
     * 生成「全部 cookie」请求头（不做域名过滤）
     * graph.qq.com/oauth2.0/authorize 需要 ptlogin2 域下发的 uin/skey/p_skey，
     * 因此这一步必须把所有已收集的 cookie 一起带上。
     */
    allHeader() {
        const picked = new Map();
        for (const item of this.store.values()) {
            if (!picked.has(item.name)) picked.set(item.name, item.value);
        }
        return [...picked.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    }

    /**
     * 导出为普通对象（用于返回给前端 / 调试）
     */
    toObject() {
        const out = {};
        for (const item of this.store.values()) out[item.name] = item.value;
        return out;
    }

    has(name) {
        for (const item of this.store.values()) {
            if (item.name === name) return true;
        }
        return false;
    }
}

/**
 * QQ 登录相关哈希工具
 */
class HashUtils {
    /**
     * ptqrtoken 计算（用于 ptqrlogin 轮询）
     */
    static hash(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash += (hash << 5) + str.charCodeAt(i);
        }
        return 2147483647 & hash;
    }

    /**
     * g_tk 计算（用于 graph.qq.com/oauth2.0/authorize）
     * 等价于 Java 的 sigHash(input, 5381)
     */
    static getGTk(pskey) {
        let gtk = 5381;
        for (let i = 0; i < pskey.length; i++) {
            gtk += (gtk << 5) + pskey.charCodeAt(i);
        }
        return gtk & 0x7fffffff;
    }
}

/**
 * 生成随机 UUID（授权请求的 ui 参数）
 */
function randomUUID() {
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
    } catch (e) {
        /* ignore */
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

module.exports = { CookieUtils, CookieJar, HashUtils, randomUUID };
