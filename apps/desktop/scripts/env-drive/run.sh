#!/bin/sh
# Env slice 2 against the real CLI, on a throwaway project only.
#
#   scripts/env-drive/run.sh <hack-desktop binary> [passes]
#
# Each pass makes a fresh temp project, HOME and HACK_HOME under /tmp, seeds
# one plaintext value with this checkout's CLI (`bun index.ts`), drives the
# app (edit that value, add a plaintext and a secret variable), then reads the
# stored values back with the same CLI. A fake hackd serves the project list;
# every `hack env` command the app runs is the real CLI. Nothing outside the
# temp directory is read or written. Needs bun (the repo's pinned version) and
# python3. BUN overrides the bun binary.
set -u
APP=$1
PASSES=${2:-1}
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
REPO=$(CDPATH= cd -- "$HERE/../../../.." && pwd -P)
BUN=${BUN:-$(command -v bun)}
[ -x "$BUN" ] || { echo "bun not found; set BUN" >&2; exit 2; }
pass=0
fail=0
n=0
while [ "$n" -lt "$PASSES" ]; do
  n=$((n + 1))
  T=$(mktemp -d /tmp/envd.XXXXXX)
  chmod 700 "$T"
  mkdir -p "$T/bin" "$T/home/.hack/daemon" "$T/proj/.hack"
  chmod 700 "$T/home/.hack/daemon"
  printf 'services:\n  api:\n    image: example.invalid/fixture:1\n' > "$T/proj/.hack/docker-compose.yml"
  # The stand-in `hack` the app runs: canned version/daemon/logs answers,
  # the real CLI for every `env` command.
  cat > "$T/bin/hack" <<STANDIN
#!/bin/sh
case "\$1" in
  env) exec "$BUN" "$REPO/index.ts" "\$@" ;;
  version) echo '{"ok":true,"data":{"schema":"hack.version.v1","version":"5.0.0"}}' ;;
  daemon) echo '{"running":true,"status":"running","version":"5.0.0","api_ok":true}' ;;
  logs) printf 'api | fixture log line\r\n'; case " \$* " in *" --no-follow "*) ;; *) exec sleep 600 ;; esac ;;
  *) echo '{"ok":false,"error":{"code":"E_FAKE","message":"not in the stand-in"}}'; exit 1 ;;
esac
STANDIN
  chmod 755 "$T/bin/hack"
  cli() {
    env -i PATH=/usr/bin:/bin HOME="$T/home" HACK_HOME="$T/home/.hack" \
      HACK_DAEMON_AUTOSTART_DISABLE=1 HACK_NO_INTERACTIVE=1 "$BUN" "$REPO/index.ts" "$@"
  }
  printf 'fake-plain-one' | cli env add FIXTURE_MODE --value-stdin --env default --service global --path "$T/proj" >/dev/null 2>&1
  python3 -I "$HERE/fakehackd.py" "$T/home/.hack/daemon/hackd.sock" "$T/proj" 5.0.0 &
  FD=$!
  i=0
  while [ ! -S "$T/home/.hack/daemon/hackd.sock" ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
  out=$(env -i PATH="$T/bin:/usr/bin:/bin" HOME="$T/home" HACK_HOME="$T/home/.hack" \
    HACK_DAEMON_AUTOSTART_DISABLE=1 SHELL=/bin/sh TERM=xterm-256color \
    XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-}" WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-}" \
    "$APP" --drive "$HERE/edit.steps" --hidden 2>&1 | grep '@drive')
  kill "$FD" 2>/dev/null
  wait "$FD" 2>/dev/null
  ok=1
  echo "$out" | grep -q '@drive result pass' || ok=0
  for kv in FIXTURE_MODE=fake-plain-two FIXTURE_NEW=fake-new-value FIXTURE_SECRET=fake-secret-value; do
    k=${kv%%=*}
    v=${kv#*=}
    [ "$(cli env get "$k" --env default --service global --path "$T/proj" 2>/dev/null)" = "$v" ] || { echo "pass $n: $k not stored as expected"; ok=0; }
  done
  if grep -q 'fake-secret-value' "$T"/proj/.hack/*.yaml; then echo "pass $n: the secret is in a plaintext YAML"; ok=0; fi
  if [ "$ok" = 1 ]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "$out"; fi
  rm -rf "$T"
done
echo "env drive: pass=$pass fail=$fail"
[ "$fail" = 0 ]
