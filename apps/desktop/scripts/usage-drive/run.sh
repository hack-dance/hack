#!/bin/sh
# The Services tab's usage, read live through the checked CLI path.
#
#   scripts/usage-drive/run.sh <hack-desktop binary> [passes]
#
# Each pass makes a temp HOME and HACK_HOME under /tmp. The fake hackd from
# the env drive lists one running Compose project, "demo"; a stand-in `hack`
# answers version, daemon, `usage --json --by-service` and `ps --json` with
# canned JSON and records every call. The pass checks what the app shows and
# that it ran exactly the read-only commands it should. No Docker, no real
# CLI, nothing outside the temp directory. Needs python3.
set -u
APP=$1
PASSES=${2:-1}
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
pass=0
fail=0
n=0
while [ "$n" -lt "$PASSES" ]; do
  n=$((n + 1))
  T=$(mktemp -d /tmp/used.XXXXXX)
  chmod 700 "$T"
  mkdir -p "$T/bin" "$T/userhome/.hack/daemon" "$T/proj/.hack"
  chmod 700 "$T/userhome/.hack/daemon"
  printf 'services:\n  api:\n    image: example.invalid/fixture:1\n  db:\n    image: example.invalid/fixture:1\n' > "$T/proj/.hack/docker-compose.yml"
  cat > "$T/bin/hack" <<STANDIN
#!/bin/sh
printf '%s\n' "\$*" >> "$T/calls"
case "\$1" in
  version) echo '{"ok":true,"data":{"schema":"hack.version.v1","version":"5.0.0"}}' ;;
  daemon) echo '{"running":true,"status":"running","version":"5.0.0","api_ok":true}' ;;
  usage) echo '{"ok":true,"data":{"schema":"hack.usage.by-service.v1","project":"demo","backend":"compose","services":[{"composeProject":"demo","service":"api","containers":1,"cpuPercent":3.2,"memUsedBytes":222298112,"memLimitBytes":2147483648},{"composeProject":"demo","service":"db","containers":1,"cpuPercent":1.4,"memUsedBytes":406847488,"memLimitBytes":null},{"composeProject":"demo--preview","service":"api","containers":1,"cpuPercent":50.0,"memUsedBytes":1073741824,"memLimitBytes":null}]}}' ;;
  ps) echo '{"ok":true,"data":{"items":[{"Service":"api","State":"running","emulated":true},{"Service":"db","State":"running"}]}}' ;;
  *) echo '{"ok":false,"error":{"code":"E_FAKE","message":"not in the stand-in"}}'; exit 1 ;;
esac
STANDIN
  chmod 755 "$T/bin/hack"
  python3 -I "$HERE/fakehackd.py" "$T/userhome/.hack/daemon/hackd.sock" "$T/proj" 5.0.0 &
  FD=$!
  i=0
  while [ ! -S "$T/userhome/.hack/daemon/hackd.sock" ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
  out=$(env -i PATH="$T/bin:/usr/bin:/bin" HOME="$T/userhome" HACK_HOME="$T/userhome/.hack" \
    HACK_DAEMON_AUTOSTART_DISABLE=1 SHELL=/bin/sh TERM=xterm-256color \
    XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-}" WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-}" \
    "$APP" --drive "$HERE/usage.steps" --hidden 2>&1 | grep '@drive')
  kill "$FD" 2>/dev/null
  wait "$FD" 2>/dev/null
  ok=1
  echo "$out" | grep -q '@drive result pass' || ok=0
  grep -qx "usage --json --by-service --path $T/proj" "$T/calls" || { echo "pass $n: no by-service usage read for the project"; ok=0; }
  grep -qx "ps --json --path $T/proj" "$T/calls" || { echo "pass $n: no ps read for the emulated flag"; ok=0; }
  # Read-only: the reads above plus the app's own startup reads (version,
  # daemon status, the Logs session's tail, the automatic doctor run).
  bad=$(grep -v -e '^usage --json --by-service ' -e '^ps --json ' -e '^version --json$' \
    -e '^daemon status --json$' -e '^logs ' -e '^doctor --json$' "$T/calls")
  [ -z "$bad" ] || { echo "pass $n: unexpected commands: $bad"; ok=0; }
  if [ "$ok" = 1 ]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "$out"; cat "$T/calls"; fi
  rm -rf "$T"
done
echo "usage drive: pass=$pass fail=$fail"
[ "$fail" = 0 ]
