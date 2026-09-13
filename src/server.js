/**
 * QRLib - 后端入口与路由
 *
 * 环境变量：
 *   PORT           监听端口（默认 3000）
 *   HOST           监听地址（默认 0.0.0.0，便于容器部署）
 *   WEBUI_ENABLED  是否提供网页界面（false 时纯 API 模式）
 *   REQUEST_TIMEOUT 单个上游请求超时毫秒数（默认 15000）
 */

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const { QRLoginSession, MiniProgramLoginSession } = require('./session');

const app = express();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';

app.disable('x-powered-by');
app.use(cors());
app.use(bodyParser.json());

// Configuration: WebUI Switch (Default: true)
const webUiEnabled = process.env.WEBUI_ENABLED !== 'false';

if (webUiEnabled) {
    // 用绝对路径，避免 pm2 / systemd 从其它工作目录启动时找不到静态资源
    app.use(express.static(path.join(__dirname, '..', 'public')));
} else {
    app.get('/', (req, res) => {
        res.json({
            success: true,
            message: 'QRLib API Server is running in Pure API Mode.',
            documentation: 'See API.md for usage.',
        });
    });
}

// 0. 健康检查（容器 / 探针用）
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        status: 'ok',
        version: require('../package.json').version,
        uptime: Math.round(process.uptime()),
        webUiEnabled,
        sessions: QRLoginSession.sessions.size,
    });
});

// 1. 获取预设列表
app.get('/api/presets', (req, res) => {
    const qrPresets = Object.keys(QRLoginSession.Presets).map((key) => {
        const config = QRLoginSession.Presets[key];
        return {
            key,
            type: 'qr',
            name: config.name,
            description: config.description,
            // 该预设是否支持换取 OAuth code
            supportsCode: Boolean(config.ptThirdAid),
        };
    });

    const mpPresets = Object.keys(MiniProgramLoginSession.Presets).map((key) => {
        const config = MiniProgramLoginSession.Presets[key];
        return {
            key,
            type: 'mp',
            name: config.name,
            description: config.description,
            supportsCode: true,
            // Hide AppID for Farm (Security/User Request)
            defaultAppId: key === 'farm' ? undefined : config.appid,
        };
    });

    res.json([...qrPresets, ...mpPresets]);
});

// 2. 创建二维码
app.post('/api/qr/create', async (req, res) => {
    const { preset = 'vip' } = req.body || {};
    try {
        if (MiniProgramLoginSession.Presets[preset]) {
            const result = await MiniProgramLoginSession.requestLoginCode();
            res.json({
                success: true,
                qrsig: result.code,
                qrcode: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(
                    result.url
                )}`,
                url: result.url,
                isMiniProgram: true,
            });
        } else {
            const result = await QRLoginSession.requestQRCode(preset);
            res.json({ success: true, ...result, isMiniProgram: false });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 3. 查询扫码状态 / 换取凭证
app.post('/api/qr/check', async (req, res) => {
    const { qrsig, preset = 'vip', appid: customAppId } = req.body || {};
    if (!qrsig) {
        return res.status(400).json({ success: false, message: 'Missing qrsig/code' });
    }

    // 安全校验：只允许可见 ASCII 且长度合理（qrsig 可能包含 * + / = 等字符，不能收得太窄）
    if (!/^[\x21-\x7e]{6,256}$/.test(qrsig)) {
        return res.status(400).json({ success: false, message: 'Invalid qrsig/code format' });
    }

    try {
        const mpConfig = MiniProgramLoginSession.Presets[preset];

        // ---------- 小程序模式 ----------
        if (mpConfig) {
            const result = await MiniProgramLoginSession.queryStatus(qrsig);

            let ret = '66';
            let msg = '等待扫码...';
            let code = '';
            let uin = '';
            let avatar = '';
            let ticket = '';

            if (result.status === 'Wait') {
                ret = '66';
                msg = '等待扫码...';
            } else if (result.status === 'Used') {
                ret = '65';
                msg = '二维码已失效';
            } else if (result.status === 'OK') {
                ret = '0';
                msg = '登录成功';
                ticket = result.ticket;
                uin = result.uin || '';
                if (uin) avatar = `https://q1.qlogo.cn/g?b=qq&nk=${uin}&s=640`;

                const appid = customAppId || mpConfig.appid || '1108291530';
                code = await MiniProgramLoginSession.getAuthCode(ticket, appid);
                if (!code) msg = '登录成功，但换取 code 失败（请检查 AppID 是否有效）';
            } else {
                ret = '65';
                msg = result.msg || '状态查询错误';
            }

            return res.json({ success: true, ret, msg, code, uin, ticket, avatar });
        }

        // ---------- 网页扫码模式 ----------
        const status = await QRLoginSession.checkStatus(qrsig, preset);

        const RET_MAP = {
            '0': { ret: '0', msg: '登录成功' },
            '65': { ret: '65', msg: '二维码已失效' },
            '66': { ret: '66', msg: '等待扫码...' },
            '67': { ret: '67', msg: '已扫码，请在手机上确认' },
        };
        const mapped = RET_MAP[status.ret] || { ret: status.ret || '65', msg: status.msg || '未知状态' };

        const payload = {
            success: true,
            ret: mapped.ret,
            msg: mapped.msg,
            nickname: status.nickname || '',
            code: '',
            uin: '',
            ticket: '',
            avatar: '',
            cookie: '',
            skey: '',
            p_skey: '',
            steps: [],
        };

        if (mapped.ret === '0') {
            // ⭐ 核心：扫码成功后必须继续「换票据」，code 才会出来
            const done = await QRLoginSession.completeLogin(qrsig, preset, status);

            payload.code = done.code;
            payload.uin = done.uin;
            payload.ticket = done.skey || '';
            payload.skey = done.skey;
            payload.p_skey = done.pSkey;
            payload.cookie = done.cookie;
            payload.steps = done.steps;
            if (done.nickname) payload.nickname = done.nickname;
            if (done.uin) payload.avatar = `https://q1.qlogo.cn/g?b=qq&nk=${done.uin}&s=640`;

            if (!done.code) {
                payload.msg = done.reason || '登录成功，但未取到 code';
            }
        }

        // 兼容旧字段：把票据平铺到顶层
        res.json({ ...payload, jumpUrl: undefined });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 4. 手动清理会话（可选）
app.post('/api/session/reset', (req, res) => {
    const { qrsig } = req.body || {};
    if (qrsig) QRLoginSession.sessions.delete(qrsig);
    res.json({ success: true, sessions: QRLoginSession.sessions.size });
});

app.use((req, res) => {
    res.status(404).json({ success: false, message: 'Not Found' });
});

const server = app.listen(port, host, () => {
    console.log(`[QRLib] Server running at http://${host}:${port}`);
    console.log(`[QRLib] WebUI ${webUiEnabled ? 'enabled' : 'disabled (Pure API Mode)'}`);
});

// 上游请求较慢时给足时间，异常时优雅退出
server.setTimeout(60000);

process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
    server.close(() => process.exit(0));
});

module.exports = app;
