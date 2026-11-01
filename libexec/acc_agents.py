"""What each coding agent is and how to drive it, behind one interface.

A new provider is a new Adapter here and nothing else: the scheduler, router and queue only use this interface. Facts are what
the installed CLI really does; nothing here guesses at quota or account entitlements.
"""
import json,os,pathlib,shutil,subprocess

class Adapter:
    """discover: `describe`. available: `availability`. start and resume: `argv`. failures: the queue's classification."""
    id='';name='';modes=();tools=();resume=False;approvals='';sandbox='';models='';background=True
    def binary(self):return os.environ.get('ACC_'+self.id.upper()+'_BIN') or shutil.which(self.id)
    def signed_in(self):
        """The monitor's last status check, not a live call. None until it has run."""
        try:return json.loads((pathlib.Path(os.environ.get('ACC_ROOT',''))/'reports/agent-health.json').read_text()).get(self.id,{}).get('logged_in')
        except (OSError,ValueError):return None
    def availability(self):
        if not self.binary():return 'not installed'
        return 'signed out' if self.signed_in() is False else None
    def argv(self,launcher,r,s,mode):raise NotImplementedError
    def describe(self):
        return {k:getattr(self,k) for k in ('id','name','modes','tools','resume','approvals','sandbox','models','background')}|{'installed':bool(self.binary())}

class Claude(Adapter):
    id='claude';name='Claude Code';modes=('plan','default','acceptEdits','bypassPermissions');tools=('read','edit');resume=True
    approvals='A denied edit ends the turn and waits for you in the background; live prompts in a terminal';sandbox='Background runs get file tools only';models='Fixed names the CLI accepts; your plan decides which run'
    def argv(self,launcher,r,s,mode):
        tools=s.get('allowed_tools',['Read','Write','Edit','Glob','Grep'])
        # Listing a tool here approves it in advance, so asking first means leaving the writing tools out until a person agrees.
        if mode=='default':tools=[t for t in tools if t in ('Read','Glob','Grep')]
        out=[launcher,'-p','--restricted','--tools','Read,Write,Edit,Glob,Grep','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--verbose','--output-format','stream-json','--permission-mode',mode,'--allowedTools',','.join(tools)]
        out+=['--resume' if r['resume_requested'] and (r['attempts'] or s.get('resume_session')) else '--session-id',r['session_id']]
        if s.get('model'):out+=['--model',s['model']]
        if s.get('effort'):out+=['--effort',s['effort']]
        return out

class Codex(Adapter):
    id='codex';name='Codex';modes=('plan','default','acceptEdits','bypassPermissions');tools=('read','edit','shell');resume=True
    approvals='None in the background: it runs in its sandbox and stops if blocked; live prompts in a terminal';sandbox='workspace-write, no network';models='Listed by the installed CLI'
    def argv(self,launcher,r,s,mode):
        out=[launcher,'--sandbox','workspace-write','-c','approval_policy="never"']
        if s.get('model'):out+=['-m',s['model']]
        if s.get('effort'):out+=['-c',f'model_reasoning_effort="{s["effort"]}"']
        out+=['exec']
        return out+(['resume','--json',r['session_id'],'-'] if r['resume_requested'] and r['session_id'] else ['--json','-'])

ADAPTERS={a.id:a for a in (Claude(),Codex())}
DEFAULT_PREFERENCES={'codex':{'backend':2,'api':2,'database':2,'tests':1,'testing':1,'build':2,'debugging':2,'integration':2,'scripting':2,'devops':2,'migration':2,'repair':1},'claude':{'frontend':2,'ui':2,'design':2,'documentation':2,'docs':2,'copy':2,'css':2,'accessibility':2}}

def preferences():
    """Operator-tunable scores, read fresh so a change applies to the next plan."""
    path=pathlib.Path(os.environ.get('ACC_ROUTING_FILE',str(pathlib.Path.home()/'.config/ai-control-center/routing.json')))
    try:raw=json.loads(path.read_text())
    except (OSError,ValueError):return DEFAULT_PREFERENCES
    return {o:{**DEFAULT_PREFERENCES.get(o,{}),**raw.get(o,{})} for o in ADAPTERS} if isinstance(raw,dict) else DEFAULT_PREFERENCES

def track_record(c):
    """Outcomes of finished agent tasks. Evidence only counts once there's enough of it to mean something."""
    out={}
    for owner in ADAPTERS:
        done=c.execute("SELECT count(*) FROM tasks WHERE json_extract(spec,'$.owner')=? AND state IN ('completed','review')",(owner,)).fetchone()[0]
        bad=c.execute("SELECT count(*) FROM tasks WHERE json_extract(spec,'$.owner')=? AND state='failed'",(owner,)).fetchone()[0]
        out[owner]={'finished':done,'failed':bad}
    return out

def registry(c):
    stats=track_record(c)
    return [{**a.describe(),'available':a.availability() is None,'unavailable_reason':a.availability(),'record':stats[a.id]} for a in ADAPTERS.values()]
