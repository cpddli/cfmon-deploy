# cfmon 部署教程（10 分钟，从零开始）

全程只需要：一个 Cloudflare 账号 + 一台能上网的电脑 + 要监控的 VPS。免费额度够用，不用绑卡。

---

## 0. 准备：装 Node.js

需要 **Node.js 20+，建议 22 LTS**（新版 wrangler 要求 ≥22）。

```bash
node -v      # 低于 v20 请先去 https://nodejs.org 装 LTS 版
```

> Windows 用户：装完后在「PowerShell」里执行下面的命令即可。

---

## 1. 拿到代码并装依赖

```bash
cd cf-monitor
npm install
```

（如果你是从我给的目录复制出去的，`npm install` 会装好 wrangler，约 1~3 分钟。）

---

## 2. 登录 Cloudflare

```bash
npx wrangler login
```

浏览器会弹出来点「Allow」即可。

> **国内网络如果卡在登录**，改用 API Token 方式：
> 1. 打开 <https://dash.cloudflare.com/profile/api-tokens> → Create Token → 用「Edit Cloudflare Workers」模板 → 生成后复制；
> 2. 在 Cloudflare 首页右下角复制 Account ID；
> 3. 设置环境变量后再执行后续命令（PowerShell）：
> ```powershell
> $env:CLOUDFLARE_API_TOKEN="你的token"
> $env:CLOUDFLARE_ACCOUNT_ID="你的account id"
> ```

---

## 3. 创建数据库

```bash
npx wrangler d1 create cfmon
```

输出里有一段 `[[d1_databases]]`，把它里面的 `database_id = "xxxx-xxxx..."` 复制出来，
替换 `wrangler.toml` 里这一行的占位内容：

```toml
[[d1_databases]]
binding = "DB"
database_name = "cfmon"
database_id = "在这里粘贴你刚拿到的 id"
```

---

## 4. 建表

```bash
npx wrangler d1 execute cfmon --remote --file=./schema.sql
```

看到成功提示就行。**这一步跳过的话，面板会一直报「服务器内部错误」。**

---

## 5. 部署

```bash
npx wrangler deploy
```

- 第一次部署会问你要不要注册一个 `workers.dev` 子域，输入 `y` 然后起个名字（比如 `yourname`）；
- 成功后终端会打印访问地址，形如：

```
https://cfmon.yourname.workers.dev
```

---

## 6. 设置面板密码

```bash
npx wrangler secret put ADMIN_PASSWORD
```

按提示输入密码（输入时不显示字符，正常现象）。设置后立刻生效，不需要重新部署。

> 密码存成 Worker Secret，不会出现在代码和仓库里。以后改密码就再执行一次这条命令。

---

## 7. 打开面板

浏览器访问 `https://cfmon.yourname.workers.dev`，输入刚才的密码登录。

首次进来是空的，点右上角 **「＋ 添加服务器」**。

---

## 8. 给服务器装 agent

在面板里填个名字（比如「香港-01」），点「创建」，会弹出一条命令，**直接整条复制**，到你的 VPS 上以 root 执行：

```bash
curl -fsSL https://cfmon.yourname.workers.dev/agent/install.sh | sudo sh -s -- \
  --url https://cfmon.yourname.workers.dev \
  --token 面板给你的一次性密钥 \
  --interval 30
```

脚本会依次做：

1. 下载采集端到 `/usr/local/bin/cfmon-agent`
2. 把地址和密钥写进 `/etc/cfmon/agent.conf`（权限 600）
3. **先上报一次做自检**，失败会当场报错，不会留个跑不起来的服务
4. 注册 systemd 服务 `cfmon-agent`，开机自启

看到「自检通过」和「服务已启动」就成功了。刷新面板，几秒内就会出现这台机器。

> 密钥**只显示这一次**，关掉窗口就看不到了。丢了没关系 —— 到面板详情里「重置密钥」，重新执行安装命令即可。

---

## 9. 确认状态

在 VPS 上：

```bash
systemctl status cfmon-agent          # 应该是 active (running)
journalctl -u cfmon-agent -n 20       # 看最近日志
/usr/local/bin/cfmon-agent --once     # 手动打一发，排查用
```

面板上：卡片应该是彩色 + 绿点，有 CPU / 内存 / 磁盘进度条、实时网速和最近一小时的 CPU 曲线。点卡片能看详情和 1h / 6h / 24h / 7d 曲线。

---

## 日常维护

| 想做什么 | 命令 |
|---|---|
| 改代码后重新发布 | `npx wrangler deploy` |
| 改面板密码 | `npx wrangler secret put ADMIN_PASSWORD` |
| 改上报间隔 | 编辑 `/etc/cfmon/agent.conf` 里的 `CFMON_INTERVAL`，然后 `sudo systemctl restart cfmon-agent` |
| 卸载 agent | `curl -fsSL https://面板地址/agent/install.sh \| sudo sh -s -- --uninstall` |
| 看 D1 用了多少额度 | Cloudflare 后台 → Workers & Pages → D1 → cfmon → Metrics |

> ### ⚠️ 改了 `wrangler.toml` 里的 `[vars]` 之后要注意
>
> 如果 `wrangler deploy` 打出这样的警告：
> ```
> The local configuration being used differs from the remote configuration ...
> Uploading the Worker will override the remote configuration with your local one.
> ```
> 这次部署会把 **ADMIN_PASSWORD 这个 secret 一起清掉**，表现为登录一直提示「密码错误」。
> 部署完补一条就行：
> ```bash
> npx wrangler secret put ADMIN_PASSWORD
> ```
> 只改代码、不改 `[vars]` 的正常部署不会触发，secret 会保留。

---

## 常见问题

**登录页提示「面板还没设置密码」**
忘了第 6 步。执行 `npx wrangler secret put ADMIN_PASSWORD`。

**登录后报错 / 一直「服务器内部错误」**
第 4 步建表没做，或 `database_id` 没替换。检查 `wrangler.toml`，再执行一次建表命令。

**`npx wrangler deploy` 报 find database / binding 相关错误**
`database_id` 还是占位符，回到第 3 步。

**装完 agent 但面板显示离线**
1. `OFFLINE_AFTER`（默认 90 秒）要比上报间隔大 3 倍以上；
2. VPS 时间是否准确：`date`；
3. `journalctl -u cfmon-agent -f` 看有没有 401 —— 密钥失效了，重置密钥重装；
4. 服务器能不能出网：`curl -I https://面板地址/api/health`。

**agent 装不上，提示没有 curl / wget**
采集端默认是零依赖的 shell 版本，只需要 curl 或 wget 之一：Debian/Ubuntu `apt install -y curl ca-certificates`，Alpine `apk add curl ca-certificates`。
**不需要 python3**（想用 Python 版本才需要，加 `--agent py`）。

**想换成自己的域名**
Cloudflare 后台 → Workers & Pages → cfmon → Settings → Domains & Routes → Add Custom Domain。域名需要托管在同一个 Cloudflare 账号下。

**报 `spawn EPERM` / 权限错误**
常见于公司电脑的安全软件拦截子进程，换一台机器或关掉拦截再试。

---

## 可选：本地先试一遍

不花任何额度，跑在本地：

```bash
npm run db:init:local          # 建本地数据库
npm run dev                    # http://127.0.0.1:8787
```

本地密码在项目自带的 `.dev.vars` 里，默认是 `devpassword`，直接用记事本改就行
（注意别用 `echo >` 覆盖，PowerShell 会写成 UTF-16，wrangler 读不了）。

只想看看界面长什么样（不需要后端）：

```bash
npm run preview                # http://127.0.0.1:8799 ，假数据
```
