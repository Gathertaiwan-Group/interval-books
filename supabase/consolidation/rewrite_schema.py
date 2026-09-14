#!/usr/bin/env python3
"""把一站的 Supabase migration 串接並機械改寫到新 schema（三站整合 Phase 1 的 10／20 腳本產生器）。

用法：
  python3 rewrite_schema.py <migrations_dir> <schema> <out_sql> <out_audit> [--private gooddays_private] [--skip 檔名關鍵字,...]

改寫規則（見 plan）：public. → <schema>.；schema public → schema <schema>；search_path 的 public → <schema>；
private. → <private>；移除 on_auth_user_created trigger（由 40 統一掛）、storage.buckets insert、業務 insert、_migrations 表。
只讀 migration、只寫兩個輸出檔，不碰資料庫。
"""
import re, sys, os, glob, argparse

def split_statements(sql: str):
    """以 ; 切語句，尊重 $$…$$／$tag$…$tag$、'…'、-- 註解、/* */。"""
    out, buf, i, n = [], [], 0, len(sql)
    dq = None; sq = False; lc = False; bc = False
    while i < n:
        c = sql[i]
        if lc:
            buf.append(c); lc = (c != '\n'); i += 1; continue
        if bc:
            buf.append(c)
            if sql.startswith('*/', i): buf.append('/'); bc = False; i += 2; continue
            i += 1; continue
        if sq:
            buf.append(c)
            if c == "'":
                if i + 1 < n and sql[i+1] == "'": buf.append("'"); i += 2; continue
                sq = False
            i += 1; continue
        if dq:
            if sql.startswith(dq, i): buf.append(dq); i += len(dq); dq = None; continue
            buf.append(c); i += 1; continue
        if sql.startswith('--', i): lc = True; buf.append(c); i += 1; continue
        if sql.startswith('/*', i): bc = True; buf.append('/'); i += 1; continue
        if c == "'": sq = True; buf.append(c); i += 1; continue
        m = re.match(r'\$[A-Za-z_]*\$', sql[i:])
        if m: dq = m.group(0); buf.append(dq); i += len(dq); continue
        if c == ';':
            buf.append(c); out.append(''.join(buf)); buf = []; i += 1; continue
        buf.append(c); i += 1
    if ''.join(buf).strip(): out.append(''.join(buf))
    return out

def norm(stmt: str) -> str:
    s = re.sub(r'--[^\n]*', '', stmt)
    s = re.sub(r'/\*.*?\*/', '', s, flags=re.S)
    return re.sub(r'\s+', ' ', s).strip().lower()

def classify(stmt: str) -> str:
    s = norm(stmt)
    if not s: return 'empty'
    if re.match(r'drop trigger if exists on_auth_user_created', s) or re.match(r'create trigger on_auth_user_created', s): return 'auth_trigger'
    if re.match(r'insert into storage\.buckets', s): return 'bucket'
    if re.search(r'\b_migrations\b', s): return 'migrations_table'
    if re.match(r'insert into ', s): return 'insert'
    return 'keep'

def rewrite(text: str, schema: str, priv: str | None):
    stats = {}
    text, stats['public_dot'] = re.subn(r'\bpublic\.', f'{schema}.', text)
    text, stats['schema_public'] = re.subn(r'\bschema public\b', f'schema {schema}', text, flags=re.I)
    text, stats['search_path'] = re.subn(r"(search_path\s*(?:=|to)\s*)'?public'?(?=\s*[,;)\n]|\s*$)", lambda m: f"{m.group(1)}{schema}", text, flags=re.I)
    if priv:
        text, stats['private_dot'] = re.subn(r'\bprivate\.', f'{priv}.', text)
        text, stats['schema_private'] = re.subn(r'\bschema private\b', f'schema {priv}', text, flags=re.I)
    return text, stats

def table_names(sql: str, schema: str):
    return set(re.findall(rf'create table (?:if not exists )?{schema}\.(\w+)', sql, flags=re.I))

def unqualified_scan(sql: str, schema: str, tables: set):
    """在函式本體與 policy 裡找『沒有 schema 前綴、但是本 schema 表名』的引用。回傳 [(行號, 函式名, search_path, 片段)]。"""
    hits = []
    lines = sql.split('\n')
    cur_fn = None; cur_sp = None
    for ln, line in enumerate(lines, 1):
        if line.lstrip().startswith('--'): continue  # 註解裡的 join/from 不是程式碼
        m = re.search(r'create (?:or replace )?function\s+([\w.]+)', line, flags=re.I)
        if m: cur_fn = m.group(1); cur_sp = None
        m = re.search(r"search_path\s*(?:=|to)\s*'?([^'\n;]*)'?", line, flags=re.I)
        if m and cur_fn: cur_sp = m.group(1).strip() or "''"
        for mm in re.finditer(r'\b(from|join|update|into|delete from)\s+("?)(\w+)\2(?![\w.])', line, flags=re.I):
            name = mm.group(3)
            if name.lower() in tables:
                hits.append((ln, cur_fn or '(policy/top-level)', cur_sp or '(none)', line.strip()[:110]))
    return hits

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src'); ap.add_argument('schema'); ap.add_argument('out_sql'); ap.add_argument('out_audit')
    ap.add_argument('--private', default=None); ap.add_argument('--skip', default='')
    ap.add_argument('--header', default='')
    a = ap.parse_args()
    skip = [s for s in a.skip.split(',') if s]
    files = sorted(glob.glob(os.path.join(a.src, '*.sql')))
    removed = {'auth_trigger': [], 'bucket': [], 'insert': [], 'migrations_table': []}
    kept_parts = []; skipped_files = []
    for f in files:
        base = os.path.basename(f)
        if any(k in base for k in skip): skipped_files.append(base); continue
        raw = open(f, encoding='utf-8').read()
        kept = []
        for st in split_statements(raw):
            k = classify(st)
            if k in removed: removed[k].append(f'{base}: {norm(st)[:90]}')
            elif k == 'keep': kept.append(st)
        # 每段自帶 search_path：原檔裡沒寫 schema 前綴的表名（例如 policy 的 using 子句）建立時才解析得到本 schema，
        # 不依賴執行器是 psql 還是 Management API。這是 20 第 16 段在排練時炸出來的教訓。
        kept_parts.append(f'\n-- ===== {base} =====\nset search_path = {a.schema}, public;\n' + ''.join(kept))
    body = ''.join(kept_parts)
    body, stats = rewrite(body, a.schema, a.private)
    header = a.header.replace('\\n', '\n')
    final = f'-- 由 rewrite_schema.py 自動產生，不要手改；改規則請改產生器。\n{header}\n{body}\n'
    open(a.out_sql, 'w', encoding='utf-8').write(final)
    tables = table_names(final, a.schema)
    residual_pub = [(i, l.strip()[:100]) for i, l in enumerate(final.split('\n'), 1) if re.search(r'\bpublic\.', l)]
    residual_priv = [(i, l.strip()[:100]) for i, l in enumerate(final.split('\n'), 1) if a.private and re.search(r'\bprivate\.', l)]
    unq = unqualified_scan(final, a.schema, tables)
    secdef = re.findall(rf'create (?:or replace )?function\s+({a.schema}[\w.]*|{a.private or "__none__"}[\w.]*)\s*\(.*?security definer.*?(?:search_path\s*(?:=|to)\s*([^\n]*))?', final, flags=re.I | re.S)
    with open(a.out_audit, 'w', encoding='utf-8') as w:
        w.write(f'# {a.schema} 改寫稽核\n\n')
        w.write(f'- 來源 migration：{len(files)} 支（跳過 {len(skipped_files)}：{", ".join(skipped_files) or "無"}）\n')
        w.write(f'- 本 schema 的表：{len(tables)} 張\n')
        w.write(f'- 改寫統計：{stats}\n')
        w.write(f'- 移除：' + ', '.join(f'{k} {len(v)}' for k, v in removed.items()) + '\n\n')
        for k, v in removed.items():
            if v:
                w.write(f'## 移除的 {k}\n' + ''.join(f'- {x}\n' for x in v) + '\n')
        w.write(f'## 殘留 public.（應為 0）：{len(residual_pub)}\n' + ''.join(f'- L{i}: {l}\n' for i, l in residual_pub) + '\n')
        if a.private:
            w.write(f'## 殘留 private.（應為 0）：{len(residual_priv)}\n' + ''.join(f'- L{i}: {l}\n' for i, l in residual_priv) + '\n')
        w.write(f'## 🔴 未限定表名（PostgREST search_path 下會靜默落到小時光 public 同名表）：{len(unq)}\n')
        w.write('| 行 | 所在函式 | 該函式 search_path | 判定 | 片段 |\n|---|---|---|---|---|\n')
        for ln, fn, sp, frag in unq:
            safe = '✅ 安全' if sp.strip("' ") == a.schema else '🔴 危險'
            w.write(f'| {ln} | {fn} | {sp} | {safe} | `{frag}` |\n')
    print(f'{a.schema}: files={len(files)} tables={len(tables)} rewrite={stats} removed={ {k:len(v) for k,v in removed.items()} } residual_public={len(residual_pub)} unqualified={len(unq)} ({sum(1 for _,_,sp,_ in unq if sp.strip(chr(39)+" ")!=a.schema)} 危險)')

if __name__ == '__main__':
    main()
