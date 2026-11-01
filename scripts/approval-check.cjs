// A real background Claude task that is denied an edit, waits, and is decided through the interface. Real usage.
const fs=require('fs'),path=require('path'),cp=require('child_process');
const home=process.env.HOME,root=process.env.ADCC_TEST_ROOT||home+'/ai-workspace/test/isolated-dashboard',base='http://127.0.0.1:'+(process.env.ADCC_TEST_PORT||3420);
const pw=require(process.env.ADCC_PLAYWRIGHT_MODULE||home+'/.cache/acc-browser/node_modules/playwright');const libs=process.env.ADCC_BROWSER_LIBS||home+'/.cache/acc-browser/sysroot/usr/lib/x86_64-linux-gnu';
const say=(s,n,x='')=>console.log([s,n,String(x).slice(0,200)].filter(Boolean).join(' | '));const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(fn,ms)=>{const end=Date.now()+ms;while(Date.now()<end){const v=await fn().catch(()=>null);if(v)return v;await sleep(1500)}return null};
(async()=>{
  const dir=path.join(root,'projects','approval-'+Date.now().toString(36));fs.mkdirSync(dir,{recursive:true});const git=(...a)=>cp.execFileSync('git',['-C',dir,...a],{encoding:'utf8'});git('init','-q','-b','main');fs.writeFileSync(path.join(dir,'README.md'),'Disposable.\n');git('add','.');git('-c','user.name=T','-c','user.email=t@localhost','commit','-qm','Start');
  const b=await pw.chromium.launch({headless:true,env:{...process.env,LD_LIBRARY_PATH:libs}});const c=await b.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});c.setDefaultTimeout(20000);const p=await c.newPage();
  await p.goto(base+'/login');await p.locator('input[type="password"]').fill(fs.readFileSync(process.env.ADCC_PASSWORD_FILE||root+'/.password','utf8').trim());await p.locator('button[type="submit"]').click();await p.waitForURL(u=>!u.pathname.includes('/login'));
  const add=async()=>(await (await p.request.post(base+'/api/tasks',{headers:{Origin:base},data:{action:'add',spec:{repo:dir,owner:'claude',prompt:'Create a file named approved.txt containing exactly: yes',test:['python3','-c','import pathlib;assert pathlib.Path("approved.txt").read_text().strip()=="yes"'],permission_mode:'default',timeout:300,max_attempts:2,auto_resume:false,model:'claude-haiku-5-5'}}})).json());
  const state=async id=>(await (await p.request.get(base+'/api/tasks')).json()).tasks.find(t=>t.id===id);
  for(const verdict of ['Approve','Reject']){
    const {id,error}=await add();if(!id){say('FAIL','task queued',error);continue}
    const t=await until(async()=>{const x=await state(id);return ['waiting_approval','failed','blocked','review'].includes(x.state)?x:null},150000);
    say(t?.state==='waiting_approval'&&t.error==='permission_requested'?'PASS':'FAIL',`${verdict}: the agent was denied and is waiting for a person`,`${t?.state} ${t?.error}`);
    await p.goto(base+'/tasks?task='+id);const d=p.getByRole('dialog');await d.getByText('needs permission').first().waitFor();await d.getByRole('button',{name:verdict,exact:true}).click();
    if(verdict==='Approve'){const r=await until(async()=>{const x=await state(id);return ['review','failed','blocked','waiting_approval'].includes(x.state)&&x.attempts>=2?x:null},150000);say(r?.state==='review'?'PASS':'FAIL','approval let the same session finish and its test passed',`${r?.state} ${r?.error}`)}
    else{const r=await until(async()=>{const x=await state(id);return x.state==='cancelled'?x:null},15000);say(r?.error==='rejected_by_operator'?'PASS':'FAIL','rejection stopped it',r?.error);const wt=path.join(root,'worktrees',id);say(fs.existsSync(path.join(wt,'approved.txt'))?'FAIL':'PASS','rejected work made no change')}
    const h=await (await p.request.get(`${base}/api/tasks?id=${id}&history=1`)).json();say(h.audit.some(a=>/approved|rejected/.test(a.action)&&a.actor==='dashboard operator')?'PASS':'FAIL','the decision is in the audit log',h.audit.map(a=>a.action).join(', '));
    await p.keyboard.press('Escape');
  }
  await b.close();process.exit(0);
})().catch(e=>{say('FAIL','approval check stopped',e.message.split('\n')[0]);process.exit(1)});
