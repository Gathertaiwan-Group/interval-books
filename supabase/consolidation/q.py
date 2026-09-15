#!/usr/bin/env python3
"""q.py <ref> <sql|@file> [--raw] — 經 Management API 跑一段 SQL（單一交易），輸出 JSON。

臨時查詢與人工檢查用；成套流程請用 run_sql.py（分段執行）或各編號腳本。
🔴 SQL 錯誤會以非零離開碼結束並印出訊息，不會靜默回空陣列——rehearsal_reset.sql 這種靠它把關的用法需要。
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mgmt import query, ApiError

if __name__ == '__main__':
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    ref, sql = sys.argv[1], sys.argv[2]
    if sql.startswith('@'):
        sql = open(sql[1:], encoding='utf-8').read()
    try:
        r = query(ref, sql)
    except ApiError as e:
        sys.exit(f'❌ {e}')
    print(json.dumps(r, ensure_ascii=False, indent=None if '--raw' in sys.argv else 1))
