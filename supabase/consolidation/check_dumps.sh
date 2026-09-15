#!/usr/bin/env bash
# 收到使用者的 7 個 pg_dump 檔後先驗：存在、非空、格式、關鍵數字。任一不對就別往下載。
set -u
SP=${SP:-/private/tmp/claude-501/-Users-aimand--gemini-File/dad55a43-d978-488c-bb46-f3353af97feb/scratchpad}
ok=1
for f in dump_ib_schema dump_ib_data dump_ib_auth dump_hh_data dump_hh_auth dump_gd_data dump_gd_auth; do
  p="$SP/$f.sql"
  if [ ! -s "$p" ]; then echo "  ⏳ $f.sql 還沒放"; ok=0; continue; fi
  head -3 "$p" | grep -q "PostgreSQL database dump" || { echo "  ❌ $f.sql 不是 pg_dump 輸出"; ok=0; continue; }
  case $f in
    dump_ib_schema) echo "  ✅ $f.sql $(wc -c <"$p") bytes｜CREATE TABLE $(grep -c '^CREATE TABLE' "$p")（期望 60）｜CREATE FUNCTION $(grep -c '^CREATE FUNCTION\|^CREATE OR REPLACE FUNCTION' "$p")（期望 133）｜CREATE POLICY $(grep -c '^CREATE POLICY' "$p")（期望 74）｜含 auth.users trigger $(grep -c 'ON auth.users' "$p")（期望 0）";;
    *_auth)         echo "  ✅ $f.sql｜auth.users 段 $(grep -c '^COPY auth.users' "$p")｜identities 段 $(grep -c '^COPY auth.identities' "$p")";;
    *)              echo "  ✅ $f.sql $(wc -c <"$p") bytes｜COPY 段 $(grep -c '^COPY ' "$p")｜setval $(grep -c 'setval' "$p")";;
  esac
done
[ $ok = 1 ] && echo "全部到齊" || echo "還缺檔案"
