#!/usr/bin/env python3
"""94_check_target_plan.py — 切換前的方案檢查：合併庫不能留在 free 方案。

  94_check_target_plan.py --dst <ref>

free 方案對這顆庫的具體風險（不是抽象的「比較好」）：
- **沒有每日備份、沒有 PITR**。這顆庫裝的是三站的訂單與已開立的電子發票，壞了沒有回復點。
- **閒置七天會自動暫停**。切換之前它會閒置一陣子，正好會被暫停；恢復後 auth 有暖機期會**假報密碼錯誤**，
  看起來就像全站登入壞掉（ifoodmap 踩過）。
- 500MB 資料庫／1GB 儲存／5GB egress 上限：目前資料約 10MB、Storage 約 19MB，空間不是問題，但
  快樂手的 course-videos 一開始放影片就會撞到。
這支腳本只檢查與提醒，不會自己去改帳單。
"""
import argparse, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mgmt import token
import json, subprocess

API = 'https://api.supabase.com/v1'


def get(path, ref):
    r = subprocess.run(['curl', '-s', '--max-time', '60', f'{API}{path}',
                        '-H', f'Authorization: Bearer {token(ref)}'], capture_output=True, text=True, timeout=80)
    return json.loads(r.stdout or '{}')


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--dst', required=True); a = ap.parse_args()
    proj = get(f'/projects/{a.dst}', a.dst)
    if 'organization_id' not in proj:
        sys.exit(f'❌ 讀不到專案：{json.dumps(proj, ensure_ascii=False)[:200]}')
    org = get(f'/organizations/{proj["organization_id"]}', a.dst)
    plan = org.get('plan')
    print(f"  專案 {proj['name']}（{a.dst}）  區域 {proj['region']}  狀態 {proj['status']}")
    print(f"  組織 {org.get('name')}  方案 {plan}")
    if plan == 'free':
        print("  🔴 free 方案：沒有每日備份與 PITR、閒置七天會自動暫停（恢復後 auth 暖機期會假報密碼錯）。")
        print("     正式切換前必須升級到 Pro；在那之前這顆庫只能當「組裝與驗證」用，不要把任何一站指過來。")
        sys.exit(2)
    print("  ✅ 方案可以承載正式資料")


if __name__ == '__main__':
    main()
