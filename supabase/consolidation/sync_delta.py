#!/usr/bin/env python3
"""sync_delta.py — 三站舊專案 → 合併專案的「只補差異」同步。**不刪除任何一列。**

  sync_delta.py [--apply] [--site ib|hh|gd ...]

為什麼不是「清空再重灌」：目標本來就是完整快照，差異通常只有幾列；清空整個庫是高風險的大量刪除
（2026-10-08 被 auto-mode 權限檢查以 Cloud Storage Mass Delete 擋下），而且這支工具切換後還要拿來
做「窗口內新資料」的補遷（runbook 第 6 步），兩件事用同一套邏輯。

做法（每一站）：
  1. auth.users／auth.identities：以 id 比對，缺的 insert、內容變了的 update（正常模式——新帳號要觸發
     三個 fan-out trigger 長出三個 schema 的 profile）。重複帳號（remap.tsv）一律以小時光的那一列為準，
     快樂手／好日子那一份跳過，與 50_load_data.sh 同一個語意。
  2. 業務表：逐表算「主鍵 → md5(整列文字)」，缺的與變了的用 upsert 寫進去（replica 模式：不觸發
     updated_at／稽核 trigger、不查 FK）。目標多出來的列只回報、不刪（profiles 本來就多了別站帳號的空殼）。
  3. 序列：照來源的 last_value／is_called setval。
比對用的列文字套用與 data_diff.py 相同的轉換：重複帳號 UUID remap、舊專案 ref → 新 ref（storage 網址）。
"""
import argparse, json, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mgmt import query, sql_str

SP = '/private/tmp/claude-501/-Users-aimand--gemini-File/dad55a43-d978-488c-bb46-f3353af97feb/scratchpad'
TARGET = 'noijrmhdfbfvjyvchvzj'
SITES = {
    'ib': ('小時光', 'kmpwughmwpdzsizrxhms', [('public', 'public'), ('inv', 'inv')]),
    'hh': ('快樂手', 'soglfvjtysqqqzbcwwci', [('public', 'happyhands')]),
    'gd': ('好日子', 'xptltqokykpmiqwlnasm', [('public', 'gooddays')]),
}
SKIP = {('gd', '_migrations')}
BATCH = 150


def remap_pairs(site):
    out = []
    p = os.path.join(SP, 'remap.tsv')
    for line in open(p):
        f = line.rstrip('\n').split('\t')
        if len(f) == 3 and f[0] == site:
            out.append((f[1], f[2]))
    return out


def replacements(site):
    reps = list(remap_pairs(site))
    if site == 'hh': reps.append(('soglfvjtysqqqzbcwwci', TARGET))
    if site == 'gd': reps.append(('xptltqokykpmiqwlnasm', TARGET))
    return reps


def wrap(expr, reps):
    for o, n in reps:
        expr = f"replace({expr}, {sql_str(o)}, {sql_str(n)})"
    return expr


def apply_text(s, reps):
    for o, n in reps:
        s = s.replace(o, n)
    return s


def table_meta(ref, schema):
    rows = query(ref, f"""
select c.relname t,
  (select string_agg(quote_ident(a.attname), ',' order by k.ord) from pg_constraint p
     cross join lateral unnest(p.conkey) with ordinality k(attnum, ord)
     join pg_attribute a on a.attrelid=p.conrelid and a.attnum=k.attnum
    where p.conrelid=c.oid and p.contype='p') pk,
  (select string_agg(quote_ident(a.attname), ',' order by a.attnum) from pg_attribute a
    where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped and a.attgenerated='') cols,
  (select coalesce(json_agg(a.attname), '[]'::json) from pg_attribute a
    where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped and a.attgenerated<>'') gen,
  exists(select 1 from pg_attribute a where a.attrelid=c.oid and a.attidentity='a' and a.attnum>0) ident_always
from pg_class c where c.relnamespace={sql_str(schema)}::regnamespace and c.relkind='r' order by 1""")
    for r in rows:
        if isinstance(r['gen'], str): r['gen'] = json.loads(r['gen'])
    return rows


def pk_expr(pk, alias='t'):
    cols = pk.split(',')
    return ' || chr(31) || '.join(f'{alias}.{c}::text' for c in cols)


def fingerprints(ref, qn, pk, reps):
    """主鍵 → md5(列文字)。一次查完整張表。"""
    rows = query(ref, f"select {wrap(pk_expr(pk), reps)} k, md5({wrap('t::text', reps)}) h from {qn} t")
    return {r['k']: r['h'] for r in rows}


def fetch_rows(ref, qn, pk, keys, gen, reps):
    """取出指定主鍵的列（JSON，去掉 generated 欄位），套上轉換。"""
    out = []
    drop = ''.join(f" - {sql_str(g)}" for g in gen)
    for i in range(0, len(keys), BATCH):
        chunk = keys[i:i + BATCH]
        # 主鍵在來源端是「轉換前」的值：反向替換回去才查得到
        src_keys = [apply_text(k, [(n, o) for o, n in reps]) for k in chunk]
        lst = 'array[' + ','.join(sql_str(k) for k in src_keys) + ']'
        rows = query(ref, f"select (to_jsonb(t){drop})::text j from {qn} t where {pk_expr(pk)} = any({lst})")
        out += [json.loads(apply_text(r['j'], reps)) for r in rows]
    return out


def upsert(qn, cols, pk, rows, ident_always, replica=True):
    if not rows: return 0
    collist = cols
    sets = ','.join(f'{c}=excluded.{c}' for c in cols.split(',') if c not in pk.split(','))
    total = 0
    for i in range(0, len(rows), BATCH):
        payload = json.dumps(rows[i:i + BATCH], ensure_ascii=False)
        tag = '$syncj$'
        assert tag not in payload
        sql = ((f"set local session_replication_role = replica;\n" if replica else '') +
               f"with ins as (insert into {qn} ({collist}) {'overriding system value' if ident_always else ''} "
               f"select {collist} from jsonb_populate_recordset(null::{qn}, {tag}{payload}{tag}::jsonb) "
               f"on conflict ({pk}) do update set {sets or pk.split(',')[0] + '=excluded.' + pk.split(',')[0]} returning 1) "
               f"select count(*) n from ins")
        total += int(query(TARGET, sql)[0]['n'])
    return total


def sync_auth(site, ref, apply_):
    reps = remap_pairs(site)
    canon_from_other = {n for o, n in reps}           # 這些 id 由小時光那一份負責
    results = []
    for tbl, pk in (('auth.users', 'id'), ('auth.identities', 'id')):
        meta = {r['t']: r for r in table_meta(ref, 'auth')}[tbl.split('.')[1]]
        src = fingerprints(ref, tbl, pk, reps)
        dst = fingerprints(TARGET, tbl, pk, [])
        if tbl == 'auth.users':
            src = {k: v for k, v in src.items() if not (site != 'ib' and k in canon_from_other)}
        else:
            # identities 的主鍵是 identity id；重複帳號那幾列的 user_id 在 remap 後指向小時光的帳號，跳過
            uid = {r['k']: r['u'] for r in query(ref, f"select id::text k, user_id::text u from auth.identities")}
            src = {k: v for k, v in src.items() if not (site != 'ib' and apply_text(uid.get(k, ''), reps) in canon_from_other)}
        missing = [k for k in src if k not in dst]
        changed = [k for k in src if k in dst and src[k] != dst[k]]
        n = 0
        if apply_ and (missing or changed):
            rows = fetch_rows(ref, tbl, pk, missing + changed, meta['gen'], reps)
            # 帳號用正常模式：新帳號要觸發 fan-out trigger 長出三個 schema 的 profile
            n = upsert(tbl, meta['cols'], pk, rows, False, replica=False)
        results.append((tbl, len(src), len(missing), len(changed), n))
    return results


def sync_schema(site, ref, s_schema, d_schema, apply_):
    reps = replacements(site)
    out = []
    for m in table_meta(ref, s_schema):
        t = m['t']
        if (site, t) in SKIP: continue
        if not m['pk']:
            out.append((t, '沒有主鍵，略過', 0, 0, 0, 0)); continue
        sq, dq = f'"{s_schema}"."{t}"', f'"{d_schema}"."{t}"'
        src = fingerprints(ref, sq, m['pk'], reps)
        dst = fingerprints(TARGET, dq, m['pk'], [])
        missing = [k for k in src if k not in dst]
        changed = [k for k in src if k in dst and src[k] != dst[k]]
        extra = len([k for k in dst if k not in src])
        n = 0
        if apply_ and (missing or changed):
            rows = fetch_rows(ref, sq, m['pk'], missing + changed, m['gen'], reps)
            n = upsert(dq, m['cols'], m['pk'], rows, m['ident_always'])
        if missing or changed or (extra and t != 'profiles'):
            out.append((t, len(src), len(missing), len(changed), extra, n))
    # 序列照來源
    seqs = query(ref, f"select sequencename n from pg_sequences where schemaname={sql_str(s_schema)}")
    seq_fix = 0
    for s in seqs:
        sv = query(ref, f'select last_value v, is_called c from "{s_schema}"."{s["n"]}"')[0]
        dv = query(TARGET, f'select last_value v, is_called c from "{d_schema}"."{s["n"]}"')[0]
        if (str(sv['v']), sv['c']) != (str(dv['v']), dv['c']):
            seq_fix += 1
            if apply_:
                query(TARGET, f"select setval({sql_str(d_schema + '.' + s['n'])}, {sv['v']}, {'true' if sv['c'] else 'false'})")
    return out, seq_fix


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--apply', action='store_true')
    ap.add_argument('--site', action='append', choices=list(SITES))
    a = ap.parse_args()
    for site in a.site or ['ib', 'hh', 'gd']:
        name, ref, pairs = SITES[site]
        print(f"═══ {name}{'（套用）' if a.apply else '（試跑，不寫入）'}")
        for tbl, total, miss, chg, n in sync_auth(site, ref, a.apply):
            print(f"  {tbl:<16} 來源 {total}：缺 {miss}、變動 {chg}" + (f" → 已寫入 {n}" if a.apply else ''))
        for s_schema, d_schema in pairs:
            rows, seq_fix = sync_schema(site, ref, s_schema, d_schema, a.apply)
            if not rows: print(f"  {s_schema}→{d_schema}：業務表全部一致")
            for t, total, miss, chg, extra, n in rows:
                print(f"  {s_schema}.{t:<26} 缺 {miss}、變動 {chg}" + (f"、目標多 {extra}（不刪，只回報）" if extra else '') + (f" → 已寫入 {n}" if a.apply else ''))
            print(f"  序列需對齊：{seq_fix}" + ('（已對齊）' if a.apply and seq_fix else ''))


if __name__ == '__main__':
    main()
