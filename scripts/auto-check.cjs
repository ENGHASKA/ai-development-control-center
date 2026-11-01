// Auto Mode through the real interface against scripts/isolated-instance.sh with ADCC_TEST_WORKER=1, using real agents
// and real usage. Closes the browser while work runs, returns on a phone viewport, and reports only what it observed.
//   node scripts/auto-check.cjs [wait-seconds]
const fs=require('fs'),path=require('path'),cp=require('child_process');
const home=process.env.HOME,root=process.env.ADCC_TEST_ROOT||home+'/ai-workspace/test/isolated-dashboard',base='http://127.0.0.1:'+(process.env.ADCC_TEST_PORT||3420);
const pw=require(process.env.ADCC_PLAYWRIGHT_MODULE||home+'/.cache/acc-browser/node_modules/playwright');
const libs=process.env.ADCC_BROWSER_LIBS||home+'/.cache/acc-browser/sysroot/usr/lib/x86_64-linux-gnu';
const limit=Number(process.argv[2]||3000)*1000,request=process.env.ADCC_AUTO_REQUEST||'Build a small full-stack task-management application with a responsive frontend, backend API, persistence, unit tests, and documentation. Coordinate available agents automatically and produce a tested result.';
const say=(s,n,x='')=>console.log(new Date().toISOString().slice(11,19),[s,n,String(x).slice(0,400)].filter(Boolean).join(' | '));
const OPEN=['planning','executing','validating','reviewing'];
(async()=>{
  const b=await pw.chromium.launch({headless:true,env:{...process.env,LD_LIBRARY_PATH:libs}});
  let c=await b.newContext({viewport:{width:1280,height:800}});c.setDefaultTimeout(20000);let p=await c.newPage();
  await p.goto(base+'/login');await p.locator('input[type="password"]').fill(fs.readFileSync(process.env.ADCC_PASSWORD_FILE||root+'/.password','utf8').trim());await p.locator('button[type="submit"]').click();await p.waitForURL(u=>!u.pathname.includes('/login'));
  const state=await c.storageState();const name='auto-'+Date.now().toString(36);let id=process.env.ADCC_AUTO_PLAN;
  if(id){await p.goto(base+'/tasks?plan='+id);say('INFO','watching plan',id);}
  else{
  await p.goto(base+'/?mode=auto');const btn=p.getByTestId('project-button');await btn.filter({hasNotText:'Loading projects'}).waitFor();await btn.click();
  const dlg=p.getByRole('dialog',{name:'Choose a project'});await dlg.getByRole('button',{name:'New project'}).click();await dlg.getByLabel('Project name').fill(name);await dlg.getByRole('button',{name:'Create project'}).click();await dlg.waitFor({state:'detached'});
  say('PASS','1 workspace selected',name);
  await p.getByRole('radio',{name:'Auto'}).check({force:true});await p.getByLabel('What do you want built?').fill(request);await p.getByRole('button',{name:'Start Auto'}).click();
  await p.waitForURL(/[?&]s=plan(:|%3A)[a-f0-9]{12}/,{timeout:30000}).catch(async e=>{const shown=await p.locator('[role=alert]').allInnerTexts();throw new Error('not submitted: '+shown.filter(Boolean).join(' / ')+' '+e.message)});id=new URL(p.url()).searchParams.get('s').slice(5);say('PASS','2 Auto Mode submitted through the interface, and it opened as a conversation',id);
  }
  const url=base+'/tasks?plan='+id;const api=async()=>{const q=await b.newContext({storageState:state});try{const r=await q.request.get(base+'/api/plans?id='+id);const j=await r.json();return j.steps?j:null}catch{return null}finally{await q.close()}};
  const end=Date.now()+limit;let plan=null,closed=false,seen=new Set(),reported={};
  const log=(pl)=>{for(const s of pl.steps||[]){const k=s.key+':'+s.state;if(!seen.has(k)){seen.add(k);say('INFO',`step ${s.key} ${s.state}`,`${s.agent}; ${s.route_reason}${s.reason?'; '+s.reason:''}`)}}if(reported.s!==pl.state){reported.s=pl.state;say('INFO','plan '+pl.state,pl.reason||pl.goal||'')}};
  while(Date.now()<end){const next=await api();if(!next){await new Promise(r=>setTimeout(r,5000));continue}plan=next;log(plan);
    if(!closed&&plan.steps?.length){say('PASS','3 plan generated',`${plan.steps.length} steps: ${plan.steps.map(s=>s.key+(s.depends.length?'<'+s.depends.join('+'):'')+'='+s.agent).join(', ')}`);await c.close();closed=true;say('PASS','9 browser closed while work continues');}
    if(!OPEN.includes(plan.state))break;await new Promise(r=>setTimeout(r,10000));}
  say(OPEN.includes(plan.state)?'FAIL':'INFO','finished waiting',plan.state+(plan.reason?': '+plan.reason:''));
  c=await b.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true,storageState:state});c.setDefaultTimeout(20000);p=await c.newPage();await p.goto(url);
  await p.getByRole('dialog').waitFor();await p.getByText(plan.steps[0]?.title??'Request').first().waitFor();say('PASS','15 reconnected from a phone viewport');
  await p.goto(base+'/?s=plan:'+id);await p.getByText(plan.steps[0]?.title??'Request').first().waitFor();for(const t of [plan.steps[0]?.route_reason,plan.request].filter(Boolean)){say(await p.getByText(t.slice(0,60),{exact:false}).first().isVisible()?'PASS':'FAIL','the conversation shows the real record',t.slice(0,80))}
  await p.screenshot({path:process.env.ADCC_AUTO_SHOT||'/dev/null'}).catch(()=>{});
  const wt=plan.worktree;
  if(plan.report){say('INFO','final test',JSON.stringify(plan.report.validation));say('INFO','review',JSON.stringify(plan.report.review));say('INFO','commits',(plan.report.commits||[]).join(' / '));}
  fs.writeFileSync(path.join(root,'auto-check-result.json'),JSON.stringify(plan,null,1));
  if(wt&&fs.existsSync(wt))say('INFO','branch files',cp.execFileSync('git',['-C',wt,'ls-files'],{encoding:'utf8'}).split('\n').join(' '));
  await b.close();process.exit(plan.state==='ready'?0:1);
})().catch(e=>{say('FAIL','auto check stopped',e.message);process.exit(1)});
