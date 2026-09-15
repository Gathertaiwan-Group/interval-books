#!/usr/bin/env python3
"""91_cron_vault.py — 把小時光的 pg_cron 排程與 vault secret 重建到目標專案（Phase 2）。

  91_cron_vault.py --src <ref> --dst <ref> [--activate] [--check]

- **排程預設建成 active=false**。切換那一刻才 `--activate`；提早開會讓新舊兩邊同時打
  `/api/tasks/*`，`dispatch_invoice_task` 各跑一次＝同一張單開兩張發票（要作廢的稅務文件）。
- vault secret 的值**不經過對話、不落地、不列印**：腳本讀出來就直接寫進目標，只印名稱與長度。
  驗證用的是兩邊在各自資料庫裡算的 md5，腳本只比對結果、印「相同／不同」。
- 目標要先有 pg_cron 與 pg_net（`00_load_baseline.sh` 會建）。
"""
import argparse, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mgmt import query, sql_str


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True); ap.add_argument('--dst', required=True)
    ap.add_argument('--activate', action='store_true', help='把目標的排程打開（切換當下才用）')
    ap.add_argument('--check', action='store_true', help='只比對，不寫入')
    a = ap.parse_args()

    ext = query(a.dst, "select count(*) filter (where extname='pg_cron') c, count(*) filter (where extname='pg_net') n from pg_extension")[0]
    if not (int(ext['c']) and int(ext['n'])):
        sys.exit('❌ 目標缺 pg_cron 或 pg_net，先跑 00_load_baseline.sh')

    # ── vault ────────────────────────────────────────────────────────────────
    secrets = query(a.src, "select name, coalesce(description,'') description, decrypted_secret v, md5(decrypted_secret) h "
                           "from vault.decrypted_secrets order by name")
    have = {s['name']: s['h'] for s in query(a.dst, "select name, md5(decrypted_secret) h from vault.decrypted_secrets")}
    print(f"═══ vault secret（來源 {len(secrets)} 個）")
    for s in secrets:
        if s['name'] in have:
            same = have[s['name']] == s['h']
            print(f"  {'✅' if same else '❌'} {s['name']}：目標已有，內容{'相同' if same else '不同'}")
            continue
        if a.check:
            print(f"  （會寫入 {s['name']}，{len(s['v'])} 字元）"); continue
        query(a.dst, f"select vault.create_secret({sql_str(s['v'])}, {sql_str(s['name'])}, {sql_str(s['description'])})")
        back = query(a.dst, f"select md5(decrypted_secret) h from vault.decrypted_secrets where name = {sql_str(s['name'])}")
        ok = back and back[0]['h'] == s['h']
        print(f"  {'✅' if ok else '❌'} {s['name']}：已寫入（{len(s['v'])} 字元），回讀{'相同' if ok else '不同'}")

    # ── cron ─────────────────────────────────────────────────────────────────
    jobs = query(a.src, "select jobname, schedule, command, active from cron.job order by jobid")
    dst_jobs = {j['jobname']: j for j in query(a.dst, "select jobname, schedule, command, active from cron.job")}
    print(f"═══ cron job（來源 {len(jobs)} 個；目標一律先建成 active=false）")
    for j in jobs:
        if j['jobname'] in dst_jobs:
            d = dst_jobs[j['jobname']]
            same = d['schedule'] == j['schedule'] and d['command'].strip() == j['command'].strip()
            print(f"  {'✅' if same else '❌'} {j['jobname']}：目標已有（{d['schedule']}，active={d['active']}），"
                  f"定義{'相同' if same else '不同'}")
            continue
        if a.check:
            print(f"  （會建立 {j['jobname']}：{j['schedule']}  {j['command'].strip()[:60]}）"); continue
        # 🔴 不能 `update cron.job`（那張表是 supabase_admin 的，postgres 會 permission denied）；
        #    開關一律走 cron.alter_job()。
        query(a.dst, f"select cron.alter_job(cron.schedule({sql_str(j['jobname'])}, {sql_str(j['schedule'])}, "
                     f"{sql_str(j['command'])}), active := false)")
        print(f"  ✅ {j['jobname']}：已建立（{j['schedule']}），active=false")

    if a.activate and not a.check:
        names = ','.join(sql_str(j['jobname']) for j in jobs)
        query(a.dst, f"select cron.alter_job(jobid, active := true) from cron.job where jobname = any(array[{names}])")
        print(f"═══ 已啟用 {len(jobs)} 個排程（切換後請盯 cron.job_run_details 與 net._http_response）")
    else:
        print("═══ 排程仍是 active=false；切換那一刻再跑 --activate（早開會讓新舊兩邊各開一次發票）")

    final = query(a.dst, "select jobname, schedule, active from cron.job order by jobid")
    for j in final:
        print(f"  目標：{j['jobname']}  {j['schedule']}  active={j['active']}")


if __name__ == '__main__':
    main()
