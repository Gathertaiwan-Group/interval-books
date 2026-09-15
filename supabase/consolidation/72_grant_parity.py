#!/usr/bin/env python3
"""72_grant_parity.py — 來源與目標的**有效權限**逐物件比對（表／序列／函式，對 anon／authenticated／service_role）。

  72_grant_parity.py --src <ref> --src-schema public --dst <ref> --dst-schema happyhands

為什麼需要這支：`schema_diff.sh` 只證明了小時光 public/inv 逐字一致；快樂手與好日子是「改寫後重建」，
grant 模型是否照搬過來沒有任何東西在把關。快樂手靠「沒有 grant」擋住 9 張只給 service role 的表
（計畫風險 10），好日子則是原本 16 支 migration 從沒寫過 grant、全靠 public 的隱含全開（30 才補上）——
兩邊都只能用「來源有什麼、目標就該有什麼」來驗。

比的是 `has_*_privilege` 的結果（有效權限，含繼承與 PUBLIC），不是 ACL 字面值。
"""
import argparse, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mgmt import query, sql_str

ROLES = ['anon', 'authenticated', 'service_role']
TABLE_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
SEQ_PRIVS = ['SELECT', 'UPDATE', 'USAGE']


def arr(xs):
    return 'array[' + ', '.join(sql_str(x) for x in xs) + ']'


def probe(ref, schema):
    r = {}
    rows = query(ref, f"""
select 'schema' kind, {sql_str(schema)} obj, r.role,
       (case when has_schema_privilege(r.role, {sql_str(schema)}, 'USAGE') then 'USAGE ' else '' end ||
        case when has_schema_privilege(r.role, {sql_str(schema)}, 'CREATE') then 'CREATE' else '' end) privs
  from unnest({arr(ROLES)}) r(role)
union all
select 'table', c.relname, r.role,
       (select coalesce(string_agg(p, ' ' order by p), '') from unnest({arr(TABLE_PRIVS)}) p
         where has_table_privilege(r.role, c.oid, p))
  from pg_class c, unnest({arr(ROLES)}) r(role)
 where c.relnamespace = {sql_str(schema)}::regnamespace and c.relkind in ('r','v','p','m')
union all
select 'sequence', c.relname, r.role,
       (select coalesce(string_agg(p, ' ' order by p), '') from unnest({arr(SEQ_PRIVS)}) p
         where has_sequence_privilege(r.role, c.oid, p))
  from pg_class c, unnest({arr(ROLES)}) r(role)
 where c.relnamespace = {sql_str(schema)}::regnamespace and c.relkind = 'S'
union all
select 'function', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', r.role,
       case when has_function_privilege(r.role, p.oid, 'EXECUTE') then 'EXECUTE' else '' end
  from pg_proc p, unnest({arr(ROLES)}) r(role)
 where p.pronamespace = {sql_str(schema)}::regnamespace and p.prokind in ('f','p')
""")
    for row in rows:
        r[(row['kind'], row['obj'], row['role'])] = row['privs']
    return r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True); ap.add_argument('--src-schema', required=True)
    ap.add_argument('--dst', required=True); ap.add_argument('--dst-schema', required=True)
    ap.add_argument('--ignore', action='append', default=[], help='略過的物件名（目標刻意多出來的）')
    a = ap.parse_args()
    s, d = probe(a.src, a.src_schema), probe(a.dst, a.dst_schema)

    def key(k):  # schema 名本身不同，比對時歸一化
        return ('schema', '<self>', k[2]) if k[0] == 'schema' else k

    s = {key(k): v for k, v in s.items()}; d = {key(k): v for k, v in d.items()}
    bad = 0
    for k in sorted(set(s) | set(d)):
        if any(ig in k[1] for ig in a.ignore):
            continue
        sv, dv = s.get(k), d.get(k)
        if sv is None:
            print(f"  ⚠️  目標多出 {k[0]} {k[1]}（{k[2]}: {dv or '無權限'}）"); bad += 1
        elif dv is None:
            print(f"  ❌ 目標少了 {k[0]} {k[1]}（來源 {k[2]}: {sv or '無權限'}）"); bad += 1
        elif sv != dv:
            print(f"  ❌ {k[0]} {k[1]} 的 {k[2]}：來源 [{sv or '無'}] → 目標 [{dv or '無'}]"); bad += 1
    total = len(set(s) | set(d))
    print(f"{'✅ 權限完全一致' if bad == 0 else f'❌ {bad} 項不同'}（比對 {total} 組物件×角色，"
          f"{a.src}.{a.src_schema} → {a.dst}.{a.dst_schema}）")
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
