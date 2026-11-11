-- 给「已经建好表」的数据库补字段（全新安装不需要跑这个，schema.sql 已包含）
-- 执行：wrangler d1 execute cfmon --remote --file=./migrations/002-alerts.sql

ALTER TABLE servers ADD COLUMN expires_at  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE servers ADD COLUMN renew_cycle INTEGER NOT NULL DEFAULT 30;
ALTER TABLE servers ADD COLUMN auto_renew  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE servers ADD COLUMN price       REAL    NOT NULL DEFAULT 0;
ALTER TABLE servers ADD COLUMN alert_state TEXT    NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
