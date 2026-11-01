"""Single-user installation management. Never operates on another installation's services."""
import argparse, hashlib, json, os, pathlib, platform, secrets, shlex, shutil, socket, sqlite3, subprocess, sys, tarfile, tempfile, time, urllib.request
VERSION='3.0.0-beta.1'
CONFIG=pathlib.Path(os.environ.get('ADCC_CONFIG',str(pathlib.Path.home()/'.config/ai-development-control-center'))).resolve()
UNITS=('adcc-dashboard','adcc-terminal','adcc-proxy','adcc-worker','adcc-tmux')
def call(args,**kwargs):return subprocess.run([str(x) for x in args],check=True,**kwargs)
def load():return json.loads((CONFIG/'installation.json').read_text())
def private(path,text):
 path=pathlib.Path(path);path.parent.mkdir(parents=True,exist_ok=True,mode=0o700);tmp=path.with_name(path.name+'.tmp');tmp.write_text(text);tmp.chmod(0o600);tmp.replace(path)
def safe_path(value):
 p=pathlib.Path(value).expanduser().resolve()
 if any(c in str(p) for c in '\n\r\x00%') or str(p) in ('/','/home',str(pathlib.Path.home())):raise ValueError('Unsafe installation path')
 return p
def config_env(c):
 return {'ACC_ROOT':c['workspace'],'ACC_FILE_ROOT':c['workspace'],'ACC_SOURCE_DIR':str(pathlib.Path(c['prefix'])/'current'),'ACC_ROOTS_FILE':str(CONFIG/'workspace-roots.json'),'ACC_POLICY_FILE':str(CONFIG/'policy.json'),'ACC_ROUTING_FILE':str(CONFIG/'routing.json'),'ADCC_CONFIG':str(CONFIG),'ACC_UNIT_PREFIX':'adcc-task@','AGENT_U_WORKTREES':str(pathlib.Path(c['workspace'])/'worktrees'),'ACC_CLAUDE_BIN':c.get('claude',''),'ACC_CODEX_BIN':c.get('codex',''),'AGENT_U_HOME':str(CONFIG/'agent-ui'),'TMUX_TMPDIR':str(pathlib.Path(c['workspace'])/'tmux'),'APP_PORT':str(c['port']+1),'DEV_PROXY_PORT':str(c['port']),'PTY_PORT':str(c['port']+2),'PATH':c['path'],'NODE_ENV':'production','NODE_OPTIONS':'--max-old-space-size=1536','OMP_NUM_THREADS':'2','CMAKE_BUILD_PARALLEL_LEVEL':'2','ACC_MAX_WORKERS':'2'}
def write_env(path,values):private(path,''.join(k+'='+json.dumps(str(v))+'\n' for k,v in values.items()))
def services(c):
 root=pathlib.Path(c['prefix'])/'current';node=c['node'];q=lambda s:json.dumps(str(s));units=pathlib.Path.home()/'.config/systemd/user';units.mkdir(parents=True,exist_ok=True)
 entries={'adcc-worker':('/usr/bin/python3 '+q(root/'bin/acc')+' worker',root,'512M','50%'), 'adcc-task@':('/usr/bin/python3 '+q(root/'bin/acc')+' execute %i',root,'2500M','200%'),'adcc-dashboard':(q(node)+' '+q(root/'dashboard/node_modules/next/dist/bin/next')+' start -H 127.0.0.1 -p '+str(c['port']+1),root/'dashboard','3G','200%'),'adcc-terminal':(q(node)+' '+q(root/'dashboard/server/pty.mjs'),root/'dashboard','1G','100%'),'adcc-proxy':(q(node)+' '+q(root/'dashboard/scripts/dev-proxy.mjs'),root/'dashboard','256M','50%'),'adcc-tmux':('/usr/bin/tmux -D -f '+q(root/'config/tmux.conf'),root,'3G','200%'),'adcc-monitor':('/usr/bin/python3 '+q(root/'bin/adcc')+' monitor',root,'128M','25%')}
 for name,(cmd,cwd,mem,cpu) in entries.items():
  filename=units/(name+'.service')
  if filename.exists() and '# Managed by AI Development Control Center' not in filename.read_text():raise ValueError('Refusing unrelated service '+str(filename))
  env=CONFIG/('dashboard.env' if name in ('adcc-dashboard','adcc-terminal') else 'runtime.env')
  deps='Requires=adcc-tmux.service\nAfter=adcc-tmux.service\n' if name in ('adcc-dashboard','adcc-terminal') else ''
  restart='no' if name in ('adcc-task@','adcc-monitor') else 'on-failure'
  text=f'# Managed by AI Development Control Center\n[Unit]\nDescription=AI Development Control Center {name}\n{deps}StartLimitIntervalSec=120\nStartLimitBurst=10\n[Service]\nType=simple\nSlice=adcc.slice\nWorkingDirectory={cwd}\nEnvironmentFile={env}\nExecStart={cmd}\nRestart={restart}\nRestartSec=5\nKillMode=control-group\nTimeoutStopSec=15\nUMask=0077\nNoNewPrivileges=yes\nMemoryMax={mem}\nCPUQuota={cpu}\nTasksMax=192\nLimitNOFILE=8192\nLogRateLimitIntervalSec=30s\nLogRateLimitBurst=100\n[Install]\nWantedBy=default.target\n'
  filename.write_text(text)
 (units/'adcc.slice').write_text('# Managed by AI Development Control Center\n[Slice]\nMemoryMax=8G\nCPUQuota=400%\nTasksMax=768\n')
 (units/'adcc-monitor.timer').write_text('# Managed by AI Development Control Center\n[Timer]\nOnBootSec=1m\nOnUnitActiveSec=5m\n[Install]\nWantedBy=timers.target\n')
 return units

def active_tasks(c):
 db=pathlib.Path(c['workspace'])/'tasks/state.sqlite3'
 if not db.exists():return False
 with sqlite3.connect(db) as conn:return bool(conn.execute("SELECT count(*) FROM tasks WHERE state='running'").fetchone()[0])
def download(url,target,digest=None):
 with urllib.request.urlopen(url,timeout=60) as r,open(target,'wb') as f:shutil.copyfileobj(r,f)
 if digest and hashlib.sha256(pathlib.Path(target).read_bytes()).hexdigest()!=digest:raise ValueError('Download integrity mismatch')
def install_impl(args):
 os.umask(0o077)
 if os.geteuid()==0:raise ValueError('Run as a normal account; use --install-system-deps for narrowly scoped sudo dependency setup')
 osinfo=dict(line.strip().split('=',1) for line in pathlib.Path('/etc/os-release').read_text().splitlines() if '=' in line)
 if osinfo.get('ID','').strip('"')!='ubuntu' or osinfo.get('VERSION_ID','').strip('"')!='24.04' or platform.machine()!='x86_64':raise ValueError('Supported platform: Ubuntu 24.04 x86_64')
 if args.install_system_deps:
  call(['sudo','apt-get','update']);call(['sudo','apt-get','install','-y','--no-install-recommends','ca-certificates','curl','git','python3','tmux','libatomic1','build-essential','pkg-config','bubblewrap','apparmor-profiles']);call(['sudo','loginctl','enable-linger',__import__('getpass').getuser()])
 source=pathlib.Path(__file__).resolve().parents[1]
 old=load() if (CONFIG/'installation.json').exists() else None
 prefix=safe_path(args.prefix or (old['prefix'] if old else pathlib.Path.home()/'.local/share/ai-development-control-center'))
 workspace=safe_path(args.workspace or (old['workspace'] if old else pathlib.Path.home()/'.local/state/ai-development-control-center'))
 if prefix==workspace or prefix.is_relative_to(workspace) or workspace.is_relative_to(prefix):raise ValueError('Installation and workspace must be separate trees')
 if old and (str(prefix)!=old['prefix'] or str(workspace)!=old['workspace']):raise ValueError('Use the existing installation paths for upgrades')
 if old and active_tasks(old):raise ValueError('Pause/finish running tasks before upgrade')
 if prefix.exists() and not old and any(prefix.iterdir()) and not (prefix/'.adcc-managed').exists():raise ValueError('Refusing a nonempty unmanaged prefix')
 for p in [CONFIG,prefix,workspace,*[workspace/x for x in ('projects','worktrees','tasks','logs','reports','tmux')]]:p.mkdir(parents=True,exist_ok=True,mode=0o700)
 private(prefix/'.adcc-managed','AI Development Control Center\n')
 for p in [CONFIG,workspace]:p.chmod(0o700)
 mem_total=next(int(x.split()[1])*1024 for x in pathlib.Path('/proc/meminfo').read_text().splitlines() if x.startswith('MemTotal:'))
 if mem_total<4*1024**3 and not args.configure_only:raise ValueError('At least 4 GiB RAM required; 8–12 GiB recommended')
 if shutil.disk_usage(prefix).free<4*1024**3 and not args.configure_only:raise ValueError('At least 4 GiB free disk required')
 node=shutil.which('node')
 if node:
  v=subprocess.check_output([node,'--version'],text=True).strip()
  if not v.startswith('v24.'):node=None
 tools=prefix/'tools';tools.mkdir(exist_ok=True)
 if not node and not args.configure_only:
  name='node-v24.22.2-linux-x64';archive=tools/(name+'.tar.xz');checks=tools/'node-SHASUMS256.txt'
  download('https://nodejs.org/dist/v24.22.2/SHASUMS256.txt',checks)
  digest=next(line.split()[0] for line in checks.read_text().splitlines() if line.split()[-1]==archive.name)
  download('https://nodejs.org/dist/v24.22.2/'+archive.name,archive,digest)
  with tarfile.open(archive) as t:t.extractall(tools,filter='data')
  node=str(tools/name/'bin/node');archive.unlink()
 node=node or shutil.which('node') or '/usr/bin/node'
 toolpath=str(pathlib.Path(node).parent)+':'+str(tools/'node_modules/.bin')+':'+str(pathlib.Path.home()/'.local/bin')+':'+os.environ.get('PATH','/usr/bin:/bin')
 env={**os.environ,'PATH':toolpath,'NODE_OPTIONS':'--max-old-space-size=2048','NEXT_TELEMETRY_DISABLED':'1','CI':'1','OMP_NUM_THREADS':'2','CMAKE_BUILD_PARALLEL_LEVEL':'2'}
 # Reuse working supported CLIs; otherwise install explicit versions locally, without importing credentials.
 agents={x:shutil.which(x) for x in ('claude','codex')}
 if not args.configure_only:
  for name in ('git','tmux','python3','bwrap'):
   if not shutil.which(name):raise ValueError(name+' missing; rerun with --install-system-deps')
  npm=str(pathlib.Path(node).parent/'npm')
  call([npm,'install','--prefix',tools,'--ignore-scripts','--no-audit','--no-fund','pnpm@11.17.0'],env=env)
  if not args.skip_agents:
   packages=[pkg for owner,pkg in [('claude','@anthropic-ai/claude-code@2.1.314'),('codex','@openai/codex@0.166.0')] if not agents[owner]]
   if packages:call([npm,'install','--prefix',tools,'--no-audit','--no-fund',*packages],env=env)
   agents={x:shutil.which(x,path=toolpath) for x in ('claude','codex')}
 release=prefix/'releases'/('v'+VERSION+'-'+time.strftime('%Y%m%d%H%M%S')+'-'+secrets.token_hex(3));release.parent.mkdir(exist_ok=True)
 shutil.copytree(source,release,ignore=shutil.ignore_patterns('.git','node_modules','.next*','__pycache__','dist','artifacts','*.log','*.pyc'))
 if not args.configure_only:
  pnpm=tools/'node_modules/.bin/pnpm';call([pnpm,'install','--frozen-lockfile'],cwd=release/'dashboard',env=env);call([pnpm,'build'],cwd=release/'dashboard',env=env)
 c={'version':VERSION,'prefix':str(prefix),'workspace':str(workspace),'port':old['port'] if old else args.port,'node':node,'path':toolpath,'claude':agents['claude'] or '', 'codex':agents['codex'] or '','release':str(release),'previous_release':old.get('release') if old else None}
 if not 1024<=c['port']<=65533:raise ValueError('Invalid port range')
 if not old and not args.configure_only:
  for port in range(c['port'],c['port']+3):
   with socket.socket() as s:s.bind(('127.0.0.1',port))
 password_file=CONFIG/'dashboard-password'
 if not password_file.exists():private(password_file,secrets.token_urlsafe(32)+'\n')
 password=password_file.read_text().strip();salt=secrets.token_bytes(16)
 import base64
 enc=lambda b:base64.urlsafe_b64encode(b).decode().rstrip('=')
 password_hash='scrypt:'+enc(salt)+':'+enc(hashlib.scrypt(password.encode(),salt=salt,n=16384,r=8,p=1,dklen=64))
 if not (CONFIG/'cookie-secret').exists():private(CONFIG/'cookie-secret',secrets.token_urlsafe(48)+'\n')
 values=config_env(c);write_env(CONFIG/'runtime.env',values)
 dashboard={**values,'UI_PASSWORD_HASH':password_hash,'UI_SECRET':(CONFIG/'cookie-secret').read_text().strip(),'ALLOWED_HOSTS':','.join('127.0.0.1:'+str(p) for p in range(c['port'],c['port']+3))+',localhost:'+str(c['port']),'TRUST_PROXY_HEADERS':'0'}
 if old and (CONFIG/'public-hostname').exists():dashboard.update(PUBLIC_HOSTNAME=(CONFIG/'public-hostname').read_text().strip(),TRUST_PROXY_HEADERS='1')
 write_env(CONFIG/'dashboard.env',dashboard)
 if old and not args.configure_only:call(['systemctl','--user','stop',*UNITS])
 link=prefix/'current.new';link.unlink(missing_ok=True);link.symlink_to(release);link.replace(prefix/'current')
 private(CONFIG/'installation.json',json.dumps(c,indent=2)+'\n');services(c)
 bindir=pathlib.Path.home()/'.local/bin';bindir.mkdir(parents=True,exist_ok=True)
 wrapper=bindir/'adcc'
 if wrapper.exists() and 'ADCC_CONFIG' not in wrapper.read_text():raise ValueError('Refusing unrelated adcc command')
 wrapper.write_text('#!/bin/sh\nexport ADCC_CONFIG='+shlex.quote(str(CONFIG))+'\nexec /usr/bin/python3 '+shlex.quote(str(prefix/'current/bin/adcc'))+' "$@"\n');wrapper.chmod(0o755)
 if not args.configure_only:
  call(['systemctl','--user','daemon-reload']);call(['systemctl','--user','enable','--now',*UNITS,'adcc-monitor.timer']);doctor(c,strict=True)
 print('Installed '+VERSION+' at '+str(prefix)+'\nPrivate access: ssh -N -L '+str(c['port'])+':127.0.0.1:'+str(c['port'])+' USER@SERVER\nOpen http://localhost:'+str(c['port'])+'\nView password locally: cat '+shlex.quote(str(password_file))+'\nConnect accounts: claude auth login; codex login\nCheck: '+str(wrapper)+' doctor')
 if args.configure_only:print('CONFIGURATION ONLY: no build, services or health check performed')

def install(args):
 old=load() if (CONFIG/'installation.json').exists() else None
 saved={p:p.read_bytes() for p in CONFIG.glob('*') if p.is_file()} if old else {}
 try:install_impl(args)
 except BaseException:
  if old:
   for p,data in saved.items():private(p,data.decode())
   prefix=pathlib.Path(old['prefix']);link=prefix/'current.rollback';link.unlink(missing_ok=True);link.symlink_to(old['release']);link.replace(prefix/'current')
   services(old)
   if not args.configure_only:
    subprocess.run(['systemctl','--user','daemon-reload'],check=False);subprocess.run(['systemctl','--user','restart',*UNITS],check=False)
  raise

def doctor(c,strict=False):
 checks={}
 for u in UNITS:checks[u]=subprocess.run(['systemctl','--user','is-active','--quiet',u]).returncode==0
 healthy=False
 for _ in range(30 if strict else 1):
  try:
   with urllib.request.urlopen('http://127.0.0.1:'+str(c['port'])+'/login',timeout=2) as r:healthy=r.status==200
  except Exception:pass
  if healthy:break
  time.sleep(1)
 checks['loopback_login']=healthy
 checks['bubblewrap_available']=shutil.which('bwrap',path=c.get('path')) is not None
 checks['private_config_mode']=CONFIG.stat().st_mode&0o077==0
 checks['user_linger']=subprocess.run(['loginctl','show-user',str(os.getuid()),'-p','Linger','--value'],capture_output=True,text=True).stdout.strip()=='yes'
 checks['claude_available']=bool(c.get('claude') and pathlib.Path(c['claude']).exists());checks['codex_available']=bool(c.get('codex') and pathlib.Path(c['codex']).exists())
 print(json.dumps(checks,indent=2))
 if strict and not all(checks[u] for u in (*UNITS,'loopback_login','private_config_mode','user_linger','bubblewrap_available')):raise ValueError('Post-install health failed; inspect journalctl --user -u adcc-dashboard')
 return checks

def backup(c,target):
 workspace=pathlib.Path(c['workspace']);target=safe_path(target)
 if target.is_relative_to(workspace):raise ValueError('Backup destination must be outside workspace')
 target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
 with tempfile.TemporaryDirectory() as td:
  db=workspace/'tasks/state.sqlite3'
  if db.exists():
   with sqlite3.connect(db) as src,sqlite3.connect(pathlib.Path(td)/'state.sqlite3') as dst:src.backup(dst)
  with tarfile.open(target,'w:gz') as t:
   if db.exists():t.add(pathlib.Path(td)/'state.sqlite3',arcname='tasks/state.sqlite3')
   for directory in ['projects','worktrees','logs','reports']:
    if (workspace/directory).exists():t.add(workspace/directory,arcname=directory,recursive=True)
   for p in (workspace/'tasks').glob('*'):
    if p.is_file() and p.suffix not in ('.sqlite3','-wal','-shm') and p.name not in ('state.sqlite3-wal','state.sqlite3-shm'):t.add(p,arcname='tasks/'+p.name)
 target.chmod(0o600);print(target)

def restore(c,archive,destination):
 dest=safe_path(destination)
 if dest.exists() and any(dest.iterdir()):raise ValueError('Restore only into an empty staging directory; never overwrite live state')
 with tarfile.open(archive) as t:
  t.extractall(dest,filter='data')
 db=dest/'tasks/state.sqlite3'
 if db.exists():
  with sqlite3.connect(db) as conn:
   if conn.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise ValueError('Restored SQLite integrity failed')
 print('Restored to staging. Git worktree pointers and absolute task paths require the original workspace path; inspect before activation. Credentials are not backed up.')

def monitor(c):
 w=pathlib.Path(c['workspace']);disk=shutil.disk_usage(w);mem={l.split(':')[0]:int(l.split()[1]) for l in pathlib.Path('/proc/meminfo').read_text().splitlines() if l.startswith(('MemTotal:','MemAvailable:'))};data={'time':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'disk_free_gib':round(disk.free/2**30,2),'memory_kib':mem,'load':os.getloadavg(),'services':{u:subprocess.run(['systemctl','--user','is-active',u],text=True,capture_output=True).stdout.strip() for u in UNITS},'warnings':[]}
 if disk.free<1024**3:data['warnings'].append('Less than 1 GiB free disk')
 private(w/'reports/health.json',json.dumps(data))
 for p in (w/'logs').glob('*.log'):
  if p.stat().st_mtime<time.time()-14*86400:p.unlink()
 print(json.dumps(data))

def main():
 os.umask(0o077);p=argparse.ArgumentParser(description=__doc__);sub=p.add_subparsers(dest='command',required=True)
 i=sub.add_parser('install');i.add_argument('--prefix');i.add_argument('--workspace');i.add_argument('--port',type=int,default=3310);i.add_argument('--configure-only',action='store_true');i.add_argument('--install-system-deps',action='store_true');i.add_argument('--skip-agents',action='store_true')
 for x in ['doctor','monitor','uninstall','config']:sub.add_parser(x)
 b=sub.add_parser('backup');b.add_argument('archive');r=sub.add_parser('restore');r.add_argument('archive');r.add_argument('--to',required=True)
 u=sub.add_parser('upgrade');u.add_argument('source',help='Reviewed, extracted release directory')
 h=sub.add_parser('https');h.add_argument('hostname')
 a=p.parse_args()
 if a.command=='install':install(a);return
 c=load()
 if a.command=='doctor':doctor(c)
 elif a.command=='monitor':monitor(c)
 elif a.command=='config':print(json.dumps(c,indent=2))
 elif a.command=='backup':backup(c,a.archive)
 elif a.command=='restore':restore(c,a.archive,a.to)
 elif a.command=='upgrade':
  if active_tasks(c):raise ValueError('Running tasks prevent upgrade')
  source=safe_path(a.source);call(['/usr/bin/python3',source/'install.py','--prefix',c['prefix'],'--workspace',c['workspace']])
 elif a.command=='uninstall':
  if active_tasks(c):raise ValueError('Pause/finish active tasks before uninstall')
  units=pathlib.Path.home()/'.config/systemd/user'
  for unit in [*UNITS,'adcc-monitor.timer','adcc-monitor.service','adcc-task@.service','adcc.slice']:
   f=units/(unit if unit.endswith(('.slice','.timer','.service')) else unit+'.service')
   if f.exists() and '# Managed by AI Development Control Center' not in f.read_text():raise ValueError('Unmanaged unit: '+str(f))
  subprocess.run(['systemctl','--user','disable','--now',*UNITS,'adcc-monitor.timer'],check=False)
  for f in units.glob('adcc*'):
   if f.is_file() and '# Managed by AI Development Control Center' in f.read_text():f.unlink()
  subprocess.run(['systemctl','--user','daemon-reload'],check=False);wrapper=pathlib.Path.home()/'.local/bin/adcc'
  if wrapper.exists() and 'ADCC_CONFIG='+shlex.quote(str(CONFIG)) in wrapper.read_text():wrapper.unlink()
  print('Services removed. Workspace, credentials, releases, backups and optional HTTPS service preserved. Review and remove those separately; no data deleted.')
 elif a.command=='https':
  from https_setup import prepare
  prepare(c,a.hostname,CONFIG)
