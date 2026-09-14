#!/usr/bin/env bash
# 00 — 小時光 live schema（只有結構、沒有資料）當 baseline：pg_dump --schema-only public + inv。
# Phase 0 已證實 live 與 repo 38 支零差異，直接以 live 為準，順便解掉小時光沒有 migration 帳本的問題。
#   用法：IB_URL="$(cat <pg_intervalbooks.url>)" ./00_intervalbooks_baseline.sh
set -euo pipefail
: "${IB_URL:?需要小時光的連線字串}"
pg_dump "$IB_URL" --schema-only --no-owner --schema=public --schema=inv > 00_intervalbooks_baseline.sql
# --no-owner：目標 owner 是 postgres；grant 要保留（inv 的權限模型靠它），所以不加 --no-privileges。
# 掛在 auth.users 上的 trigger 不屬於 public/inv、不在 dump 裡；public.handle_new_user() 會在，40 保留它不掛。
# cron.job／vault 也不在——Phase 2 在目標重建（見 README）。
echo "baseline: $(wc -l < 00_intervalbooks_baseline.sql) 行"
echo "檢查 1 — auth.users 的 trigger 不該在裡面（期望 0）： $(grep -c 'ON auth.users' 00_intervalbooks_baseline.sql || true)"
echo "檢查 2 — CREATE TABLE 數（期望 60）： $(grep -c '^CREATE TABLE' 00_intervalbooks_baseline.sql)"
echo "檢查 3 — 目標要先啟用的 extension： $(grep -oE 'CREATE EXTENSION IF NOT EXISTS \S+' 00_intervalbooks_baseline.sql | sort -u | tr '\n' ' ')"
