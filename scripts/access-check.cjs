// Each access mode against real agents and real file outcomes, on the isolated instance. Real usage, disposable projects.
const fs=require('fs'),path=require('path'),cp=require('child_process');
const home=process.env.HOME,root=process.env.ADCC_TEST_ROOT||home+'/ai-workspace/test/isolated-dashboard',base='http://127.0.0.1:'+(process.env.ADCC_TEST_PORT||3420);
const say=(s,n,x='')=>console.log([s,n,String(x).split('\n')[0].slice(0,200)].filter(Boolean).join(' | '));const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(f,ms)=>{const e=Date.now()+ms;while(Date.now()<e){if(await f())return true;await sleep(1500)}return false};
let cookie='';const call=async(u,body)=>{const r=await fetch(base+u,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',Origin:base,Cookie:cookie},body:body?JSON.stringify(body):undefined});const c=r.headers.get('set-cookie');if(c)cookie=c.split(';')[0];return r};
const tmuxT=(...a)=>cp.execFileSync('tmux',['-u','-S',root+'/tmux/tmux-'+process.getuid()+'/default',...a],{encoding:'utf8',env:{...process.env,TMUX:undefined,TMUX_PANE:undefined}});
const project=n=>{const d=path.join(root,'projects',n+'-'+Date.now().toString(36));fs.mkdirSync(d,{recursive:true});cp.execFileSync('git',['init','-q','-b','main',d]);fs.writeFileSync(d+'/README.md','x\n');cp.execFileSync('git',['-C',d,'add','.']);cp.execFileSync('git',['-C',d,'-c','user.name=T','-c','user.email=t@localhost','commit','-qm','s']);return d};
async function run(agent,mode,prompt,file,wait){const d=project(agent+'-'+mode);const r=await call('/api/sessions',{agent,profile:agent,cwd:d,text:prompt.replaceAll('{D}',d),model:agent==='claude'?'claude-haiku-5-5':undefined,permissionMode:mode,clientId:agent+mode+Date.now()});const body=await r.json();if(!r.ok)return{error:body.error,d};const made=await until(()=>fs.existsSync(path.join(d,file)),wait);return{made,d,id:body.id,terminal:body.terminal}}
const close=t=>{if(t)try{tmuxT('kill-session','-t',t)}catch{}};
(async()=>{
 await call('/api/auth/login',{password:fs.readFileSync(root+'/.password','utf8').trim()});
 const write='Create a file named out.txt containing hi in the current folder. Do it now without asking me anything.';
 for(const [agent,mode,expect,wait] of [['claude','plan',false,40000],['codex','plan',false,50000],['claude','default',false,40000],['codex','default',false,50000],['claude','acceptEdits',true,60000],['codex','acceptEdits',true,80000]]){
  const r=await run(agent,mode,write,'out.txt',wait);
  if(r.error){say('FAIL',`${agent} ${mode} failed to start`,r.error);continue}
  say(r.made===expect?'PASS':'FAIL',`${agent} ${mode}: file ${r.made?'written':'not written'}`,expect?'expected to write':'expected to hold back');close(r.terminal)}
 const policy=process.env.ACC_POLICY_FILE||root+'/policy.json';
 const off=await call('/api/agents');const offModes=(await off.json()).agents.find(a=>a.id==='codex').capabilities.modes;say(offModes.includes('bypassPermissions')?'FAIL':'PASS','Full Access is not offered while the policy is off',offModes.join(' '));
 const stray=await run('codex','bypassPermissions',write,'out.txt',15000);say(stray.made===false||stray.error?'PASS':'INFO','a client asking for Full Access with the policy off gets the safe mode',stray.made?'wrote in workspace-write?':'held back');close(stray.terminal);
 fs.writeFileSync(policy,JSON.stringify({full_access:true}));
 const on=(await (await call('/api/agents')).json()).agents.find(a=>a.id==='codex').capabilities.modes;say(on.includes('bypassPermissions')?'PASS':'FAIL','the operator policy turns Full Access on');
 const outside=path.join(root,'outside-'+Date.now());fs.mkdirSync(outside);
 const escape=`Run this exact shell command: touch ${outside}/made.txt; id -u > uid.txt; sudo -n true; echo sudo=$? >> uid.txt`;
 const c=await run('codex','bypassPermissions',escape,'uid.txt',80000);say(c.made?'PASS':'FAIL','Codex Full Access really has no sandbox: it wrote outside its folder',fs.existsSync(outside+'/made.txt'));
 if(c.made){await sleep(2000);const t=fs.readFileSync(c.d+'/uid.txt','utf8');say(!/^0$/m.test(t)?'PASS':'FAIL','Full Access is not root',t.replace(/\n/g,' '));say(/sudo=0/.test(t)?'FAIL':'PASS','Full Access has no passwordless sudo',t.replace(/\n/g,' '))}close(c.terminal);
 const claude=await run('claude','bypassPermissions',`Run the shell command: touch ran.txt`,'ran.txt',60000);say(claude.made?'PASS':'FAIL','Claude Full Access ran a command without a prompt');close(claude.terminal);
 const refused=await call('/api/sessions',{agent:'codex',profile:'codex',cwd:'/etc',text:'x',permissionMode:'bypassPermissions',clientId:'x'+Date.now()});say(refused.status===403?'PASS':'FAIL','Full Access still cannot start outside approved folders',refused.status);
 fs.writeFileSync(policy,JSON.stringify({full_access:false}));process.exit(0)
})().catch(e=>{say('FAIL','stopped',e.message.slice(0,200));process.exit(1)});
