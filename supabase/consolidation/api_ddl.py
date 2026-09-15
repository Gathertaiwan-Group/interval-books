#!/usr/bin/env python3
"""api_ddl.py — 用 Management API 從 catalog 產出 schema-only DDL（仿 pg_dump --schema-only --no-owner），不需要 DB 密碼。
  api_ddl.py --ref REF --out FILE --schema public --schema inv

與 pg_dump 的差別（刻意的）：
  - 建立順序：schema／default acl → 序列 → 表（先不帶 default）→ identity → 函式 → column default → 約束 → 索引 → view → trigger → policy。
    default 延後是因為 default 可能呼叫 public/inv 自己的函式；函式簽章又可能用到表型別（例如 RETURNS public.profiles）。
  - ACL 一律寫成「REVOKE ALL（PUBLIC＋四個角色）再 GRANT」的明示狀態；載入後把目標再跑一次本產生器，
    兩份輸出 diff 為空就證明 catalog 相同（schema_diff.sh）。
  - 只支援這三個庫實際用到的功能；遇到沒支援的物件（matview、partition、column acl、domain…）直接中止，不會默默漏掉。
所有 catalog 反解析都在 search_path = '' 之下（與 pg_dump 相同），所以型別／函式／表名全部帶 schema。
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mgmt import query, in_list

ROLES = ['postgres', 'anon', 'authenticated', 'service_role']
OBJTYPE = {'r': 'TABLES', 'S': 'SEQUENCES', 'f': 'FUNCTIONS', 'T': 'TYPES', 'n': 'SCHEMAS'}
POLCMD = {'*': 'ALL', 'r': 'SELECT', 'a': 'INSERT', 'w': 'UPDATE', 'd': 'DELETE'}
TGMODE = {'D': 'DISABLE TRIGGER', 'R': 'ENABLE REPLICA TRIGGER', 'A': 'ENABLE ALWAYS TRIGGER'}
HEADER = """--
-- PostgreSQL database dump
--

-- Dumped from database version {ver}
-- Dumped by api_ddl.py (Supabase Management API, schema-only, no owner) — schemas: {schemas}

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

"""


def ACL(expr):
    return (f"(select json_agg(json_build_object('g', coalesce(r.rolname,'PUBLIC'), 'p', x.privilege_type) "
            f"order by coalesce(r.rolname,'PUBLIC'), x.privilege_type) from aclexplode({expr}) x left join pg_roles r on r.oid=x.grantee)")


def js(v):
    return json.loads(v) if isinstance(v, str) else v


def pg_array(v):
    """text[] 可能以 JSON array 或 '{a,b}' 字串回來。"""
    if v is None:
        return []
    if isinstance(v, list):
        return v
    return [x for x in v.strip('{}').split(',') if x]


def acl_stmts(kind, ident, acl_null, acl):
    if acl_null:
        return []
    out = [f"REVOKE ALL ON {kind} {ident} FROM PUBLIC;"] + [f"REVOKE ALL ON {kind} {ident} FROM {r};" for r in ROLES]
    by = {}
    for e in js(acl) or []:
        by.setdefault(e['g'], []).append(e['p'])
    for g in sorted(by):
        out.append(f"GRANT {', '.join(sorted(by[g]))} ON {kind} {ident} TO {g};")
    return out


def topo(items, key, deps):
    """依 deps（key 的集合）做穩定拓樸排序；items 已按名稱排好，同層維持原序。"""
    done, out, remaining = set(), [], list(items)
    while remaining:
        progressed = False
        for it in list(remaining):
            if all(d in done or d not in {key(x) for x in items} for d in deps(it)):
                out.append(it); done.add(key(it)); remaining.remove(it); progressed = True
        if not progressed:
            raise SystemExit(f'❌ 循環依賴：{[key(x) for x in remaining]}')
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ref', required=True); ap.add_argument('--out', required=True)
    ap.add_argument('--schema', action='append', required=True)
    a = ap.parse_args()
    S = in_list(a.schema)

    def q(sql):
        return query(a.ref, "set local search_path = '';\n" + sql)

    ver = q("select current_setting('server_version') v")[0]['v']
    L = [HEADER.format(ver=ver, schemas=', '.join(a.schema))]

    # ── 0. 不支援的功能一律中止（寧可停也不要默默漏）─────────────────────────────────────
    unsup = q(f"""select
 (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in {S} and c.relkind in ('m','p','f')) matview_part_foreign,
 (select count(*) from pg_inherits i join pg_class c on c.oid=i.inhrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in {S}) inherits,
 (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in {S} and c.relkind in ('r') and c.relpersistence<>'p') unlogged,
 (select count(*) from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname in {S} and t.typtype in ('d','r','m') ) domain_range,
 (select count(*) from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname in {S} and t.typtype='c' and not exists (select 1 from pg_class c where c.reltype=t.oid)) composite,
 (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in {S} and p.prokind not in ('f','p')) agg_window,
 (select count(*) from pg_statistic_ext s join pg_namespace n on n.oid=s.stxnamespace where n.nspname in {S}) ext_stats,
 (select count(*) from pg_rewrite r join pg_class c on c.oid=r.ev_class join pg_namespace n on n.oid=c.relnamespace where n.nspname in {S} and r.rulename<>'_RETURN') rules,
 (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace, aclexplode(c.relacl) x where n.nspname in {S} and x.is_grantable) grant_option,
 (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in {S} and c.relkind in ('r') and (c.reloptions is not null or c.relreplident<>'d')) table_options,
 (select count(*) from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace join pg_type t on t.oid=a.atttypid where n.nspname in {S} and c.relkind='r' and a.attnum>0 and not a.attisdropped and (a.attstorage<>t.typstorage or a.attcompression<>'' or a.attstattarget is not null)) column_storage,
 (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in {S} and c.relkind in ('r','v','S','p','m') and pg_get_userbyid(c.relowner)<>'postgres') non_postgres_owner,
 (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in {S} and pg_get_userbyid(p.proowner)<>'postgres') non_postgres_fn_owner,
 (select count(*) from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname in {S} and t.typacl is not null) type_acl,
 (select count(*) from pg_index x join pg_class i on i.oid=x.indexrelid join pg_namespace n on n.oid=i.relnamespace where n.nspname in {S} and (not x.indisvalid or x.indisclustered)) odd_index,
 (select count(*) from pg_ts_config t join pg_namespace n on n.oid=t.cfgnamespace where n.nspname in {S}) ts_config""")[0]
    bad = {k: v for k, v in unsup.items() if int(v) != 0}
    if bad:
        raise SystemExit(f'❌ 有產生器不支援的物件，先擴充再跑：{bad}')

    # ── 1. schema、comment、default privileges、schema ACL ─────────────────────────────────
    L.append('--\n-- Schemas\n--\n\n')
    for s in q(f"""select n.nspname, quote_ident(n.nspname) qn, n.nspacl is null acl_null, {ACL('n.nspacl')} acl,
                     quote_literal(obj_description(n.oid,'pg_namespace')) cmt
                   from pg_namespace n where n.nspname in {S} order by 1"""):
        if s['nspname'] != 'public':
            L.append(f"CREATE SCHEMA {s['qn']};\n")
        if s['cmt']:
            L.append(f"COMMENT ON SCHEMA {s['qn']} IS {s['cmt']};\n")
        if s['nspname'] != 'public':  # public 是 pg_database_owner 的，平台預設，兩邊本來就一樣
            L.extend(x + '\n' for x in acl_stmts('SCHEMA', s['qn'], s['acl_null'], s['acl']))
        L.append('\n')
    for d in q(f"""select r.rolname role, quote_ident(n.nspname) qn, d.defaclobjtype t, {ACL('d.defaclacl')} acl
                   from pg_default_acl d join pg_roles r on r.oid=d.defaclrole join pg_namespace n on n.oid=d.defaclnamespace
                   where n.nspname in {S} and n.nspname<>'public' order by 1,2,3"""):
        obj = OBJTYPE[d['t']]
        pre = f"ALTER DEFAULT PRIVILEGES FOR ROLE {d['role']} IN SCHEMA {d['qn']}"
        L.append(f"{pre} REVOKE ALL ON {obj} FROM PUBLIC;\n{pre} REVOKE ALL ON {obj} FROM {d['role']};\n")
        by = {}
        for e in js(d['acl']) or []:
            by.setdefault(e['g'], []).append(e['p'])
        for g in sorted(by):
            L.append(f"{pre} GRANT {', '.join(sorted(by[g]))} ON {obj} TO {g};\n")
        L.append('\n')

    # ── 2. enum ───────────────────────────────────────────────────────────────────────────
    for t in q(f"""select quote_ident(n.nspname)||'.'||quote_ident(t.typname) qn,
                     (select string_agg(quote_literal(e.enumlabel), ', ' order by e.enumsortorder) from pg_enum e where e.enumtypid=t.oid) labels,
                     quote_literal(obj_description(t.oid,'pg_type')) cmt
                   from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname in {S} and t.typtype='e' order by 1"""):
        L.append(f"CREATE TYPE {t['qn']} AS ENUM ({t['labels']});\n")
        if t['cmt']:
            L.append(f"COMMENT ON TYPE {t['qn']} IS {t['cmt']};\n")
        L.append('\n')

    # ── 3. 序列（identity 的在表那段建；serial／獨立的在這裡建，OWNED BY 等表建好再補）──────
    seqs = q(f"""select n.nspname s, c.relname nm, quote_ident(n.nspname)||'.'||quote_ident(c.relname) qn, format_type(sq.seqtypid, null) typ,
                   sq.seqstart, sq.seqincrement, sq.seqmin, sq.seqmax, sq.seqcache, sq.seqcycle,
                   c.relacl is null acl_null, {ACL('c.relacl')} acl, quote_literal(obj_description(c.oid,'pg_class')) cmt,
                   d.deptype, quote_ident(dn.nspname)||'.'||quote_ident(dc.relname) own_tbl, quote_ident(a.attname) own_col
                 from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_sequence sq on sq.seqrelid=c.oid
                 left join pg_depend d on d.objid=c.oid and d.classid='pg_class'::regclass and d.refclassid='pg_class'::regclass and d.deptype in ('a','i')
                 left join pg_class dc on dc.oid=d.refobjid left join pg_namespace dn on dn.oid=dc.relnamespace
                 left join pg_attribute a on a.attrelid=d.refobjid and a.attnum=d.refobjsubid
                 where n.nspname in {S} and c.relkind='S' order by 1,2""")

    def seq_params(s, indent='    ', with_type=True):
        p = []
        if with_type and s['typ'] != 'bigint':  # identity 的序列型別跟著欄位走，選項裡不能再寫 AS type
            p.append(f"AS {s['typ']}")
        p += [f"START WITH {s['seqstart']}", f"INCREMENT BY {s['seqincrement']}", f"MINVALUE {s['seqmin']}",
              f"MAXVALUE {s['seqmax']}", f"CACHE {s['seqcache']}"] + (['CYCLE'] if s['seqcycle'] else [])
        return ''.join(f"{indent}{x}\n" for x in p)

    def seq_extras(s):
        out = ''
        if s['cmt']:
            out += f"COMMENT ON SEQUENCE {s['qn']} IS {s['cmt']};\n"
        out += ''.join(x + '\n' for x in acl_stmts('SEQUENCE', s['qn'], s['acl_null'], s['acl']))
        return out

    identity_seq = {(s['own_tbl'], s['own_col']): s for s in seqs if s['deptype'] == 'i'}
    L.append('--\n-- Sequences\n--\n\n')
    for s in seqs:
        if s['deptype'] == 'i':
            continue
        L.append(f"CREATE SEQUENCE {s['qn']}\n{seq_params(s)}".rstrip('\n') + ';\n' + seq_extras(s) + '\n')

    # ── 4. 表（欄位、NOT NULL、COLLATE；default 延後）、comment、RLS、ACL、identity ───────────
    tables = q(f"""select n.nspname s, c.relname nm, quote_ident(n.nspname)||'.'||quote_ident(c.relname) qn, c.relrowsecurity rls, c.relforcerowsecurity frls,
                     c.relacl is null acl_null, {ACL('c.relacl')} acl, quote_literal(obj_description(c.oid,'pg_class')) cmt,
                     (select json_agg(json_build_object('name', quote_ident(a.attname), 'type', format_type(a.atttypid, a.atttypmod), 'notnull', a.attnotnull,
                         'default', pg_get_expr(ad.adbin, ad.adrelid), 'identity', a.attidentity, 'generated', a.attgenerated,
                         'collate', case when a.attcollation<>0 and a.attcollation<>t.typcollation then
                             (select quote_ident(cn.nspname)||'.'||quote_ident(co.collname) from pg_collation co join pg_namespace cn on cn.oid=co.collnamespace where co.oid=a.attcollation) end,
                         'cmt', quote_literal(col_description(c.oid, a.attnum)),
                         'acl', {ACL('a.attacl')}) order by a.attnum)
                      from pg_attribute a join pg_type t on t.oid=a.atttypid left join pg_attrdef ad on ad.adrelid=c.oid and ad.adnum=a.attnum
                      where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped) cols
                   from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in {S} and c.relkind='r' order by 1,2""")
    defaults = []
    L.append('--\n-- Tables\n--\n\n')
    for t in tables:
        cols = js(t['cols'])
        lines = []
        for c in cols:
            ln = f"    {c['name']} {c['type']}"
            if c['collate']:
                ln += f" COLLATE {c['collate']}"
            if c['generated'] == 's':
                ln += f" GENERATED ALWAYS AS ({c['default']}) STORED"
            if c['notnull']:
                ln += ' NOT NULL'
            lines.append(ln)
            if c['default'] is not None and c['identity'] == '' and c['generated'] == '':
                defaults.append((t['qn'], c['name'], c['default']))
        L.append(f"CREATE TABLE {t['qn']} (\n" + ',\n'.join(lines) + '\n);\n')
        if t['cmt']:
            L.append(f"COMMENT ON TABLE {t['qn']} IS {t['cmt']};\n")
        for c in cols:
            if c['cmt']:
                L.append(f"COMMENT ON COLUMN {t['qn']}.{c['name']} IS {c['cmt']};\n")
        for c in cols:
            if c['identity']:
                s = identity_seq.get((t['qn'], c['name']))
                if not s:
                    raise SystemExit(f"❌ 找不到 identity 序列：{t['qn']}.{c['name']}")
                kind = 'ALWAYS' if c['identity'] == 'a' else 'BY DEFAULT'
                L.append(f"ALTER TABLE {t['qn']} ALTER COLUMN {c['name']} ADD GENERATED {kind} AS IDENTITY (\n    SEQUENCE NAME {s['qn']}\n{seq_params(s, with_type=False)});\n")
                L.append(seq_extras(s))
        if t['rls']:
            L.append(f"ALTER TABLE {t['qn']} ENABLE ROW LEVEL SECURITY;\n")
        if t['frls']:
            L.append(f"ALTER TABLE {t['qn']} FORCE ROW LEVEL SECURITY;\n")
        L.extend(x + '\n' for x in acl_stmts('TABLE', t['qn'], t['acl_null'], t['acl']))
        for c in cols:  # 欄位級 ACL：預設為空、表級 REVOKE 不會動到它，直接 GRANT 即可
            by = {}
            for e in js(c['acl']) or []:
                by.setdefault(e['g'], []).append(e['p'])
            for g in sorted(by):
                L.append(f"GRANT {', '.join(p + '(' + c['name'] + ')' for p in sorted(by[g]))} ON TABLE {t['qn']} TO {g};\n")
        L.append('\n')
    for s in seqs:
        if s['deptype'] == 'a':
            L.append(f"ALTER SEQUENCE {s['qn']} OWNED BY {s['own_tbl']}.{s['own_col']};\n")
    L.append('\n')

    # ── 5. 函式（依 pg_depend 拓樸；本體不驗證，與 pg_dump 的 check_function_bodies=false 相同）──
    fns = q(f"""select p.oid, n.nspname s, p.proname nm, p.prokind,
                  quote_ident(n.nspname)||'.'||quote_ident(p.proname)||'('||pg_get_function_identity_arguments(p.oid)||')' sig,
                  pg_get_functiondef(p.oid) def, p.proacl is null acl_null, {ACL('p.proacl')} acl, quote_literal(obj_description(p.oid,'pg_proc')) cmt,
                  (select json_agg(d.refobjid) from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.refclassid='pg_proc'::regclass and d.refobjid<>p.oid) deps
                from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in {S} and p.prokind in ('f','p') order by 2,3,5""")
    fns = topo(fns, lambda f: f['oid'], lambda f: js(f['deps']) or [])
    L.append('--\n-- Functions\n--\n\n')
    for f in fns:
        kind = 'PROCEDURE' if f['prokind'] == 'p' else 'FUNCTION'
        L.append(f['def'].rstrip() + ';\n')
        if f['cmt']:
            L.append(f"COMMENT ON {kind} {f['sig']} IS {f['cmt']};\n")
        L.extend(x + '\n' for x in acl_stmts(kind, f['sig'], f['acl_null'], f['acl']))
        L.append('\n')

    # ── 6. column default（此時函式與序列都在了）───────────────────────────────────────────
    L.append('--\n-- Column defaults\n--\n\n')
    for qn, col, d in defaults:
        L.append(f"ALTER TABLE ONLY {qn} ALTER COLUMN {col} SET DEFAULT {d};\n")
    L.append('\n')

    # ── 7. 約束：PK／UNIQUE／CHECK／EXCLUDE 先，FK 後 ──────────────────────────────────────────
    cons = q(f"""select quote_ident(n.nspname)||'.'||quote_ident(c.relname) qn, quote_ident(k.conname) cn, k.contype, pg_get_constraintdef(k.oid) def,
                   quote_literal(obj_description(k.oid,'pg_constraint')) cmt
                 from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace
                 where n.nspname in {S} and k.contype in ('p','u','c','x','f') and k.conparentid=0
                 order by (k.contype='f'), n.nspname, c.relname, k.conname""")
    L.append('--\n-- Constraints\n--\n\n')
    for k in cons:
        L.append(f"ALTER TABLE ONLY {k['qn']}\n    ADD CONSTRAINT {k['cn']} {k['def']};\n")
        if k['cmt']:
            L.append(f"COMMENT ON CONSTRAINT {k['cn']} ON {k['qn']} IS {k['cmt']};\n")
    L.append('\n')

    # ── 8. 索引（約束自帶的不重建，但 comment 照補）──────────────────────────────────────────
    idx = q(f"""select quote_ident(n.nspname)||'.'||quote_ident(i.relname) iqn, pg_get_indexdef(i.oid) def, quote_literal(obj_description(i.oid,'pg_class')) cmt,
                  exists (select 1 from pg_constraint k where k.conindid=i.oid and k.contype in ('p','u','x')) is_con
                from pg_index x join pg_class c on c.oid=x.indrelid join pg_class i on i.oid=x.indexrelid join pg_namespace n on n.oid=c.relnamespace
                where n.nspname in {S} order by n.nspname, c.relname, i.relname""")
    L.append('--\n-- Indexes\n--\n\n')
    for i in idx:
        if not i['is_con']:
            L.append(i['def'] + ';\n')
        if i['cmt']:
            L.append(f"COMMENT ON INDEX {i['iqn']} IS {i['cmt']};\n")
    L.append('\n')

    # ── 9. view（依 view 之間的依賴拓樸；options 如 security_invoker 照搬）────────────────────
    views = q(f"""select c.oid, quote_ident(n.nspname)||'.'||quote_ident(c.relname) qn, c.reloptions::text opts, pg_get_viewdef(c.oid, true) def,
                    c.relacl is null acl_null, {ACL('c.relacl')} acl, quote_literal(obj_description(c.oid,'pg_class')) cmt,
                    (select json_agg(json_build_object('name', quote_ident(a.attname), 'cmt', quote_literal(col_description(c.oid,a.attnum))) order by a.attnum)
                       from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped and col_description(c.oid,a.attnum) is not null) colcmts,
                    (select json_agg(distinct d.refobjid) from pg_depend d join pg_rewrite r on r.oid=d.objid
                       where r.ev_class=c.oid and d.classid='pg_rewrite'::regclass and d.refclassid='pg_class'::regclass and d.refobjid<>c.oid
                         and exists (select 1 from pg_class rc where rc.oid=d.refobjid and rc.relkind='v')) deps
                  from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in {S} and c.relkind='v' order by n.nspname, c.relname""")
    views = topo(views, lambda v: v['oid'], lambda v: js(v['deps']) or [])
    L.append('--\n-- Views\n--\n\n')
    for v in views:
        opts = pg_array(v['opts'])
        with_ = f" WITH ({', '.join(o.split('=',1)[0] + '=' + repr(o.split('=',1)[1]) for o in opts)})" if opts else ''
        L.append(f"CREATE VIEW {v['qn']}{with_} AS\n{v['def'].rstrip().rstrip(';')};\n")
        if v['cmt']:
            L.append(f"COMMENT ON VIEW {v['qn']} IS {v['cmt']};\n")
        for c in js(v['colcmts']) or []:
            L.append(f"COMMENT ON COLUMN {v['qn']}.{c['name']} IS {c['cmt']};\n")
        L.extend(x + '\n' for x in acl_stmts('TABLE', v['qn'], v['acl_null'], v['acl']))
        L.append('\n')

    # ── 10. trigger ───────────────────────────────────────────────────────────────────────
    trgs = q(f"""select quote_ident(n.nspname)||'.'||quote_ident(c.relname) qn, quote_ident(t.tgname) tn, pg_get_triggerdef(t.oid) def, t.tgenabled,
                   quote_literal(obj_description(t.oid,'pg_trigger')) cmt
                 from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
                 where n.nspname in {S} and not t.tgisinternal order by n.nspname, c.relname, t.tgname""")
    L.append('--\n-- Triggers\n--\n\n')
    for t in trgs:
        L.append(t['def'] + ';\n')
        if t['tgenabled'] != 'O':
            L.append(f"ALTER TABLE {t['qn']} {TGMODE[t['tgenabled']]} {t['tn']};\n")
        if t['cmt']:
            L.append(f"COMMENT ON TRIGGER {t['tn']} ON {t['qn']} IS {t['cmt']};\n")
    L.append('\n')

    # ── 11. policy ────────────────────────────────────────────────────────────────────────
    pols = q(f"""select quote_ident(n.nspname)||'.'||quote_ident(c.relname) qn, quote_ident(p.polname) pn, p.polpermissive perm, p.polcmd::text cmd,
                   (select string_agg(coalesce(quote_ident(r.rolname),'PUBLIC'), ', ' order by coalesce(r.rolname,'')) from unnest(p.polroles) u(oid) left join pg_roles r on r.oid=u.oid) roles,
                   pg_get_expr(p.polqual, p.polrelid) qual, pg_get_expr(p.polwithcheck, p.polrelid) wc, quote_literal(obj_description(p.oid,'pg_policy')) cmt
                 from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace
                 where n.nspname in {S} order by n.nspname, c.relname, p.polname""")
    L.append('--\n-- Policies\n--\n\n')
    for p in pols:
        st = f"CREATE POLICY {p['pn']} ON {p['qn']} AS {'PERMISSIVE' if p['perm'] else 'RESTRICTIVE'} FOR {POLCMD[p['cmd']]} TO {p['roles']}"
        if p['qual'] is not None:
            st += f" USING ({p['qual']})"
        if p['wc'] is not None:
            st += f" WITH CHECK ({p['wc']})"
        L.append(st + ';\n')
        if p['cmt']:
            L.append(f"COMMENT ON POLICY {p['pn']} ON {p['qn']} IS {p['cmt']};\n")
    L.append('\n--\n-- PostgreSQL database dump complete\n--\n')

    with open(a.out, 'w', encoding='utf-8') as f:
        f.write(''.join(L))
    print(f"✅ {a.out}：表 {len(tables)}、序列 {len(seqs)}、函式 {len(fns)}、約束 {len(cons)}、索引 {len(idx)}、view {len(views)}、"
          f"trigger {len(trgs)}、policy {len(pols)}、default {len(defaults)}、{os.path.getsize(a.out)} bytes")


if __name__ == '__main__':
    main()
