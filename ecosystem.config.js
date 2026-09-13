/**
 * PM2 部署配置（服务器常驻）
 *
 *   npm install -g pm2
 *   pm2 start ecosystem.config.js
 *   pm2 save && pm2 startup
 */
module.exports = {
    apps: [
        {
            name: 'qrlib',
            script: 'src/server.js',
            cwd: __dirname,
            instances: 1,
            // 会话（qrsig -> cookie 容器）保存在进程内存中，请勿开启 cluster 多实例
            exec_mode: 'fork',
            autorestart: true,
            max_memory_restart: '300M',
            env: {
                NODE_ENV: 'production',
                PORT: 3000,
                HOST: '0.0.0.0',
                WEBUI_ENABLED: 'true',
                REQUEST_TIMEOUT: '15000',
            },
        },
    ],
};
