#!/usr/bin/env python3
"""data_diff.py — 來源專案 vs 目標專案逐表比對：count(*) 與整表 md5（列文字排序後串起來）。兩邊都走 Management API，同一組 session 設定。
  data_diff.py --src REF --dst REF --schema public=happyhands [--schema inv=inv] [--table auth.users=auth.users ...]
               [--remap remap.tsv --site hh] [--replace old=new ...] [--filter auth.users:id --filter auth.identities:user_id --filter public.profiles:id]
  --remap/--site：來源列文字先做 old→canon 的 UUID 替換（與 50 的 sed 相同語意）；被 remap 掉的帳號在 --filter 表裡從來源排除（目標保留的是小時光那一列）。
  --filter T:COL：來源取全部（排除 remap 舊 id），目標只取 COL 在來源 id 集合內的列（profiles 目標多 46 列空殼、auth 多別站帳號，都靠這個對齊）。
  --replace：來源列文字再做任意字串替換（60 改寫過 URL 之後比對用：--replace <舊 ref>=<新 ref>）。
"""
import argparse, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mgmt import query, sql_str

SETTINGS = ("set local search_path = ''; set local extra_float_digits = 3; set local datestyle = 'ISO, MDY'; "
            "set local intervalstyle = 'postgres'; set local bytea_output = 'hex'; set local timezone = 'UTC';\n")


def qn(s, t):
    return f'"{s}"."{t}"'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True); ap.add_argument('--dst', required=True)
    ap.add_argument('--schema', action='append', default=[]); ap.add_argument('--table', action='append', default=[])
    ap.add_argument('--remap'); ap.add_argument('--site'); ap.add_argument('--replace', action='append', default=[])
    ap.add_argument('--filter', action='append', default=[])
    a = ap.parse_args()

    remap = []
    if a.remap:
        for line in open(a.remap):
            p = line.rstrip('\n').split('\t')
            if len(p) == 3 and p[0] == a.site:
                remap.append((p[1], p[2]))
    repl = remap + [tuple(r.split('=', 1)) for r in a.replace]
    filt = dict(f.split(':', 1) for f in a.filter)

    def src_expr(e):
        for o, n in repl:
            e = f"replace({e}, {sql_str(o)}, {sql_str(n)})"
        return e

    pairs = []  # (src_schema, src_table, dst_schema, dst_table)
    for m in a.schema:
        s, d = (m.split('=', 1) + [None])[:2]; d = d or s
        for r in query(a.src, f"select c.relname t from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname={sql_str(s)} and c.relkind='r' order by 1"):
            pairs.append((s, r['t'], d, r['t']))
    for m in a.table:
        s, d = (m.split('=', 1) + [None])[:2]; d = d or s
        pairs.append((*s.split('.', 1), *d.split('.', 1)))

    bad = 0
    for ss, st, ds, dt in pairs:
        exists = query(a.dst, f"select to_regclass({sql_str(qn(ds, dt))}) is not null e")[0]['e']
        if not exists:
            print(f"  ⚠️  {ss}.{st}: 目標沒有 {ds}.{dt}（跳過）"); continue
        key = f'{ss}.{st}'
        col = filt.get(key)
        s_where = d_where = ''
        if col:
            olds = [o for o, _ in remap]
            if olds:
                s_where = f" where {col}::text <> all(array[{','.join(sql_str(o) for o in olds)}])"
            ids = [r['i'] for r in query(a.src, f"select {col}::text i from {qn(ss, st)}{s_where}")]
            ids = [next((n for o, n in remap if o == i), i) for i in ids]
            d_where = f" where {col}::text = any(array[{','.join(sql_str(i) for i in ids)}]::text[])" if ids else ' where false'
        s_row = src_expr('t::text')
        s = query(a.src, SETTINGS + f"select count(*) n, md5(coalesce(string_agg(r, E'\\n' order by r collate \"C\"), '')) h from (select {s_row} r from {qn(ss, st)} t{s_where}) x")[0]
        d = query(a.dst, SETTINGS + f"select count(*) n, md5(coalesce(string_agg(r, E'\\n' order by r collate \"C\"), '')) h from (select t::text r from {qn(ds, dt)} t{d_where}) x")[0]
        ok = s['n'] == d['n'] and s['h'] == d['h']
        bad += (not ok)
        print(f"  {'✅' if ok else '❌'} {ss}.{st} → {ds}.{dt}: 來源 {s['n']} 列 / 目標 {d['n']} 列，md5 {'相同' if s['h']==d['h'] else '不同'}{'（篩 '+col+'）' if col else ''}")

    # 序列：last_value / is_called
    for m in a.schema:
        s, d = (m.split('=', 1) + [None])[:2]; d = d or s
        seqs = [r['n'] for r in query(a.src, f"select sequencename n from pg_sequences where schemaname={sql_str(s)} order by 1")]
        for n in seqs:
            sv = query(a.src, f"select last_value v, is_called c from {qn(s, n)}")[0]
            dv = query(a.dst, f"select last_value v, is_called c from {qn(d, n)}")[0]
            ok = (sv['v'], sv['c']) == (dv['v'], dv['c'])
            bad += (not ok)
            print(f"  {'✅' if ok else '❌'} 序列 {s}.{n}: 來源 ({sv['v']},{sv['c']}) / 目標 ({dv['v']},{dv['c']})")
    print('全部相同' if bad == 0 else f'❌ {bad} 項不同')
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
