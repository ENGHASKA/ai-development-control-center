"""Durable task state and independent executors. Provider credentials are never inspected."""
import argparse,contextlib,fcntl,hashlib,json,os,pathlib,re,selectors,signal,shutil,sqlite3,subprocess,sys,time,uuid
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent))
import acc_agents,acc_roots,acc_sessions
ROOT=pathlib.Path(os.environ.get('ACC_ROOT',str(pathlib.Path.home()/'.local/state/ai-development-control-center'))).resolve()
SOURCE=pathlib.Path(__file__).resolve().parents[1]
STATES=('queued','running','blocked','retrying','paused','cancelled','failed','review','completed','waiting_input','waiting_approval')
OPEN_STATES=('queued','retrying','running','paused','waiting_input','waiting_approval')
STOP=False
LEASE_FD=None
# The systemd template a task runs under; production keeps its original unit names.
UNIT_PREFIX=os.environ.get('ACC_UNIT_PREFIX','adcc-task@')

def connect():
    os.umask(0o077)
    for d in ('tasks','tasks/leases','logs','reports','worktrees'):(ROOT/d).mkdir(parents=True,exist_ok=True,mode=0o700)
    c=sqlite3.connect(ROOT/'tasks/state.sqlite3',timeout=15);c.row_factory=sqlite3.Row
    c.execute('PRAGMA journal_mode=WAL');c.execute('PRAGMA synchronous=FULL')
    c.execute('CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,spec TEXT NOT NULL,state TEXT NOT NULL,result TEXT,cancel INTEGER DEFAULT 0,attempts INTEGER DEFAULT 0,approved_by TEXT)')
    fields={r[1] for r in c.execute('PRAGMA table_info(tasks)')}
    for name,typ in {'permission_override':'TEXT','created_at':'REAL','started_at':'REAL','finished_at':'REAL','heartbeat':'REAL','last_output_at':'REAL','phase':"TEXT DEFAULT 'queued'",'runner_pid':'INTEGER','runner_start':'TEXT','child_pid':'INTEGER','child_start':'TEXT','boot_id':'TEXT','unit':'TEXT','run_id':'TEXT','session_id':'TEXT','error':'TEXT','retry_at':'REAL','pause':"INTEGER DEFAULT 0",'resume_requested':"INTEGER DEFAULT 0",'fingerprint':'TEXT'}.items():
        if name not in fields:c.execute(f'ALTER TABLE tasks ADD COLUMN {name} {typ}')
    c.execute("UPDATE tasks SET created_at=? WHERE created_at IS NULL",(time.time(),))
    c.execute("CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY,task TEXT,previous TEXT,state TEXT,recorded_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))")
    c.execute("CREATE TRIGGER IF NOT EXISTS task_insert AFTER INSERT ON tasks BEGIN INSERT INTO events(task,state) VALUES(new.id,new.state); END")
    c.execute("CREATE TRIGGER IF NOT EXISTS task_transition AFTER UPDATE OF state ON tasks WHEN old.state!=new.state BEGIN INSERT INTO events(task,previous,state) VALUES(new.id,old.state,new.state); END")
    c.execute('CREATE TABLE IF NOT EXISTS provider_controls(owner TEXT PRIMARY KEY,error TEXT,updated REAL)')
    c.execute('CREATE TABLE IF NOT EXISTS attempts(task TEXT,number INTEGER,run_id TEXT,started REAL,finished REAL,state TEXT,result TEXT,PRIMARY KEY(task,number))')
    c.execute('CREATE TABLE IF NOT EXISTS task_inputs(seq INTEGER PRIMARY KEY,task TEXT NOT NULL,text TEXT NOT NULL,state TEXT NOT NULL,actor TEXT,at REAL,delivered_at REAL)')
    c.execute('CREATE TABLE IF NOT EXISTS audit_log(seq INTEGER PRIMARY KEY,task TEXT,plan TEXT,action TEXT NOT NULL,actor TEXT,detail TEXT,at REAL NOT NULL)')
    import acc_auto;acc_auto.schema(c)
    c.commit();return c

def ident(value):
    if not re.fullmatch(r'[0-9a-f]{12}',value or ''):raise ValueError('Use a valid task ID')
    return value

def load(c,value):
    r=c.execute('SELECT * FROM tasks WHERE id=?',(ident(value),)).fetchone()
    if not r:raise ValueError('Unknown task')
    return r

def update(c,value,**fields):
    c.execute('UPDATE tasks SET '+','.join(k+'=?' for k in fields)+' WHERE id=?',(*fields.values(),value));c.commit()

def git(repo,*args):
    return subprocess.check_output(['git','-C',str(repo),*args],stderr=subprocess.STDOUT,text=True,timeout=30).strip()

def scrub(text):
    text=re.sub(r'(?i)(bearer\s+)[\w.\-]+',r'\1[REDACTED]',text)
    text=re.sub(r'\b(?:sk-[\w-]{12,}|gh[pousr]_[\w]{16,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b','[REDACTED]',text)
    return re.sub(r'(?i)((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|authorization)["\s]*[:=]["\s]*)[^\s,}]+',r'\1[REDACTED]',text)

def fingerprint(wt):
    h=hashlib.sha256(git(wt,'diff','--binary','HEAD').encode())
    paths=git(wt,'ls-files','--others','--exclude-standard').splitlines()
    for name in sorted(paths)[:2000]:
        p=pathlib.Path(wt)/name;h.update(name.encode())
        try:
            if p.is_file() and not p.is_symlink():
                size=p.stat().st_size
                if size<=5*1024*1024:h.update(p.read_bytes())
                else:h.update(str((size,p.stat().st_mtime_ns)).encode())
        except OSError:h.update(b'changed-during-scan')
    return h.hexdigest()

def audit(c,task,action,actor,detail=''):
    """Every approval and intervention, kept apart from task state so it survives whatever happens to the task."""
    c.execute('INSERT INTO audit_log(task,action,actor,detail,at) VALUES(?,?,?,?,?)',(task,action,actor or 'operator',scrub(str(detail))[:500],time.time()));c.commit()

def repo_problem(path):
    """Why a folder can't seed a task, told apart so nobody has to guess."""
    p=pathlib.Path(path)
    if not p.exists():return 'That project folder no longer exists'
    if not os.access(p,os.R_OK|os.X_OK):return 'This account cannot read that project'
    try:inside=git(p,'rev-parse','--is-inside-work-tree')
    except (subprocess.CalledProcessError,OSError):return 'That folder is not a Git repository. Tasks need Git; open it in a terminal instead'
    if inside!='true':return 'That folder is not a Git working tree'
    try:git(p,'rev-parse','--verify','-q','HEAD')
    except subprocess.CalledProcessError:return 'That repository has no commits yet'
    return None

def test_argv_problem(argv,cwd):
    first=argv[0]
    if pathlib.Path(cwd,first).is_dir() or first in ('.','..'):return f'The test command starts with a folder, not a program: {first}'
    if '/' not in first and not shutil.which(first):return f'The test command needs a program this server does not have: {first}'
    return None

def approved(path):
    p=pathlib.Path(path).resolve();return p.is_relative_to(ROOT) or acc_roots.allowed(p)

def enqueue(c,filename):
    return enqueue_spec(c,json.loads(pathlib.Path(filename).read_text()))

def enqueue_spec(c,s,internal=False):
    repo=pathlib.Path(s['repo']).resolve()
    if not approved(repo):raise ValueError('Repositories must be inside an approved workspace folder')
    issue=repo_problem(repo)
    if issue:raise ValueError(issue)
    if git(repo,'rev-parse','--is-inside-work-tree')!='true':raise ValueError('Not a repository')
    if not approved(git(repo,'rev-parse','--path-format=absolute','--git-common-dir')):raise ValueError('Git metadata must remain inside an approved workspace folder')
    if s['owner'] not in ('claude','codex','demo') and not (internal and s['owner']=='verifier'):raise ValueError('Unknown owner')
    if not internal and ({'plan','fixture_files','sandbox_test'}&set(s)):raise ValueError('Those settings are for Auto Mode')
    if s.get('model') is not None and not re.fullmatch(r'[\w.:/@-]{1,80}',str(s['model'])):raise ValueError('That model name is not valid')
    if s.get('effort') is not None and s['effort'] not in ('low','medium','high','xhigh','max','ultra'):raise ValueError('That reasoning effort is not valid')
    if not isinstance(s.get('prompt'),str) or not s['prompt'].strip():raise ValueError('Prompt required')
    resuming=s.get('resume_session')
    if resuming:s['test']=s.get('test') or []
    elif not isinstance(s.get('test'),list) or not s['test'] or not all(isinstance(x,str) and x for x in s['test']):raise ValueError('Explicit test argv required')
    if s['test']:
        issue=test_argv_problem(s['test'],repo)
        if issue:raise ValueError(issue)
    # A project with nothing in it is a real choice, but never a surprise: an agent would work blind and bill for it.
    if not resuming and not git(repo,'ls-tree','-r','--name-only',s.get('base','HEAD')) and s.get('allow_empty') is not True:raise ValueError('This project has no files at that commit. Choose the right project, or confirm that starting empty is what you want')
    if s.get('permission_mode','default') not in ('default','acceptEdits','plan'):raise ValueError('Permission bypass is disabled')
    if set(s.get('allowed_tools',['Read','Write','Edit','Glob','Grep']))-{'Read','Write','Edit','Glob','Grep'}:raise ValueError('Background Claude tools are limited to approved file tools; run tests through explicit test argv')
    for d in s.get('depends',[]):load(c,d)
    s['timeout']=min(86400,max(5,int(s.get('timeout',3600))))
    s['stall_timeout']=min(s['timeout'],max(30,int(s.get('stall_timeout',1800))))
    s['max_attempts']=min(3,max(1,int(s.get('max_attempts',3))))
    s['retry_base']=min(300,max(5,int(s.get('retry_base',30))))
    for p in s.get('outputs',[]):
        if not isinstance(p,str) or pathlib.PurePath(p).is_absolute() or '..' in pathlib.PurePath(p).parts or p.startswith('.git'):raise ValueError('Outputs must be explicit safe relative paths')
    if s.get('auto_commit') and s['auto_commit']!='all' and not s.get('outputs'):raise ValueError('Auto commit requires explicit reviewed output paths')
    if s.get('hold_for_approval') not in (None,True,False):raise ValueError('Invalid approval setting')
    value=uuid.uuid4().hex[:12];s.update(repo=str(repo),base=git(repo,'rev-parse',s.get('base','HEAD')),branch=git(repo,'rev-parse','--abbrev-ref','HEAD'),worktree=str(ROOT/'worktrees'/value))
    if resuming:
        # The conversation belongs to its folder, so it continues there, not in a copy. The tree lease keeps this exclusive.
        s['worktree']=str(repo);s['in_place']=True
    else:
        git(repo,'worktree','add','-b','task/'+value,s['worktree'],s['base'])
        expected=git(repo,'ls-tree','-r','--name-only',s['base']).splitlines();actual=git(s['worktree'],'ls-files').splitlines()
        if sorted(expected)!=sorted(actual):
            git(repo,'worktree','remove','--force',s['worktree']);git(repo,'branch','-D','task/'+value)
            raise ValueError('The task worktree did not match the project at that commit, so it was removed')
    (ROOT/'tasks'/f'{value}-handoff.md').write_text(f"# Task {value}\nOwner: {s['owner']}\nBranch: task/{value}\n\n{s['prompt']}\n\nRecord decisions, tests, blockers and next actions here. No secrets.\n")
    held=s.get('hold_for_approval') is True
    c.execute('INSERT INTO tasks(id,spec,state,phase,created_at,session_id,resume_requested) VALUES(?,?,?,?,?,?,?)',(value,json.dumps(s),'waiting_approval' if held else 'queued','waiting_approval' if held else 'queued',time.time(),resuming or (str(uuid.uuid4()) if s['owner']=='claude' else None),1 if resuming else 0))
    if held:c.execute('UPDATE tasks SET error=? WHERE id=?',('approval_before_start',value))
    c.commit();audit(c,value,'resume-session' if resuming else 'created',s.get('actor'),resuming or s['owner'])
    if not internal:print(value)
    return value

def boot_id():return pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()

def proc_start(pid):
    try:return pathlib.Path('/proc',str(pid),'stat').read_text().rsplit(') ',1)[1].split()[19]
    except (OSError,IndexError):return None

def acc_argv():
    return ['/usr/bin/python3',str(SOURCE/'bin/acc')]

def clean_env():
    allow={'HOME','PATH','USER','LOGNAME','LANG','LC_ALL','TERM','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','TMUX_TMPDIR','ACC_ROOT','ACC_ROOTS_FILE','ACC_CLAUDE_BIN','ACC_CODEX_BIN'}
    e={k:v for k,v in os.environ.items() if k in allow}
    e.update(OMP_NUM_THREADS='2',CMAKE_BUILD_PARALLEL_LEVEL='2',NODE_OPTIONS='--max-old-space-size=2048',PYTHONDONTWRITEBYTECODE='1')
    if LEASE_FD is not None:e['ACC_LEASE_FD']=str(LEASE_FD)
    return e

@contextlib.contextmanager
def lease(wt):
    global LEASE_FD
    path=ROOT/'tasks/leases'/(hashlib.sha256(str(pathlib.Path(wt).resolve()).encode()).hexdigest()+'.lock')
    fd=os.open(path,os.O_CREAT|os.O_RDWR,0o600)
    try:
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);os.set_inheritable(fd,True);LEASE_FD=fd;yield fd
    finally:LEASE_FD=None;os.close(fd)

def checkpoint(c,value):
    r=load(c,value);s=json.loads(r['spec']);wt=s['worktree']
    data={'task':value,'owner':s['owner'],'recorded_at':time.time(),'attempt':r['attempts'],'state':r['state'],'phase':r['phase'],'session_id':r['session_id'],'head':git(wt,'rev-parse','HEAD'),'changed_files':git(wt,'status','--porcelain').splitlines(),'diff_stat':git(wt,'diff','--stat',s['base']),'error':r['error']}
    target=ROOT/'tasks'/f'{value}-checkpoint.json';tmp=target.with_suffix('.tmp');tmp.write_text(json.dumps(data,indent=2));tmp.replace(target)
    update(c,value,fingerprint=fingerprint(wt))
    return data

def stop(*_):
    global STOP
    STOP=True

def cancellation_targets(value,child):
    targets={child:proc_start(child)}
    # In a dedicated task unit, include detached tool descendants in that exact cgroup.
    cg=pathlib.Path('/proc/self/cgroup').read_text().strip().split(':',2)[-1]
    if cg.endswith('/'+UNIT_PREFIX+value+'.service'):
        try:
            for raw in pathlib.Path('/sys/fs/cgroup'+cg,'cgroup.procs').read_text().split():
                pid=int(raw)
                if pid!=os.getpid():targets[pid]=proc_start(pid)
        except OSError:pass
    return targets

def execute(c,value,argv,cwd,label,timeout,input_text=None,attempt=None):
    number=attempt or load(c,value)['attempts'] or 1
    path=ROOT/'logs'/f'{value}-a{number}-{label}.log'
    alias=ROOT/'logs'/f'{value}-{label}.log'
    if alias.is_symlink():alias.unlink()
    if not alias.exists():alias.symlink_to(path.name)
    env=clean_env();fds=(LEASE_FD,) if LEASE_FD is not None else ()
    p=subprocess.Popen(argv,cwd=cwd,env=env,stdin=subprocess.PIPE if input_text is not None else subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,start_new_session=True,pass_fds=fds)
    update(c,value,child_pid=p.pid,child_start=proc_start(p.pid),boot_id=boot_id(),phase=label,heartbeat=time.time(),last_output_at=time.time())
    if input_text is not None:
        try:p.stdin.write(input_text.encode());p.stdin.close()
        except BrokenPipeError:pass
    sel=selectors.DefaultSelector();sel.register(p.stdout,selectors.EVENT_READ)
    started=time.monotonic();last_progress=time.monotonic();last_beat=0;last_cp=0;last_fp=fingerprint(cwd)
    pending=b'';written=0;cancel_reason=None;kill_at=None;tail=''
    targets=None
    session=load(c,value)['session_id'];spec=json.loads(load(c,value)['spec'])
    with path.open('x') as out:
        os.chmod(path,0o600)
        try:
            while sel.get_map() or p.poll() is None:
                now=time.monotonic();r=load(c,value)
                reason='cancelled' if r['cancel'] else 'paused' if r['pause'] else 'interrupted' if STOP else 'timeout' if now-started>timeout else None
                if reason and not cancel_reason:cancel_reason=reason;kill_at=now+5
                if now-last_cp>=5:
                    new=fingerprint(cwd)
                    if new!=last_fp:last_progress=now;last_fp=new
                    checkpoint(c,value);last_cp=now
                if now-last_progress>spec.get('stall_timeout',1800) and not cancel_reason:cancel_reason='stalled';kill_at=now+5
                if cancel_reason:
                    if targets is None:targets=cancellation_targets(value,p.pid)
                    for victim,tick in targets.items():
                        if tick and proc_start(victim)==tick:
                            with contextlib.suppress(ProcessLookupError):os.kill(victim,signal.SIGKILL if now>=kill_at else signal.SIGTERM)
                    with contextlib.suppress(ProcessLookupError):os.killpg(p.pid,signal.SIGKILL if now>=kill_at else signal.SIGTERM)
                for key,_ in sel.select(.2):
                    data=os.read(key.fd,8192)
                    if not data:sel.unregister(key.fileobj);continue
                    pending+=data;last_progress=now
                    while b'\n' in pending or len(pending)>16384:
                        if b'\n' in pending:line,pending=pending.split(b'\n',1)
                        else:line,pending=pending[:16384],pending[16384:]
                        line=line.decode(errors='replace')
                        try:
                            event=json.loads(line)
                            candidate=event.get('thread_id') or event.get('session_id')
                            if isinstance(candidate,str) and re.fullmatch(r'[a-f0-9-]{36}',candidate):session=candidate
                        except (ValueError,AttributeError):pass
                        clean=scrub(line)+'\n';tail=(tail+clean)[-16000:]
                        if written<5*1024*1024:out.write(clean);out.flush();written+=len(clean.encode())
                if now-last_beat>=1:
                    update(c,value,heartbeat=time.time(),last_output_at=time.time()-(now-last_progress),session_id=session);last_beat=now
                if cancel_reason and now>kill_at+2:break
            if pending:
                clean=scrub(pending.decode(errors='replace'));tail=(tail+clean)[-16000:]
                if written<5*1024*1024:out.write(clean)
            code=p.wait(timeout=3)
        except BaseException:
            with contextlib.suppress(ProcessLookupError):os.killpg(p.pid,signal.SIGKILL)
            p.wait(timeout=5);raise
        finally:sel.close()
    return {'argv':argv,'exit':code,'cancelled':bool(cancel_reason),'reason':cancel_reason,'log':str(path),'seconds':round(time.monotonic()-started,3),'tail':tail,'log_truncated':written>=5*1024*1024,'session_id':session}

def classification(text):
    # Claude emits informational rate_limit_event records even when requests are allowed.
    lines=[]
    for line in text.splitlines():
        try: item=json.loads(line)
        except ValueError: item=None
        if isinstance(item,dict) and item.get('type')=='rate_limit_event' and item.get('rate_limit_info',{}).get('status')=='allowed':continue
        lines.append(line)
    t='\n'.join(lines).lower()
    if any(x in t for x in ['bwrap:','sandbox prevented','sandbox blocked','failed rtm_newaddr','uid_map']):return 'sandbox'
    if any(x in t for x in ['unauthorized','authentication expired','authentication failed','not logged in','please log in','invalid api key','login required','authentication_error','token_expired','failed to authenticate']):return 'authentication'
    if any(x in t for x in ['rate limit reached','rate_limit','quota exceeded','quota exhausted','usage limit','usage exhausted','credit balance','insufficient credits','too many requests','usage_limit','insufficient_quota','hit your limit','out of extra usage']):return 'quota'
    if re.search(r'"permission_denials"\s*:\s*\[\s*\{',t):return 'permission'
    if any(x in t for x in ['permission denied','permission was denied','not allowed to use','permission request','permission_required']):return 'permission'
    if any(x in t for x in ['connection reset','econnreset','econnrefused','network is unreachable','service unavailable','http 503','temporary failure','network timeout']):return 'transient'
    return None

def sandboxed(wt,repo,argv):
    """Run agent-written tests where they can't reach the network, credentials, other tasks or anything but this worktree."""
    if not shutil.which('bwrap'):raise ValueError('bubblewrap is required to run planned tests')
    home=pathlib.Path.home();out=['bwrap','--ro-bind','/','/','--dev','/dev','--proc','/proc','--tmpfs','/tmp','--tmpfs',str(ROOT)]
    for root in acc_roots.extra():out+=['--tmpfs',str(root)]
    for name in acc_auto_masked():
        p=home/name
        if p.is_dir():out+=['--tmpfs',str(p)]
        elif p.exists():out+=['--ro-bind','/dev/null',str(p)]
    common=git(wt,'rev-parse','--path-format=absolute','--git-common-dir')
    return out+['--ro-bind',common,common,'--bind',wt,wt,'--chdir',wt,'--unshare-net','--unshare-pid','--unshare-ipc','--new-session','--die-with-parent','--setenv','HOME','/tmp','--',*argv]

def acc_auto_masked():
    import acc_auto;return acc_auto.MASKED

def pending_inputs(c,value):
    return c.execute("SELECT * FROM task_inputs WHERE task=? AND state='pending' ORDER BY seq",(value,)).fetchall()

def argv_for(r,s,inputs=()):
    prompt=s['prompt']
    if inputs:prompt='\n\n'.join(i['text'] for i in inputs)
    elif r['resume_requested'] and s.get('in_place'):pass
    elif r['resume_requested']:
        cp=ROOT/'tasks'/f"{r['id']}-checkpoint.json"
        prompt+='\n\nContinue from the retained worktree and checkpoint. Inspect existing changes before continuing; do not repeat completed work or destructive actions. Checkpoint:\n'+(cp.read_text() if cp.exists() else 'Previous execution interrupted; inspect Git status.')
    prompt+='\n\nWork only in this folder. Never read credentials or unrelated production files. Do not merge, push, deploy, or bypass permissions.'+('' if s.get('in_place') else ' Acceptance tests are run independently by the executor.')
    if s['owner']=='verifier':return ['/usr/bin/true'],None
    if s['owner']=='demo':
        if s.get('fixture_files') is not None:return ['python3','-c',"import json,pathlib,sys\nfor n,t in json.loads(sys.argv[1]).items():\n p=pathlib.Path(n);p.parent.mkdir(parents=True,exist_ok=True);p.write_text(t)",json.dumps(s['fixture_files'])],None
        return ['python3','-c',"from pathlib import Path; Path('demo-result.txt').write_text('isolated task completed\\n')"],None
    agent=acc_agents.ADAPTERS[s['owner']];mode=r['permission_override'] or s.get('permission_mode','default')
    argv=agent.argv(str(SOURCE/('bin/acc-'+s['owner'])),r,s,mode)
    return argv,prompt

def persist_report(c,value):
    r=dict(load(c,value));r['events']=[dict(x) for x in c.execute('SELECT * FROM events WHERE task=? ORDER BY seq',(value,))]
    p=ROOT/'reports'/f'{value}.json';tmp=p.with_suffix('.tmp');tmp.write_text(json.dumps(r,indent=2));tmp.replace(p)

def run_one(c,row):
    value=row['id'];s=json.loads(row['spec']);wt=s['worktree'];initial_fp=fingerprint(wt);initial_head=git(wt,'rev-parse','HEAD');initial_clean=not git(wt,'status','--porcelain')
    result={};number=row['attempts']+1;state='failed';error=None
    try:
        with lease(wt):
            # A service start and a scheduler recovery cannot both claim one execution.
            c.execute('BEGIN IMMEDIATE');current=load(c,value)
            if current['state'] not in ('queued','retrying') or current['cancel'] or current['pause']:c.rollback();return
            if current['retry_at'] and current['retry_at']>time.time():c.rollback();return
            started=time.time();runid=uuid.uuid4().hex
            c.execute("UPDATE tasks SET state='running',attempts=?,run_id=?,started_at=?,finished_at=NULL,heartbeat=?,runner_pid=?,runner_start=?,boot_id=?,error=NULL,result=NULL,phase='starting' WHERE id=?",(number,runid,started,started,os.getpid(),proc_start(os.getpid()),boot_id(),value))
            c.execute('INSERT INTO attempts(task,number,run_id,started,state) VALUES(?,?,?,?,?)',(value,number,runid,started,'running'));c.commit()
            if row['resume_requested']==2:
                previous=json.loads(row['result'] or '{}')['run'];text=pathlib.Path(previous['log']).read_text()
                if previous['exit']!=0 or previous.get('reason') or classification(text):raise ValueError('Existing agent output is not eligible for verification')
                result['run']={**previous,'tail':text[-65536:],'verification_only':True}
            else:
                inputs=pending_inputs(c,value);argv,prompt=argv_for(row,s,inputs)
                for i in inputs:c.execute("UPDATE task_inputs SET state='delivered',delivered_at=? WHERE seq=?",(time.time(),i['seq']))
                c.commit();result['run']=execute(c,value,argv,wt,'run',s['timeout'],prompt,number)
            run=result['run'];issue=classification(run['tail']);rc=run['exit']
            if run['reason']:state='paused' if run['reason']=='paused' else 'blocked';error=run['reason']
            elif issue=='permission' and s['owner']=='claude' and s.get('permission_mode','default')=='default':state='waiting_approval';error='permission_requested'
            elif issue in ('sandbox','authentication','quota','permission'):state='blocked';error=issue
            elif rc or issue=='transient':
                safe=s.get('retry_safe') is True and initial_clean and not git(wt,'status','--porcelain') and fingerprint(wt)==initial_fp and git(wt,'rev-parse','HEAD')==initial_head
                if (rc==75 or issue=='transient') and safe and number<s.get('max_attempts',3):state='retrying';error='transient'
                else:state='failed';error=issue or 'agent_exit'
            elif not s['test']:state='waiting_input'
            else:
                result['test']=execute(c,value,sandboxed(wt,s['repo'],s['test']) if s.get('sandbox_test') else s['test'],wt,'test',max(1,s['timeout']-run.get('seconds',0)),attempt=number)
                test=result['test']
                if test['reason']:state='paused' if test['reason']=='paused' else 'blocked';error=test['reason']
                elif test['exit']:state='failed';error='acceptance_tests_failed'
                else:
                    if s.get('auto_commit')=='all':
                        git(wt,'add','-A')
                        # Enforced here: a project's own .gitignore can un-ignore this folder, and agents write one.
                        git(wt,'rm','-r','--cached','-q','--ignore-unmatch','.acc')
                        if git(wt,'diff','--cached','--name-only'):git(wt,'-c','user.name=Control Center','-c','user.email=control-center@localhost','commit','-m','Task '+value+': tested work')
                    elif s.get('auto_commit'):
                        changed=git(wt,'ls-files','--modified','--others','--exclude-standard').splitlines()
                        if set(changed)-set(s['outputs']):raise ValueError('Unexpected changed paths; auto-commit refused')
                        for p in s['outputs']:
                            if not (pathlib.Path(wt)/p).is_file():raise ValueError('Required output missing: '+p)
                        git(wt,'add','--',*s['outputs'])
                        if git(wt,'diff','--cached','--name-only'):git(wt,'commit','-m','Task '+value+': tested checkpoint for review')
                    state='review'
            result['changed_files']=git(wt,'status','--porcelain').splitlines();result['commits']=git(wt,'log','--oneline',s['base']+'..HEAD').splitlines();result['diff_stat']=git(wt,'diff','--stat',s['base']);result['error']=error
            # Tail is diagnostic only, keep it bounded and redacted; the full sanitized stream is on disk.
            for phase in ('run','test'):
                if phase in result:result[phase].pop('tail',None)
            if error in ('authentication','quota','sandbox') and s['owner'] in ('claude','codex'):
                c.execute('INSERT INTO provider_controls(owner,error,updated) VALUES(?,?,?) ON CONFLICT(owner) DO UPDATE SET error=excluded.error,updated=excluded.updated',(s['owner'],error,time.time()));c.commit()
            retry_at=time.time()+s.get('retry_base',30)*2**(number-1) if state=='retrying' else None
            # A follow-up sent during this turn starts the next one, unless the turn stopped for a person.
            if pending_inputs(c,value) and state in ('review','waiting_input'):state='queued';s['max_attempts']=min(100,s.get('max_attempts',3)+1);c.execute('UPDATE tasks SET spec=?,resume_requested=1,finished_at=? WHERE id=?',(json.dumps(s),time.time(),value))
            update(c,value,state=state,error=error,result=json.dumps(result),finished_at=time.time(),heartbeat=time.time(),phase=state,child_pid=None,retry_at=retry_at,resume_requested=1 if state=='queued' else 0,permission_override=None)
            c.execute('UPDATE attempts SET finished=?,state=?,result=? WHERE task=? AND number=?',(time.time(),state,json.dumps(result),value,number));c.commit();checkpoint(c,value);persist_report(c,value)
    except BlockingIOError:
        update(c,value,state='blocked',error='worktree_already_owned',phase='blocked');persist_report(c,value)
    except Exception as e:
        update(c,value,state='failed',error=scrub(str(e))[:1000],result=json.dumps({'error':scrub(str(e))[:1000]}),finished_at=time.time(),phase='failed');persist_report(c,value)

def active_unit(unit):
    if not unit:return False
    p=subprocess.run(['systemctl','--user','is-active',unit],capture_output=True,text=True)
    return p.stdout.strip() in ('active','activating','deactivating','reloading')

def reconcile(c):
    now=time.time()
    for r in c.execute("SELECT * FROM tasks WHERE state='running'").fetchall():
        alive=r['boot_id']==boot_id() and r['runner_pid'] and proc_start(r['runner_pid'])==r['runner_start'] and r['runner_start'] is not None
        if r['unit'] and active_unit(r['unit']):
            if r['heartbeat'] and now-r['heartbeat']>60:
                subprocess.run(['systemctl','--user','stop',r['unit']],capture_output=True,timeout=20)
                update(c,r['id'],state='blocked',phase='blocked',error='executor_heartbeat_lost_checkpoint_retained',finished_at=now);checkpoint(c,r['id']);persist_report(c,r['id'])
            elif r['error']=='executor_heartbeat_stale':update(c,r['id'],error=None)
            continue
        if alive:continue
        if r['started_at'] and now-r['started_at']<10:continue
        s=json.loads(r['spec']);auto=s.get('auto_resume') is True and not r['cancel'] and not r['pause'] and r['attempts']<s.get('max_attempts',3)
        state='retrying' if auto else 'blocked'
        update(c,r['id'],state=state,error='executor_interrupted_checkpoint_retained',phase=state,child_pid=None,finished_at=now,resume_requested=1,retry_at=now+s.get('retry_base',30) if auto else None)
        c.execute("UPDATE attempts SET state='blocked',finished=? WHERE task=? AND number=? AND state='running'",(now,r['id'],r['attempts']));c.commit()
        checkpoint(c,r['id']);persist_report(c,r['id'])

def worker(c,once=False):
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
    lock=(ROOT/'tasks/worker.lock').open('w');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    limit=min(2,max(1,int(os.environ.get('ACC_MAX_WORKERS','1'))))
    if once:
        if any(json.loads(x['spec'])['owner'] not in ('demo','verifier') for x in c.execute("SELECT spec FROM tasks WHERE state IN ('queued','retrying')")):raise ValueError('Use the persistent dispatcher for real agents; once is only for offline infrastructure fixtures')
        from concurrent.futures import ThreadPoolExecutor
        reconcile(c)
        import acc_auto;acc_auto.advance(c)
        with ThreadPoolExecutor(max_workers=limit) as pool:
            jobs=[]
            for r in c.execute("SELECT * FROM tasks WHERE state IN ('queued','retrying') ORDER BY rowid").fetchall():
                if r['cancel']:update(c,r['id'],state='blocked',error='cancelled_before_start');continue
                if r['pause']:continue
                if r['retry_at'] and r['retry_at']>time.time():continue
                if all(load(c,d)['state']=='completed' for d in json.loads(r['spec']).get('depends',[])):
                    if json.loads(r['spec'])['owner'] not in ('demo','verifier'):continue
                    def job(row):
                        local=connect()
                        try:run_one(local,row)
                        finally:local.close()
                    jobs.append(pool.submit(job,r))
            for j in jobs:j.result()
        return
    import acc_auto
    while not STOP:
        reconcile(c)
        acc_auto.advance(c)
        active=c.execute("SELECT * FROM tasks WHERE state='running'").fetchall()
        running=len(active)
        owner_counts={}
        for active_row in active:
            owner=json.loads(active_row['spec'])['owner'];owner_counts[owner]=owner_counts.get(owner,0)+1
        # Leave work queued rather than starting new paid jobs under resource pressure.
        disk_ok=shutil.disk_usage(ROOT).free>=1024**3
        available=next(int(x.split()[1]) for x in pathlib.Path('/proc/meminfo').read_text().splitlines() if x.startswith('MemAvailable:'))
        pending=c.execute("SELECT * FROM tasks WHERE state IN ('queued','retrying') ORDER BY rowid").fetchall() if disk_ok and available>=512*1024 else []
        for r in pending:
            if running>=limit or STOP:break
            if r['cancel']:update(c,r['id'],state='blocked',error='cancelled_before_start');continue
            if r['pause']:continue
            if r['retry_at'] and r['retry_at']>time.time():continue
            if not all(load(c,d)['state']=='completed' for d in json.loads(r['spec']).get('depends',[])):continue
            owner=json.loads(r['spec'])['owner']
            blocked=None if owner=='verifier' else c.execute('SELECT error FROM provider_controls WHERE owner=?',(owner,)).fetchone()
            if blocked:
                update(c,r['id'],state='blocked',phase='blocked',error='provider_'+blocked['error']);persist_report(c,r['id']);continue
            if owner_counts.get(owner,0)>=1:continue
            unit=UNIT_PREFIX+r['id']+'.service'
            # Starting an already-active unit is idempotent; the task executor additionally holds a whole-worktree lease.
            if active_unit(unit):running+=1;owner_counts[owner]=owner_counts.get(owner,0)+1;continue
            update(c,r['id'],unit=unit)
            p=subprocess.run(['systemctl','--user','start',unit],capture_output=True,text=True)
            if p.returncode:update(c,r['id'],state='blocked',error='systemd_dispatch_failed',phase='blocked')
            else:running+=1;owner_counts[owner]=owner_counts.get(owner,0)+1
        time.sleep(1)

def followup(c,value,text,actor=None):
    """Queue a message for the same conversation. Print modes take one prompt per turn, so it goes in when the turn ends."""
    r=load(c,value);s=json.loads(r['spec'])
    if s['owner'] not in ('claude','codex'):raise ValueError('This task has no conversation to continue')
    if not isinstance(text,str) or not text.strip():raise ValueError('Write a message first')
    if len(text)>20000:raise ValueError('That message is too long')
    if r['state'] in ('completed','cancelled'):raise ValueError('This task is finished. Resume its session to continue')
    if not r['session_id']:raise ValueError('This task has no saved session yet. Try again once it has started')
    c.execute('INSERT INTO task_inputs(task,text,state,actor,at) VALUES(?,?,?,?,?)',(value,text.strip(),'pending',actor or 'operator',time.time()))
    audit(c,value,'follow-up',actor,text.strip()[:200])
    if r['state'] in ('running','queued','retrying'):print('queued');return 'queued'
    s['max_attempts']=min(100,max(s.get('max_attempts',3),r['attempts']+1))
    update(c,value,state='queued',phase='queued',spec=json.dumps(s),cancel=0,pause=0,error=None,retry_at=None,resume_requested=1)
    print('sent');return 'sent'

def decide(c,value,verdict,actor=None,reason=''):
    """The operator's answer to a task waiting for them."""
    r=load(c,value)
    if r['state'] not in ('waiting_approval','review'):raise ValueError('This task is not waiting for a decision')
    if verdict=='reject':
        audit(c,value,'rejected',actor,reason or r['error'] or r['state'])
        update(c,value,state='cancelled',phase='cancelled',error='rejected_by_operator',finished_at=time.time());persist_report(c,value);return
    if r['state']=='review':raise ValueError('Approving reviewed work runs its tests first; use approve')
    audit(c,value,'approved',actor,reason or r['error'] or '')
    extra={'permission_override':'acceptEdits','resume_requested':1} if r['error']=='permission_requested' else {}
    s=json.loads(r['spec']);s['max_attempts']=min(100,max(s.get('max_attempts',3),r['attempts']+1))
    update(c,value,state='queued',phase='queued',error=None,spec=json.dumps(s),**extra)

def finish_conversation(c,value,actor=None):
    r=load(c,value)
    if r['state']!='waiting_input':raise ValueError('Only a conversation waiting for you can be closed')
    audit(c,value,'closed',actor);update(c,value,state='completed',phase='completed',approved_by=actor or 'operator',finished_at=time.time());persist_report(c,value)

def resume_session(c,filename):
    """Queue the next turn of an existing conversation, or refuse with the reason. Never a new conversation in its place."""
    raw=json.loads(pathlib.Path(filename).read_text());agent=raw.get('agent');value=acc_sessions.check_id(raw.get('session'))
    if agent not in ('claude','codex'):raise ValueError('Sessions can only be resumed for Claude or Codex')
    if not isinstance(raw.get('prompt'),str) or not raw['prompt'].strip():raise ValueError('Write what the agent should do next')
    facts=acc_sessions.inspect(agent,value,raw.get('cwd'))
    if facts.get('problem'):raise ValueError(facts['problem'])
    for t in c.execute(f"SELECT id FROM tasks WHERE session_id=? AND state IN ({','.join('?'*len(OPEN_STATES))})",(value,*OPEN_STATES)).fetchall():raise ValueError('A background task is already using this conversation: '+t['id'])
    for t in c.execute(f"SELECT id,spec FROM tasks WHERE state IN ({','.join('?'*len(OPEN_STATES))})",OPEN_STATES).fetchall():
        other=json.loads(t['spec'])
        if pathlib.Path(other['worktree']).resolve()==pathlib.Path(facts['repo']).resolve():raise ValueError('Another task is working in this folder: '+t['id'])
    return enqueue_spec(c,{'repo':facts['repo'],'owner':agent,'prompt':raw['prompt'].strip(),'resume_session':value,'test':[],'permission_mode':raw.get('permission_mode','acceptEdits'),'timeout':raw.get('timeout',14400),'max_attempts':1,'model':raw.get('model'),'effort':raw.get('effort'),'actor':raw.get('actor')},internal=True)

def control(c,action,value):
    r=load(c,value)
    audit(c,value,action,'operator')
    if action=='cancel':
        update(c,value,cancel=1)
        if r['state']!='running':update(c,value,state='blocked',error='cancelled_before_start',phase='blocked')
    elif action=='pause':
        update(c,value,pause=1)
        if r['state']!='running':update(c,value,state='paused',phase='paused',error='operator_paused')
    elif action in ('retry','resume'):
        if r['state'] not in ('failed','blocked','paused','waiting_approval'):raise ValueError('Only interrupted, failed, blocked or paused tasks may be resumed')
        s=json.loads(r['spec']);ceiling=s.get('max_attempts',3)
        if r['attempts']>=ceiling:raise ValueError('Attempt budget exhausted; create a separately reviewed task')
        update(c,value,state='queued',cancel=0,pause=0,error=None,retry_at=None,resume_requested=1 if action=='resume' else 0,phase='queued')
    persist_report(c,value)

def approve(c,value,reviewer):
    r=load(c,value)
    if r['state']!='review' or not reviewer:raise ValueError('Passing tests and named reviewer required')
    audit(c,value,'approved-review',reviewer)
    s=json.loads(r['spec']);wt=s['worktree']
    with lease(wt):
        if git(wt,'status','--porcelain'):raise ValueError('Commit reviewed changes first')
        check=execute(c,value,s['test'],wt,'approval-test-'+str(time.time_ns()),s['timeout'],attempt=r['attempts'])
        if check['exit'] or check['cancelled']:raise ValueError('Approval test failed')
        if git(wt,'status','--porcelain'):raise ValueError('Tests changed files; review before approving')
        subprocess.run(['git','-C',s['repo'],'merge-tree','--write-tree','HEAD','task/'+value],check=True,stdout=subprocess.DEVNULL)
        result=json.loads(r['result'] or '{}');check.pop('tail',None);result.update(approval_test=check,commits=git(wt,'log','--oneline',s['base']+'..HEAD').splitlines(),reviewed_head=git(wt,'rev-parse','HEAD'),changed_files=git(wt,'diff','--name-status',s['base'],'HEAD').splitlines())
        update(c,value,state='completed',phase='completed',approved_by=reviewer,result=json.dumps(result),finished_at=time.time());checkpoint(c,value);persist_report(c,value)
    print('Approved. Merge explicitly with git merge --no-ff task/'+value)

def history(c,value):
    load(c,value)
    return {'inputs':[dict(x) for x in c.execute('SELECT seq,text,state,actor,at,delivered_at FROM task_inputs WHERE task=? ORDER BY seq',(value,))],'audit':[dict(x) for x in c.execute('SELECT seq,action,actor,detail,at FROM audit_log WHERE task=? ORDER BY seq',(value,))],'attempts':[{k:x[k] for k in ('number','state','started','finished')} for x in c.execute('SELECT * FROM attempts WHERE task=? ORDER BY number',(value,))]}

def logs(c,value):
    r=load(c,value);result=[]
    for p in sorted((ROOT/'logs').glob(value+'-a*.log')):
        with p.open('rb') as f:
            f.seek(max(0,p.stat().st_size-16000));data=f.read(16000).decode(errors='replace')
        result.append({'name':p.name,'text':scrub(data)})
    return result[-6:]

def snapshot(c):
    tasks=[]
    for row in c.execute('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 100'):
        r=dict(row);s=json.loads(r.pop('spec'));result=json.loads(r.pop('result') or '{}');r['owner']=s['owner'];r['title']=scrub(s['prompt'][:250]);r['repo']=s['repo'];r['branch']=s.get('branch');r['base']=s.get('base');r['in_place']=bool(s.get('in_place'));r['resumed']=bool(s.get('resume_session'));r['pending_inputs']=len(pending_inputs(c,r['id']));r['plan']=s.get('plan');r['plan_key']=s.get('plan_key');r['model']=s.get('model');r['effort']=s.get('effort');r['worktree']=s['worktree'];r['depends']=s.get('depends',[]);r['test_exit']=result.get('test',{}).get('exit');r['commits']=list(reversed(result.get('commits',[])));r['elapsed']=round((r['finished_at'] or time.time())-(r['started_at'] or r['created_at']),1);tasks.append(r)
    health={}
    try:health=json.loads((ROOT/'reports/health.json').read_text())
    except (OSError,ValueError):pass
    import acc_auto
    return {'server_time':time.time(),'tasks':tasks,'plans':acc_auto.listing(c),'provider_blocks':{r['owner']:r['error'] for r in c.execute('SELECT * FROM provider_controls')},'health':health,'execution':'Independent systemd task units; browser polling has no ownership of agent lifetimes'}

def main():
    global STOP
    os.umask(0o077);p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('action',choices=['add','list','show','worker','once','execute','cancel','pause','resume','retry','approve','snapshot','logs','reconcile','unblock-agent','verify','plan-add','plan-list','plan-show','plan-cancel','plan-resume','plan-approve-step','plan-merge','validate-plan','validate-review','roots','agents','policy','session-inspect','session-resume','followup','decide','close','history']);p.add_argument('value',nargs='?');p.add_argument('extra',nargs='?');p.add_argument('--reviewer');a=p.parse_args()
    if a.action=='session-inspect':
        print(json.dumps(acc_sessions.inspect(a.value,a.extra)));return
    # These run inside a test step or at a shell, where the queue database is out of reach or not needed.
    if a.action in ('validate-plan','validate-review'):
        import acc_auto;acc_auto.validate_file(a.action[9:],a.value);return
    if a.action=='policy':
        if a.value!='full-access' or a.extra not in ('on','off',None):raise ValueError('Use: acc policy full-access [on|off]')
        if a.extra:acc_roots.set_full_access(a.extra=='on')
        print('full access:','on' if acc_roots.full_access() else 'off');return
    if a.action=='roots':
        if a.value=='add':acc_roots.add(a.extra)
        elif a.value=='remove':acc_roots.remove(a.extra)
        elif a.value not in (None,'list'):raise ValueError('Use: acc roots [list|add PATH|remove PATH]')
        print('\n'.join(map(str,acc_roots.roots())));return
    c=connect();import acc_auto
    if a.action=='add':enqueue(c,a.value)
    elif a.action=='list':
        for r in c.execute('SELECT * FROM tasks ORDER BY rowid'):print(r['id'],r['state'],json.loads(r['spec'])['owner'],json.loads(r['spec'])['prompt'][:80])
    elif a.action=='show':print(json.dumps(dict(load(c,a.value)),indent=2))
    elif a.action in ('worker','once'):worker(c,a.action=='once')
    elif a.action=='execute':
        signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
        row=load(c,a.value)
        if json.loads(row['spec'])['owner'] not in ('demo','verifier') and not pathlib.Path('/proc/self/cgroup').read_text().strip().endswith('/'+UNIT_PREFIX+a.value+'.service'):raise ValueError('Real agents execute only inside their dedicated systemd task unit')
        run_one(c,row)
    elif a.action in ('cancel','pause','resume','retry'):control(c,a.action,a.value)
    elif a.action=='verify':
        r=load(c,a.value);previous=json.loads(r['result'] or '{}').get('run',{})
        if r['state']!='blocked' or previous.get('exit')!=0 or previous.get('reason') or classification(pathlib.Path(previous['log']).read_text()):raise ValueError('Only successful agent output with no current blocker can be verified')
        update(c,a.value,state='queued',phase='queued',error=None,resume_requested=2)
    elif a.action=='approve':approve(c,a.value,a.reviewer)
    elif a.action=='agents':print(json.dumps(acc_agents.registry(c)))
    elif a.action=='session-resume':print(resume_session(c,a.value))
    elif a.action=='followup':followup(c,a.value,pathlib.Path(a.extra).read_text(),a.reviewer)
    elif a.action=='decide':decide(c,a.value,a.extra,a.reviewer)
    elif a.action=='close':finish_conversation(c,a.value,a.reviewer)
    elif a.action=='history':print(json.dumps(history(c,a.value)))
    elif a.action=='plan-add':acc_auto.add(c,a.value)
    elif a.action=='plan-list':print(json.dumps(acc_auto.listing(c)))
    elif a.action=='plan-show':print(json.dumps(acc_auto.describe(c,acc_auto.plan_row(c,a.value),events=True)))
    elif a.action=='plan-cancel':acc_auto.request_cancel(c,a.value)
    elif a.action=='plan-resume':acc_auto.resume(c,a.value)
    elif a.action=='plan-approve-step':acc_auto.approve_step(c,a.value,a.extra)
    elif a.action=='plan-merge':acc_auto.merge(c,a.value,a.reviewer or 'operator')
    elif a.action=='snapshot':print(json.dumps(snapshot(c)))
    elif a.action=='logs':print(json.dumps(logs(c,a.value)))
    elif a.action=='reconcile':reconcile(c)
    elif a.action=='unblock-agent':
        if a.value not in ('claude','codex'):raise ValueError('Choose claude or codex')
        c.execute('DELETE FROM provider_controls WHERE owner=?',(a.value,));c.commit();print('Provider circuit cleared. Review and resume individual blocked tasks explicitly.')
    c.close()
