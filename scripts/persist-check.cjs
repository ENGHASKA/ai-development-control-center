// Real persistence: a turn must outlive the browser AND the dashboard. Needs isolated-instance.sh started by this script's
// caller with ADCC_TEST_WORKER=1. Pass the app's pid-finding port. Real usage, disposable project.
const fs=require('fs'),path=require('path'),cp=require('child_process');
const home=process.env.HOME,agent=process.argv[2]||'codex',root=process.env.ADCC_TEST_ROOT||home+'/ai-workspace/test/isolated-dashboard',port=Number(process.env.ADCC_TEST_PORT||3420),base='http://127.0.0.1:'+port;
const pw=require(process.env.ADCC_PLAYWRIGHT_MODULE||home+'/.cache/acc-browser/node_modules/playwright');const libs=process.env.ADCC_BROWSER_LIBS||home+'/.cache/acc-browser/sysroot/usr/lib/x86_64-linux-gnu';
const say=(s,n,x='')=>console.log([s,n,String(x).split('\n')[0].slice(0,220)].filter(Boolean).join(' | '));const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(fn,ms)=>{const end=Date.now()+ms;while(Date.now()<end){const v=await fn().catch(()=>null);if(v)return v;await sleep(1000)}return null};
(async()=>{
 const dir=path.join(root,'projects','persist-'+agent+'-'+Date.now().toString(36));fs.mkdirSync(dir,{recursive:true});cp.execFileSync('git',['init','-q','-b','main',dir]);fs.writeFileSync(dir+'/README.md','x\n');cp.execFileSync('git',['-C',dir,'add','.']);cp.execFileSync('git',['-C',dir,'-c','user.name=T','-c','user.email=t@localhost','commit','-qm','s']);
 const b=await pw.chromium.launch({headless:true,env:{...process.env,LD_LIBRARY_PATH:libs}});let c=await b.newContext();c.setDefaultTimeout(20000);let p=await c.newPage();
 await p.goto(base+'/login');await p.locator('input[type="password"]').fill(fs.readFileSync(process.env.ADCC_PASSWORD_FILE||root+'/.password','utf8').trim());await p.locator('button[type="submit"]').click();await p.waitForURL(u=>!u.pathname.includes('/login'));const state=await c.storageState();
 const text=agent==='codex'?'Run the shell command sleep 30, then create a file named survived.txt containing yes. Then reply DONE.':'Create a file named first.txt containing yes, then reply DONE.';
 const r=await p.request.post(base+'/api/sessions',{headers:{Origin:base},timeout:120000,data:{agent,profile:agent,cwd:dir,text,model:agent==='claude'?'claude-haiku-5-5':undefined,permissionMode:'acceptEdits',clientId:'p'+Date.now()}});const body=await r.json();say(r.ok()?'PASS':'FAIL','started',JSON.stringify(body).slice(0,160));if(!r.ok())process.exit(1);
 await c.close();say('INFO','browser closed');
 const app=cp.execSync(`ss -lntp | grep 127.0.0.1:${port+1} | grep -o 'pid=[0-9]*' | cut -d= -f2`,{encoding:'utf8'}).trim();const procs=()=>cp.execSync(`pgrep -c -f '${agent==='codex'?'codex.*resume|/codex( |$)':'claude'}' || true`,{encoding:'utf8'}).trim();
 process.kill(Number(app),'SIGKILL');say('INFO','dashboard killed with SIGKILL',app);
 console.log('RESTART_DASHBOARD');await until(async()=>fs.existsSync(root+'/.restarted'),60000);
 await until(async()=>(await fetch(base+'/login')).status===200,60000);say('PASS','dashboard is back');
 const f=agent==='codex'?'survived.txt':'first.txt';say(await until(async()=>fs.existsSync(path.join(dir,f)),150000)?'PASS':'FAIL','the turn finished with the dashboard gone',f);
 c=await b.newContext({viewport:{width:390,height:844},storageState:state});c.setDefaultTimeout(20000);p=await c.newPage();await p.goto(base+'/?s='+encodeURIComponent(body.id));
 const main=p.locator('main');say(await until(async()=>/DONE/.test(await main.innerText()),40000)?'PASS':'FAIL','the original conversation came back in a new browser');
 const seen=await p.evaluate(()=>[...document.querySelectorAll('main *')].filter(e=>e.children.length===0&&/^DONE/.test(e.textContent.trim())).length);say(seen<=1?'PASS':'FAIL','no duplicated reply after reconnecting',seen);
 const box=p.locator('textarea').first();await box.waitFor();await sleep(1500);await box.click();await box.pressSequentially('Reply with exactly: AGAIN');await sleep(300);
 const [res]=await Promise.all([p.waitForResponse(u=>/\/message/.test(u.url())),p.getByRole('button',{name:'Send'}).first().click()]);const sent=await res.json();say(res.ok()?'PASS':'FAIL','follow-up sent to the same terminal',JSON.stringify(sent).slice(0,120));
 say(await until(async()=>/AGAIN/.test((await main.innerText()).replace(/exactly: AGAIN/g,'')),90000)?'PASS':'FAIL','the agent answered the follow-up');
 await b.close();process.exit(0)
})().catch(e=>{say('FAIL','stopped',e.message.split('\n')[0]);process.exit(1)});
