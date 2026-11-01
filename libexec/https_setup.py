"""Prepare, but never silently apply, public ingress. Operator reviews privileged changes."""
import json,pathlib,re,secrets,shlex,shutil,socket,subprocess,os

def prepare(c,hostname,config):
 from manage import private,config_env,write_env
 if not re.fullmatch(r'(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}',hostname):raise ValueError('Use a valid controlled DNS hostname, not an IP or URL')
 resolved=sorted({x[4][0] for x in socket.getaddrinfo(hostname,443)})
 if not resolved:raise ValueError('Hostname does not resolve')
 if not shutil.which('caddy'):raise ValueError('Install maintained Caddy 2.8+ using https://caddyserver.com/docs/install first. Do not stop an unrelated service.')
 target=config/'https';target.mkdir(mode=0o700,exist_ok=True);password=secrets.token_urlsafe(32)
 p=subprocess.run(['caddy','hash-password'],input=password+'\n',text=True,capture_output=True,check=True)
 hashed=p.stdout.strip()
 if not hashed.startswith('$2'):raise ValueError('Caddy did not produce bcrypt')
 private(target/'edge-password',password+'\n')
 source=pathlib.Path(__file__).resolve().parents[1]
 template=(source/'config/Caddyfile.template').read_text().replace('@HOST@',hostname).replace('@PORT@',str(c['port'])).replace('@HASH@',hashed)
 private(target/'Caddyfile',template)
 subprocess.run(['caddy','validate','--config',str(target/'Caddyfile'),'--adapter','caddyfile'],check=True)
 # Serve as this trusted operator, with only low-port binding capability. No root shell or writable executable.
 import pwd
 user=pwd.getpwuid(os.getuid()).pw_name
 unit=f'# Managed by AI Development Control Center HTTPS\n[Unit]\nDescription=AI Development Control Center HTTPS\nAfter=network-online.target\nWants=network-online.target\n[Service]\nUser={user}\nGroup={pwd.getpwuid(os.getuid()).pw_gid}\nExecStart=/usr/bin/caddy run --config {json.dumps(str(target/"Caddyfile"))} --adapter caddyfile\nRestart=on-failure\nRestartSec=5\nAmbientCapabilities=CAP_NET_BIND_SERVICE\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE\nNoNewPrivileges=yes\nPrivateTmp=yes\nProtectSystem=strict\nReadWritePaths={json.dumps(str(target))}\nEnvironment=XDG_DATA_HOME={target}/data\nEnvironment=XDG_CONFIG_HOME={target}/config\nUMask=0077\nMemoryMax=256M\nTasksMax=64\n[Install]\nWantedBy=multi-user.target\n'
 private(target/'adcc-https.service',unit)
 script='''#!/bin/sh
set -eu
[ "$(id -u)" -eq 0 ] || { echo 'Run this reviewed script using sudo'; exit 1; }
unit=/etc/systemd/system/adcc-https.service
if [ -e "$unit" ] && ! head -n1 "$unit" | grep -qx '# Managed by AI Development Control Center HTTPS'; then echo 'Refusing unrelated service'; exit 1; fi
/usr/bin/caddy validate --config @CONFIG@ --adapter caddyfile
if ss -lnt | awk '{print $4}' | grep -Eq ':(80|443)$' && ! systemctl is-active --quiet adcc-https; then echo 'Ports 80/443 occupied: review existing ingress; nothing changed'; exit 1; fi
install -m0644 @UNIT@ "$unit"
systemctl daemon-reload
systemctl enable --now adcc-https
'''.replace('@CONFIG@',shlex.quote(str(target/'Caddyfile'))).replace('@UNIT@',shlex.quote(str(target/'adcc-https.service')))
 private(target/'apply-https.sh',script)
 # App credentials remain independent; regenerate only the runtime environment's nonsecret HTTPS settings.
 envfile=config/'dashboard.env';lines=envfile.read_text().splitlines();lines=[x for x in lines if not x.startswith(('PUBLIC_HOSTNAME=','TRUST_PROXY_HEADERS='))];lines+=['PUBLIC_HOSTNAME='+json.dumps(hostname),'TRUST_PROXY_HEADERS="1"'];private(envfile,'\n'.join(lines)+'\n');private(config/'public-hostname',hostname+'\n')
 print('DNS resolves to '+', '.join(resolved)+'. Confirm these are this server before applying.\nReview '+str(target/'Caddyfile')+' and '+str(target/'apply-https.sh')+'\nThen: sudo sh '+shlex.quote(str(target/'apply-https.sh'))+'\nsystemctl --user restart adcc-dashboard adcc-terminal\nPublic target: https://'+hostname+'\nEdge user: operator. View edge password locally: cat '+shlex.quote(str(target/'edge-password'))+'\nPublic access is NOT verified until TLS and both logins pass from an independent network. No firewall rules changed.')
