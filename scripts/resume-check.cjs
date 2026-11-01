// Real resume through the dashboard with DISPOSABLE conversations made here, against scripts/isolated-instance.sh with
// ADCC_TEST_WORKER=1. Uses real provider usage. The word each session is told proves the same conversation continued: a new
// one can't know it. Never give this script an existing session.
//   node scripts/resume-check.cjs claude|codex
const fs=require('fs'),path=require('path'),cp=require('child_process'),crypto=require('crypto');
const home=process.env.HOME,agent=process.argv[2]||'codex',label=agent==='codex'?'Codex':'Claude';
const root=process.env.ADCC_TEST_ROOT||home+'/ai-workspace/test/isolated-dashboard',base='http://127.0.0.1:'+(process.env.ADCC_TEST_PORT||3420);
const pw=require(process.env.ADCC_PLAYWRIGHT_MODULE||home+'/.cache/acc-browser/node_modules/playwright');
const libs=process.env.ADCC_BROWSER_LIBS||home+'/.cache/acc-browser/sysroot/usr/lib/x86_64-linux-gnu';
const password=fs.readFileSync(process.env.ADCC_PASSWORD_FILE||root+'/.password','utf8').trim();
const say=(s,n,x='')=>console.log([s,n,String(x).split('\n')[0].slice(0,260)].filter(Boolean).join(' | '));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(fn,ms)=>{const end=Date.now()+ms;while(Date.now()<end){const v=await fn().catch(()=>null);if(v)return v;await sleep(1000)}return null};
const word='WORD'+crypto.randomBytes(4).toString('hex').toUpperCase();
(async()=>{
  const name=`resume-${agent}-${Date.now().toString(36)}`,dir=path.join(root,'projects',name);fs.mkdirSync(dir,{recursive:true});
  const git=(...a)=>cp.execFileSync('git',['-C',dir,...a],{encoding:'utf8'});git('init','-q','-b','main');fs.writeFileSync(path.join(dir,'README.md'),'Disposable resume test.\n');git('add','.');git('-c','user.name=T','-c','user.email=t@localhost','commit','-qm','Start');
  const first=`Remember this word for later: ${word}. Reply with just OK.`;let id;
  if(agent==='claude'){id=crypto.randomUUID();cp.execFileSync('claude',['-p','--session-id',id,'--model','claude-haiku-5-5',first],{cwd:dir,encoding:'utf8',timeout:120000,stdio:['ignore','pipe','pipe']})}
  else{const out=cp.execFileSync('codex',['exec','--json','--skip-git-repo-check',first],{cwd:dir,encoding:'utf8',timeout:180000,stdio:['ignore','pipe','pipe']});id=/"thread_id":"([0-9a-f-]{36})"/.exec(out)?.[1]}
  if(!id)throw new Error('no disposable session was created');say('PASS','disposable session created outside the dashboard',id);
  const b=await pw.chromium.launch({headless:true,env:{...process.env,LD_LIBRARY_PATH:libs}});
  let c=await b.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});c.setDefaultTimeout(20000);let p=await c.newPage();
  await p.goto(base+'/login');await p.locator('input[type="password"]').fill(password);await p.locator('button[type="submit"]').click();await p.waitForURL(u=>!u.pathname.includes('/login'));const state=await c.storageState();
  await p.goto(base+'/?mode=resume');await p.getByTestId('project-button').filter({hasNotText:'Loading projects'}).waitFor();await until(async()=>{await p.getByRole('radio',{name:label}).click({force:true});return p.getByRole('radio',{name:label}).isChecked()},10000);
  await p.getByLabel('Search or paste a session ID').fill('00000000-0000-4000-8000-000000000000');await p.getByText('A new one won\'t be started').waitFor();say('PASS','an unknown ID is refused, not replaced');
  await p.getByLabel('Search or paste a session ID').fill(id);await p.getByLabel('What should it do next?').waitFor();say('PASS','the session was found and its folder checked');
  await p.getByLabel('What should it do next?').fill('Create a file named remembered.txt containing exactly the word I asked you to remember earlier, and nothing else.');await p.getByRole('button',{name:'Continue in background'}).click();
  await p.waitForURL(/\/tasks\?task=[a-f0-9]{12}/);const task=new URL(p.url()).searchParams.get('task');say('PASS','resumed from a phone viewport',task);
  await c.close();say('INFO','browser closed during the turn');
  const file=path.join(dir,'remembered.txt');
  const got=await until(async()=>fs.existsSync(file)&&fs.readFileSync(file,'utf8').trim(),240000);
  say(got===word?'PASS':'FAIL','the resumed conversation kept its original context',`expected ${word}, found ${got}`);
  const q=await b.newContext({storageState:state});const api=async()=>(await (await q.request.get(base+'/api/tasks')).json()).tasks.find(t=>t.id===task);
  const waiting=await until(async()=>{const t=await api();return t.state==='waiting_input'?t:null},120000);
  say(waiting&&waiting.session_id===id?'PASS':'FAIL','same provider session recorded; task waits for a message',waiting?.session_id);say(waiting?.in_place?'PASS':'FAIL','worked in place, with no copy of the project');
  c=await b.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true,storageState:state});c.setDefaultTimeout(20000);p=await c.newPage();await p.goto(base+'/tasks?task='+task);
  const d=p.getByRole('dialog');await d.getByText('Waiting for your message').first().waitFor();say('PASS','reconnected to the task from a new browser');
  await d.getByText(/turn\.completed|"type":"result"/).first().waitFor().then(()=>say('PASS','live output visible')).catch(()=>say('FAIL','live output visible'));
  await d.getByLabel(`Send ${label} a message`).fill('Create a file named second.txt containing the same remembered word.');await d.getByRole('button',{name:'Send',exact:true}).click();
  const second=path.join(dir,'second.txt');const got2=await until(async()=>fs.existsSync(second)&&fs.readFileSync(second,'utf8').trim(),240000);
  say(got2===word?'PASS':'FAIL','a follow-up continued the same conversation',got2);
  await until(async()=>(await api()).state==='waiting_input',120000);
  const again=await q.request.post(base+'/api/resume',{headers:{Origin:base},data:{agent,session:id,prompt:'x'}});say(again.status()===400?'PASS':'FAIL','a second resume of an open conversation is refused',(await again.json()).error);
  const hist=await (await q.request.get(`${base}/api/tasks?id=${task}&history=1`)).json();say(hist.audit.some(a=>a.action==='resume-session')&&hist.audit.some(a=>a.action==='follow-up')?'PASS':'FAIL','the audit log records the resume and the follow-up',hist.audit.map(a=>a.action).join(', '));
  await p.reload().catch(()=>{});await d.getByRole('button',{name:'Finish'}).click();await until(async()=>(await api()).state==='completed',20000).then(v=>say(v?'PASS':'FAIL','conversation closed by the operator'));
  await p.goto(base+'/?mode=resume');await p.getByTestId('project-button').filter({hasNotText:'Loading projects'}).waitFor();await until(async()=>{await p.getByRole('radio',{name:label}).click({force:true});return p.getByRole('radio',{name:label}).isChecked()},10000);await p.getByLabel('Search or paste a session ID').fill(id);await p.getByRole('button',{name:'Open in terminal'}).click();
  await p.waitForFunction(()=>document.querySelector('.xterm')!==null,null,{timeout:30000}).then(()=>say('PASS','interactive resume opened in the kept terminal')).catch(e=>say('FAIL','interactive resume opened in the kept terminal',e.message));
  await sleep(6000);
  const live=await q.request.get(base+'/api/terminals');const open=(await live.json()).terminals.find(t=>t.session?.includes(id));say(open&&!open.exited?'PASS':'FAIL','the terminal is alive after the browser attached',JSON.stringify(open?.exited??null));
  const busy=await until(async()=>(await (await q.request.get(`${base}/api/resume?agent=${agent}&id=${id}`)).json()).in_use,15000);say(busy?'PASS':'FAIL','the open terminal marks the conversation in use');
  const blocked=await q.request.post(base+'/api/resume',{headers:{Origin:base},data:{agent,session:id,prompt:'x'}});say(blocked.status()===400?'PASS':'FAIL','background resume refused while the terminal holds it',(await blocked.json()).error);
  await b.close();process.exit(0);
})().catch(e=>{say('FAIL','resume check stopped',e.message);process.exit(1)});
