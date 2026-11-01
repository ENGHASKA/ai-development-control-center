"""Failure-injection tests. These do not represent real provider execution."""
import importlib.util,json,os,pathlib,subprocess,tempfile,time,unittest
from unittest.mock import patch
SOURCE=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('runtime',SOURCE/'libexec/acc_runtime.py');r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
class DurableRuntimeTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.previous=r.ROOT;r.ROOT=pathlib.Path(self.tmp.name);r.STOP=False;self.c=r.connect();self.repo=r.ROOT/'projects/sample';self.repo.mkdir(parents=True)
  for cmd in [('init','-b','main'),('config','user.name','Durability test'),('config','user.email','test@localhost')]:r.git(self.repo,*cmd)
  (self.repo/'README.md').write_text('fixture\n');r.git(self.repo,'add','.');r.git(self.repo,'commit','-m','fixture')
 def tearDown(self):self.c.close();r.ROOT=self.previous;self.tmp.cleanup();r.STOP=False
 def add(self,**extra):
  data={'repo':str(self.repo),'owner':'demo','prompt':'Failure injection fixture','test':['python3','-c','pass'],'max_attempts':3,**extra};p=r.ROOT/'input.json';p.write_text(json.dumps(data));return r.enqueue(self.c,p)
 def test_auth_quota_and_sandbox_are_blockers(self):
  for text,expected in [('not logged in','authentication'),('quota exceeded','quota'),('bwrap: operation not permitted','sandbox')]:
   i=self.add(retry_safe=True)
   with patch.object(r,'argv_for',return_value=(['python3','-c',f'print({text!r});raise SystemExit(1)'],None)):r.run_one(self.c,r.load(self.c,i))
   row=r.load(self.c,i);self.assertEqual(row['state'],'blocked');self.assertEqual(row['error'],expected);self.assertEqual(row['attempts'],1);self.assertIsNone(row['retry_at'])
 def test_clean_transient_retries_have_backoff_and_limit(self):
  i=self.add(retry_safe=True,retry_base=5)
  with patch.object(r,'argv_for',return_value=(['python3','-c',"print('ECONNRESET');raise SystemExit(75)"],None)):
   for n in range(3):
    before=time.time();r.run_one(self.c,r.load(self.c,i));row=r.load(self.c,i)
    if n<2:
     self.assertEqual(row['state'],'retrying');self.assertGreaterEqual(row['retry_at']-before,5*2**n);r.update(self.c,i,retry_at=0)
    else:self.assertEqual(row['state'],'failed')
  self.assertEqual(len(list((r.ROOT/'logs').glob(i+'-a*-run.log'))),3)
 def test_dirty_transient_is_not_replayed(self):
  i=self.add(retry_safe=True)
  with patch.object(r,'argv_for',return_value=(['python3','-c',"from pathlib import Path;Path('partial.txt').write_text('side effect');print('ECONNRESET');raise SystemExit(75)"],None)):r.run_one(self.c,r.load(self.c,i))
  self.assertEqual(r.load(self.c,i)['state'],'failed')
 def test_live_executor_not_blocked_by_reconcile(self):
  i=self.add();r.update(self.c,i,state='running',runner_pid=os.getpid(),runner_start=r.proc_start(os.getpid()),boot_id=r.boot_id(),heartbeat=time.time(),started_at=time.time()-20)
  r.reconcile(self.c);self.assertEqual(r.load(self.c,i)['state'],'running')
 def test_boot_change_checkpoint_resume_requires_opt_in(self):
  i=self.add(auto_resume=True,retry_base=5)
  r.update(self.c,i,state='running',attempts=1,runner_pid=9999999,boot_id='previous-boot',started_at=time.time()-30)
  r.reconcile(self.c);row=r.load(self.c,i);self.assertEqual(row['state'],'retrying');self.assertEqual(row['resume_requested'],1);self.assertTrue((r.ROOT/'tasks'/f'{i}-checkpoint.json').exists())
  j=self.add();r.update(self.c,j,state='running',attempts=1,boot_id='previous-boot',started_at=time.time()-30);r.reconcile(self.c);self.assertEqual(r.load(self.c,j)['state'],'blocked')
 def test_pause_preserves_files_and_resume_ownership(self):
  i=self.add();r.control(self.c,'pause',i);self.assertEqual(r.load(self.c,i)['state'],'paused');r.control(self.c,'resume',i);row=r.load(self.c,i);self.assertEqual(row['state'],'queued');self.assertEqual(json.loads(row['spec'])['owner'],'demo');self.assertEqual(row['resume_requested'],1)
 def test_secret_environment_not_inherited(self):
  with patch.dict(os.environ,{'AWS_SECRET_ACCESS_KEY':'fixture','UI_SECRET':'fixture','SSH_AUTH_SOCK':'fixture','OPENAI_API_KEY':'fixture'}):
   env=r.clean_env();self.assertNotIn('AWS_SECRET_ACCESS_KEY',env);self.assertNotIn('UI_SECRET',env);self.assertNotIn('SSH_AUTH_SOCK',env);self.assertNotIn('OPENAI_API_KEY',env)
 def test_provider_blocker_opens_account_circuit_without_retry(self):
  i=self.add(owner='claude',retry_safe=True)
  with patch.object(r,'argv_for',return_value=(['python3','-c',"print('usage_limit reached');raise SystemExit(1)"],None)):r.run_one(self.c,r.load(self.c,i))
  self.assertEqual(r.load(self.c,i)['state'],'blocked');self.assertEqual(self.c.execute('SELECT error FROM provider_controls WHERE owner=?',('claude',)).fetchone()[0],'quota')
 def test_real_agents_cannot_run_in_foreground_once(self):
  self.add(owner='codex')
  with self.assertRaises(ValueError):r.worker(self.c,once=True)
 def test_allowed_rate_limit_notification_is_not_exhaustion(self):
  self.assertIsNone(r.classification(json.dumps({'type':'rate_limit_event','rate_limit_info':{'status':'allowed','overageStatus':'rejected'}})))
  self.assertEqual(r.classification('rate_limit reached'),'quota')
 def test_temporary_local_http_outage_recovers_with_bounded_retry(self):
  import http.server,threading
  class Handler(http.server.BaseHTTPRequestHandler):
   status=503
   def do_GET(self):self.send_response(self.status);self.end_headers()
   def log_message(self,*args):pass
  server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
  code="import urllib.request,urllib.error\ntry: urllib.request.urlopen('http://127.0.0.1:%d',timeout=2)\nexcept urllib.error.HTTPError: print('HTTP 503 service unavailable');raise SystemExit(75)"%server.server_port
  try:
   i=self.add(retry_safe=True)
   with patch.object(r,'argv_for',return_value=(['python3','-c',code],None)):
    r.run_one(self.c,r.load(self.c,i));self.assertEqual(r.load(self.c,i)['state'],'retrying');Handler.status=200;r.update(self.c,i,retry_at=0);r.run_one(self.c,r.load(self.c,i));self.assertEqual(r.load(self.c,i)['state'],'review');self.assertEqual(r.load(self.c,i)['attempts'],2)
  finally:server.shutdown();server.server_close();thread.join()
 def test_verification_reuses_successful_output_without_provider_call(self):
  i=self.add();row=r.load(self.c,i);wt=pathlib.Path(json.loads(row['spec'])['worktree']);log=r.ROOT/'logs'/'previous.log';log.write_text('successful output')
  r.update(self.c,i,state='queued',resume_requested=2,result=json.dumps({'run':{'exit':0,'reason':None,'log':str(log)}}))
  with patch.object(r,'argv_for',side_effect=AssertionError('Must not call provider')):r.run_one(self.c,r.load(self.c,i))
  row=r.load(self.c,i);self.assertEqual(row['state'],'review');self.assertTrue(json.loads(row['result'])['run']['verification_only'])
 def test_claude_uses_installed_restricted_mode_and_no_command_tools(self):
  i=self.add(owner='claude');row=r.load(self.c,i);argv,prompt=r.argv_for(row,json.loads(row['spec']))
  self.assertIn('--restricted',argv);self.assertEqual(argv[argv.index('--tools')+1],'Read,Write,Edit,Glob,Grep');self.assertIn('--strict-mcp-config',argv)
if __name__=='__main__':unittest.main()
