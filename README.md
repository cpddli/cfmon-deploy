# cfmon

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cpddli/cfmon-deploy)

轻量服务器监控面板，跑在 Cloudflare Workers + D1 上，**不使用 Durable Object**。

## 一键部署

1. 点上面的按钮，用 Cloudflare 账号授权
2. 仓库选 `cpddli/cfmon-deploy`，分支 `main`
3. 提示绑定 D1 时，**新建一个**名为 `cfmon` 的数据库（或选已有的）
4. 点 Deploy，等 1 分钟
5. 打开分配到的 `*.workers.dev` 地址，**第一次进入会让你设置管理密码**

> 表结构会在第一次访问时自动创建，**不需要跑任何 SQL**，也不需要配置 secret。

如果部署时报「找不到数据库」之类的错误，说明流程没自动建库，手动来两步：
在 Cloudflare 后台建一个 D1 数据库叫 `cfmon`，把它给你的 ID 填进 `wrangler.toml` 的 `database_id`，再部署一次。

## 装到服务器上

面板里点「添加服务器」，会给你一条命令，在 VPS 上以 root 执行即可：

```bash
curl -fsSL https://你的面板地址/agent/install.sh | sudo sh -s -- \
  --url https://你的面板地址 --token 面板给的密钥
```

采集端是**零依赖的 shell 脚本**，不需要 python3，只需要 curl 或 wget。

## 功能

- 游客模式：不登录也能看状态，只有增删改需要登录
- CPU / 内存 / 磁盘 / 网速 / 负载 / 运行时间，1 小时 / 6 小时 / 24 小时曲线
- Telegram 告警：持续负载、离线、账单到期、循环计费
- 拖动排序、深色主题、按名称/地区/系统搜索

完整文档见主仓库：https://github.com/cpddli/cfmon
