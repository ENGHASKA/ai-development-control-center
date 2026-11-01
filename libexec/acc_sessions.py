"""Existing provider conversations: finding them, checking them, and continuing the same one.

Claude Code and Codex both resume from their own saved records, so continuing means passing the provider's ID to its CLI.
Nothing here reads credentials or conversation text. Only the records' location and working folder are used, and a session
that can't be found is an error, never a new conversation.
"""
import json,os,pathlib,re,sqlite3,subprocess
import acc_roots

UUID=re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')

def check_id(value):
    """IDs reach a command line, so only the exact provider format passes."""
    if not isinstance(value,str) or not UUID.fullmatch(value):raise ValueError('That is not a valid session ID')
    return value

def claude_home():
    return pathlib.Path(os.environ.get('CLAUDE_HOME',str(pathlib.Path.home()/'.claude')))

def codex_home():
    return pathlib.Path(os.environ.get('CODEX_HOME',str(pathlib.Path.home()/'.codex')))

def first_cwd(path):
    """The folder a transcript recorded, reading only its first lines."""
    with open(path,errors='replace') as f:
        for _,line in zip(range(40),f):
            try:item=json.loads(line)
            except ValueError:continue
            cwd=item.get('cwd') or (item.get('payload') or {}).get('cwd')
            if isinstance(cwd,str):return cwd
    return None

def claude_session(value):
    root=claude_home()/'projects'
    for folder in root.glob('*'):
        f=folder/(value+'.jsonl')
        if f.is_file():return {'file':str(f),'cwd':first_cwd(f)}
    return None

def codex_session(value):
    home=codex_home();found=sorted((home/'sessions').rglob(f'*{value}.jsonl')) if (home/'sessions').is_dir() else []
    if found:return {'file':str(found[-1]),'cwd':first_cwd(found[-1])}
    try:
        c=sqlite3.connect(f"file:{home/'state_5.sqlite'}?mode=ro",uri=True)
        row=c.execute('SELECT cwd FROM threads WHERE id=?',(value,)).fetchone()
        c.close()
    except sqlite3.Error:row=None
    return {'file':None,'cwd':row[0]} if row else None

def find(agent,value):
    check_id(value)
    if agent=='claude':return claude_session(value)
    if agent=='codex':return codex_session(value)
    raise ValueError('Sessions can only be resumed for Claude or Codex')

def open_elsewhere(value):
    """Processes of this user running this session. Reading every command line sees sessions opened at a plain shell too."""
    me=os.getuid();found=[]
    for p in pathlib.Path('/proc').iterdir():
        if not p.name.isdigit() or int(p.name)==os.getpid():continue
        try:
            if p.stat().st_uid!=me:continue
            argv=(p/'cmdline').read_bytes().split(b'\0')
        except OSError:continue
        text=[a.decode(errors='replace') for a in argv if a]
        if value in text and text and pathlib.Path(text[0]).name in ('claude','codex','acc-claude','acc-codex','node','python3'):found.append(int(p.name))
    return found

def inspect(agent,value,cwd=None):
    """What can be done with a session. `problem` is the reason it can't be resumed here, in words a person can act on."""
    record=find(agent,value)
    if not record:return {'exists':False,'agent':agent,'id':value,'problem':f'No saved {agent} conversation has this ID on this server. A new one won\'t be started in its place.'}
    folder=cwd or record['cwd']
    out={'exists':True,'agent':agent,'id':value,'cwd':record['cwd'],'folder':folder,'in_use':bool(open_elsewhere(value))}
    if not folder:return {**out,'problem':'This conversation does not record its folder. Choose a project to resume it in.'}
    p=pathlib.Path(folder)
    if not p.is_dir():return {**out,'problem':f'This conversation\'s folder is gone: {folder}.'}
    if agent=='claude' and record['cwd'] and p.resolve()!=pathlib.Path(record['cwd']).resolve():return {**out,'problem':'Claude can only resume a conversation from the folder it started in.'}
    if not acc_roots.allowed(p):return {**out,'approval':str(p.resolve()),'problem':f'{p} is not an approved folder. Approve it at a shell with: acc roots add {p}'}
    try:top=subprocess.check_output(['git','-C',str(p),'rev-parse','--show-toplevel'],stderr=subprocess.DEVNULL,text=True).strip()
    except (subprocess.CalledProcessError,OSError):return {**out,'problem':'Background resume needs a Git repository. Open it in a terminal instead.','interactive':True}
    out['repo']=top
    if out['in_use']:return {**out,'problem':'This conversation is open somewhere else right now. Close it there first, so two copies can\'t write to it.'}
    return out
