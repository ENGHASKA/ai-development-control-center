#!/bin/sh
# Review this installer and verify SHA256SUMS before execution. No curl-to-shell.
set -eu
version=3.0.0-beta.1
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -f "$here/install.py" ]; then exec python3 "$here/install.py" "$@"; fi
archive="$here/ai-development-control-center-$version.tar.gz"
[ -f "$archive" ] && [ -f "$here/SHA256SUMS" ] || { echo 'Download the release archive and SHA256SUMS beside this verified installer.' >&2; exit 1; }
(cd "$here" && sha256sum --check --ignore-missing SHA256SUMS)
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT HUP INT TERM
python3 - "$archive" "$staging" <<'PY'
import sys,tarfile
with tarfile.open(sys.argv[1]) as t:t.extractall(sys.argv[2],filter='data')
PY
python3 "$staging/ai-development-control-center-$version/install.py" "$@"
