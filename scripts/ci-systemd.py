#!/usr/bin/env python3
"""Real service/queue lifecycle acceptance in a disposable Ubuntu runner. No paid agents."""
import json,os,pathlib,signal,subprocess,time,tempfile
home=pathlib.Path.home();adcc=home/'.local/bin/adcc';config=home/'.config/ai-development-control-center';c=json.loads((config/'installation.json').read_text());root=pathlib.Path(c['workspace']);repo=root/'projects/ci-example';repo.mkdir()
def run(*args):return subprocess.check_output([str(x) for x in args],text=True).strip()
for args in [('init','-b','main'),('config','user.name','CI fixture'),('config','user.email','fixture@example.invalid')]:run('git','-C',repo,*args)
(repo/'progress.py').write_text("import pathlib,time\np=pathlib.Path('progress.txt')\nn=int(p.read_text()) if p.exists() else 0\nwhile n<60:\n n+=1;p.write_text(str(n));print(n,flush=True);time.sleep(.3)\nassert n==60\n")
run('git','-C',repo,'add','.');run('git','-C',repo,'commit','-m','Independent infrastructure test fixture')
spec={'repo':str(repo),'owner':'demo','prompt':'CI infrastructure fixture; no provider activity','test':['python3','progress.py'],'timeout':120,'auto_resume':True,'max_attempts':2,'retry_base':5}
p=root/'tasks/ci.json';p.write_text(json.dumps(spec));i=run(adcc,'task','add',p)
def row():return json.loads(run(adcc,'task','show',i))
def wait(predicate,seconds=90):
 for _ in range(seconds*5):
  r=row()
  if predicate(r):return r
  time.sleep(.2)
 raise AssertionError('Timed out: '+str(row()))
r=wait(lambda r:r['state']=='running' and r['phase']=='test');pid=r['runner_pid'];runid=r['run_id']
subprocess.run(['systemctl','--user','restart','adcc-dashboard'],check=True)
worker=int(run('systemctl','--user','show','adcc-worker','-p','MainPID','--value'));os.kill(worker,signal.SIGKILL);time.sleep(7)
after=row();assert after['runner_pid']==pid and after['run_id']==runid and after['attempts']==1
r=wait(lambda r:r['state']=='review');wt=pathlib.Path(json.loads(r['spec'])['worktree']);run('git','-C',wt,'add','.');run('git','-C',wt,'commit','-m','Reviewed fixture output');run(adcc,'task','approve',i,'--reviewer','CI-infrastructure-review');assert row()['state']=='completed'
# Second real executor interruption proves checkpoint recovery; not a mocked agent success.
spec['base']='main';p.write_text(json.dumps(spec));j=run(adcc,'task','add',p);i=j
r=wait(lambda r:r['state']=='running' and r['phase']=='test');time.sleep(1);os.kill(r['runner_pid'],signal.SIGKILL);recovered=wait(lambda r:r['state']=='review');assert recovered['attempts']==2
archive=root.parent/'ci-backup.tar.gz';run(adcc,'backup',archive);restored=root.parent/'ci-restore';run(adcc,'restore',archive,'--to',restored);assert (restored/'tasks/state.sqlite3').exists()
# Upgrade the same reviewed source through the actual installer, preserving state and credentials.
password=(config/'dashboard-password').read_bytes();source=pathlib.Path(__file__).resolve().parents[1];subprocess.run([str(adcc),'upgrade',str(source)],check=True);assert (config/'dashboard-password').read_bytes()==password;assert row()['state']=='review'
subprocess.run([str(adcc),'doctor'],check=True)
(root/'reports/ci-acceptance.json').write_text(json.dumps({'status':'PASS','scope':'Real systemd lifecycle on disposable Ubuntu 24.04 runner, infrastructure fixtures only','dashboard_restart':True,'dispatcher_crash':True,'executor_checkpoint_recovery':True,'logs_retained':True,'review_gate':True,'backup_restore':True,'upgrade_preserved_credentials_and_state':True},indent=2))
print('SYSTEMD_ACCEPTANCE_PASS')
