import json,os,pathlib,sqlite3,subprocess,tempfile,time,unittest
ACC=str(pathlib.Path(__file__).resolve().parents[1]/'bin/acc')
class QueueTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.tmp.name);self.env=dict(os.environ,ACC_ROOT=str(self.root));self.repo=self.root/'projects/sample';self.repo.mkdir(parents=True)
  for d in ('worktrees','logs','reports'): (self.root/d).mkdir()
  self.git('init','-b','main');self.git('config','user.name','Control Center Test');self.git('config','user.email','test@localhost');(self.repo/'README.md').write_text('Test\n');self.git('add','.');self.git('commit','-m','Initial')
 def tearDown(self):self.tmp.cleanup()
 def git(self,*args):return subprocess.check_output(['git','-C',str(self.repo),*args],text=True,stderr=subprocess.DEVNULL)
 def acc(self,*args,ok=True):
  p=subprocess.run([ACC,*args],env=self.env,capture_output=True,text=True)
  if ok:self.assertEqual(p.returncode,0,p.stderr+p.stdout)
  return p
 def add(self,depends=None,test=None):
  p=self.root/'spec.json';p.write_text(json.dumps({'repo':str(self.repo),'owner':'demo','prompt':'Run isolated demo','depends':depends or [],'test':test or ['python3','-c',"from pathlib import Path; assert Path('demo-result.txt').read_text() == 'isolated task completed\\n'"]}));return self.acc('add',str(p)).stdout.strip()
 def show(self,i):return json.loads(self.acc('show',i).stdout)
 def test_dependency_review_and_conflict_gate(self):
  first=self.add();second=self.add([first]);self.acc('once');self.assertEqual(self.show(first)['state'],'review');self.assertEqual(self.show(second)['state'],'queued')
  self.assertNotEqual(self.acc('approve',first,'--reviewer','human',ok=False).returncode,0)
  wt=json.loads(self.show(first)['spec'])['worktree'];subprocess.run(['git','-C',wt,'add','.'],check=True);subprocess.run(['git','-C',wt,'commit','-m','Reviewed demo'],check=True,stdout=subprocess.DEVNULL)
  self.acc('approve',first,'--reviewer','human');self.acc('once');self.assertEqual(self.show(second)['state'],'review');self.assertFalse((self.repo/'demo-result.txt').exists())
 def test_failed_tests_and_bounded_retry(self):
  i=self.add(test=['python3','-c','raise SystemExit(1)'])
  for n in range(3):
   self.acc('once');self.assertEqual(self.show(i)['state'],'failed')
   if n<2:self.acc('retry',i)
  self.assertNotEqual(self.acc('retry',i,ok=False).returncode,0)
 def test_interrupted_worker_requires_explicit_retry(self):
  i=self.add()
  with sqlite3.connect(self.root/'tasks/state.sqlite3') as c:c.execute("UPDATE tasks SET state='running' WHERE id=?",(i,))
  self.acc('once');self.assertEqual(self.show(i)['state'],'blocked');self.acc('retry',i);self.acc('once');self.assertEqual(self.show(i)['state'],'review')
 def test_cancel_and_sanitize_log(self):
  i=self.add(test=['python3','-u','-c',"import time; print('access_token=private-example-value'); time.sleep(20)"])
  p=subprocess.Popen([ACC,'once'],env=self.env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  try:
   log=self.root/'logs'/f'{i}-test.log';deadline=time.time()+10
   while (not log.exists() or not log.stat().st_size) and time.time()<deadline:time.sleep(.05)
   self.acc('cancel',i);p.wait(timeout=10);self.assertIn('[REDACTED]',log.read_text());self.assertNotIn('private-example-value',log.read_text());self.assertNotEqual(self.show(i)['state'],'review')
  finally:
   if p.poll() is None:p.terminate();p.wait()
 def test_cancel_when_process_closes_output(self):
  i=self.add(test=['python3','-c','import os,time; os.close(1); os.close(2); time.sleep(20)'])
  p=subprocess.Popen([ACC,'once'],env=self.env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  try:
   log=self.root/'logs'/f'{i}-test.log';deadline=time.time()+10
   while not log.exists() and time.time()<deadline:time.sleep(.05)
   self.assertTrue(log.exists());time.sleep(.15);self.acc('cancel',i);p.wait(timeout=5);self.assertEqual(self.show(i)['state'],'blocked')
  finally:
   if p.poll() is None:p.terminate();p.wait()
 def test_two_slots_overlap_without_shared_worktree(self):
  barrier=self.root/'barrier';barrier.mkdir()
  code="""import pathlib,time,json,sys
barrier=pathlib.Path(sys.argv[1]);start=time.time();(barrier/(pathlib.Path.cwd().name+'.ready')).touch()
while len(list(barrier.glob('*.ready')))<2:
 if time.time()-start>30:raise SystemExit('The second worker did not run concurrently')
 time.sleep(.02)
time.sleep(.6);pathlib.Path('timing.json').write_text(json.dumps([start,time.time()]))
"""
  command=['python3','-c',code,str(barrier)]
  a=self.add(test=command);b=self.add(test=command)
  self.env['ACC_MAX_WORKERS']='2';self.acc('once')
  intervals=[]
  for i in (a,b):
   row=self.show(i);self.assertEqual(row['state'],'review');wt=pathlib.Path(json.loads(row['spec'])['worktree']);intervals.append(json.loads((wt/'timing.json').read_text()))
  self.assertLess(max(x[0] for x in intervals),min(x[1] for x in intervals))
 def test_conflicting_branch_is_not_approved_or_merged(self):
  i=self.add();self.acc('once');wt=pathlib.Path(json.loads(self.show(i)['spec'])['worktree'])
  (wt/'README.md').write_text('Task side conflicting change\n')
  subprocess.run(['git','-C',str(wt),'add','.'],check=True);subprocess.run(['git','-C',str(wt),'commit','-m','Task conflict'],check=True,stdout=subprocess.DEVNULL)
  (self.repo/'README.md').write_text('Integration side conflicting change\n');self.git('add','README.md');self.git('commit','-m','Integration conflict');head=self.git('rev-parse','HEAD')
  self.assertNotEqual(self.acc('approve',i,'--reviewer','test-reviewer',ok=False).returncode,0)
  self.assertEqual(self.show(i)['state'],'review');self.assertEqual(self.git('rev-parse','HEAD'),head)
if __name__=='__main__':unittest.main()
