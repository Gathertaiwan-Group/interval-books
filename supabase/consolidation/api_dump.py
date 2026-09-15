#!/usr/bin/env python3
"""api_dump.py — 用 Management API 產出與 `pg_dump --data-only` 相同格式的資料檔（COPY 段 + SEQUENCE SET）。
只對來源做 SELECT，不需要 DB 密碼；輸出可直接餵 psql，也讓 check_dumps.sh / 50_load_data.sh 原樣可用。

  api_dump.py --ref REF --out FILE --schema public [--schema inv]
  api_dump.py --ref REF --out FILE --table auth.users --table auth.identities   （依給定順序輸出）

忠實度的關鍵：每個欄位在伺服器端 ::text（跟 COPY TO 用同一套輸出函式），session 設定比照 pg_dump
（extra_float_digits=3、DateStyle ISO、IntervalStyle postgres、bytea hex、UTC）；generated column 跳過
（COPY 不能寫）；序列用 last_value/is_called 出 setval。
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mgmt import query, in_list, sql_str

PAGE = 300
SETTINGS = ("set local search_path = ''; set local extra_float_digits = 3; set local datestyle = 'ISO, MDY'; "
            "set local intervalstyle = 'postgres'; set local bytea_output = 'hex'; set local timezone = 'UTC';\n")

HEADER = """--
-- PostgreSQL database dump
--

-- Dumped from database version {ver}
-- Dumped by api_dump.py (Supabase Management API, data-only)

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


def esc(v):
    """COPY text 格式的跳脫（與 COPY TO 相同）。"""
    if v is None:
        return '\\N'
    return (v.replace('\\', '\\\\').replace('\n', '\\n').replace('\r', '\\r').replace('\t', '\\t')
             .replace('\b', '\\b').replace('\f', '\\f').replace('\v', '\\v'))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ref', required=True); ap.add_argument('--out', required=True)
    ap.add_argument('--schema', action='append', default=[]); ap.add_argument('--table', action='append', default=[])
    a = ap.parse_args()
    if bool(a.schema) == bool(a.table):
        sys.exit('給 --schema 或 --table 其中一種')

    def q(sql):
        return query(a.ref, SETTINGS + sql)

    ver = q("select current_setting('server_version') v")[0]['v']

    if a.schema:
        filt = f"n.nspname in {in_list(a.schema)}"
    else:
        pairs = ','.join(f"({sql_str(t.split('.')[0])},{sql_str(t.split('.')[1])})" for t in a.table)
        filt = f"(n.nspname, c.relname) in ({pairs})"
    tables = q(f"""
select n.nspname s, c.relname t, quote_ident(n.nspname)||'.'||quote_ident(c.relname) qname,
  (select string_agg(quote_ident(a.attname), ', ' order by a.attnum) from pg_attribute a
     where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped and a.attgenerated='') cols,
  (select string_agg(quote_ident(a.attname), ', ' order by k.ord) from pg_constraint p
     cross join lateral unnest(p.conkey) with ordinality k(attnum, ord)
     join pg_attribute a on a.attrelid=p.conrelid and a.attnum=k.attnum
     where p.conrelid=c.oid and p.contype='p') pk
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where c.relkind in ('r','p') and {filt}
order by 1,2""")
    if a.table:  # 依給定順序（auth.users 要在 identities 前）
        order = {t: i for i, t in enumerate(a.table)}
        tables.sort(key=lambda r: order[f"{r['s']}.{r['t']}"])
        missing = set(a.table) - {f"{r['s']}.{r['t']}" for r in tables}
        if missing:
            sys.exit(f'找不到表：{missing}')

    out = [HEADER.format(ver=ver)]
    total = 0
    for tb in tables:
        cols = [c.strip() for c in tb['cols'].split(', ')]
        sel = ', '.join(f'{c}::text as c{i}' for i, c in enumerate(cols))
        order_by = tb['pk'] or 'ctid'
        n = int(q(f"select count(*) n from {tb['qname']}")[0]['n'])
        out.append(f"--\n-- Data for Name: {tb['t']}; Type: TABLE DATA; Schema: {tb['s']}; Owner: postgres\n--\n\n")
        out.append(f"COPY {tb['qname']} ({tb['cols']}) FROM stdin;\n")
        got = 0
        for off in range(0, n, PAGE):
            rows = q(f"select {sel} from {tb['qname']} order by {order_by} limit {PAGE} offset {off}")
            for r in rows:
                out.append('\t'.join(esc(r[f'c{i}']) for i in range(len(cols))) + '\n')
            got += len(rows)
        if got != n:
            sys.exit(f'❌ {tb["qname"]}: count={n} 但抓到 {got}')
        out.append('\\.\n\n\n')
        total += n
        print(f"  {tb['qname']}: {n} 列", flush=True)

    if a.schema:
        seqs = q(f"select quote_ident(schemaname)||'.'||quote_ident(sequencename) q, schemaname s, sequencename n "
                 f"from pg_sequences where schemaname in {in_list(a.schema)} order by 1")
        if seqs:
            union = ' union all '.join(f"select {sql_str(s['q'])} q, last_value, is_called from {s['q']}" for s in seqs)
            vals = {r['q']: r for r in q(union)}
            for s in seqs:
                v = vals[s['q']]
                out.append(f"--\n-- Name: {s['n']}; Type: SEQUENCE SET; Schema: {s['s']}; Owner: postgres\n--\n\n")
                out.append(f"SELECT pg_catalog.setval({sql_str(s['q'])}, {v['last_value']}, {'true' if v['is_called'] else 'false'});\n\n\n")
            print(f"  序列 setval：{len(seqs)} 個")

    out.append("--\n-- PostgreSQL database dump complete\n--\n\n")
    with open(a.out, 'w', encoding='utf-8') as f:
        f.write(''.join(out))
    print(f"✅ {a.out}：{len(tables)} 表、{total} 列、{os.path.getsize(a.out)} bytes")


if __name__ == '__main__':
    main()
