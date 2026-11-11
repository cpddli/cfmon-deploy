-- 给「已经建好表」的数据库补 region 字段（全新安装不需要跑）
-- 执行：wrangler d1 execute cfmon --remote --file=./migrations/003-region.sql

ALTER TABLE servers ADD COLUMN region TEXT NOT NULL DEFAULT '';
