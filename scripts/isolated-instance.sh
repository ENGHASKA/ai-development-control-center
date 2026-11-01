#!/usr/bin/env bash
# Runs a built dashboard from this checkout beside any live install, for browser and integration tests.
# Own ports, tmux server, workspace, task queue, settings and throwaway password; nothing is shared with
# production except the provider CLIs and their logins, so real sessions still consume real provider usage.
#   scripts/isolated-instance.sh seed    create the disposable workspace and fixtures
#   scripts/isolated-instance.sh serve   run proxy, app and terminal service in the foreground
#   scripts/isolated-instance.sh fixtures  add real queue records from the provider-free demo agent, for browser checks
#   scripts/isolated-instance.sh clean   remove this script's task unit and stop only tasks it started
# With ADCC_TEST_WORKER=1, serve also runs a queue worker, whose tasks use their own systemd template, as production's do.
set -euo pipefail
SOURCE=$(cd "$(dirname "$0")/.." && pwd)
ROOT=${ADCC_TEST_ROOT:-$HOME/ai-workspace/test/isolated-dashboard}
PORT=${ADCC_TEST_PORT:-3420}
NODE_DIR=${ADCC_NODE_DIR:-$HOME/.nvm/versions/node/v24.22.2/bin}
UNIT=acc-isolated-task
UNIT_FILE=$HOME/.config/systemd/user/$UNIT@.service

install_unit() {
  cat > "$UNIT_FILE" <<UNIT_END
[Unit]
Description=Isolated test task %i
[Service]
Type=simple
Slice=acc.slice
WorkingDirectory=$SOURCE
Environment=PATH=$NODE_DIR:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=ACC_ROOT=$ROOT ACC_ROOTS_FILE=$ROOT/roots.json ACC_UNIT_PREFIX=$UNIT@ ACC_ALLOW_FIXTURES=${ADCC_TEST_FIXTURES:-0}
UMask=0077
NoNewPrivileges=yes
ExecStart=/usr/bin/python3 $SOURCE/bin/acc execute %i
Restart=no
KillMode=control-group
TimeoutStopSec=15
MemoryMax=2500M
CPUQuota=200%
TasksMax=192
UNIT_END
  systemctl --user daemon-reload
}

fixtures() {
  seed >/dev/null
  export ACC_ROOT="$ROOT" ACC_ROOTS_FILE="$ROOT/roots.json" ACC_SOURCE_DIR="$SOURCE"
  local dir=$ROOT/specs one two
  mkdir -p "$dir"
  spec() { python3 -c 'import json,sys;print(json.dumps({"repo":sys.argv[1],"owner":"demo","prompt":sys.argv[2],"test":sys.argv[3:],"timeout":60,"max_attempts":1}))' "$ROOT/projects/sample-repo" "$@"; }
  spec 'Add input validation to the signup form' python3 -c 'print("12 tests passed")' > "$dir/one.json"
  spec 'Migrate the settings store to SQLite' python3 -c 'import sys;print("2 tests failed");sys.exit(1)' > "$dir/two.json"
  spec 'Refresh the API reference from the OpenAPI spec' python3 -c 'print("ok")' > "$dir/three.json"
  one=$(python3 "$SOURCE/bin/acc" add "$dir/one.json" | tail -1)
  two=$(python3 "$SOURCE/bin/acc" add "$dir/two.json" | tail -1)
  python3 "$SOURCE/bin/acc" add "$dir/three.json" >/dev/null
  python3 "$SOURCE/bin/acc" execute "$one" >/dev/null
  python3 "$SOURCE/bin/acc" execute "$two" >/dev/null
  python3 -c 'import json,sys;print(json.dumps({"repo":sys.argv[1],"owner":"claude","prompt":"Held for approval fixture","test":["python3","-c","pass"],"timeout":60,"hold_for_approval":True}))' "$ROOT/projects/sample-repo" > "$dir/held.json"
  python3 "$SOURCE/bin/acc" add "$dir/held.json" >/dev/null
  mkdir -p "$ROOT/projects/empty-repo"; git -C "$ROOT/projects/empty-repo" init -q -b main; git -C "$ROOT/projects/empty-repo" -c user.name=T -c user.email=t@localhost commit -q --allow-empty -m Start
  python3 - "$ROOT/projects/sample-repo" > "$dir/plan.json" <<'PLAN_END'
import json,sys
test=["python3","-m","unittest","discover","-s","tests"]
check="import pathlib,unittest\nclass T(unittest.TestCase):\n    def test_it(self):\n        self.assertTrue(pathlib.Path('%s').exists())\n"
step=lambda key,title,depends:{"key":key,"title":title,"description":"Fixture step","depends":depends,"capabilities":["backend"],"test":test}
print(json.dumps({"repo":sys.argv[1],"request":"Fixture plan with two steps","max_repairs":0,"fixture":{
  "plan":{"goal":"Add a sample feature","tasks":[step("first","Write the first part",[]),step("second","Write the second part",["first"])],"validation":{"test":test,"acceptance":["Both parts exist"]}},
  "steps":{"first":{"first.txt":"1","tests/__init__.py":"","tests/test_first.py":check%"first.txt"},"second":{"second.txt":"2","tests/test_second.py":check%"second.txt"}},
  "review":{"approved":False,"summary":"One problem found","findings":["first.txt needs a header"]}}}))
PLAN_END
  ACC_ALLOW_FIXTURES=1 python3 "$SOURCE/bin/acc" plan-add "$dir/plan.json" >/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do ACC_ALLOW_FIXTURES=1 python3 "$SOURCE/bin/acc" once; done
  python3 "$SOURCE/bin/acc" list | cut -c14-60
}

clean() {
  systemctl --user list-units "$UNIT@*" --plain --no-legend --all | awk '{print $1}' | while read -r unit; do systemctl --user stop "$unit"; done
  rm -f "$UNIT_FILE"
  systemctl --user daemon-reload
}

seed() {
  mkdir -p "$ROOT"/{projects,worktrees,tasks/leases,logs,reports,tmux,agent-ui}
  chmod 700 "$ROOT" "$ROOT/tmux"
  [ -f "$ROOT/.password" ] || (umask 077; head -c 18 /dev/urandom | base64 | tr -d '/+=' > "$ROOT/.password")
  [ -f "$ROOT/.secret" ] || (umask 077; head -c 36 /dev/urandom | base64 | tr -d '/+=' > "$ROOT/.secret")
  local repo="$ROOT/projects/sample-repo"
  if [ ! -d "$repo/.git" ]; then
    mkdir -p "$repo"
    git -C "$repo" init -q -b main
    git -C "$repo" config user.name "Isolated fixture"
    git -C "$repo" config user.email fixture@example.invalid
    printf 'Disposable fixture for dashboard tests.\n' > "$repo/README.md"
    git -C "$repo" add .
    git -C "$repo" commit -qm "Fixture"
    git -C "$repo" worktree add -q -b feature/sample "$ROOT/worktrees/sample-feature"
  fi
  mkdir -p "$ROOT/projects/plain-folder"
  printf 'Workspace ready at %s\n' "$ROOT"
}

serve() {
  seed >/dev/null
  # $TMUX outranks TMUX_TMPDIR: left set, this instance would drive the tmux server it was started from
  unset TMUX TMUX_PANE
  export PATH="$NODE_DIR:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
  export NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 SHELL=/bin/bash
  export ACC_ROOT="$ROOT" ACC_FILE_ROOT="$ROOT" ACC_SOURCE_DIR="$SOURCE" AGENT_U_HOME="$ROOT/agent-ui"
  export AGENT_U_CONFIG="$ROOT/agent-ui/config.json" TMUX_TMPDIR="$ROOT/tmux" ACC_ROOTS_FILE="$ROOT/roots.json" ACC_POLICY_FILE="$ROOT/policy.json" ACC_UNIT_PREFIX="$UNIT@"
  export DEV_PROXY_PORT="$PORT" APP_PORT=$((PORT + 1)) PTY_PORT=$((PORT + 2))
  export ALLOWED_HOSTS="localhost,127.0.0.1" UI_PASSWORD="$(cat "$ROOT/.password")" UI_SECRET="$(cat "$ROOT/.secret")"
  # the real CLAUDE_HOME and CODEX_HOME stay for live sessions; screenshots must not show them
  if [ "${ADCC_TEST_SANITIZED:-}" = 1 ]; then
    mkdir -p "$ROOT/provider/claude" "$ROOT/provider/codex"
    [ -f "$HOME/.codex/models_cache.json" ] && cp "$HOME/.codex/models_cache.json" "$ROOT/provider/codex/"
    export CLAUDE_HOME="$ROOT/provider/claude" CODEX_HOME="$ROOT/provider/codex"
  fi
  cd "$SOURCE/dashboard"
  trap 'kill 0' EXIT
  if [ "${ADCC_TEST_WORKER:-}" = 1 ]; then
    install_unit
    ACC_MAX_WORKERS=2 python3 "$SOURCE/bin/acc" worker &
  fi
  node scripts/dev-proxy.mjs &
  node server/pty.mjs &
  node node_modules/next/dist/bin/next start -H 127.0.0.1 -p "$APP_PORT" &
  wait
}

case "${1:-}" in
  seed) seed ;;
  serve) serve ;;
  fixtures) fixtures ;;
  clean) clean ;;
  *) echo "usage: $0 seed|serve|fixtures|clean" >&2; exit 2 ;;
esac
