#!/usr/bin/env python3
"""Package only tracked source. Never recursively archive an installation or working state."""
import hashlib,pathlib,subprocess,tarfile,io,shutil
root=pathlib.Path(__file__).resolve().parents[1];version=(root/'VERSION').read_text().strip();dest=root/'dist';dest.mkdir(exist_ok=True);name='ai-development-control-center-'+version;archive=dest/(name+'.tar.gz')
tracked=subprocess.check_output(['git','-C',str(root),'ls-files','-z']).decode().split('\0')
forbidden=('.env','node_modules/','.next','state.sqlite','dashboard-password','edge-password','.pem','.key','.claude/')
assert all(not any(x in f for x in forbidden) for f in tracked if f)
with tarfile.open(archive,'w:gz',format=tarfile.PAX_FORMAT) as t:
 for f in sorted(filter(None,tracked)):
  p=root/f
  if p.is_dir():continue
  info=t.gettarinfo(str(p),arcname=name+'/'+f);info.uid=info.gid=0;info.uname=info.gname='';info.mtime=0
  if p.is_symlink():t.addfile(info)
  else:
   with p.open('rb') as data:t.addfile(info,data)
shutil.copy2(root/'install.sh',dest/'install.sh')
(dest/'SHA256SUMS').write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.name+'\n' for p in [archive,dest/'install.sh']))
print(archive)
