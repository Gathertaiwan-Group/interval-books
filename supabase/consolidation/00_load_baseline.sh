#!/usr/bin/env bash
# 00 — 把使用者跑的小時光 schema dump（dump_ib_schema.sql）載入目標專案。
#   前置：目標要先有 pg_cron / pg_net（dump 不含 CREATE EXTENSION）。
#   用法：NEW_URL="$(cat …/pg_rehearsal.url)" ./00_load_baseline.sh
set -euo pipefail
SP=${SP:-/private/tmp/claude-501/-Users-aimand--gemini-File/dad55a43-d978-488c-bb46-f3353af97feb/scratchpad}
: "${NEW_URL:?}"
psql "$NEW_URL" -v ON_ERROR_STOP=1 -Atc "create extension if not exists pg_cron; create extension if not exists pg_net; select 'ext ok'"
psql "$NEW_URL" -v ON_ERROR_STOP=1 -q -f "$SP/dump_ib_schema.sql"
psql "$NEW_URL" -Atc "select 'public tables='||(select count(*) from pg_tables where schemaname='public')||' inv tables='||(select count(*) from pg_tables where schemaname='inv')||' policies='||(select count(*) from pg_policies where schemaname in ('public','inv'))"
echo "期望 public 39 / inv 21 / policies 74"
