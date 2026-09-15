#!/usr/bin/env python3
"""gen_grants.py — 從**來源專案的實際 ACL** 產生目標 schema 的 grant 腳本（30 的產生器）。

  gen_grants.py --ref <來源 ref> --src-schema public --schema gooddays --out 30_gooddays_grants.sql

為什麼不能用「照 Supabase 對 public 的預設全開」一句帶過（原本 30 就是這樣寫的，2026-09-15 被 72 抓到）：
好日子的 live 庫裡有 6 個物件其實是**關著的**——`v_user_points_balance`／`v_expirable_earn_points`
兩個 view 是 `security_invoker=false`（繞過底下表的 RLS）、`reserve_course_seat`／
`release_course_seats_for_order`／`expire_course_reservations`／`handle_new_user` 四支是 security definer，
來源只給 service_role。一句 `grant all on all tables/functions` 會把全體會員的點數餘額與座位操作對 anon 打開。

做法：逐物件 `revoke all`（PUBLIC ＋三個角色）再照來源的 ACL `grant` 回去，所以腳本可重複執行、
也會把先前多給的權限收回來。驗收用 `72_grant_parity.py`。
"""
import argparse, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mgmt import query, sql_str

ROLES = ['PUBLIC', 'anon', 'authenticated', 'service_role']
OBJ = {'r': 'TABLE', 'v': 'TABLE', 'm': 'TABLE', 'p': 'TABLE', 'S': 'SEQUENCE'}
DEFACL = {'r': 'TABLES', 'S': 'SEQUENCES', 'f': 'FUNCTIONS'}


def acl_json(expr):
    return (f"(select json_agg(json_build_object('g', coalesce(r.rolname,'PUBLIC'), 'p', x.privilege_type) "
            f"order by coalesce(r.rolname,'PUBLIC'), x.privilege_type) from aclexplode({expr}) x "
            f"left join pg_roles r on r.oid=x.grantee where coalesce(r.rolname,'PUBLIC') = any({sql_str('{' + ','.join(ROLES) + '}')}::text[]))")


def grants_for(kind, ident, acl):
    out = [f"revoke all on {kind} {ident} from {r};" for r in ROLES]
    by = {}
    for e in acl or []:
        by.setdefault(e['g'], []).append(e['p'])
    for g in sorted(by):
        out.append(f"grant {', '.join(sorted(by[g]))} on {kind} {ident} to {g};")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ref', required=True); ap.add_argument('--src-schema', default='public')
    ap.add_argument('--schema', required=True); ap.add_argument('--out', required=True)
    ap.add_argument('--also-schema', action='append', default=[], help='額外附帶的 schema，格式 來源:目標')
    ap.add_argument('--skip', action='append', default=[], help='來源有、目標刻意沒有的物件名（例如好日子的 _migrations 帳本）')
    a = ap.parse_args()

    def emit(src_schema, dst_schema, L):
        def q(sql):
            return query(a.ref, "set local search_path = '';\n" + sql)
        L.append(f"\n-- ═══ {dst_schema}（來源 {a.ref}.{src_schema}）═══\n")
        # schema usage / create
        for r in q(f"""select r.role, has_schema_privilege(r.role, {sql_str(src_schema)}, 'USAGE') u,
                              has_schema_privilege(r.role, {sql_str(src_schema)}, 'CREATE') c
                       from unnest(array[{','.join(sql_str(x) for x in ROLES if x != 'PUBLIC')}]) r(role)"""):
            privs = [p for p, ok in (('usage', r['u']), ('create', r['c'])) if ok]
            L.append(f"revoke all on schema {dst_schema} from {r['role']};\n")
            if privs:
                L.append(f"grant {', '.join(privs)} on schema {dst_schema} to {r['role']};\n")
        # 表／view／序列
        for o in q(f"""select c.relname nm, c.relkind, {acl_json('c.relacl')} acl
                       from pg_class c where c.relnamespace={sql_str(src_schema)}::regnamespace
                         and c.relkind in ('r','v','m','p','S') order by c.relkind, c.relname"""):
            if o['nm'] in a.skip:
                L.append(f"-- （略過 {o['nm']}：目標刻意沒有這個物件）\n"); continue
            L.extend(x + '\n' for x in grants_for(OBJ[o['relkind']], f"{dst_schema}.\"{o['nm']}\"", o['acl']))
        # 函式
        for o in q(f"""select p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' sig, p.prokind,
                              {acl_json('p.proacl')} acl
                       from pg_proc p where p.pronamespace={sql_str(src_schema)}::regnamespace
                         and p.prokind in ('f','p') order by 1"""):
            if o['sig'].split('(')[0] in a.skip:
                L.append(f"-- （略過 {o['sig']}：目標刻意沒有這個物件）\n"); continue
            kind = 'procedure' if o['prokind'] == 'p' else 'function'
            L.extend(x + '\n' for x in grants_for(kind, f"{dst_schema}.{o['sig']}", o['acl']))
        # default privileges（未來新建的物件跟來源同樣的預設）
        for d in q(f"""select d.defaclobjtype t, {acl_json('d.defaclacl')} acl
                       from pg_default_acl d join pg_roles r on r.oid=d.defaclrole join pg_namespace n on n.oid=d.defaclnamespace
                       where n.nspname={sql_str(src_schema)} and r.rolname='postgres' order by 1"""):
            obj = DEFACL[d['t']]
            pre = f"alter default privileges in schema {dst_schema}"
            for r in ROLES:
                L.append(f"{pre} revoke all on {obj} from {r};\n")
            by = {}
            for e in d['acl'] or []:
                by.setdefault(e['g'], []).append(e['p'])
            for g in sorted(by):
                L.append(f"{pre} grant {', '.join(sorted(by[g]))} on {obj} to {g};\n")

    L = [f"-- 由 gen_grants.py 從 {a.ref} 的實際 ACL 產生，不要手改；改規則請改產生器。\n",
         "-- 目的：目標 schema 的有效權限＝來源 schema 的有效權限（對 PUBLIC／anon／authenticated／service_role）。\n",
         "-- 🔴 不可以用 `grant all on all tables/functions` 一句帶過：好日子有 2 個繞過 RLS 的 view 與 4 支\n",
         "--    security definer 函式在來源是只給 service_role 的，全開等於把會員點數與座位操作對 anon 打開。\n",
         "-- 驗收：72_grant_parity.py 逐物件×角色比對有效權限。\n"]
    emit(a.src_schema, a.schema, L)
    for pair in a.also_schema:
        s, d = pair.split(':', 1)
        emit(s, d, L)
    open(a.out, 'w', encoding='utf-8').write(''.join(L))
    print(f"✅ {a.out}：{sum(1 for x in L if x.startswith(('grant','revoke','alter')))} 條語句")


if __name__ == '__main__':
    main()
