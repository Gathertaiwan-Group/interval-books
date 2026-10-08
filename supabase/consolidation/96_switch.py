#!/usr/bin/env python3
"""96_switch.py — 逐站把正式網站切到合併資料庫（runbook 第 4 步的自動化）。

  96_switch.py ib            小時光：停舊庫排程 → Vercel env → 重新部署 production → 等上線 → 煙霧測試 → 開新庫排程
  96_switch.py gd            好日子：Vercel env → Railway env（不觸發部署）→ 合併 cutover/merged-db 並 push
                             → 等 Vercel 上線 → Railway 部署同一個 commit → 煙霧測試
  96_switch.py hh            快樂手：Vercel env → 合併 cutover/merged-db 並 push → 等上線 → 煙霧測試

🔴 好日子／快樂手的「新環境變數」一定要跟「指定 schema 的程式」同一次部署：
   只換 env 沒換程式 → 查 public.* ＝ 讀寫小時光的同名表（沒有錯誤訊息）；只換程式沒換 env → 舊庫沒有那個 schema，整站壞。
   Vercel 的 env 只在下一次部署生效，所以先改 env、再 push 程式，讓同一次 build 同時拿到兩者。
   Railway 改變數預設會用**舊 commit**立刻重新部署——一定要 skipDeploys，再指定新 commit 部署。
"""
import json, os, subprocess, sys, time, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mgmt import token, query

SP = '/private/tmp/claude-501/-Users-aimand--gemini-File/dad55a43-d978-488c-bb46-f3353af97feb/scratchpad'
TARGET = 'noijrmhdfbfvjyvchvzj'
TEAM = 'team_4meLkHZuHu0i2boCKXLISF8g'
VTOK = open(os.path.join(SP, 'vercel_token')).read().strip()
SITES = {
    'ib': dict(name='小時光', vercel='interval-books', old='kmpwughmwpdzsizrxhms', repo=None,
               env={'VITE_SUPABASE_URL': 'url', 'VITE_SUPABASE_ANON_KEY': 'anon', 'SUPABASE_SERVICE_ROLE_KEY': 'service'},
               pages=['https://www.intervalbooks.tw/', 'https://www.intervalbooks.tw/shop', 'https://www.intervalbooks.tw/events']),
    'gd': dict(name='好日子', vercel='goodday', old='xptltqokykpmiqwlnasm', repo='/Users/aimand/.gemini/File/goodday',
               env={'NEXT_PUBLIC_SUPABASE_URL': 'url', 'NEXT_PUBLIC_SUPABASE_ANON_KEY': 'anon', 'SUPABASE_SERVICE_ROLE_KEY': 'service'},
               pages=['https://interval-livid.vercel.app/', 'https://interval-livid.vercel.app/login', 'https://interval-livid.vercel.app/products']),
    'hh': dict(name='快樂手', vercel='happyhands', old='soglfvjtysqqqzbcwwci', repo='/Users/aimand/.gemini/File/happyhand',
               env={'NEXT_PUBLIC_SUPABASE_URL': 'url', 'NEXT_PUBLIC_SUPABASE_ANON_KEY': 'anon', 'SUPABASE_SERVICE_ROLE_KEY': 'service'},
               pages=['https://happyhands.com.tw/', 'https://happyhands.com.tw/login', 'https://happyhands.com.tw/courses']),
}
RAILWAY_GD = dict(project='b9bed002-454e-47dc-b413-7280ebdf974f', env='e68d581b-6055-44e2-aa7e-d26925e30f81',
                  service='b3b203a4')  # 只是前綴，執行時補全


def sh(args, inp=None, timeout=120):
    r = subprocess.run(args, input=inp, capture_output=True, text=True, timeout=timeout)
    return r.stdout


def vapi(method, path, body=None):
    args = ['curl', '-s', '--max-time', '60', '-X', method, f'https://api.vercel.com{path}{"&" if "?" in path else "?"}teamId={TEAM}',
            '-H', f'Authorization: Bearer {VTOK}']
    if body is not None:
        args += ['-H', 'Content-Type: application/json', '-d', '@-']
    out = sh(args, json.dumps(body) if body is not None else None)
    return json.loads(out or '{}')


def target_values():
    keys = json.loads(sh(['curl', '-s', f'https://api.supabase.com/v1/projects/{TARGET}/api-keys?reveal=true',
                          '-H', f'Authorization: Bearer {token(TARGET)}']))
    k = {x['id']: x['api_key'] for x in keys}
    return {'url': f'https://{TARGET}.supabase.co', 'anon': k['anon'], 'service': k['service_role']}


def set_vercel_env(project, mapping, vals):
    envs = vapi('GET', f'/v10/projects/{project}/env')['envs']
    for key, which in mapping.items():
        e = next((x for x in envs if x['key'] == key), None)
        if not e:
            raise SystemExit(f'❌ {project} 沒有 {key}')
        r = vapi('PATCH', f'/v9/projects/{project}/env/{e["id"]}', {'value': vals[which]})
        if r.get('error'):
            raise SystemExit(f'❌ 改 {project}.{key} 失敗：{r["error"]}')
        print(f'  ✅ Vercel {project}.{key} → 新專案（適用 {",".join(e.get("target", []))}）')


def latest_prod(project):
    d = vapi('GET', f'/v6/deployments?app={project}&target=production&limit=1')['deployments'][0]
    return d['uid'], (d.get('meta') or {}).get('githubCommitSha', '')


def wait_ready(uid, label, limit=1200):
    t0 = time.time()
    while time.time() - t0 < limit:
        d = vapi('GET', f'/v13/deployments/{uid}')
        st = d.get('readyState') or d.get('status')
        if st in ('READY', 'ERROR', 'CANCELED'):
            print(f'  {"✅" if st == "READY" else "❌"} {label} 部署 {st}（{int(time.time()-t0)} 秒）')
            return st == 'READY'
        time.sleep(15)
    print(f'  ❌ {label} 等了 {limit} 秒還沒好'); return False


def wait_commit(project, sha, limit=1500):
    t0 = time.time()
    while time.time() - t0 < limit:
        for d in vapi('GET', f'/v6/deployments?app={project}&target=production&limit=5').get('deployments', []):
            if (d.get('meta') or {}).get('githubCommitSha', '').startswith(sha[:7]):
                return wait_ready(d['uid'], project, limit - int(time.time() - t0))
        time.sleep(15)
    print(f'  ❌ {project} 等不到 commit {sha[:7]} 的部署'); return False


def smoke(site):
    s = SITES[site]
    ok = True
    for url in s['pages']:
        code = sh(['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '-L', '--max-time', '30', url + ('?cb=%d' % time.time())])
        good = code == '200'
        ok &= good
        print(f'  {"✅" if good else "❌"} {url} → {code}')
    # 網站實際載入的程式指向哪個 Supabase
    ref = re.compile(r'([a-z]{20})\.supabase\.co')
    found = set()
    for url in s['pages'][:2]:
        html = sh(['curl', '-sL', '--max-time', '30', url + ('?cb=%d' % time.time())])
        found |= set(ref.findall(html))
        for src in re.findall(r'(?:src|href)="([^"]+\.js[^"]*)"', html)[:60]:
            from urllib.parse import urljoin
            found |= set(ref.findall(sh(['curl', '-sL', '--max-time', '20', urljoin(url, src)])))
    on_new = TARGET in found and s['old'] not in found
    ok &= on_new
    print(f'  {"✅" if on_new else "❌"} 網站程式指向：{sorted(found)}')
    return ok


def git_ff_push(repo):
    def g(*a): return subprocess.run(['git', '-C', repo, *a], capture_output=True, text=True)
    g('fetch', '-q', 'origin')
    if g('rev-parse', 'main').stdout != g('rev-parse', 'origin/main').stdout:
        raise SystemExit(f'❌ {repo} 的 main 跟 origin 不同步，先處理')
    r = g('merge', '--ff-only', 'cutover/merged-db')
    if r.returncode:
        raise SystemExit(f'❌ fast-forward 失敗：{r.stderr}')
    p = g('push', 'origin', 'main')
    if p.returncode:
        raise SystemExit(f'❌ push 失敗：{p.stderr}')
    sha = g('rev-parse', 'HEAD').stdout.strip()
    print(f'  ✅ cutover/merged-db 已合進 main 並推上（{sha[:7]}）')
    return sha


def _railway_ids():
    sys.path.insert(0, '/tmp')
    from railway_gql import gql
    proj = gql("query($id:String!){ project(id:$id){ services{ edges{ node{ id name } } } } }", {'id': RAILWAY_GD['project']})
    sid = next(e['node']['id'] for e in proj['data']['project']['services']['edges'] if e['node']['name'] == 'api')
    return gql, sid


def railway_gd(vals, _sha):
    gql, sid = _railway_ids()
    r = gql("""mutation($i: VariableCollectionUpsertInput!){ variableCollectionUpsert(input:$i) }""",
            {'i': {'projectId': RAILWAY_GD['project'], 'environmentId': RAILWAY_GD['env'], 'serviceId': sid,
                   'variables': {'SUPABASE_URL': vals['url'], 'SUPABASE_SERVICE_ROLE_KEY': vals['service']}, 'skipDeploys': True}})
    if 'errors' in r: raise SystemExit(f'❌ Railway 變數：{r["errors"]}')
    print('  ✅ Railway api 的 SUPABASE_URL／SERVICE_ROLE_KEY → 新專案（暫不部署）')
    return True


def railway_deploy(sha):
    gql, sid = _railway_ids()
    d = gql("mutation($s:String!,$e:String!,$c:String){ serviceInstanceDeployV2(serviceId:$s, environmentId:$e, commitSha:$c) }",
            {'s': sid, 'e': RAILWAY_GD['env'], 'c': sha})
    if 'errors' in d: raise SystemExit(f'❌ Railway 部署：{d["errors"]}')
    dep = d['data']['serviceInstanceDeployV2']
    print(f'  … Railway api 用 commit {sha[:7]} 部署中')
    t0 = time.time()
    while time.time() - t0 < 1200:
        st = gql("query($id:String!){ deployment(id:$id){ status } }", {'id': dep})
        status = (((st.get('data') or {}).get('deployment')) or {}).get('status')
        if status in ('SUCCESS', 'FAILED', 'CRASHED', 'REMOVED'):
            print(f'  {"✅" if status == "SUCCESS" else "❌"} Railway api 部署 {status}（{int(time.time()-t0)} 秒）')
            return status == 'SUCCESS'
        time.sleep(15)
    print('  ❌ Railway api 部署逾時'); return False


def main():
    site = sys.argv[1]
    s = SITES[site]
    print(f'═══ 切換 {s["name"]}')
    vals = target_values()
    if site == 'ib':
        n = query(s['old'], "select count(*) n from (select cron.alter_job(jobid, active := false) from cron.job where active) x")[0]['n']
        print(f'  ✅ 舊小時光庫的排程已停（{n} 個）——防新舊兩邊各開一次發票')
        set_vercel_env(s['vercel'], s['env'], vals)
        uid, sha = latest_prod(s['vercel'])
        r = vapi('POST', '/v13/deployments?forceNew=1', {'name': s['vercel'], 'deploymentId': uid, 'target': 'production'})
        if r.get('error'): raise SystemExit(f'❌ 重新部署失敗：{r["error"]}')
        print(f'  … 用目前的正式版（{sha[:7]}）重新部署，讓新 env 生效')
        if not wait_ready(r['id'], s['vercel']): raise SystemExit(1)
        ok = smoke(site)
        if ok:
            out = subprocess.run(['python3', os.path.join(os.path.dirname(os.path.abspath(__file__)), '91_cron_vault.py'),
                                  '--src', s['old'], '--dst', TARGET, '--activate'], capture_output=True, text=True)
            print('  ' + '\n  '.join(l for l in out.stdout.splitlines() if '目標：' in l or '已啟用' in l))
        else:
            print('  ⚠️ 煙霧測試沒過，新庫排程**不開**；先看問題')
    else:
        set_vercel_env(s['vercel'], s['env'], vals)
        if site == 'gd':
            # Railway 先放變數（skipDeploys），再推程式：Railway 若會在 push 時自動部署，拿到的就是新 env＋新程式
            ok_api = railway_gd(vals, None)
            sha_pushed = git_ff_push(s['repo'])
            ok_web = wait_commit(s['vercel'], sha_pushed)
            ok_api = railway_deploy(sha_pushed)
            ok = ok_web and ok_api and smoke(site)
        else:
            sha_pushed = git_ff_push(s['repo'])
            ok = wait_commit(s['vercel'], sha_pushed) and smoke(site)
    print(f'═══ {s["name"]}：{"✅ 切換完成" if ok else "❌ 有項目沒過，見上方"}')
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
