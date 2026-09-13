# QRLib API 接口文档

本文档详细描述了 QRLib 提供的后端 API 接口。所有接口均返回 JSON 格式数据。

**Base URL**: `http://localhost:3000` (默认，可用 `PORT` 环境变量修改)

---

## 1. 健康检查 (Health)

- **Endpoint**: `/api/health`
- **Method**: `GET`

### 响应 (Response)

```json
{
  "success": true,
  "status": "ok",
  "version": "1.1.0",
  "uptime": 42,
  "webUiEnabled": true,
  "sessions": 1
}
```

---

## 2. 获取预设列表 (Get Presets)

获取支持的登录目标预设列表。

- **Endpoint**: `/api/presets`
- **Method**: `GET`

### 响应 (Response)

```json
[
  {
    "key": "music",
    "type": "qr",
    "name": "QQ音乐 (Music)",
    "description": "QQ音乐网页版 · OAuth code",
    "supportsCode": true
  },
  {
    "key": "vip",
    "type": "qr",
    "name": "QQ会员 (VIP)",
    "description": "QQ会员官网",
    "supportsCode": false
  },
  {
    "key": "miniprogram",
    "type": "mp",
    "name": "小程序开发 (DevTools)",
    "description": "QQ小程序开发者工具",
    "supportsCode": true,
    "defaultAppId": ""
  }
]
```

| 字段 | 说明 |
| :--- | :--- |
| `type` | `qr` = 网页扫码；`mp` = 小程序 |
| `supportsCode` | **是否能产出 OAuth `code`**。为 `false` 时只会返回 Cookie 凭证 |

---

## 3. 获取登录二维码 (Create QR Code)

请求生成一个新的登录二维码。

- **Endpoint**: `/api/qr/create`
- **Method**: `POST`
- **Content-Type**: `application/json`

### 请求参数 (Request Body)

| 参数名 | 类型 | 必选 | 描述 | 示例 |
| :--- | :--- | :--- | :--- | :--- |
| `preset` | string | 否 | 预设 Key (来自接口 2)，默认为 `vip` | `"music"`, `"farm"` |

### 响应 (Response)

```json
{
  "success": true,
  "qrsig": "463aeac0...",          // 二维码签名（核心，用于查询状态）
  "qrcode": "data:image/png;base64,...",  // 二维码图片，可直接用于 <img src>
  "url": "https://ssl.ptlogin2.qq.com/ptqrshow?...",  // 二维码原始请求地址
  "redirectUri": "https://y.qq.com/portal/wx_redirect.html?...",
  "oauthMode": true,               // 是否为 OAuth 换 code 模式
  "expiresIn": 120,                // 建议有效期（秒）
  "isMiniProgram": false
}
```

> 小程序模式下 `qrcode` 为第三方图片直链，`qrsig` 即接口返回的登录码。

---

## 4. 查询扫码状态 / 换取凭证 (Check QR Status)

轮询查询二维码的扫描和登录状态，**扫码成功后会在同一个接口里完成换票据流程并返回 `code`**。
**建议轮询间隔：2 秒**。

- **Endpoint**: `/api/qr/check`
- **Method**: `POST`
- **Content-Type**: `application/json`

### 请求参数 (Request Body)

| 参数名 | 类型 | 必选 | 描述 | 示例 |
| :--- | :--- | :--- | :--- | :--- |
| `qrsig` | string | **是** | 上一步获取的 `qrsig` | `"463aeac0..."` |
| `preset` | string | 否 | 当前使用的预设 Key | `"music"` |
| `appid` | string | 否 | (仅限小程序模式) 自定义 AppID | `"1108291530"` |

> `qrsig` 允许包含可见 ASCII 字符（含 `*` `+` `/` `=` `_` `-`），长度 6–256。

### 状态：等待扫码 / 已扫码待确认

```json
{
  "success": true,
  "ret": "66",
  "msg": "等待扫码...",
  "nickname": "",
  "code": "",
  "uin": "",
  "ticket": "",
  "avatar": "",
  "cookie": "",
  "skey": "",
  "p_skey": "",
  "steps": []
}
```

| ret | 含义 |
| :--- | :--- |
| `66` | 等待扫码，继续轮询 |
| `67` | 已扫码，等待手机端确认，继续轮询 |
| `65` | 二维码已失效，停止轮询并刷新 |
| `0` | 登录成功，见下方成功响应 |

### 状态：登录成功 (Success) 🎉

```json
{
  "success": true,
  "ret": "0",
  "msg": "登录成功",
  "nickname": "昵称",
  "code": "A1B2C3D4E5F6...",                                  // [核心] OAuth 授权码
  "uin": "123456789",                                          // [核心] QQ 号
  "avatar": "https://q1.qlogo.cn/g?b=qq&nk=123456789&s=640",   // 头像
  "ticket": "@xxxxxx",                                         // skey（部分场景等价于票据）
  "skey": "@xxxxxx",                                           // [核心] skey
  "p_skey": "xxxxxx",                                          // [核心] p_skey
  "cookie": "uin=o0123456789; skey=@xxxxxx; p_skey=xxxxxx",     // 可直接使用的 Cookie 凭证
  "steps": [
    { "step": "parse_jump", "ok": true, "hasUin": true, "hasPtsigx": true },
    { "step": "check_sig", "ok": true, "host": "ssl.ptlogin2.graph.qq.com", "status": 302 },
    { "step": "oauth_authorize", "ok": true, "status": 302, "location": "https://y.qq.com/..." }
  ]
}
```

### `steps` 字段说明

用于排查「为什么 `code` 是空的」，每个元素代表换票据链路中的一步：

| step | 说明 | 常见失败原因 |
| :--- | :--- | :--- |
| `parse_jump` | 从 `ptqrlogin` 返回的跳转地址里解析 `uin` / `ptsigx` | 解析不到说明上游返回结构变化 |
| `check_sig` | 用一次性票据换取 `skey` / `p_skey` | `hasPtsigx=false` 或票据已被消费 |
| `oauth_authorize` | 用 `p_skey` 计算 `g_tk` 后调用授权接口取 `code` | `client_id` / `redirect_uri` 不匹配 |
| `follow_redirect` | 兜底：手动跟随跳转链从 `Location` 里找 `code` | — |

### `code` 为空的典型场景

| 场景 | `msg` / `reason` |
| :--- | :--- |
| 使用了非 OAuth 预设（vip / qzone / wegame） | 该登录目标不提供 OAuth code，已返回 Cookie 凭证 |
| 一次性票据过期 | `check_sig 未下发 p_skey（登录票据换取失败）` |
| 上游客户端参数变更 | `authorize 未返回 code（通常是 client_id / redirect_uri 不匹配）` |

---

## 5. 重置会话 (Reset Session)（可选）

二维码刷新后释放服务端 Cookie 容器，避免内存堆积。

- **Endpoint**: `/api/session/reset`
- **Method**: `POST`

```json
{ "qrsig": "463aeac0..." }
```

```json
{ "success": true, "sessions": 0 }
```

---

## 错误响应

```json
{ "success": false, "message": "Invalid qrsig/code format" }
```

| HTTP | 场景 |
| :--- | :--- |
| `400` | 缺少 `qrsig`，或 `qrsig` 格式非法 |
| `404` | 路径不存在 |
| `500` | 申请二维码失败 / 上游异常，`message` 中有具体原因 |
