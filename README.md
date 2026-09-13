# QRLib

- 本工具仅供学习和开发测试使用，请勿用于非法用途。

QQ 扫码登录 Web 服务：用手机 QQ 扫码后，自动完成「换票据」流程，返回 **Authorization Code / UIN / skey / p_skey** 等登录凭证。

---

## 🆕 v1.1.0 更新说明（修复「扫码后拿不到 code」）

**问题现象**：部署后二维码能正常显示、手机也能扫码成功，但接口返回的 `code` 永远是空字符串。

**根因**：QQ 扫码登录不是「扫完就把 code 吐给你」，而是 **OAuth 2.0 授权码模式的多步换票据流程**。
旧实现只在扫码成功返回的 `jumpUrl` 里找 `code`，而真实链路是：

```text
① ptqrshow              申请二维码          -> 下发 qrsig
② ptqrlogin             轮询扫码状态        -> ret=0，返回 jumpUrl（内含 uin / ptsigx）
③ check_sig             用一次性票据换票据  -> 下发 uin / skey / p_skey
④ oauth2.0/authorize    用 p_skey 计算 g_tk -> 302 的 Location 里才带 code ⭐
```

旧实现走完 ② 就结束了，所以 `code` 必然为空。本次修复：

| # | 修复内容 |
| :-- | :--- |
| 1 | 补齐 ③④ 两步换票据流程（`check_sig` → `oauth2.0/authorize`），`code` 现在能正常产出 |
| 2 | 新增服务端会话容器：按域名保存每一步的 `Set-Cookie`。旧实现每次轮询只带 `qrsig`，跨域名票据根本换不出来 |
| 3 | 新增 `check_sig` 兜底域名（`ssl.ptlogin2.graph.qq.com` / `ssl.ptlogin2.qq.com`），兼容不同第三方应用 |
| 4 | 收缩 `qrsig` 校验正则。旧正则 `^[a-zA-Z0-9+/=._-]+$` 会把含 `*` 的合法 `qrsig` 直接判成非法请求 |
| 5 | `ptqrlogin` 补全真实浏览器参数（`ptredirect/h/t/g/ptlang/js_ver/has_onekey`），并预置 `xlogin` 拿 `pt_login_sig` |
| 6 | 新增 `67 已扫码待确认` 状态；上游 4xx/5xx 不再抛 500，按「二维码失效」返回 |
| 7 | 接口新增 `steps` 字段：逐步返回换票据过程，`code` 为空时能直接看出卡在哪一步 |
| 8 | 非 OAuth 预设（QQ会员 / QQ空间 / WeGame）改为明确返回 Cookie 凭证，并提示这些目标本身不签发 code |
| 9 | 修复代理问题：`PORT` / `HOST` 环境变量、静态资源绝对路径、404/健康检查、优雅退出 |
| 10 | 前端：凭证区新增 Cookie 展示、获取失败原因提示、点击复制 Toast，移动端不再隐藏结果面板 |

> ⚠️ **重要**：`code` 只会由 **QQ音乐 (Music)** 和 **瓦罗兰特 (VAL)** 这两个 OAuth 预设产出。
> QQ会员 / QQ空间 / WeGame 走的是普通网页登录，服务端不会签发 `code`，请使用返回的 Cookie（uin / skey / p_skey）凭证。

---

## 📦 安装步骤

1. **下载源码**
   下载并解压本项目到本地目录。

2. **安装依赖**
   在项目根目录下打开终端，运行：

   ```bash
   npm install
   ```

   *如果要手动安装依赖：*

   ```bash
   npm install express cors body-parser axios
   ```

3. **目录结构**

   ```text
   /
   ├── public/                 # 前端静态资源 (HTML/CSS/JS)
   ├── src/
   │   ├── server.js           # 后端入口与路由
   │   ├── session.js          # 核心登录 / 换票据逻辑
   │   └── utils.js            # Cookie 容器与哈希工具
   ├── ecosystem.config.js     # PM2 部署配置
   ├── Dockerfile
   ├── docker-compose.yaml
   ├── API.md                  # 接口开发文档
   └── README.md               # 说明文档
   ```

---

## 🚀 启动与部署

### 开发模式 / 本地运行

```bash
node src/server.js
```

启动成功后，控制台会输出：

```text
[QRLib] Server running at http://0.0.0.0:3000
[QRLib] WebUI enabled
```

打开浏览器访问 [http://localhost:3000](http://localhost:3000) 即可看到图形化登录界面。

### 环境变量

| 变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `WEBUI_ENABLED` | `true` | 设为 `false` 进入纯 API 模式（不提供网页界面） |
| `REQUEST_TIMEOUT` | `15000` | 单个上游请求超时（毫秒） |

**PowerShell (Windows):**

```powershell
$env:PORT="8080"; $env:WEBUI_ENABLED="false"; node src/server.js
```

**Linux / Mac:**

```bash
PORT=8080 WEBUI_ENABLED=false node src/server.js
```

### 🐳 Docker 部署（推荐）

```bash
# 构建并启动
docker compose up -d

# 指定宿主机端口
PORT=8080 docker compose up -d

# 查看状态 / 日志
docker compose ps
docker compose logs -f

# 停止
docker compose down
```

浏览器打开 [http://localhost:3000](http://localhost:3000)（或自定义端口）。

### 服务器部署 (PM2 推荐)

```bash
# 全局安装 pm2
npm install pm2 -g

# 方式一：使用配置文件（推荐）
pm2 start ecosystem.config.js

# 方式二：直接启动
pm2 start src/server.js --name "qrlib"

pm2 status
pm2 logs qrlib
pm2 save && pm2 startup
```

> ⚠️ 会话（`qrsig` → Cookie 容器）保存在进程内存中，**请勿使用 PM2 cluster 多实例模式**
> （`ecosystem.config.js` 已固定为 `fork` 单实例）。若确需多实例，请把会话容器替换为 Redis。

### Nginx 反向代理示例

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 60s;
}
```

---

## 🖥️ 功能特性

- **多模式支持**：QQ 会员、QQ 空间、QQ 音乐、WeGame、无畏契约网页端登录，以及小程序开发者工具 / QQ 经典农场登录。
- **完整换票据链路**：扫码成功后自动完成 `check_sig` → `oauth2.0/authorize`，返回可用的 OAuth `code`。
- **过程可观测**：接口返回 `steps` 步骤链路，`code` 为空时能直接定位是哪一步失败。
- **会话隔离**：每个二维码独立 Cookie 容器，10 分钟自动回收过期会话。
- **极简 UI**：采用 "Soft Modernism" 设计风格，大字体、宽间距，移动端与桌面端自适应。

---

## ⚠️ 注意事项 / 常见问题

1. **生成的二维码有效期通常为 2 分钟**，超时需刷新。
2. **请妥善保管获取到的 `code` 与 Cookie**，这等同于您的登录凭证。
3. **`code` 为空怎么办？**
   - 先看接口返回的 `steps` 字段，它会明确指出失败步骤。
   - `check_sig 未下发 p_skey`：一次性票据已失效，请刷新二维码重新扫码。
   - `authorize 未返回 code`：`client_id` 与 `redirect_uri` 不匹配（上游策略变更时可提出 issue）。
   - 使用 QQ会员 / QQ空间 / WeGame 预设时，本身不会返回 `code`，请使用 Cookie 凭证。
4. **二维码申请失败（未拿到 qrsig）**：通常说明服务器出口 IP 被腾讯风控，换一个 IP / 换机房重试。国内机房成功率明显高于境外机房。
5. **上游请求全部超时或报 `400 The plain HTTP request was sent to HTTPS port`**：检查服务器是否设置了 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量，代理会破坏 HTTPS 直连，请先取消这些变量再启动服务。
6. **不要用 CDN / 负载均衡把请求分发到多个实例**，二维码会话在内存中（见上方 PM2 说明）。

---

## 📖 接口文档

- [API.md](./API.md) - 完整 API 接口参数与返回定义。

## 🔗 参考项目

- [mioki/plugins/qr-login](https://github.com/vikiboss/mioki/blob/main/plugins/qr-login/index.ts) - 扫码与轮询逻辑参考，特此感谢。
- [simple_sq_music_plus / QQLoginHelp.java](https://gitee.com/it2022/simple_sq_music_plus) - 第三方 OAuth 换 `code` 链路参考，特此感谢。

## 📄 License

[MIT](./LICENSE)
