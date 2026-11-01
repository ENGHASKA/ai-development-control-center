// Real provider sessions through the dashboard, against scripts/isolated-instance.sh started WITHOUT ADCC_TEST_SANITIZED.
// Uses real provider usage, so it runs on request only: node scripts/live-check.cjs claude|codex
// Reports PASS, FAIL or BLOCKED for each step, and never counts a step it didn't observe.
const fs=require('fs'),path=require('path');
const home=process.env.HOME,agent=process.argv[2]||'claude',label=agent==='codex'?'Codex':'Claude';
const pw=require(process.env.ADCC_PLAYWRIGHT_MODULE||home+'/.cache/acc-browser/node_modules/playwright');
const root=process.env.ADCC_TEST_ROOT||home+'/ai-workspace/test/isolated-dashboard',base='http://127.0.0.1:'+(process.env.ADCC_TEST_PORT||3420);
const libs=process.env.ADCC_BROWSER_LIBS||home+'/.cache/acc-browser/sysroot/usr/lib/x86_64-linux-gnu';
const password=fs.readFileSync(process.env.ADCC_PASSWORD_FILE||root+'/.password','utf8').trim(),stamp=Date.now().toString(36);
const say=(s,n,x='')=>console.log([s,n,String(x).split('\n')[0].slice(0,300)].filter(Boolean).join(' | '));
const QUOTA=/usage limit|rate limit|quota|too many requests|limit reached|resets? /i;
(async()=>{
  const name=`live-${agent}-${stamp}`,dir=path.join(root,'projects',name),file=path.join(dir,'hello.txt');
  const b=await pw.chromium.launch({headless:true,env:{...process.env,LD_LIBRARY_PATH:libs}});
  let c=await b.newContext({viewport:{width:1280,height:800}});c.setDefaultTimeout(20000);let p=await c.newPage();
  await p.goto(base+'/login');await p.locator('input[type="password"]').fill(password);await p.locator('button[type="submit"]').click();await p.waitForURL(u=>!u.pathname.includes('/login'));
  const state=await c.storageState();
  await p.goto(base+'/');const project=p.getByTestId('project-button');await project.waitFor();await project.click();
  const dlg=p.getByRole('dialog',{name:'Choose a project'});await dlg.getByRole('button',{name:'New project'}).click();await dlg.getByLabel('Project name').fill(name);await dlg.getByRole('button',{name:'Create project'}).click();await dlg.waitFor({state:'detached'});
  say('PASS','new, never-trusted project created and selected in the dashboard',name);
  await p.getByRole('radio',{name:label}).check({force:true});
  await p.getByRole('button',{name:/^Approvals:/}).first().click();await p.getByRole('menuitemradio',{name:/Accept edits/}).click();
  if(agent==='claude'){await p.getByRole('button',{name:/Model: /}).first().click();await p.getByRole('menuitemradio',{name:/Haiku 5\.5/}).first().click();}
  const box=p.locator('textarea').first();await box.fill('Create a file named hello.txt in the current folder containing exactly the text: control center ok. Then reply with the single word DONE.');await p.keyboard.press('Control+Enter');
  const started=Date.now();
  const outcome=await Promise.race([p.waitForURL(u=>/[?&]s=/.test(u.search),{timeout:100000}).then(()=>'opened').catch(()=>null),p.locator('main [role=alert]').filter({hasText:/\S/}).first().waitFor({timeout:100000}).then(async()=>'alert:'+await p.locator('main [role=alert]').filter({hasText:/\S/}).first().innerText()).catch(()=>null)]);
  if(!outcome||outcome.startsWith('alert:')){const m=outcome?.slice(6)??'no session and no error within 100 seconds';say(QUOTA.test(m)?'BLOCKED':'FAIL',`${label} session start`,m);await b.close();process.exitCode=QUOTA.test(m)?0:1;return;}
  say('PASS',`${label} session started from the dashboard`,`${Math.round((Date.now()-started)/1000)}s`);
  const url=p.url();
  const until=async(fn,ms)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return true;await new Promise(r=>setTimeout(r,500));}return false;};
  const wrote=await until(()=>fs.existsSync(file)&&/control center ok/.test(fs.readFileSync(file,'utf8')),120000);
  say(wrote?'PASS':'FAIL',`${label} edited the authorized test file`,wrote?fs.readFileSync(file,'utf8').trim():'file not written in 120s');
  const body=()=>p.locator('main').innerText();
  const replied=await until(async()=>/\bDONE\b/.test((await body()).replace(/reply with the single word DONE/g,'')),60000);
  say(replied?'PASS':'FAIL',`${label} response reached the browser`);
  await c.close();
  c=await b.newContext({viewport:{width:390,height:844},storageState:state,hasTouch:true,isMobile:true});c.setDefaultTimeout(20000);p=await c.newPage();await p.goto(url);
  const back=await until(async()=>/control center ok|hello\.txt/.test(await p.locator('main').innerText().catch(()=>'')),30000);
  say(back?'PASS':'FAIL',`${label} session reconnected after the browser closed, on a phone viewport`);
  const reply=p.locator('textarea').first();await reply.waitFor();await reply.click();await reply.pressSequentially('Reply with the single word PONG.');
  const send=p.getByRole('button',{name:'Send'}).first();const kept=await until(async()=>(await reply.inputValue())==='Reply with the single word PONG.'&&await send.isEnabled(),8000);
  say(kept?'PASS':'FAIL','typed text survived the page finishing loading',await reply.inputValue());await send.click();
  const pong=await until(async()=>/\bPONG\b/.test((await p.locator('main').innerText()).replace(/single word PONG/g,'')),90000);
  say(pong?'PASS':'FAIL',`${label} answered a further message after reconnecting`);
  await b.close();
})().catch(e=>{say('FAIL','live check stopped',e.message);process.exit(1)});
