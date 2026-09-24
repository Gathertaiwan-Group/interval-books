#!/usr/bin/env python3
"""90_storage_migrate.py — 把來源專案的 Storage 桶子與物件搬到目標專案（三站共 8 個桶、205 個物件、約 19MB）。

  90_storage_migrate.py --src <ref> --dst <ref> [--bucket name ...] [--dry-run] [--verify-only]

為什麼不能用 SQL：`storage.buckets` / `storage.objects` 有平台保護，直接寫會被擋
（`Direct deletion from storage tables is not allowed`），一律走 Storage API。
service_role key 是即時從 Management API 取的，不落地、不列印。

搬什麼：桶子的 id／public／file_size_limit／allowed_mime_types，以及每個物件的完整路徑與 content-type。
不搬 owner（來源幾乎都是 service_role 傳的、本來就是 null）與 storage.objects 的 RLS policy（三站都沒有）。
驗收：逐物件比對大小與內容 md5（來源與目標各下載一次）。

🔴 物件的公開網址含專案 ref，改寫在 `60_url_rewrite.sql`（好日子的 product-images 與快樂手的 media）；
   舊專案刪掉之前那些網址仍然活著，計畫要求舊專案至少多留 90 天。
"""
import argparse, hashlib, json, os, subprocess, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mgmt import query, token, sql_str

API = 'https://api.supabase.com/v1'


def curl(args, binary=False, timeout=180):
    r = subprocess.run(['curl', '-s', '--max-time', str(timeout), '-w', '\n%{http_code}'] + args,
                       capture_output=True, timeout=timeout + 20)
    out = r.stdout
    nl = out.rfind(b'\n')
    body, code = out[:nl], int(out[nl + 1:] or 0)
    return code, (body if binary else body.decode('utf-8', 'replace'))


def service_key(ref):
    code, body = curl(['-H', f'Authorization: Bearer {token(ref)}', f'{API}/projects/{ref}/api-keys?reveal=true'])
    if code != 200:
        sys.exit(f'❌ 取不到 {ref} 的 API key（HTTP {code}）')
    for k in json.loads(body):
        if k.get('id') == 'service_role':
            return k['api_key']
    sys.exit(f'❌ {ref} 沒有 service_role key')


def buckets(ref, only):
    rows = query(ref, "select id, name, public, file_size_limit, allowed_mime_types::text mimes from storage.buckets order by id")
    return [b for b in rows if not only or b['id'] in only]


def objects(ref, bucket):
    return query(ref, f"""select name, (metadata->>'size')::bigint sz, metadata->>'mimetype' mime
                          from storage.objects where bucket_id = {sql_str(bucket)} order by name""")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True); ap.add_argument('--dst', required=True)
    ap.add_argument('--bucket', action='append', default=[])
    ap.add_argument('--dry-run', action='store_true'); ap.add_argument('--verify-only', action='store_true')
    a = ap.parse_args()
    sk, dk = service_key(a.src), service_key(a.dst)
    s_url, d_url = f'https://{a.src}.supabase.co/storage/v1', f'https://{a.dst}.supabase.co/storage/v1'
    sh = ['-H', f'Authorization: Bearer {sk}', '-H', f'apikey: {sk}']
    dh = ['-H', f'Authorization: Bearer {dk}', '-H', f'apikey: {dk}']

    bad = moved = skipped = 0
    for b in buckets(a.src, a.bucket):
        objs = objects(a.src, b['id'])
        total = sum(int(o['sz'] or 0) for o in objs)
        print(f"\n═══ {b['id']}（{'public' if b['public'] else 'private'}，{len(objs)} 物件，{total/1048576:.1f} MB）")
        exists = any(x['id'] == b['id'] for x in buckets(a.dst, [b['id']]))
        if not exists:
            payload = {'id': b['id'], 'name': b['name'], 'public': b['public'],
                       'file_size_limit': b['file_size_limit'],
                       'allowed_mime_types': (b['mimes'][1:-1].split(',') if b['mimes'] and b['mimes'] != '{}' else None)}
            if a.dry_run or a.verify_only:
                print(f"  （會建桶子：{json.dumps(payload, ensure_ascii=False)}）")
            else:
                code, body = curl(dh + ['-X', 'POST', f'{d_url}/bucket', '-H', 'Content-Type: application/json',
                                        '-d', json.dumps(payload)])
                print(f"  建桶子 → HTTP {code} {body[:120]}")
                if code >= 300:
                    bad += 1; continue
        else:
            # 已存在：設定要一致，否則上傳會被 mime／大小限制擋掉，而且是靜默的行為差異
            d = buckets(a.dst, [b['id']])[0]
            same = (d['public'] == b['public'] and d['file_size_limit'] == b['file_size_limit'] and d['mimes'] == b['mimes'])
            print(f"  桶子已存在，設定{'一致' if same else '🔴 不一致（public/limit/mimes）'}")
            bad += (not same)

        for o in objs:
            path = o['name']
            code, data = curl(sh + [f"{s_url}/object/{b['id']}/{path}"], binary=True)
            if code != 200:
                print(f"  ❌ 下載失敗 {path}（HTTP {code}）"); bad += 1; continue
            src_md5 = hashlib.md5(data).hexdigest()
            if int(o['sz'] or 0) != len(data):
                print(f"  ⚠️  {path}：DB 記的大小 {o['sz']} 與實際 {len(data)} 不同")
            if not a.verify_only and not a.dry_run:
                tmp = write_tmp(data)   # --data-binary @檔案：避免把位元組塞進 argv（二進位與大小都不安全）
                code, body = curl(dh + ['-X', 'POST', f"{d_url}/object/{b['id']}/{path}",
                                        '-H', f"Content-Type: {o['mime'] or 'application/octet-stream'}",
                                        '-H', 'x-upsert: true', '--data-binary', f'@{tmp}'], timeout=300)
                os.unlink(tmp); TMP.remove(tmp)
                if code >= 300:
                    print(f"  ❌ 上傳失敗 {path}（HTTP {code}）{body[:120]}"); bad += 1; continue
                moved += 1
            # 驗：從目標抓回來比 md5
            code, back = curl(dh + [f"{d_url}/object/{b['id']}/{path}"], binary=True)
            if a.dry_run:
                skipped += 1; continue
            if code != 200 or hashlib.md5(back).hexdigest() != src_md5:
                print(f"  ❌ 驗證不符 {path}（HTTP {code}，md5 {'不同' if code == 200 else 'n/a'}）"); bad += 1
        if not a.dry_run:
            d_objs = objects(a.dst, b['id'])
            ok = len(d_objs) == len(objs) and sum(int(x['sz'] or 0) for x in d_objs) == total
            print(f"  {'✅' if ok else '❌'} 目標 {len(d_objs)} 物件 / {sum(int(x['sz'] or 0) for x in d_objs)/1048576:.1f} MB")
            bad += (not ok)

    print(f"\n{'✅ 全部一致' if bad == 0 else f'❌ {bad} 項有問題'}"
          f"（搬了 {moved} 個物件{'，dry-run 未寫入' if a.dry_run else ''}）")
    sys.exit(1 if bad else 0)


TMP = []


def write_tmp(data):
    import tempfile
    f = tempfile.NamedTemporaryFile(delete=False)
    f.write(data); f.close(); TMP.append(f.name)
    return f.name


if __name__ == '__main__':
    try:
        main()
    finally:
        for f in TMP:
            try: os.unlink(f)
            except OSError: pass
