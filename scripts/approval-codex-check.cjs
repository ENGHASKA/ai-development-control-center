// A real agent approval (ADCC_APPROVAL_AGENT=codex|claude), answered through the conversation, in a disposable project. Real usage. Against an isolated or given install.
const fs=require('fs'),path=require('path'),cp=require('child_process');
const home=process.env.HOME,root=process.env.ADCC_TEST_ROOT||home+'/ai-workspace/test/isolated-dashboard',base='http://127.0.0.1:'+(process.env.ADCC_TEST_PORT||3420);
const pw=require(process.env.ADCC_PLAYWRIGHT_MODULE||home+'/.cache/acc-browser/node_modules/playwright');const libs=process.env.ADCC_BROWSER_LIBS||home+'/.cache/acc-browser/sysroot/usr/lib/x86_64-linux-gnu';
const say=(s,n,x='')=>console.log([s,n,String(x).split('\n')[0].slice(0,200)].filter(Boolean).join(' | '));const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(f,ms)=>{const e=Date.now()+ms;while(Date.now()<e){const v=await f().catch(()=>null);if(v)return v;await sleep(1000)}return null};
const agent=process.env.ADCC_APPROVAL_AGENT||'codex';
(async()=>{
 const dir=path.join(root,'projects','approve-'+Date.now().toString(36));fs.mkdirSync(dir,{recursive:true});cp.execFileSync('git',['init','-q','-b','main',dir]);fs.writeFileSync(dir+'/README.md','x\n');cp.execFileSync('git',['-C',dir,'add','.']);cp.execFileSync('git',['-C',dir,'-c','user.name=T','-c','user.email=t@localhost','commit','-qm','s']);
 const b=await pw.chromium.launch({headless:true,env:{...process.env,LD_LIBRARY_PATH:libs}});const c=await b.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});c.setDefaultTimeout(30000);const p=await c.newPage();
 await p.goto(base+'/login');await p.locator('input[type="password"]').fill(fs.readFileSync(process.env.ADCC_PASSWORD_FILE||root+'/.password','utf8').trim());await p.locator('button[type="submit"]').click();await p.waitForURL(u=>!u.pathname.includes('/login'));
 const r=await p.request.post(base+'/api/sessions',{headers:{Origin:base},timeout:130000,data:{agent,profile:agent,cwd:dir,...(agent==='claude'?{model:'claude-haiku-5-5'}:{}),text:'Create a file named one.txt containing hi, using the shell.',permissionMode:'default',clientId:'a'+Date.now()}});const body=await r.json();say(r.ok()?'PASS':'FAIL','Ask First starts Codex',JSON.stringify(body).slice(0,130));if(!r.ok())process.exit(1);
 await p.goto(base+'/?s='+encodeURIComponent(body.id));const card=p.getByRole('region',{name:'Approval required'});await card.waitFor({timeout:60000});say('PASS','a real approval appeared in the conversation',(await card.innerText()).split('\n').slice(1,4).join(' / '));
 say(fs.existsSync(dir+'/one.txt')?'FAIL':'PASS','nothing ran before a decision');
 const key=encodeURIComponent(body.id);const before=await (await p.request.get(`${base}/api/sessions/${key}/approval`)).json();
 const wrong=await p.request.post(`${base}/api/sessions/${key}/approval`,{headers:{Origin:base},data:{decision:'approve',request:'not-this-one'}});say(wrong.status()===409?'PASS':'FAIL','an answer to a different request is refused',wrong.status());
 await card.getByRole('button',{name:'Reject'}).click();await card.waitFor({state:'detached',timeout:20000});await sleep(3000);say(fs.existsSync(dir+'/one.txt')?'FAIL':'PASS','rejecting stopped it: no file');
 const again=await p.request.post(`${base}/api/sessions/${key}/approval`,{headers:{Origin:base},data:{decision:'approve',request:before.approval.id}});say(again.status()===409?'PASS':'FAIL','a decision cannot be used twice',again.status());
 const box=p.locator('textarea').first();await box.waitFor();await box.click();await box.pressSequentially('Please try again, create one.txt with the shell.');await p.getByRole('button',{name:'Send'}).first().click();
 const c2=p.getByRole('region',{name:'Approval required'});await c2.waitFor({timeout:60000});await c2.getByRole('button',{name:'Approve once'}).click();
 say(await until(async()=>fs.existsSync(dir+'/one.txt'),40000)?'PASS':'FAIL','approving let it run: file created');
 await b.close();process.exit(0)
})().catch(e=>{say('FAIL','stopped',e.message.split('\n')[0]);process.exit(1)});
