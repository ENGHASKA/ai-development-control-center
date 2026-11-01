"""Folders agents may work in: the workspace, plus roots an operator approved at a shell.

The web interface can read this list but never change it, so a browser session or a prompt cannot widen its own reach.
"""
import json,os,pathlib

HOME=pathlib.Path.home()
PROTECTED=('.ssh','.gnupg','.aws','.claude','.codex','.config','.local','.cache','.nvm','backups')

def workspace():
    return pathlib.Path(os.environ.get('ACC_ROOT',str(HOME/'.local/state/ai-development-control-center'))).resolve()

def config_file():
    return pathlib.Path(os.environ.get('ACC_ROOTS_FILE',str(HOME/'.config/ai-control-center/workspace-roots.json')))

def problem(path):
    """Why a folder can't be an approved root, or None."""
    p=pathlib.Path(path).resolve()
    if not p.is_relative_to(HOME) or p==HOME:return 'Approved roots must be folders inside the home directory, not the home directory itself'
    if p.parts[len(HOME.parts)] in PROTECTED:return 'That folder holds credentials or system tools'
    if p==workspace().parent:return 'That folder holds the workspace; approve a folder beside it instead'
    if not p.is_dir():return 'Folder not found'
    return None

def extra():
    try:raw=json.loads(config_file().read_text())
    except (OSError,ValueError):return []
    if not isinstance(raw,dict) or not isinstance(raw.get('roots'),list):return []
    return [pathlib.Path(x).resolve() for x in raw['roots'] if isinstance(x,str) and not problem(x)]

def roots():
    return [workspace(),*extra()]

def allowed(path):
    p=pathlib.Path(path).resolve()
    return any(p.is_relative_to(r) for r in roots())

def save(values):
    target=config_file();target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    tmp=target.with_suffix('.tmp');tmp.write_text(json.dumps({'roots':sorted(set(values))},indent=2)+'\n');os.chmod(tmp,0o600);tmp.replace(target)

def add(path):
    issue=problem(path)
    if issue:raise ValueError(issue)
    save([*map(str,extra()),str(pathlib.Path(path).resolve())])

def remove(path):
    p=pathlib.Path(path).resolve()
    save([str(x) for x in extra() if x!=p])

def policy_file():
    return pathlib.Path(os.environ.get('ACC_POLICY_FILE',str(HOME/'.config/ai-control-center/policy.json')))

def full_access():
    """Whether an operator allowed full access. Agents stay inside approved folders either way, and it never means root."""
    try:return json.loads(policy_file().read_text()).get('full_access') is True
    except (OSError,ValueError,AttributeError):return False

def set_full_access(on):
    target=policy_file();target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    tmp=target.with_suffix('.tmp');tmp.write_text(json.dumps({'full_access':on})+'\n');os.chmod(tmp,0o600);tmp.replace(target)
