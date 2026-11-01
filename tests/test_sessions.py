"""Resuming conversations through the real queue with a fake provider binary. No test here can reach a real session."""
import json,os,pathlib,re,subprocess,sys,tempfile,time,unittest
BASE=pathlib.Path(__file__).resolve().parents[1]
ACC=str(BASE/'bin/acc')
A='11111111-2222-4333-8444-555555555555'
B='66666666-7777-4888-9999-aaaaaaaaaaaa'
FAKE='''#!/usr/bin/env python3
import json,os,pathlib,sys
# The executor passes a fixed environment, so this finds its files beside itself.
here=pathlib.Path(sys.argv[0]).resolve().parent
open(here/'calls.jsonl','a').write(json.dumps({'argv':sys.argv[1:],'cwd':os.getcwd(),'stdin':sys.stdin.read()})+'\\n')
reply=here/'reply.txt'
print(reply.read_text() if reply.exists() else '{"type":"done"}')
'''

class Base(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.tmp.name).resolve()
        self.fake=self.root/'fake-agent';self.fake.write_text(FAKE);self.fake.chmod(0o755);self.calls=self.root/'calls.jsonl'
        self.env={**os.environ,'ACC_ROOT':str(self.root),'ACC_ROOTS_FILE':str(self.root/'roots.json'),'CODEX_HOME':str(self.root/'codex'),'CLAUDE_HOME':str(self.root/'claude'),'ACC_CODEX_BIN':str(self.fake),'ACC_CLAUDE_BIN':str(self.fake)}
        self.repo=self.project('app')
    def tearDown(self):self.tmp.cleanup()
    def project(self,name,commit=True):
        p=self.root/'projects'/name;p.mkdir(parents=True);subprocess.check_call(['git','init','-q','-b','main',str(p)])
        for k,v in (('user.name','T'),('user.email','t@localhost')):subprocess.check_call(['git','-C',str(p),'config',k,v])
        if commit:(p/'README.md').write_text('app\n');subprocess.check_call(['git','-C',str(p),'add','.']);subprocess.check_call(['git','-C',str(p),'commit','-qm','start'])
        return p
    def codex_session(self,sid=A,cwd=None):
        d=self.root/'codex/sessions/2026/10/31';d.mkdir(parents=True,exist_ok=True)
        (d/f'rollout-2026-10-31T00-00-00-{sid}.jsonl').write_text(json.dumps({'type':'session_meta','payload':{'id':sid,'cwd':str(cwd or self.repo)}})+'\n')
    def claude_session(self,sid=A,cwd=None):
        d=self.root/'claude/projects/x';d.mkdir(parents=True,exist_ok=True)
        (d/f'{sid}.jsonl').write_text(json.dumps({'type':'user','cwd':str(cwd or self.repo)})+'\n')
    def acc(self,*a,ok=True,env=None):
        p=subprocess.run([ACC,*a],env={**self.env,**(env or {})},capture_output=True,text=True,timeout=60)
        if ok:self.assertEqual(p.returncode,0,p.stderr+p.stdout)
        return p
    def resume(self,agent='codex',sid=A,ok=True,**extra):
        f=self.root/'r.json';f.write_text(json.dumps({'agent':agent,'session':sid,'prompt':'Carry on',**extra}));return self.acc('session-resume',str(f),ok=ok)
    def add(self,ok=True,repo=None,**extra):
        f=self.root/'s.json';f.write_text(json.dumps({'repo':str(repo or self.repo),'owner':'demo','prompt':'Do it','test':['python3','-c','pass'],'timeout':30,**extra}));return self.acc('add',str(f),ok=ok)
    def show(self,i):return json.loads(self.acc('show',i).stdout)
    def run_turn(self,i,reply=None):
        r=self.root/'reply.txt'
        r.write_text(reply) if reply else r.unlink(missing_ok=True)
        code=f"import sys;sys.path.insert(0,{str(BASE/'libexec')!r});import acc_runtime as r;c=r.connect();r.run_one(c,r.load(c,{i!r}))"
        subprocess.run([sys.executable,'-c',code],env=self.env,check=True,timeout=60)
    def last_call(self):return json.loads(self.calls.read_text().splitlines()[-1])
    def err(self,p):return p.stderr+p.stdout

class Inspecting(Base):
    def test_ids_must_be_exact(self):
        for bad in ('x',A+' --dangerously-bypass',';rm -rf /','--last','../'+A,B.upper(),A+'\n'):
            self.assertNotEqual(self.acc('session-inspect','codex',bad,ok=False).returncode,0,bad)
    def info(self,*a):return json.loads(self.acc('session-inspect',*a).stdout)
    def test_a_missing_session_is_reported_never_replaced(self):
        d=self.info('codex',A);self.assertFalse(d['exists']);self.assertIn('won\'t be started',d['problem'])
        self.assertNotEqual(self.resume(ok=False).returncode,0);self.assertFalse(self.calls.exists())
    def test_finds_both_providers(self):
        self.codex_session();self.claude_session(B)
        self.assertEqual(self.info('codex',A)['cwd'],str(self.repo));self.assertEqual(self.info('claude',B)['repo'],str(self.repo))
        self.assertFalse(self.info('claude',A)['exists'],'a Codex ID is not a Claude session')
    def test_unapproved_folder(self):
        self.codex_session(cwd='/etc');d=self.info('codex',A);self.assertIn('not an approved folder',d['problem']);self.assertIn('acc roots add',d['problem'])
        self.assertNotEqual(self.resume(ok=False).returncode,0)
    def test_folder_gone(self):
        self.codex_session(cwd=self.root/'gone');self.assertIn('folder is gone',self.info('codex',A)['problem'])
    def test_plain_folder_offers_the_terminal_only(self):
        p=self.root/'plain';p.mkdir();self.codex_session(cwd=p);d=self.info('codex',A);self.assertTrue(d['interactive']);self.assertIn('Git repository',d['problem'])
    def test_claude_must_stay_in_its_folder(self):
        self.claude_session();other=self.project('other')
        f=self.root/'r.json';f.write_text(json.dumps({'agent':'claude','session':A,'prompt':'x','cwd':str(other)}));self.assertIn('folder it started',self.err(self.acc('session-resume',str(f),ok=False)))
    def test_a_session_open_elsewhere_is_refused(self):
        self.codex_session()
        p=subprocess.Popen(['python3','-c','import time;time.sleep(30)',A],executable=sys.executable)
        try:
            time.sleep(.4);d=self.info('codex',A);self.assertTrue(d['in_use']);self.assertIn('open somewhere else',d['problem'])
        finally:p.kill();p.wait()
        self.assertFalse(self.info('codex',A)['in_use'])

class Resuming(Base):
    def test_codex_continues_the_same_conversation_in_place(self):
        self.codex_session();i=self.resume().stdout.strip();t=self.show(i);self.run_turn(i)
        c=self.last_call();self.assertEqual(c['cwd'],str(self.repo));
        self.assertIn('resume',c['argv']);self.assertIn(A,c['argv']);self.assertLess(c['argv'].index('resume'),c['argv'].index(A));self.assertIn('Carry on',c['stdin'])
        self.assertEqual(c['argv'][c['argv'].index('--sandbox')+1],'workspace-write')
        self.assertEqual(self.show(i)['state'],'waiting_input');self.assertEqual(t['session_id'],A)
    def test_claude_continues_the_same_conversation_in_place(self):
        self.claude_session();i=self.resume('claude').stdout.strip();self.run_turn(i);c=self.last_call()
        self.assertEqual(c['argv'][c['argv'].index('--resume')+1],A);self.assertNotIn('--session-id',c['argv']);self.assertNotIn('--fork-session',c['argv']);self.assertEqual(c['cwd'],str(self.repo))
    def test_no_worktree_is_made_for_a_resume(self):
        self.codex_session();i=self.resume().stdout.strip();s=json.loads(self.show(i)['spec'])
        self.assertEqual(s['worktree'],str(self.repo));self.assertFalse((self.root/'worktrees'/i).exists())
    def test_two_resumes_of_one_session_are_refused(self):
        self.codex_session();self.resume();self.assertIn('already using',self.err(self.resume(ok=False)))
    def test_two_conversations_in_one_folder_are_refused(self):
        self.codex_session();self.codex_session(B);self.resume();self.assertIn('Another task is working',self.err(self.resume(sid=B,ok=False)))
    def test_a_held_tree_stops_the_turn_without_running_it(self):
        import fcntl,hashlib
        self.codex_session();i=self.resume().stdout.strip();(self.root/'tasks/leases').mkdir(parents=True,exist_ok=True)
        fd=os.open(self.root/'tasks/leases'/(hashlib.sha256(str(self.repo).encode()).hexdigest()+'.lock'),os.O_CREAT|os.O_RDWR);fcntl.flock(fd,fcntl.LOCK_EX)
        self.run_turn(i);os.close(fd);t=self.show(i);self.assertEqual(t['state'],'blocked');self.assertEqual(t['error'],'worktree_already_owned');self.assertFalse(self.calls.exists())
    def test_live_checks_only_use_sessions_they_create(self):
        s=(BASE/'scripts/resume-check.cjs').read_text();self.assertNotRegex(s,r'[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?<!0{12})');self.assertIn('randomUUID',s)

class FollowUps(Base):
    def message(self,i,text,**k):
        f=self.root/'m.txt';f.write_text(text);return self.acc('followup',i,str(f),'--reviewer','tester',**k)
    def started(self):
        self.codex_session();i=self.resume().stdout.strip();self.run_turn(i);return i
    def test_a_follow_up_runs_as_the_next_turn_of_the_same_session(self):
        i=self.started();self.assertEqual(self.message(i,'Now do this').stdout.strip(),'sent');self.assertEqual(self.show(i)['state'],'queued');self.run_turn(i)
        c=self.last_call();self.assertIn('Now do this',c['stdin']);self.assertNotIn('Carry on',c['stdin']);self.assertIn(A,c['argv'])
        self.assertEqual(self.show(i)['state'],'waiting_input')
        h=json.loads(self.acc('history',i).stdout);self.assertEqual(h['inputs'][0]['state'],'delivered');self.assertIn('follow-up',[a['action'] for a in h['audit']])
    def test_a_message_during_a_turn_waits_and_says_so(self):
        i=self.resume_running();self.assertEqual(self.message(i,'Later').stdout.strip(),'queued')
    def resume_running(self):
        self.codex_session();i=self.resume().stdout.strip();return i
    def test_a_waiting_message_starts_the_next_turn_when_this_one_ends(self):
        i=self.resume_running()
        code=f"import sys;sys.path.insert(0,{str(BASE/'libexec')!r});import acc_runtime as r\nc=r.connect();c.execute(\"UPDATE tasks SET state='running' WHERE id=?\",({i!r},));c.commit()"
        subprocess.run([sys.executable,'-c',code],env=self.env,check=True);self.message(i,'After that')
        code=f"import sys;sys.path.insert(0,{str(BASE/'libexec')!r});import acc_runtime as r\nc=r.connect();c.execute(\"UPDATE tasks SET state='queued' WHERE id=?\",({i!r},));c.commit()"
        subprocess.run([sys.executable,'-c',code],env=self.env,check=True);self.run_turn(i)
        h=json.loads(self.acc('history',i).stdout);self.assertEqual(h['inputs'][0]['state'],'delivered')
    def test_empty_finished_and_sessionless_tasks_refuse(self):
        i=self.started()
        self.assertNotEqual(self.message(i,'   ',ok=False).returncode,0);self.acc('close',i,'--reviewer','t')
        self.assertIn('finished',self.err(self.message(i,'x',ok=False)))
        d=self.add().stdout.strip();self.assertIn('no conversation',self.err(self.message(d,'x',ok=False)))
    def test_closing_only_applies_to_a_waiting_conversation(self):
        d=self.add().stdout.strip();self.assertNotEqual(self.acc('close',d,'--reviewer','t',ok=False).returncode,0)

class Approvals(Base):
    def claude_task(self,**extra):
        return self.add(owner='claude',permission_mode='default',**extra).stdout.strip()
    DENIED='{"type":"result","permission_denials":[{"tool_name":"Write"}]}'
    def test_a_denied_action_waits_and_approval_retries_with_edits_allowed(self):
        i=self.claude_task();self.run_turn(i,self.DENIED);t=self.show(i);self.assertEqual(t['state'],'waiting_approval');self.assertEqual(t['error'],'permission_requested')
        self.acc('decide',i,'approve','--reviewer','me');self.assertEqual(self.show(i)['state'],'queued');self.run_turn(i);c=self.last_call()
        self.assertEqual(c['argv'][c['argv'].index('--permission-mode')+1],'acceptEdits');self.assertIn('--resume',c['argv'])
        self.assertEqual(self.show(i)['state'],'review')
        self.assertNotIn('bypassPermissions',c['argv'])
    def test_asking_first_really_withholds_the_writing_tools(self):
        i=self.claude_task();self.run_turn(i,self.DENIED);c=self.last_call();allowed=c['argv'][c['argv'].index('--allowedTools')+1].split(',')
        self.assertEqual(sorted(allowed),['Glob','Grep','Read']);self.acc('decide',i,'approve','--reviewer','me');self.run_turn(i);c=self.last_call()
        self.assertIn('Write',c['argv'][c['argv'].index('--allowedTools')+1].split(','))
    def test_rejecting_stops_it_and_keeps_the_work(self):
        i=self.claude_task();self.run_turn(i,self.DENIED);self.acc('decide',i,'reject','--reviewer','me');t=self.show(i);self.assertEqual(t['state'],'cancelled');self.assertEqual(t['error'],'rejected_by_operator')
        self.assertTrue(pathlib.Path(json.loads(t['spec'])['worktree']).exists())
    def test_held_tasks_never_start_until_approved(self):
        i=self.add(hold_for_approval=True).stdout.strip();self.assertEqual(self.show(i)['state'],'waiting_approval');self.acc('once');self.assertEqual(self.show(i)['state'],'waiting_approval')
        self.acc('decide',i,'approve','--reviewer','me');self.acc('once');self.assertEqual(self.show(i)['state'],'review')
    def test_decisions_need_something_waiting(self):
        i=self.add().stdout.strip();self.assertNotEqual(self.acc('decide',i,'approve','--reviewer','me',ok=False).returncode,0)
    def test_every_decision_is_audited_with_who_made_it(self):
        i=self.add(hold_for_approval=True).stdout.strip();self.acc('decide',i,'reject','--reviewer','the operator')
        a=json.loads(self.acc('history',i).stdout)['audit'];self.assertEqual(a[-1]['action'],'rejected');self.assertEqual(a[-1]['actor'],'the operator')
    def test_cancel_reaches_a_waiting_task(self):
        i=self.add(hold_for_approval=True).stdout.strip();self.acc('cancel',i);self.assertEqual(self.show(i)['error'],'cancelled_before_start')

class ProjectChecks(Base):
    def test_an_empty_project_needs_an_explicit_choice(self):
        e=self.project('empty',commit=False);subprocess.check_call(['git','-C',str(e),'commit','-q','--allow-empty','-m','Start project'])
        self.assertIn('no files',self.err(self.add(repo=e,ok=False)));self.assertEqual(self.acc('list').stdout,'');self.assertEqual(list((self.root/'worktrees').glob('*')) if (self.root/'worktrees').exists() else [],[])
        self.assertTrue(self.add(repo=e,allow_empty=True).stdout.strip())
    def test_a_worktree_holds_the_project_at_the_recorded_commit(self):
        i=self.add().stdout.strip();s=json.loads(self.show(i)['spec']);self.assertTrue(pathlib.Path(s['worktree'],'README.md').exists());self.assertEqual(s['branch'],'main')
        self.assertEqual(subprocess.check_output(['git','-C',s['worktree'],'rev-parse','HEAD'],text=True).strip(),s['base'])
    def test_each_kind_of_bad_project_is_named(self):
        plain=self.root/'projects/plain';plain.mkdir();self.assertIn('not a Git repository',self.err(self.add(repo=plain,ok=False)))
        self.assertIn('no commits',self.err(self.add(repo=self.project('new',commit=False),ok=False)))
    def test_a_folder_is_not_a_test_command(self):
        self.assertIn('folder, not a program',self.err(self.add(test=['.'],ok=False)));self.assertIn('does not have',self.err(self.add(test=['no-such-runner'],ok=False)))

class Isolation(unittest.TestCase):
    def test_nothing_in_the_repository_stops_a_whole_tmux_server(self):
        for p in [*(BASE/'scripts').glob('*'),*(BASE/'bin').glob('*'),*(BASE/'libexec').glob('*.py'),BASE/'dashboard/server/pty.mjs']:
            if p.is_file():self.assertNotIn('kill-server',p.read_text(errors='replace'),p)
    def test_the_test_instance_cant_join_another_tmux_server(self):
        s=(BASE/'scripts/isolated-instance.sh').read_text();self.assertIn('unset TMUX',s);self.assertIn('TMUX_TMPDIR="$ROOT/tmux"',s)

if __name__=='__main__':unittest.main()
