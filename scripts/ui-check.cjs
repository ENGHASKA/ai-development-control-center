// Browser checks of the dashboard against scripts/isolated-instance.sh. No provider is contacted: anything that would
// start an agent is intercepted or stops at the queue, because no worker runs there. Real sessions: scripts/live-check.cjs.
// ADCC_PLAYWRIGHT_MODULE, ADCC_BROWSER_LIBS (extra library folder) and ADCC_TEST_ROOT locate a local setup.
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),cp=require('child_process');
const home=process.env.HOME;
const pw=require(process.env.ADCC_PLAYWRIGHT_MODULE||home+'/.cache/acc-browser/node_modules/playwright');
const root=process.env.ADCC_TEST_ROOT||home+'/ai-workspace/test/isolated-dashboard';
const base='http://127.0.0.1:'+(process.env.ADCC_TEST_PORT||3420);
const password=fs.readFileSync(root+'/.password','utf8').trim();
const libs=process.env.ADCC_BROWSER_LIBS||home+'/.cache/acc-browser/sysroot/usr/lib/x86_64-linux-gnu';
const launchEnv={...process.env,...(fs.existsSync(libs)?{LD_LIBRARY_PATH:libs}:{})};
const results=[];
const report=r=>{results.push(r);console.log(r.join(' | '));};
async function check(name,fn){try{await fn();report(['PASS',name]);}catch(e){report(['FAIL',name,String(e.message).split('\n')[0].slice(0,220)]);}}
const fresh=async pg=>{await pg.goto(base+'/',{waitUntil:'domcontentloaded'});await pg.evaluate(()=>localStorage.removeItem('cui:tabs'));await pg.goto(base+'/',{waitUntil:'domcontentloaded'})};
async function signIn(page){await page.goto(base+'/login',{waitUntil:'domcontentloaded'});await page.locator('input[type="password"]').fill(password);await page.locator('button[type="submit"]').click();await page.waitForURL(u=>!u.pathname.includes('/login'),{waitUntil:'commit'});}
const noOverflow=p=>p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth);
const post=(req,url,data,headers={})=>req.post(base+url,{data,headers:{Origin:base,...headers}});
const uniq=Date.now().toString(36);

async function suite(browserType,label){
  const b=await browserType.launch({headless:true,env:launchEnv});
  const phone=await b.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:browserType.name()!=='firefox'});
  phone.setDefaultTimeout(10000);const page=await phone.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const t=n=>`${label}: ${n}`;
  await check(t('signed-out pages redirect and APIs refuse'),async()=>{
    const r=await page.goto(base+'/tasks',{waitUntil:'domcontentloaded'});assert.match(new URL(r.url()).pathname,/login/);
    for(const u of ['/api/tasks','/api/workspace','/api/agents','/api/sessions'])assert.equal((await page.request.get(base+u)).status(),401,u);
    assert.equal((await post(page.request,'/api/workspace',{action:'create',name:'x'})).status(),401);
  });
  await signIn(page);
  await check(t('foreign origin and unknown host refused'),async()=>{
    assert.equal((await post(page.request,'/api/workspace',{action:'create',name:'x'},{Origin:'https://attacker.invalid'})).status(),403);
    assert.equal((await page.request.get(base+'/api/workspace',{headers:{Host:'attacker.invalid'}})).status(),421);
  });
  await check(t('work outside the workspace is refused'),async()=>{
    const r=page.request;
    for(const agent of ['claude','codex']){const s=await post(r,'/api/sessions',{agent,profile:agent,cwd:'/etc',text:'x',permissionMode:'plan',clientId:uniq+agent+label});assert.equal(s.status(),403,agent);assert.match((await s.json()).error,/outside the development workspace/);}
    assert.equal((await post(r,'/api/sessions',{agent:'codex',profile:'codex',cwd:'/etc',text:'x',worktree:true,permissionMode:'plan',clientId:uniq+'wt'+label})).status(),403);
    assert.equal((await post(r,'/api/terminals',{profile:'claude',cwd:'/etc'})).status(),403);
    assert.equal((await post(r,'/api/workspace',{action:'register',path:'/etc'})).status(),403);
    assert.equal((await r.get(base+'/api/fs?path=/etc')).status(),403);
    assert.equal((await r.get(base+'/api/fs')).ok(),true);
    assert.equal((await (await r.get(base+'/api/fs')).json()).parent,null);
    assert.equal((await post(r,'/api/workspace',{action:'create',name:'../escape'})).status(),400);
  });
  await check(t('workspace lists only allowed folders, and says what each is'),async()=>{
    const w=await (await page.request.get(base+'/api/workspace')).json();
    assert(w.entries.every(e=>e.path.startsWith(root)));
    const kind=n=>w.entries.find(e=>e.name===n)?.kind;
    assert.equal(kind('sample-repo'),'git');assert.equal(kind('plain-folder'),'folder');assert.equal(kind('sample-feature'),'worktree');
    assert.equal(w.entries.find(e=>e.name==='sample-repo').queueable,true);assert.equal(w.entries.find(e=>e.name==='sample-feature').queueable,false);
  });
  await check(t('capabilities never offer bypass here, and report sign-in as a verdict only'),async()=>{
    const {agents}=await (await page.request.get(base+'/api/agents')).json();
    for(const a of agents.filter(a=>['claude','codex'].includes(a.id))){assert(!a.capabilities.modes.includes('bypassPermissions'));assert(['signed-in','signed-out','unknown'].includes(a.signIn));}
    assert(!JSON.stringify(agents).includes('@'));
  });
  await page.goto(base+'/',{waitUntil:'domcontentloaded'});
  const projectBtn=page.getByTestId('project-button');
  await check(t('a real project is preselected and clearly named'),async()=>{
    await projectBtn.waitFor();await assertEventually(async()=>/Git repository|Folder/.test(await projectBtn.innerText()));
  });
  await check(t('project picker selects, creates, and refuses duplicates'),async()=>{
    await projectBtn.click();const dlg=page.getByRole('dialog',{name:'Choose a project'});await dlg.waitFor();
    await pick(dlg,'plain-folder');await assertEventually(async()=>/plain-folder/.test(await projectBtn.innerText()));
    await assertEventually(async()=>/What's next in plain-folder/.test(await page.locator('h1').innerText()));
    await projectBtn.click();await dlg.getByRole('button',{name:'New project'}).click();
    await dlg.getByLabel('Project name').fill('sample-repo');await dlg.getByRole('button',{name:'Create project'}).click();
    await dlg.getByRole('alert').filter({hasText:'already exists'}).waitFor();
    const name='created-'+label+'-'+uniq;await dlg.getByLabel('Project name').fill(name);await dlg.getByRole('button',{name:'Create project'}).click();
    await assertEventually(async()=>(await projectBtn.innerText()).includes(name));
    assert(fs.existsSync(path.join(root,'projects',name,'.git')));
    assert.equal(cp.execFileSync('git',['-C',path.join(root,'projects',name),'rev-list','--count','HEAD'],{encoding:'utf8'}).trim(),'1');
  });
  await check(t('a registered folder that vanished shows as missing, cannot be picked, and can be removed'),async()=>{
    const gone=path.join(root,'projects','gone-'+label+'-'+uniq);fs.mkdirSync(gone);
    assert.equal((await post(page.request,'/api/workspace',{action:'register',path:gone})).status(),200);fs.rmdirSync(gone);
    await page.goto(base+'/',{waitUntil:'domcontentloaded'});await projectBtn.waitFor();await projectBtn.click();
    const dlg=page.getByRole('dialog',{name:'Choose a project'});
    const row=dlg.getByRole('listitem').filter({hasText:path.basename(gone)});await row.getByText('Missing').waitFor();
    assert.equal(await row.getByRole('button').first().isDisabled(),true);
    await row.getByRole('button',{name:'Remove'}).click();await row.waitFor({state:'detached'});
    await page.keyboard.press('Escape');
  });
  await check(t('Auto is a real choice, forces background, and hides what does not apply'),async()=>{
    await page.getByRole('radio',{name:'Auto'}).check({force:true});
    await page.getByLabel('What do you want built?').waitFor();
    assert.equal(await page.getByRole('radio',{name:'Interactive'}).count(),0);assert.equal(await page.getByRole('radio',{name:'Background'}).count(),0);
    assert.equal(await page.getByLabel('Test command').count(),0);
    await page.getByRole('button',{name:'Start Auto'}).waitFor();
    await page.getByRole('radio',{name:'Claude'}).check({force:true});
    await page.getByText('Keeps running on the server').waitFor();
  });
  await check(t('Codex starts with an approval mode the server accepts, and Bypass is not offered'),async()=>{
    await page.getByRole('radio',{name:'Codex'}).check({force:true});
    let sent=null;await page.route('**/api/sessions',r=>{if(r.request().method()==='POST'){sent=r.request().postDataJSON();return r.fulfill({status:400,json:{error:'intercepted by test'}});}return r.continue();});
    await page.locator('textarea').first().fill('no provider call happens here');await page.keyboard.press('Control+Enter');
    const radio=await page.getByRole('radio',{name:'Codex'}).evaluate(e=>`checked=${e.checked} disabled=${e.disabled}`);await assertEventually(()=>sent!==null);assert.equal(sent.agent,'codex',`sent ${sent.agent} with the Codex radio ${radio}`);assert.notEqual(sent.permissionMode,'bypassPermissions');
    await page.unroute('**/api/sessions');await page.goto(base+'/',{waitUntil:'domcontentloaded'});
    await page.getByRole('button',{name:/Approvals|Ask first|approval/i}).first().click();
    const menu=page.getByRole('menu',{name:'Approvals'});await menu.waitFor();
    assert.equal(await menu.getByText('Bypass approvals').count(),0);assert.equal(await menu.getByRole('menuitemradio').count(),3);
    await page.keyboard.press('Escape');
  });
  await check(t('background form validates, and reaches the real queue'),async()=>{
    await page.goto(base+'/?mode=background',{waitUntil:'domcontentloaded'});await projectBtn.waitFor();
    await projectBtn.click();const dlg=page.getByRole('dialog',{name:'Choose a project'});await pick(dlg,'plain-folder');
    await page.getByRole('alert').filter({hasText:'starts from a Git repository'}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Queue task'}).isDisabled(),true);
    await projectBtn.click();await pick(dlg,'sample-repo');
    await page.getByRole('radio',{name:'Claude'}).check({force:true});
    await page.getByLabel('What should the agent do?').fill('UI check '+label+' '+uniq);
    await page.getByRole('button',{name:'Queue task'}).click();
    await page.getByText('Enter the command that proves the work is done.').waitFor();
    await page.getByLabel('Test command').fill('echo "unterminated');await page.getByRole('button',{name:'Queue task'}).click();
    await page.getByText('Close the quote in this command.').waitFor();
    await page.getByLabel('Test command').fill('python3 -c "print(1)"');await page.getByRole('button',{name:'Queue task'}).click();
    await page.waitForURL(/\/tasks\?task=[a-f0-9]{12}/);
    await page.getByRole('dialog').getByText('Queued').first().waitFor();
    await page.getByRole('dialog').getByRole('button',{name:'Cancel'}).click();
    await page.getByRole('dialog').getByText('Cancelled before it started.').waitFor();
    await page.getByRole('dialog').getByRole('button',{name:'Close'}).click();
  });
  await check(t('tasks show real states, filter, and open logs'),async()=>{
    await page.goto(base+'/tasks',{waitUntil:'domcontentloaded'});await page.getByRole('heading',{name:'Background tasks',exact:true}).waitFor();
    await page.getByText('Needs review').first().waitFor();await page.getByText('Failed',{exact:true}).first().waitFor();
    await page.getByRole('group',{name:'Filter tasks'}).getByRole('button',{name:/^Needs you/}).click();assert.equal(await page.getByText('Queued',{exact:true}).count(),0);
    await page.getByRole('button',{name:/Migrate the settings store/}).click();
    const d=page.getByRole('dialog');await d.getByText('The test command failed.').first().waitFor();await d.getByText('2 tests failed').waitFor();
    await d.getByRole('button',{name:'Close'}).click();
  });
  await check(t('resume refuses bad and unknown IDs, and is a clear separate path'),async()=>{
    await page.goto(base+'/?mode=resume',{waitUntil:'domcontentloaded'});const box=page.getByLabel('Search or paste a session ID');await box.waitFor();
    await page.getByRole('radio',{name:'Resume session'}).waitFor();assert.equal(await page.getByRole('radio',{name:'Resume session'}).isChecked(),true);
    assert.equal(await page.getByRole('button',{name:'Continue in background'}).isDisabled(),true);
    await box.fill('00000000-0000-4000-8000-000000000000');await page.getByText("A new one won't be started").waitFor();
    assert.equal(await page.getByRole('button',{name:'Open in terminal'}).isDisabled(),true);assert(await noOverflow(page));
    for(const bad of ['--last','x;id','00000000-0000-4000-8000-000000000000\n'])assert.equal((await post(page.request,'/api/resume',{agent:'codex',session:bad,prompt:'x'})).status(),400,bad);
    assert.equal((await post(page.request,'/api/resume',{agent:'gemini',session:'00000000-0000-4000-8000-000000000000',prompt:'x'})).status(),400);
    assert.equal((await post(page.request,'/api/resume',{agent:'codex',session:'00000000-0000-4000-8000-000000000000',prompt:'x'})).status(),400);
    assert.equal((await page.request.get(base+'/api/resume?agent=codex&id=../etc')).status(),200);
  });
  await check(t('an empty project needs an explicit choice before a task starts'),async()=>{
    await page.goto(base+'/?mode=background',{waitUntil:'domcontentloaded'});await projectBtn.filter({hasNotText:'Loading projects'}).waitFor();await projectBtn.click();const dlg=page.getByRole('dialog',{name:'Choose a project'});await pick(dlg,'empty-repo');
    await page.getByRole('radio',{name:'Claude'}).check({force:true});await page.getByLabel('What should the agent do?').fill('Continue the release work');await page.getByLabel('Test command').fill('python3 -m unittest');
    await page.getByText(/has no files yet/).waitFor();assert.equal(await page.getByRole('button',{name:'Queue task'}).isDisabled(),true);
  });
  await check(t('Auto accepts an empty project and reaches the planner'),async()=>{
    let sent=null;await page.route('**/api/plans',r=>{if(r.request().method()==='POST'){sent=r.request().postDataJSON();return r.fulfill({status:400,json:{error:'intercepted by test'}})}return r.continue()});
    await page.goto(base+'/?mode=auto',{waitUntil:'domcontentloaded'});await projectBtn.filter({hasNotText:'Loading projects'}).waitFor();await projectBtn.click();await pick(page.getByRole('dialog',{name:'Choose a project'}),'empty-repo');
    await page.getByLabel('What do you want built?').fill('Build something');await page.getByRole('button',{name:'Start Auto'}).click();await assertEventually(()=>sent!==null);assert.equal(sent.maxRepairs,2);await page.unroute('**/api/plans');
  });
  await check(t('a held task shows approve and reject, and rejecting is recorded'),async()=>{
    await page.goto(base+'/tasks',{waitUntil:'domcontentloaded'});await page.getByRole('button',{name:/Held for approval fixture/}).click();const d=page.getByRole('dialog');await d.getByRole('button',{name:'Approve'}).waitFor();await d.getByRole('button',{name:'Reject'}).waitFor();await d.getByText('Needs your approval').first().waitFor();
    await d.getByLabel('Send Claude a message').waitFor();await d.getByRole('button',{name:'Close'}).click();
  });
  await check(t('a finished plan shows steps, routing, tests and review, and merging needs confirmation'),async()=>{
    await page.goto(base+'/tasks',{waitUntil:'domcontentloaded'});const row=page.getByRole('region',{name:'Auto plans'}).getByRole('button',{name:/Add a sample feature/});await row.waitFor();
    await row.getByText('Ready for your review').waitFor();await row.getByText('2 of 2 steps').waitFor();await row.click();
    const d=page.getByRole('dialog');await d.getByText('Reviewer found problems').waitFor();await d.getByText('first.txt needs a header').waitFor();
    await d.getByText('Write the second part').waitFor();await d.getByText('After: first').waitFor();await d.getByText('Final test of the merged work').waitFor();
    await d.getByRole('button',{name:'Merge into project'}).click();await d.getByRole('button',{name:'Confirm merge'}).waitFor();await d.getByRole('button',{name:'Not yet'}).click();
    assert.equal(await d.getByRole('button',{name:'Confirm merge'}).count(),0);assert(await noOverflow(page));
    await d.getByRole('button',{name:'Close'}).click();
    const plans=await (await page.request.get(base+'/api/plans')).json();assert.equal(plans[0].state,'ready');
    assert.equal((await post(page.request,'/api/plans',{action:'merge',id:'../../etc'})).status(),400);
    assert.equal((await post(page.request,'/api/plans',{action:'create',repo:'/etc',request:'x'})).status(),403);
    assert.equal((await post(page.request,'/api/plans',{action:'approve-step',id:plans[0].id,step:'$(reboot)'})).status(),400);
  });
  await check(t('light theme applies and stays readable on phones'),async()=>{
    const ctx=await b.newContext({viewport:{width:390,height:844},storageState:await phone.storageState()});await ctx.addInitScript(()=>localStorage.setItem('bui-theme','light'));const q=await ctx.newPage();await q.goto(base+'/tasks',{waitUntil:'domcontentloaded'});await q.getByRole('heading',{name:'Background tasks',exact:true}).waitFor();
    assert.equal(await q.evaluate(()=>document.documentElement.classList.contains('dark')),false);assert(await noOverflow(q));await ctx.close();
  });
  await check(t('an Auto plan reads as a conversation, with real activity and logs'),async()=>{
    const plans=await (await page.request.get(base+'/api/plans')).json();const id=plans.find(p=>p.goal==='Add a sample feature').id;
    await page.goto(base+'/?s='+encodeURIComponent('plan:'+id));await page.getByText('Fixture plan with two steps').first().waitFor();await page.getByText('Add a sample feature').first().waitFor();
    await page.getByText('Write the second part').waitFor();await page.getByText('After: first').waitFor();await page.getByText('Reviewer found problems').waitFor();await page.getByRole('button',{name:'Merge into project'}).waitFor();
    assert(new URL(page.url()).pathname==='/');
    await page.getByText('Agent activity and logs').first().click();await page.getByRole('button',{name:'Copy output'}).first().waitFor();assert(await noOverflow(page));
  });
  await check(t('a locked conversation asks for its PIN, and shows nothing before that'),async()=>{
    const key='00000000-0000-4000-8000-'+Date.now().toString(16).padStart(12,'0').slice(-12);const name='ui'+uniq+label.slice(0,3);
    assert.equal((await post(page.request,'/api/access',{action:'add-user',name,password:'correct horse battery'})).status(),200);
    for(const body of [{action:'set',session:key,pin:'2468'},{action:'set',session:key,mode:'pin',pinLevel:'view'}])assert.equal((await post(page.request,'/api/access',body)).status(),200);
    const ctx=await b.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:browserType.name()!=='firefox'});ctx.setDefaultTimeout(10000);const m=await ctx.newPage();
    await m.goto(base+'/login',{waitUntil:'domcontentloaded'});await m.locator('#username').fill(name);await m.locator('input[type="password"]').fill('correct horse battery');await m.locator('button[type="submit"]').click();await m.waitForURL(u=>!u.pathname.includes('/login'),{waitUntil:'commit'});
    await m.goto(base+'/?s='+key,{waitUntil:'domcontentloaded'});await m.getByText('This conversation is locked').waitFor();
    await m.locator('input[type="password"]').fill('1111');await m.getByRole('button',{name:'Unlock'}).click();await m.getByRole('alert').filter({hasText:'Wrong PIN'}).waitFor();
    await m.locator('input[type="password"]').fill('2468');await m.getByRole('button',{name:'Unlock'}).click();await m.getByRole('link',{name:'Sharing and access'}).waitFor();
    await m.getByText('View only').first().waitFor();assert(await m.getByRole('link',{name:'Sharing and access'}).isVisible());assert(await noOverflow(m));
    await ctx.close();
  });
  await check(t('Full access: off shows the way to turn it on, needs the risk acknowledged, and a member never gets it'),async()=>{
    await fresh(page);await page.getByRole('radio',{name:'Claude'}).check({force:true});
    await page.getByRole('button',{name:/Approvals|Ask first|approval/i}).first().click();const menu=page.getByRole('menu',{name:'Approvals'});await menu.waitFor();
    await menu.getByText('Full access is off').waitFor();await menu.getByRole('link',{name:/Full access is off/}).click();await page.waitForURL('**/team**',{waitUntil:'commit'});
    const card=page.getByRole('region',{name:/^Full access/});await card.waitFor();const on=card.getByRole('button',{name:'Turn on Full access'});
    assert.equal(await on.isDisabled(),true);assert.equal((await post(page.request,'/api/full-access',{enabled:true})).status(),400);
    await card.getByRole('checkbox').check();await on.click();await card.getByRole('button',{name:'Turn off Full access'}).waitFor();
    await fresh(page);await page.getByRole('radio',{name:'Claude'}).check({force:true});await page.getByRole('button',{name:/Approvals|Ask first|approval/i}).first().click();await menu.getByRole('menuitemradio',{name:/Full access/}).waitFor();await page.keyboard.press('Escape');
    const name='fa'+uniq+label.slice(0,3);assert.equal((await post(page.request,'/api/access',{action:'add-user',name,password:'correct horse battery'})).status(),200);
    const ctx=await b.newContext();ctx.setDefaultTimeout(10000);const m=await ctx.newPage();await m.goto(base+'/login',{waitUntil:'domcontentloaded'});await m.locator('#username').fill(name);await m.locator('input[type="password"]').fill('correct horse battery');await m.locator('button[type="submit"]').click();await m.waitForURL(u=>!u.pathname.includes('/login'),{waitUntil:'commit'});
    const agents=await (await m.request.get(base+'/api/agents')).json();for(const a of agents.agents.filter(x=>['claude','codex'].includes(x.id))){assert.equal(a.capabilities.fullAccess,'hidden');assert(!a.capabilities.modes.includes('bypassPermissions'))}
    assert.equal((await m.request.get(base+'/api/full-access')).status(),403);assert.equal((await post(m.request,'/api/full-access',{enabled:false})).status(),403);
    await m.goto(base+'/',{waitUntil:'domcontentloaded'});await m.getByRole('button',{name:/Approvals|Ask first|approval/i}).first().click();const mm=m.getByRole('menu',{name:'Approvals'});await mm.waitFor();assert.equal(await mm.getByText(/Full access/).count(),0);await ctx.close();
    assert.equal((await post(page.request,'/api/full-access',{enabled:false})).status(),200);
  });
  await check(t('tasks survive a lost connection and recover on their own'),async()=>{
    await page.goto(base+'/tasks',{waitUntil:'domcontentloaded'});await page.getByText('Live',{exact:true}).waitFor();
    await page.route('**/api/tasks',r=>r.abort());await page.getByText('Reconnecting…',{exact:true}).waitFor({timeout:6000});
    await page.getByText('Needs review').first().waitFor();await page.getByText(/Tasks keep running/).waitFor();
    await page.unroute('**/api/tasks');await page.getByText('Live',{exact:true}).waitFor({timeout:6000});
  });
  await check(t('phone layouts do not overflow, controls are large enough, and nothing floats over the composer'),async()=>{
    for(const u of ['/','/?mode=background','/tasks']){await page.goto(base+u,{waitUntil:'domcontentloaded'});await page.waitForTimeout(700);assert(await noOverflow(page),'overflow '+u);
      const small=await page.evaluate(()=>[...document.querySelectorAll('main a,main button,main [role=radio],main input,main select')].filter(e=>{const hit=(e.matches('input[type=checkbox]')&&e.closest('label'))||e;const r=hit.getBoundingClientRect();const s=getComputedStyle(e);return r.width>1&&r.height>1&&s.visibility!=='hidden'&&!e.closest('[aria-hidden=true]')&&(r.height<24||r.width<24)}).map(e=>(e.getAttribute('aria-label')||e.textContent||e.tagName).trim().slice(0,30)));
      assert.deepEqual(small.filter(s=>s!=='Skip to message'),[],'too small on '+u+': '+small.join(', '));}
    await page.goto(base+'/',{waitUntil:'domcontentloaded'});await page.waitForTimeout(500);assert.equal(await page.locator('a[href="/tasks"]:visible').count(),0);
  });
  await check(t('no uncaught page errors'),async()=>assert.deepEqual(errors,[]));
  await phone.close();

  const desk=await b.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'});desk.setDefaultTimeout(10000);const d=await desk.newPage();await signIn(d).catch(async e=>{report(['INFO',t('first navigation in a new context was slow, retried once'),String(e.message).split('\n')[0].slice(0,120)]);await signIn(d)});
  await check(t('sidebar reaches background tasks and back'),async()=>{
    await d.goto(base+'/',{waitUntil:'domcontentloaded'});await d.getByRole('link',{name:'Background tasks'}).click();await d.waitForURL('**/tasks');
    await d.getByRole('link',{name:'Sessions'}).click();await d.waitForURL(u=>u.pathname==='/');
  });
  await check(t('keyboard reaches and drives the run controls, with visible focus'),async()=>{
    await d.goto(base+'/',{waitUntil:'domcontentloaded'});await d.getByTestId('project-button').filter({hasNotText:'Loading projects'}).waitFor();
    const radio=d.getByRole('radio',{name:'Claude'});await radio.focus();await d.keyboard.press('ArrowRight');
    await assertEventually(()=>d.getByRole('radio',{name:'Codex'}).isChecked());
    const outline=await d.evaluate(()=>{const span=document.activeElement.nextElementSibling;return getComputedStyle(span).outlineStyle});assert.notEqual(outline,'none');await d.getByRole('radio',{name:'Claude'}).check({force:true});
  });
  await check(t('dialogs trap focus, close on Escape, and return focus'),async()=>{
    await d.getByTestId('project-button').click();await d.getByRole('dialog').waitFor();await d.keyboard.press('Escape');await d.getByRole('dialog').waitFor({state:'detached'});
    await assertEventually(()=>d.evaluate(()=>document.activeElement?.dataset?.testid==='project-button'));
  });
  await desk.close();await b.close();
}
const pick=(dlg,name)=>dlg.getByRole('button',{name:new RegExp('^'+name)}).first().click();
async function assertEventually(fn,ms=6000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,100));}assert.fail('condition not met in time');}

(async()=>{
  await suite(pw.chromium,'chromium');
  for(const name of (process.env.ADCC_ENGINES||'firefox,webkit').split(',').filter(Boolean)){try{await Promise.race([suite(pw[name],name),new Promise((_,no)=>setTimeout(()=>no(new Error('no result in 240 seconds')),240000))]);}catch(e){report(['BLOCKED',name+': browser did not run',String(e.message).split('\n')[0].slice(0,160)]);}}
  const fail=results.filter(r=>r[0]==='FAIL').length;console.log(`${results.filter(r=>r[0]==='PASS').length} passed, ${fail} failed, ${results.filter(r=>r[0]==='BLOCKED').length} blocked`);process.exitCode=fail?1:0;
process.exit(process.exitCode||0);
})().catch(e=>{console.error(e);process.exit(1)});
