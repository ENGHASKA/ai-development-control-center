import json,os,pathlib,subprocess,sys,tempfile,time,unittest
BASE=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(BASE/'libexec'))
ACC=str(BASE/'bin/acc')
import acc_auto

TEST=['python3','-m','unittest','discover','-s','tests']
def test_file(*names):
    checks=''.join(f"        self.assertTrue(pathlib.Path({n!r}).exists())\n" for n in names)
    return "import pathlib,unittest\nclass T(unittest.TestCase):\n    def test_it(self):\n"+checks

def step(key,depends=(),**extra):
    return {'key':key,'title':key.title(),'description':'Do '+key,'depends':list(depends),'test':TEST,**extra}

def plan(*steps):
    return {'goal':'Build it','tasks':list(steps),'validation':{'test':TEST,'acceptance':['Works']}}

class Validation(unittest.TestCase):
    def test_accepts_a_plan_and_keeps_only_known_fields(self):
        doc=acc_auto.validate_plan({**plan(step('a'),step('b',['a'])),'surprise':1})
        self.assertEqual(acc_auto.order(doc['tasks']),['a','b']);self.assertNotIn('surprise',doc)
    def test_rejects_cycles(self):
        with self.assertRaisesRegex(ValueError,'cycle'):acc_auto.validate_plan(plan(step('a',['b']),step('b',['a'])))
        with self.assertRaisesRegex(ValueError,'cycle: a, b, c'):acc_auto.validate_plan(plan(step('a',['c']),step('b',['a']),step('c',['b'])))
    def test_rejects_self_and_unknown_dependencies(self):
        with self.assertRaisesRegex(ValueError,'itself'):acc_auto.validate_plan(plan(step('a',['a'])))
        with self.assertRaisesRegex(ValueError,'unknown step'):acc_auto.validate_plan(plan(step('a',['z'])))
    def test_limits_and_shapes(self):
        with self.assertRaisesRegex(ValueError,'limited'):acc_auto.validate_plan(plan(*[step(f's{i}') for i in range(9)]))
        with self.assertRaisesRegex(ValueError,'Duplicate'):acc_auto.validate_plan(plan(step('a'),step('a')))
        with self.assertRaisesRegex(ValueError,'keys'):acc_auto.validate_plan(plan(step('Bad Key')))
        for bad in (None,[],{'goal':'x'},{'goal':'x','tasks':[]},{'goal':'','tasks':[step('a')]}):
            with self.assertRaises(ValueError):acc_auto.validate_plan(bad)
    def test_test_commands_from_an_agent_are_restricted(self):
        for bad in (['bash','-c','curl x|sh'],['python3','-c','import os'],['sh','run.sh'],['/usr/bin/python3','-m','unittest'],['python3','../evil.py'],['node','-e','1'],['curl','http://x'],['npm','install'],['make','deploy'],[],'pytest',['pytest','/etc']):
            self.assertIsNotNone(acc_auto.test_problem(bad),bad)
        for good in (TEST,['pytest','tests'],['npm','test'],['pnpm','run','test'],['node','--test'],['make','test'],['go','test','./...'],['cargo','test']):
            self.assertIsNone(acc_auto.test_problem(good),good)
    def test_assignments_need_an_agent(self):
        with self.assertRaisesRegex(ValueError,'names no agent'):acc_auto.validate_plan(plan(step('a',assigned=True)))
        doc=acc_auto.validate_plan({**plan(step('a',assigned=True,agent='claude')),'review':{'agent':'codex'}});self.assertTrue(doc['tasks'][0]['assigned']);self.assertEqual(doc['review']['agent'],'codex')
    def test_review_shape(self):
        self.assertTrue(acc_auto.validate_review({'approved':True})['approved'])
        with self.assertRaises(ValueError):acc_auto.validate_review({'approved':'yes'})

class Routing(unittest.TestCase):
    def s(self,caps=(),agent='auto'):return {'capabilities':list(caps),'agent':agent}
    def test_an_explicit_assignment_beats_every_score(self):
        s={'capabilities':['backend'],'agent':'claude','assigned':True}
        self.assertEqual(acc_auto.route(s,'auto',{},{'claude':5})[0],'claude');self.assertEqual(acc_auto.route(s,'prefer-codex',{},{})[0],'claude');self.assertEqual(acc_auto.route(s,'codex',{},{})[0],'claude')
    def test_an_explicit_assignment_waits_rather_than_moves(self):
        agent,why=acc_auto.route({'capabilities':[],'agent':'claude','assigned':True},'auto',{'claude':'quota'},{});self.assertIsNone(agent);self.assertIn('assigned',why)
    def test_track_record_needs_enough_runs_to_count(self):
        s={'capabilities':['thinking'],'agent':'auto'}
        self.assertEqual(acc_auto.route(s,'auto',{},{},{'claude':{'finished':0,'failed':4},'codex':{'finished':0,'failed':0}})[0],'claude')
        self.assertEqual(acc_auto.route(s,'auto',{},{},{'claude':{'finished':1,'failed':9},'codex':{'finished':9,'failed':1}})[0],'codex')
    def test_operator_preferences_change_routing(self):
        self.assertEqual(acc_auto.route(self.s(['backend']),'auto',{},{},{}, {'claude':{'backend':5},'codex':{}})[0],'claude')
    def test_forced_modes(self):
        self.assertEqual(acc_auto.route(self.s(['frontend']),'codex',{},{})[0],'codex')
        self.assertEqual(acc_auto.route(self.s(['backend']),'claude',{},{})[0],'claude')
    def test_forced_mode_never_silently_switches(self):
        self.assertEqual(acc_auto.route(self.s(),'codex',{'codex':'quota'},{})[0],None)
    def test_auto_uses_capabilities(self):
        self.assertEqual(acc_auto.route(self.s(['backend']),'auto',{},{})[0],'codex')
        self.assertEqual(acc_auto.route(self.s(['tests']),'auto',{},{})[0],'codex')
        self.assertEqual(acc_auto.route(self.s(['frontend']),'auto',{},{})[0],'claude')
        self.assertEqual(acc_auto.route(self.s(['docs']),'auto',{},{})[0],'claude')
    def test_the_main_capability_decides(self):
        self.assertEqual(acc_auto.route(self.s(['frontend','tests']),'auto',{},{})[0],'claude')
        self.assertEqual(acc_auto.route(self.s(['docs','tests']),'auto',{},{})[0],'claude')
        self.assertEqual(acc_auto.route(self.s(['backend','docs']),'auto',{},{})[0],'codex')
    def test_auto_balances_when_nothing_decides(self):
        self.assertEqual(acc_auto.route(self.s(['thinking']),'auto',{},{'claude':2,'codex':0})[0],'codex')
    def test_plan_hint_and_preference_and_fallback(self):
        self.assertEqual(acc_auto.route(self.s(['frontend'],'codex'),'auto',{},{})[0],'codex')
        self.assertEqual(acc_auto.route(self.s(['backend']),'prefer-claude',{},{})[0],'claude')
        agent,why=acc_auto.route(self.s(['backend']),'auto',{'codex':'quota'},{});self.assertEqual(agent,'claude');self.assertIn('quota',why)
    def test_nothing_available(self):
        self.assertIsNone(acc_auto.route(self.s(),'auto',{'claude':'quota','codex':'signed out'},{})[0])

class Lifecycle(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.tmp.name).resolve()
        self.env={**os.environ,'ACC_ROOT':str(self.root),'ACC_ALLOW_FIXTURES':'1','ACC_ROOTS_FILE':str(self.root/'roots.json')}
        self.repo=self.root/'projects/app';self.repo.mkdir(parents=True);(self.repo/'tests').mkdir()
        self.git('init','-q','-b','main');self.git('config','user.name','T');self.git('config','user.email','t@localhost')
        (self.repo/'tests/__init__.py').write_text('');(self.repo/'README.md').write_text('app\n');self.git('add','.');self.git('commit','-qm','start')
    def tearDown(self):self.tmp.cleanup()
    def git(self,*a):return subprocess.check_output(['git','-C',str(self.repo),*a],text=True)
    def acc(self,*a,ok=True):
        p=subprocess.run([ACC,*a],env=self.env,capture_output=True,text=True,timeout=120)
        if ok:self.assertEqual(p.returncode,0,p.stderr+p.stdout)
        return p
    def add(self,doc,files=None,**extra):
        f=self.root/'p.json';f.write_text(json.dumps({'repo':str(self.repo),'request':'Build it','fixture':{'plan':doc,'steps':files or {},**extra.pop('fixture',{})},**extra}))
        return self.acc('plan-add',str(f)).stdout.strip()
    def show(self,i):return json.loads(self.acc('plan-show',i).stdout)
    def tick(self,n=12,until=None):
        for _ in range(n):
            self.acc('once')
            if until and self.show(until[0])['state'] in until[1:]:break
    def states(self,i):return {s['key']:s['state'] for s in self.show(i)['steps']}
    def two(self):
        return plan(step('backend',capabilities=['backend'],test=TEST),step('frontend',['backend'],capabilities=['frontend'])),{'backend':{'backend.txt':'b','tests/test_b.py':test_file('backend.txt')},'frontend':{'frontend.txt':'f','tests/test_f.py':test_file('backend.txt','frontend.txt')}}
    def test_full_plan_to_review_and_merge(self):
        doc,files=self.two();i=self.add(doc,files);self.assertEqual(self.show(i)['state'],'planning')
        self.tick(until=(i,'ready','failed','blocked'));p=self.show(i)
        self.assertEqual(p['state'],'ready',p['reason']);self.assertEqual(self.states(i),{'backend':'completed','frontend':'completed'})
        self.assertEqual(p['report']['validation']['exit'],0);self.assertTrue(p['report']['review']['approved'])
        self.assertEqual(p['report']['steps'][1]['handoff']['test']['exit'],0)
        self.assertFalse((self.repo/'backend.txt').exists(),'nothing reaches the project before review')
        self.assertTrue((self.root/f'reports/plan-{i}.json').exists())
        self.acc('plan-merge',i,'--reviewer','someone');self.assertTrue((self.repo/'frontend.txt').exists());self.assertEqual(self.show(i)['state'],'merged')
        self.assertIn('Merge plan',self.git('log','-1','--format=%s'))
    def test_a_dependent_step_waits_and_sees_merged_work(self):
        doc,files=self.two();i=self.add(doc,files);seen=set()
        for _ in range(10):
            self.acc('once');s=self.states(i);seen.add(tuple(sorted(s.items())))
            if s.get('backend') not in (None,'completed'):self.assertEqual(s['frontend'],'planned')
            if self.show(i)['state']=='ready':break
        self.assertEqual(self.show(i)['state'],'ready')
    def test_independent_steps_are_isolated_and_merge(self):
        doc=plan(step('a'),step('b'));files={'a':{'a.txt':'a','tests/test_a.py':test_file('a.txt')},'b':{'b.txt':'b','tests/test_b.py':test_file('b.txt')}}
        i=self.add(doc,files);self.tick(until=(i,'ready','failed','blocked'));p=self.show(i);self.assertEqual(p['state'],'ready',p['reason'])
        self.assertNotEqual(p['steps'][0]['worktree'],p['steps'][1]['worktree'])
        self.assertTrue(pathlib.Path(p['worktree'],'a.txt').exists() and pathlib.Path(p['worktree'],'b.txt').exists())
    def test_a_one_step_plan_is_reviewed_too(self):
        i=self.add(plan(step('only')),{'only':{'tests/test_o.py':test_file()+'        pass\n'}});self.tick(until=(i,'ready','failed','blocked'));p=self.show(i)
        self.assertEqual(p['state'],'ready',p['reason']);self.assertIsNotNone(p['review_task']);self.assertTrue(p['report']['review']['approved'])
    def test_agent_saying_done_is_not_enough(self):
        i=self.add(plan(step('a')),{'a':{'tests/test_a.py':test_file('never.txt')}});self.tick(until=(i,'failed','blocked','ready'));p=self.show(i)
        self.assertEqual(p['state'],'failed');self.assertIn('acceptance_tests_failed',p['reason']);self.assertEqual(p['steps'][0]['attempts'],2)
    def test_bad_plans_never_create_steps(self):
        i=self.add(plan(step('a',['b']),step('b',['a'])));self.tick(4,until=(i,'failed'));p=self.show(i)
        self.assertEqual(p['state'],'failed');self.assertEqual(p['steps'],[])
    def test_conflicting_steps_stop_for_a_person(self):
        doc=plan(step('a'),step('b'));t={'tests/test_x.py':test_file()+'        pass\n'}
        i=self.add(doc,{'a':{'same.txt':'one',**t},'b':{'same.txt':'two',**t}});self.tick(until=(i,'blocked','failed','ready'));p=self.show(i)
        self.assertEqual(p['state'],'blocked');self.assertIn('conflicts in',p['reason']);self.assertIn('same.txt',p['reason'])
        self.assertEqual(subprocess.check_output(['git','-C',p['worktree'],'status','--porcelain'],text=True),'','the failed merge is backed out')
    def test_high_risk_waits_for_the_operator(self):
        i=self.add(plan(step('a',risk='high')),{'a':{'tests/test_a.py':test_file()+'        pass\n'}});self.tick(6,until=(i,'failed'))
        self.assertEqual(self.states(i),{'a':'waiting_approval'});self.assertEqual(self.show(i)['state'],'executing')
        self.acc('plan-approve-step',i,'a');self.tick(until=(i,'ready','failed','blocked'));self.assertEqual(self.show(i)['state'],'ready')
    def test_ticks_never_duplicate_a_task(self):
        doc,files=self.two();i=self.add(doc,files);self.tick(until=(i,'ready'))
        rows=[t for t in json.loads(self.acc('snapshot').stdout)['tasks'] if t['plan']==i]
        keys=[t['plan_key'] for t in rows];self.assertEqual(len(keys),len(set(keys)),keys)
        self.tick(3);self.assertEqual(len([t for t in json.loads(self.acc('snapshot').stdout)['tasks'] if t['plan']==i]),len(rows))
    def test_a_lost_tick_finds_its_task_instead_of_starting_another(self):
        doc,files=self.two();i=self.add(doc,files)
        sys.path.insert(0,str(BASE/'libexec'))
        code=f"""
import os,sys
sys.path.insert(0,{str(BASE/'libexec')!r})
import acc_runtime as rt,acc_auto
c=rt.connect();rt.worker
p=acc_auto.plan_row(c,{i!r})
print(acc_auto.task_with(c,{i!r},'@plan')==p['planner_task'],acc_auto.queue(c,p,'@plan',{{'owner':'demo','prompt':'x','test':['true']}})==p['planner_task'])
"""
        self.assertEqual(subprocess.check_output([sys.executable,'-c',code],env=self.env,text=True).strip(),'True True')
    def test_a_tick_before_the_planner_is_recorded_changes_nothing(self):
        code=f"""
import sys
sys.path.insert(0,{str(BASE/'libexec')!r})
import acc_runtime as rt,acc_auto
c=rt.connect();now=1.0
c.execute("INSERT INTO plans(id,request,repo,routing,options,state,base,created_at,updated_at) VALUES('abcdefabcdef','x','/r','auto','{{}}','planning','h',1,1)");c.commit()
acc_auto.advance(c);print(acc_auto.plan_row(c,'abcdefabcdef')['state'])
"""
        self.assertEqual(subprocess.check_output([sys.executable,'-c',code],env=self.env,text=True).strip(),'planning')
    def test_cancel_stops_the_plan_and_leaves_history(self):
        doc,files=self.two();i=self.add(doc,files);self.tick(2);self.acc('plan-cancel',i);self.tick(2);p=self.show(i)
        self.assertEqual(p['state'],'cancelled');self.assertTrue(all(s['state'] in ('cancelled','completed') for s in p['steps']))
        self.assertTrue(any(e['state']=='cancelled' for e in p['events']))
        self.assertNotEqual(self.acc('plan-cancel',i,ok=False).returncode,0)
    def test_resume_after_a_fix_finishes_the_plan(self):
        i=self.add(plan(step('a')),{'a':{'tests/test_a.py':test_file('later.txt')}});self.tick(until=(i,'failed'));p=self.show(i);self.assertEqual(p['state'],'failed')
        pathlib.Path(p['steps'][0]['worktree'],'later.txt').write_text('fixed');self.acc('plan-resume',i);self.tick(until=(i,'ready','failed','blocked'));self.assertEqual(self.show(i)['state'],'ready',self.show(i)['reason'])
    def test_merge_refuses_an_unfinished_plan_or_a_dirty_project(self):
        i=self.add(plan(step('a')),{'a':{'tests/test_a.py':test_file()+'        pass\n'}});self.assertNotEqual(self.acc('plan-merge',i,ok=False).returncode,0)
        self.tick(until=(i,'ready'));(self.repo/'README.md').write_text('edited\n');r=self.acc('plan-merge',i,ok=False);self.assertIn('uncommitted',r.stderr+r.stdout)
    def test_review_findings_reach_the_report(self):
        doc,files=self.two();i=self.add(doc,files,max_repairs=0,fixture={'review':{'approved':False,'summary':'No','findings':['api.py is wrong']}});self.tick(until=(i,'ready','failed','blocked'));p=self.show(i)
        self.assertEqual(p['state'],'ready');self.assertFalse(p['report']['review']['approved']);self.assertIn('api.py is wrong',p['report']['review']['findings'])
    def test_agent_notes_are_never_committed_even_if_the_project_unignores_them(self):
        i=self.add(plan(step('a')),{'a':{'.gitignore':'!.acc/\n!.acc/handoff.json\n','.acc/handoff.json':'{"summary":"mine"}','tests/test_a.py':test_file()+'        pass\n'}})
        self.tick(until=(i,'ready','failed','blocked'));p=self.show(i);self.assertEqual(p['state'],'ready',p['reason'])
        self.assertNotIn('.acc/handoff.json',subprocess.check_output(['git','-C',p['worktree'],'ls-files'],text=True))
        self.assertEqual(p['steps'][0]['handoff']['reported_by_agent']['summary'],'mine')
    def provider_stop(self,allow=False,reason='quota'):
        """A real plan whose step then reports a provider stop, as run_one records it."""
        i=self.add(plan(step('a')),{'a':{'tests/test_a.py':test_file()+'        pass\n'}},allow_reassign=allow)
        self.tick(3,until=(i,'executing'))
        code=f'''
import sys,time
sys.path.insert(0,{str(BASE/'libexec')!r})
import acc_runtime as rt,acc_auto
c=rt.connect();s=acc_auto.steps_of(c,{i!r})[0]
if not s['task']:acc_auto.advance(c);s=acc_auto.steps_of(c,{i!r})[0]
c.execute("UPDATE plan_steps SET agent='claude' WHERE plan=?",({i!r},))
c.execute("UPDATE tasks SET state='blocked',error=?,spec=json_set(spec,'$.owner','claude') WHERE id=?",({reason!r},s['task']))
c.execute("INSERT INTO provider_controls(owner,error,updated) VALUES('claude',?,?) ON CONFLICT(owner) DO UPDATE SET error=excluded.error",({reason!r},time.time()));c.commit()
acc_auto.advance(c)
s=acc_auto.steps_of(c,{i!r})[0];print(s['state'],s['agent'],s['reason'],acc_auto.plan_row(c,{i!r})['state'],sep='|')
'''
        return i,subprocess.check_output([sys.executable,'-c',code],env={**self.env,'ACC_CODEX_BIN':'/usr/bin/true','ACC_CLAUDE_BIN':'/usr/bin/true'},text=True).strip()
    def test_usage_limit_stops_the_plan_and_keeps_its_work(self):
        i,out=self.provider_stop();self.assertEqual(out,'blocked|claude|quota|blocked');self.assertIn('quota',self.show(i)['reason'])
    def test_usage_limit_moves_to_the_other_agent_only_when_allowed(self):
        i,out=self.provider_stop(allow=True);self.assertTrue(out.startswith('planned|codex|') or out.startswith('queued|codex|'),out);self.assertEqual(out.split('|')[-1],'executing')
        self.assertIn('allowed',self.show(i)['steps'][0]['route_reason'])
    def test_sign_in_stop_is_reported_as_itself(self):
        self.assertIn('authentication',self.provider_stop(reason='authentication')[1])
    def test_a_stopped_provider_gets_no_new_planner_work(self):
        i,_=self.provider_stop()
        f=self.root/'q.json';f.write_text(json.dumps({'repo':str(self.repo),'request':'More','routing':'claude'}))
        r=self.acc('plan-add',str(f),ok=False);self.assertNotEqual(r.returncode,0);self.assertIn('quota',r.stderr+r.stdout)
    def repairing(self,reviews,**extra):
        t=test_file()+'        pass\n'
        doc=plan(step('a'),step('b'));files={'a':{'a.txt':'a','tests/test_a.py':t},'b':{'b.txt':'b','tests/test_b.py':t},'repair-1':{'r1.txt':'1'},'repair-2':{'r2.txt':'2'},'repair-3':{'r3.txt':'3'}}
        i=self.add(doc,files,fixture={'reviews':reviews},**extra);self.tick(30,until=(i,'ready','failed','blocked'));return i,self.show(i)
    BAD={'approved':False,'summary':'No','findings':['store.py:10 loses updates']}
    OK={'approved':True,'summary':'Fine','findings':[]}
    def test_a_review_finding_is_repaired_retested_and_rereviewed(self):
        i,p=self.repairing([self.BAD,self.OK]);self.assertEqual(p['state'],'ready',p['reason']);self.assertEqual(p['repairs'],1);self.assertTrue(p['report']['review']['approved'])
        s=[x for x in p['steps'] if x['key']=='repair-1'][0];self.assertEqual(s['state'],'completed');self.assertIn('store.py:10 loses updates',s['repairs']);self.assertIn('Merge step repair-1',subprocess.check_output(['git','-C',p['worktree'],'log','--oneline'],text=True))
        self.assertEqual(sorted(k for k in [t['plan_key'] for t in json.loads(self.acc('snapshot').stdout)['tasks'] if t['plan']==i] if k.startswith('@')),['@plan','@review-0','@review-1','@verify-0','@verify-1'])
    def test_the_same_finding_twice_stops_as_no_progress(self):
        i,p=self.repairing([self.BAD,{**self.BAD,'findings':['store.py:44 loses updates']}]);self.assertEqual(p['repairs'],1);self.assertEqual(p['state'],'ready');self.assertFalse(p['report']['review']['approved']);self.assertIn('findings',p['reason'])
        self.assertTrue(any(e['state']=='repair-stopped' for e in p['events']))
    def test_repairs_stop_at_their_budget(self):
        rounds=[{**self.BAD,'findings':[f'problem number {w}']} for w in ('one','two','three','four')]
        i,p=self.repairing(rounds);self.assertEqual(p['repairs'],2);self.assertEqual(p['state'],'ready');self.assertFalse(p['report']['review']['approved'])
        i,p=self.repairing(rounds,max_repairs=0);self.assertEqual(p['repairs'],0)
    def test_a_budget_out_of_range_is_refused(self):
        f=self.root/'p.json'
        for bad in (9,-1,True,'2'):
            f.write_text(json.dumps({'repo':str(self.repo),'request':'x','max_repairs':bad}));self.assertNotEqual(self.acc('plan-add',str(f),ok=False).returncode,0,bad)
    def test_requests_outside_the_workspace_are_refused(self):
        f=self.root/'p.json';f.write_text(json.dumps({'repo':'/etc','request':'x'}));r=self.acc('plan-add',str(f),ok=False);self.assertIn('approved',r.stderr+r.stdout)
    def test_fixtures_need_the_test_switch(self):
        code=f"import sys;sys.path.insert(0,{str(BASE/'libexec')!r});import acc_auto;print(acc_auto.clean_options({{'fixture':{{'plan':1}}}})['fixture'])"
        env={k:v for k,v in self.env.items() if k!='ACC_ALLOW_FIXTURES'}
        self.assertEqual(subprocess.check_output([sys.executable,'-c',code],env=env,text=True).strip(),'None')
        self.assertIn('plan',subprocess.check_output([sys.executable,'-c',code],env=self.env,text=True))
    def test_queue_api_cant_reach_internal_settings(self):
        for extra in ({'owner':'verifier'},{'owner':'demo','fixture_files':{'x':'y'}},{'owner':'demo','sandbox_test':False},{'owner':'demo','plan':'x'}):
            f=self.root/'s.json';f.write_text(json.dumps({'repo':str(self.repo),'owner':'demo','prompt':'x','test':['true'],**extra}));self.assertNotEqual(self.acc('add',str(f),ok=False).returncode,0,extra)
    def test_bad_model_settings_are_refused(self):
        for extra in ({'models':{'claude':{'model':'x;rm -rf'}}},{'models':{'codex':{'effort':'insane'}}}):
            f=self.root/'p.json';f.write_text(json.dumps({'repo':str(self.repo),'request':'x',**extra}));self.assertNotEqual(self.acc('plan-add',str(f),ok=False).returncode,0)

class Sandbox(unittest.TestCase):
    def test_planned_tests_cant_reach_secrets_network_or_other_work(self):
        with tempfile.TemporaryDirectory() as t:
            root=pathlib.Path(t).resolve();wt=root/'worktrees/one';wt.parent.mkdir();other=root/'worktrees/two';other.mkdir();(other/'secret.txt').write_text('x')
            subprocess.check_call(['git','init','-q',str(wt)])
            code=f'''
import sys
sys.path.insert(0,{str(BASE/'libexec')!r})
import acc_runtime as rt,os,subprocess
argv=rt.sandboxed({str(wt)!r},{str(wt)!r},["python3","-c","""
import os,pathlib,socket
home=pathlib.Path(os.path.expanduser("~"))
results=[]
results.append(("other",pathlib.Path({str(other/'secret.txt')!r}).exists()))
real=pathlib.Path({str(pathlib.Path.home())!r})
results.append(("ssh",any((real/".ssh").iterdir()) if (real/".ssh").exists() else False))
results.append(("claude",(real/".claude/.credentials.json").exists()))
results.append(("codex",(real/".codex/auth.json").exists()))
try:
    s=socket.socket();s.settimeout(2);s.connect(("1.1.1.1",53));results.append(("net",True))
except OSError:results.append(("net",False))
pathlib.Path("made.txt").write_text("ok")
print(results)
"""])
print(subprocess.run(argv,capture_output=True,text=True))
'''
            p=subprocess.run([sys.executable,'-c',code],env={**os.environ,'ACC_ROOT':str(root)},capture_output=True,text=True,timeout=30)
            self.assertIn("returncode=0",p.stdout,p.stdout+p.stderr)
            for name in ('other','ssh','claude','codex','net'):self.assertIn(f"('{name}', False)",p.stdout,p.stdout)
            self.assertTrue((wt/'made.txt').exists())

class Roots(unittest.TestCase):
    def run_py(self,code,**env):
        return subprocess.run([sys.executable,'-c',f'import sys;sys.path.insert(0,{str(BASE/"libexec")!r});import acc_roots as r\n'+code],env={**os.environ,**env},capture_output=True,text=True)
    def test_protected_places_cant_be_roots(self):
        home=pathlib.Path.home()
        code=f"import pathlib\nfor p in ['/','/etc','/root',{str(home)!r},{str(home/'.ssh')!r},{str(home/'.claude')!r},{str(home/'.codex')!r},{str(home/'.config')!r},{str(home/'.ssh/x')!r}]:print(p,bool(r.problem(p)))"
        out=self.run_py(code).stdout;self.assertNotIn('False',out,out)
    def test_symlinks_are_resolved(self):
        with tempfile.TemporaryDirectory(dir=pathlib.Path.home()) as t:
            base=pathlib.Path(t);(base/'ws').mkdir();(base/'ws/escape').symlink_to('/etc')
            out=self.run_py("print(r.allowed(sys.argv) if 0 else r.allowed(%r),r.allowed(%r))"%(str(base/'ws/escape'),str(base/'ws')),ACC_ROOT=str(base/'ws'),ACC_ROOTS_FILE=str(base/'r.json')).stdout
            self.assertEqual(out.strip(),'False True')
    def test_a_hand_edited_protected_root_is_ignored(self):
        with tempfile.TemporaryDirectory(dir=pathlib.Path.home()) as t:
            base=pathlib.Path(t);f=base/'r.json';f.write_text(json.dumps({'roots':['/etc',str(pathlib.Path.home()/'.ssh')]}))
            self.assertEqual(self.run_py('print(r.extra())',ACC_ROOTS_FILE=str(f)).stdout.strip(),'[]')

class Access(unittest.TestCase):
    def test_full_access_is_off_until_an_operator_turns_it_on_and_stays_inside_approved_folders(self):
        with tempfile.TemporaryDirectory() as t:
            root=pathlib.Path(t).resolve();policy=root/'policy.json';(root/'app').mkdir()
            env={**os.environ,'ACC_ROOT':str(root),'ACC_ROOTS_FILE':str(root/'r.json'),'ACC_POLICY_FILE':str(policy)}
            fake=root/'fake';fake.write_text('#!/bin/sh\necho started\n');fake.chmod(0o755);env['ACC_CLAUDE_BIN']=str(fake)
            run=lambda cwd:subprocess.run([str(BASE/'bin/acc-claude'),'--permission-mode','bypassPermissions'],cwd=cwd,env=env,capture_output=True,text=True)
            self.assertIn('bypass',run(root/'app').stderr)
            self.assertIn('on',subprocess.run([ACC,'policy','full-access','on'],env=env,capture_output=True,text=True).stdout)
            self.assertEqual(run(root/'app').stdout.strip(),'started')
            r=run('/etc');self.assertNotEqual(r.returncode,0);self.assertIn('approved',r.stderr)
            subprocess.run([ACC,'policy','full-access','off'],env=env,check=True,capture_output=True);self.assertIn('bypass',run(root/'app').stderr)
            policy.write_text('garbage');self.assertIn('bypass',run(root/'app').stderr)

class Registry(unittest.TestCase):
    def test_every_adapter_gives_the_same_interface(self):
        import acc_agents
        for a in acc_agents.ADAPTERS.values():
            d=a.describe()
            for k in ('id','name','modes','tools','resume','approvals','sandbox','models'):self.assertTrue(d[k] is not None and d[k]!='',k)
            self.assertTrue(callable(a.argv))
    def test_an_agent_reviewing_only_its_own_work_is_not_independent(self):
        code=f"""
import sys
sys.path.insert(0,{str(BASE/'libexec')!r})
import acc_auto
class C:pass
print(acc_auto.fingerprint('store.py:10-12 Loses updates')==acc_auto.fingerprint('store.py:44 loses updates!'))
"""
        self.assertEqual(subprocess.check_output([sys.executable,'-c',code],text=True).strip(),'True')

class Launcher(unittest.TestCase):
    def launch(self,cwd,root,*args):
        fake=pathlib.Path(root)/'fake-claude';fake.write_text('#!/bin/sh\necho started\n');fake.chmod(0o755)
        return subprocess.run([str(BASE/'bin/acc-claude'),*args],cwd=cwd,env={**os.environ,'ACC_ROOT':str(root),'ACC_CLAUDE_BIN':str(fake),'ACC_ROOTS_FILE':str(pathlib.Path(root)/'r.json')},capture_output=True,text=True)
    def test_runs_in_any_workspace_folder_and_refuses_outside(self):
        with tempfile.TemporaryDirectory() as t:
            root=pathlib.Path(t).resolve();(root/'projects/app').mkdir(parents=True);(root/'test').mkdir()
            self.assertEqual(self.launch(root/'projects/app',root).stdout.strip(),'started')
            self.assertEqual(self.launch(root/'test',root).stdout.strip(),'started')
            r=self.launch('/etc',root);self.assertNotEqual(r.returncode,0);self.assertIn('approved',r.stderr)
    def test_bypass_stays_refused(self):
        with tempfile.TemporaryDirectory() as t:
            r=self.launch(t,pathlib.Path(t).resolve(),'--dangerously-skip-permissions');self.assertNotEqual(r.returncode,0);self.assertIn('bypass',r.stderr)
    def test_one_agent_per_tree(self):
        import fcntl,hashlib
        with tempfile.TemporaryDirectory() as t:
            root=pathlib.Path(t).resolve();app=root/'projects/app';app.mkdir(parents=True);(root/'tasks/leases').mkdir(parents=True)
            subprocess.check_call(['git','init','-q',str(app)]);(app/'sub').mkdir()
            lock=root/'tasks/leases'/(hashlib.sha256(str(app).encode()).hexdigest()+'.lock');fd=os.open(lock,os.O_CREAT|os.O_RDWR);fcntl.flock(fd,fcntl.LOCK_EX)
            r=self.launch(app/'sub',root);os.close(fd);self.assertIn('Another agent',r.stderr)

if __name__=='__main__':unittest.main()
