# 服务器 Docker 部署指南

面向 Linux 服务器（Ubuntu / Debian / CentOS / 宝塔面板均可），全程 Docker，宿主机只需要装 Docker。

---

## 一、服务器准备

### 1. 安装 Docker

**Ubuntu / Debian：**

```bash
curl -fsSL https://get.docker.com | sh
sudo systemctl enable --now docker
sudo usermod -aG docker $USER   # 把自己加进 docker 组，之后不用 sudo
# 重新登录一次 SSH 让用户组生效
```

**CentOS / Rocky / Alma：**

```bash
sudo yum install -y yum-utils
sudo yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
sudo yum install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo systemctl enable --now docker
```

**验证（必须带 `docker compose` 子命令）：**

```bash
docker -v
docker compose version
```

> 如果 `docker compose` 报错找不到命令，是少了 compose 插件：
> `sudo apt install docker-compose-plugin` 或 `sudo yum install docker-compose-plugin`。
> 老系统的 `docker-compose`（带横杠）也能用，把下文命令里的 `docker compose` 换成 `docker-compose`。

### 2. 放行端口

项目默认对外端口 **3000**，按你的环境放行：

```bash
# 服务器本机防火墙
sudo ufw allow 3000/tcp          # Ubuntu / Debian
# 或
sudo firewall-cmd --permanent --add-port=3000/tcp && sudo firewall-cmd --reload   # CentOS

# 云服务器还要去控制台的安全组 / 防火墙规则里放行 TCP 3000
```

### 3. 清除代理变量（**最容易踩的坑**）

如果服务器上设过 `HTTP_PROXY` / `HTTPS_PROXY`，容器里所有对腾讯的 HTTPS 请求都会失败，报：

```
400 The plain HTTP request was sent to HTTPS port
```

部署前检查并清掉：

```bash
echo "HTTP_PROXY=$HTTP_PROXY  HTTPS_PROXY=$HTTPS_PROXY"
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy
```

如果是写进 `/etc/environment` 或 `/etc/profile` 的，也要一并删掉，否则重启后又会生效。

---

## 二、部署

```bash
# 1. 拉代码
git clone https://github.com/comboondu123/QRLib-main-fixed.git
cd QRLib-main-fixed

# 2. 构建并后台启动
docker compose up -d --build

# 3. 看日志确认起来了
docker compose logs -f
```

看到服务监听在 `0.0.0.0:3000` 就说明成功。按 `Ctrl+C` 退出日志（**不会**停掉容器）。

### 验证

```bash
# 健康检查
curl http://127.0.0.1:3000/api/health

# 从你本机浏览器打开（换成服务器公网 IP）
# http://<服务器IP>:3000
```

---

## 三、常用运维命令

```bash
docker compose ps                  # 查看运行状态（应显示 healthy）
docker compose logs -f --tail=100  # 实时日志
docker compose restart             # 重启
docker compose down                # 停止并删除容器
docker compose up -d --build       # 改了代码后重新构建
```

### 更新代码

```bash
git pull
docker compose up -d --build
```

---

## 四、换端口

想从 3000 换成 8080（只改宿主机映射，容器内仍是 3000）：

```bash
PORT=8080 docker compose up -d
```

或在项目根目录建一个 `.env` 文件：

```env
PORT=8080
```

> 如果是宝塔面板，注意别和面板占用的端口冲突。

---

## 五、可选：用 Nginx 反代 + 域名 + HTTPS

如果想让用户通过 `https://qr.你的域名.com` 访问，而不是 `IP:3000`：

```nginx
server {
    listen 80;
    server_name qr.你的域名.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 扫码是长轮询，超时给宽一点
        proxy_read_timeout 120s;
    }
}
```

配好后用 `certbot --nginx` 或宝塔面板一键申请 Let's Encrypt 证书即可。

> **注意**：如果你用了 CDN / 反向代理，务必确认它没有对响应做 HTML 改写或注入，某些代理会破坏轮询接口的 JSON。

---

## 六、故障排查

| 现象 | 原因 / 解决 |
| :-- | :-- |
| 群里/页面上扫码后 `code` 一直为空 | 只有 **QQ音乐(music)** 和 **瓦罗兰特(val)** 两个预设会签发 OAuth code。QQ会员 / QQ空间 / WeGame 本身就不签发，会返回 Cookie 凭证（`uin` / `skey` / `p_skey`）。前端"处理过程"面板会显示卡在哪一步。 |
| 所有请求都失败，日志里是 `400 ... sent to HTTPS port` | 服务器设了 `HTTP_PROXY`/`HTTPS_PROXY`，按第一部分第 3 步清掉。 |
| 浏览器打不开页面，容器却显示 running | ① 端口没放行（本机防火墙 / 云安全组）；② 端口被占用，`ss -tlnp \| grep 3000` 查一下。 |
| 容器一直 `unhealthy` | `docker compose logs` 看报错。多半还是代理变量问题。 |
| 构建时卡在 `npm ci` | 服务器访问 npm 源慢，给 Docker 配国内镜像源，或改用 `npm install --registry=https://registry.npmmirror.com`。 |
| 扫码提示"二维码已失效" | 正常现象，二维码有效期约 2 分钟，刷新页面重新生成即可。 |

---

## 七、重要提醒

1. **会话存在内存里，只能跑单实例。**
   不要用 PM2 cluster、也不要给这个服务开多个副本做负载均衡——扫码状态、Cookie 都不是持久化的，多实例会导致轮询打到没有该会话的进程上，表现为"扫码了但一直没反应"。

2. **不要提交 `.env` 或任何凭证到仓库。** `.gitignore` 和 `.dockerignore` 已经排除了。

3. **公网暴露前想清楚。** 这个服务会产出可登录的 QQ 凭证。建议至少加一层 Nginx Basic Auth，或限制来源 IP，别裸奔在公网。

4. **容器内以非 root 用户 `node` 运行**，只暴露 3000 一个端口，没有挂载宿主机目录，安全面已经收得比较小。

---

## 八、不用 Docker 的备选方案（PM2）

```bash
# 装 Node 18+（推荐 22）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

cd QRLib-main-fixed
npm ci --omit=dev
npm install -g pm2

pm2 start ecosystem.config.js
pm2 save
pm2 startup   # 按提示执行它输出的那行命令，配置开机自启
```

`ecosystem.config.js` 里已固定 `instances: 1`、`exec_mode: 'fork'`，**不要**改成 cluster。
