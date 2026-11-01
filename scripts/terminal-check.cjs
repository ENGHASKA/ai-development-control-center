// The web terminal against scripts/isolated-instance.sh: opens a kept agent terminal, cuts its socket, and checks the
// same terminal comes back. No prompt is sent, so no model request is made.
const fs=require('fs');const home=process.env.HOME;
const pw=require(process.env.ADCC_PLAYWRIGHT_MODULE||home+'/.cache/acc-browser/node_modules/playwright');
const root=process.env.ADCC_TEST_ROOT||home+'/ai-workspace/test/isolated-dashboard',base='http://127.0.0.1:'+(process.env.ADCC_TEST_PORT||3420);
const libs=process.env.ADCC_BROWSER_LIBS||home+'/.cache/acc-browser/sysroot/usr/lib/x86_64-linux-gnu';
const say=(s,n,x='')=>console.log([s,n,x].filter(Boolean).join(' | '));
(async()=>{
  const b=await pw.chromium.launch({headless:true,env:{...process.env,LD_LIBRARY_PATH:libs}});
  const c=await b.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});c.setDefaultTimeout(20000);const p=await c.newPage();
  const sockets=[];await p.routeWebSocket(/\/pty/,ws=>{const server=ws.connectToServer();ws.onMessage(m=>server.send(m));server.onMessage(m=>ws.send(m));sockets.push(ws);});
  await p.goto(base+'/login');await p.locator('input[type="password"]').fill(fs.readFileSync(process.env.ADCC_PASSWORD_FILE||root+'/.password','utf8').trim());await p.locator('button[type="submit"]').click();await p.waitForURL(u=>!u.pathname.includes('/login'));
  await p.goto(base+'/');await p.getByTestId('project-button').filter({hasNotText:'Loading projects'}).waitFor();await p.waitForTimeout(500);await p.getByRole('button',{name:'Open in terminal'}).click();
  await p.waitForFunction(()=>document.querySelector('.xterm')!==null,null,{timeout:30000});
  const opened=()=>sockets.filter(s=>s).length;
  for(let i=0;i<40&&!opened();i++)await p.waitForTimeout(250);
  say(opened()?'PASS':'FAIL','terminal opened from the dashboard over a websocket',`${opened()} socket`);
  await p.waitForTimeout(4000);
  const box=await p.locator('.xterm').first().boundingBox();const w=await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth);
  say(box&&box.width>200&&box.width<=390&&w?'PASS':'FAIL','terminal fits the phone viewport',box?`${Math.round(box.width)}x${Math.round(box.height)}`:'no box');
  await p.screenshot({path:process.argv[2]||'/dev/null'}).catch(()=>{});
  const before=sockets.length;await sockets.at(-1).close({code:1011,reason:'test'});
  await p.getByText('Reconnecting…').first().waitFor({timeout:6000}).then(()=>say('PASS','a dropped socket shows Reconnecting')).catch(()=>say('FAIL','a dropped socket shows Reconnecting'));
  for(let i=0;i<80&&sockets.length===before;i++)await p.waitForTimeout(250);
  say(sockets.length>before?'PASS':'FAIL','terminal opened a new socket on its own',`${sockets.length-before} new`);
  await p.getByText('Reconnecting…').first().waitFor({state:'hidden',timeout:15000}).then(()=>say('PASS','terminal recovered')).catch(()=>say('FAIL','terminal recovered'));
  await b.close();process.exit(0);
})().catch(e=>{say('FAIL','terminal check stopped',String(e.message).split('\n')[0].slice(0,240));process.exit(1)});
