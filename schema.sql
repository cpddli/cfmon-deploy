-- cfmon 数据库结构
-- 执行：wrangler d1 execute cfmon --remote --file=./schema.sql

-- 服务器表：一台服务器一行。agent 每次上报只 UPDATE 这一行，
-- 所以「一次上报 = 1 行写入」，这是成本最低的存法。
CREATE TABLE IF NOT EXISTS servers (
  id          TEXT PRIMARY KEY,            -- UUID
  name        TEXT NOT NULL,               -- 面板显示名
  region      TEXT NOT NULL DEFAULT '',    -- 地区（一个 emoji 或短词，显示在卡片标题前）
  note        TEXT NOT NULL DEFAULT '',    -- 备注（机房 / 到期日 / 用途）
  sort_order  INTEGER NOT NULL DEFAULT 0,  -- 排序，小的在前

  token_hash  TEXT NOT NULL UNIQUE,        -- agent 密钥的 SHA-256，明文不落库
  token_hint  TEXT NOT NULL DEFAULT '',    -- 密钥前 6 位，方便在面板里区分

  -- 静态信息（agent 上报后填充）
  hostname    TEXT NOT NULL DEFAULT '',
  os          TEXT NOT NULL DEFAULT '',
  arch        TEXT NOT NULL DEFAULT '',
  cpu_model   TEXT NOT NULL DEFAULT '',
  cpu_cores   INTEGER NOT NULL DEFAULT 0,
  kernel      TEXT NOT NULL DEFAULT '',
  agent       TEXT NOT NULL DEFAULT '',

  -- 最新一次快照，JSON（cpu / mem / disk / net / load ...）
  stats       TEXT NOT NULL DEFAULT '{}',

  last_seen   INTEGER NOT NULL DEFAULT 0,  -- 最后上报时间（unix 秒）
  last_sample INTEGER NOT NULL DEFAULT 0,  -- 最后一次写入历史采样的时间
  created_at  INTEGER NOT NULL DEFAULT 0,

  -- 计费信息
  expires_at  INTEGER NOT NULL DEFAULT 0,  -- 到期日（unix 秒，当天 0 点 UTC）
  renew_cycle INTEGER NOT NULL DEFAULT 30, -- 续费周期天数（30/90/365）
  auto_renew  INTEGER NOT NULL DEFAULT 0,  -- 1 = 循环计费，到期自动顺延
  price       REAL    NOT NULL DEFAULT 0,  -- 价格（仅展示）

  -- 各类提醒上次发送时间，JSON：{"cpu":ts,"offline":ts,"bill":{"exp":..,"sent":[7,3]}}
  alert_state TEXT NOT NULL DEFAULT '{}'
);

-- 历史采样表：只存曲线需要的百分比和速率，行很小。
-- (server_id, ts) 做主键，查询某台某时间段是一段连续范围扫描。
CREATE TABLE IF NOT EXISTS samples (
  server_id TEXT    NOT NULL,
  ts        INTEGER NOT NULL,
  cpu       REAL    NOT NULL DEFAULT 0,   -- %
  mem       REAL    NOT NULL DEFAULT 0,   -- %
  swap      REAL    NOT NULL DEFAULT 0,   -- %
  disk      REAL    NOT NULL DEFAULT 0,   -- %
  load1     REAL    NOT NULL DEFAULT 0,
  rx        REAL    NOT NULL DEFAULT 0,   -- 下行 B/s
  tx        REAL    NOT NULL DEFAULT 0,   -- 上行 B/s
  PRIMARY KEY (server_id, ts)
) WITHOUT ROWID;

-- 历史查询是「取最近 N 分钟」，按主键 (server_id, ts) 走不到 ts 范围，
-- 所以额外建一个 ts 索引，避免每次画图都全表扫描。
CREATE INDEX IF NOT EXISTS idx_samples_ts ON samples (ts);

-- 全局配置：Telegram token、告警阈值等，单行 JSON（key 固定为 config）
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 登录失败记录，用于简单的暴力破解限流（15 分钟内失败 10 次即锁定）
CREATE TABLE IF NOT EXISTS login_fail (
  ip TEXT    NOT NULL,
  ts INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_login_fail_ip_ts ON login_fail (ip, ts);
