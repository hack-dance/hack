#!/usr/bin/env bash
# Run a command with networking disabled: a fresh network namespace whose
# only interface is a loopback that is down. Used to prove that a build and
# its tests need no network once the inputs are provisioned.
#
#   bash term/scripts/no-network.sh COMMAND [ARGS...]
#
# Uses an unprivileged user namespace where the host allows one, otherwise
# passwordless sudo (hosted CI runners). Linux only.
set -euo pipefail
if [[ $# -eq 0 ]]; then
  echo 'usage: no-network.sh COMMAND [ARGS...]' >&2
  exit 2
fi
# Inside the namespace: refuse to continue if any interface but lo exists.
inner='
ifs=$(awk -F: "NR > 2 { gsub(/ /, \"\", \$1); printf \"%s \", \$1 }" /proc/net/dev)
if [ "$ifs" != "lo " ]; then
  echo "no-network: unexpected interfaces: $ifs" >&2
  exit 3
fi
exec "$@"'
if unshare --user --map-root-user --net true 2>/dev/null; then
  exec unshare --user --map-root-user --net -- bash -c "$inner" no-network "$@"
elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  exec sudo -E unshare --net -- sudo -E -u "$(id -un)" \
    env "PATH=$PATH" "HOME=$HOME" bash -c "$inner" no-network "$@"
fi
echo 'no-network: cannot create a network namespace (needs unprivileged user namespaces or passwordless sudo)' >&2
exit 2
