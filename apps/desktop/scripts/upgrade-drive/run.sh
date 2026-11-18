#!/usr/bin/env bash
# Drive the Upgrade pane against the real CLI without touching a real home.
#
#   scripts/upgrade-drive/run.sh <hack-desktop binary> [passes]
#
# Each pass makes a fresh HOME, HACK_HOME and a git-initialised project under
# /tmp, registers the project there (hack config set --path) with an outdated
# .hack/.gitignore, and runs the app (`--drive … --hidden`):
#   1. save.steps     check (ready), Save snapshot; a snapshot manifest must
#                     land in the temp home;
#   then the harness runs `hack upgrade apply --only ignore-rules` (the app
#   never applies), which rewrites .hack/.gitignore and keeps a snapshot;
#   2. restore.steps  Restore the newest snapshot (apply's); .hack/.gitignore
#                     must come back byte for byte;
#   then the harness edits .hack/.gitignore;
#   3. keep.steps     Restore again; the edit must stay (no --overwrite).
# The `hack` the app runs is a stand-in that runs this checkout's CLI
# (`bun index.ts`) for `upgrade`, and answers version and daemon status
# itself; no daemon runs. Nothing outside the temp tree is written, and it is
# removed after each pass. Needs `bun` (set BUN to choose one), git, python3.
set -euo pipefail
APP=${1:?usage: run.sh <hack-desktop binary> [passes]}
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
  T=$(mktemp -d /tmp/upgd.XXXXXX)
  chmod 700 "$T"
  H="$T/userhome/.hack"
  P="$T/proj"
  mkdir -p "$T/bin" "$H" "$P/.hack"
  printf 'services:\n  api:\n    image: example.invalid/fixture:1\n' > "$P/.hack/docker-compose.yml"
  printf '{"name":"demo"}\n' > "$P/.hack/hack.config.json"
  printf '# old rules\n' > "$P/.hack/.gitignore"
  cp "$P/.hack/.gitignore" "$T/seed"
  # Git in a clean environment: the temp HOME, no system or global config,
  # no hooks, no signing, nothing inherited (GIT_DIR and friends).
  tgit() {
    env -i PATH=/usr/bin:/bin HOME="$T/userhome" GIT_CONFIG_NOSYSTEM=1 \
      GIT_CONFIG_GLOBAL=/dev/null git -C "$P" -c core.hooksPath=/dev/null \
      -c commit.gpgsign=false -c user.email=fixture@example.invalid \
      -c user.name=fixture "$@"
  }
  tgit init -q
  tgit add -A
  tgit commit -qm fixture
  cat > "$T/bin/hack" <<STANDIN
#!/bin/sh
case "\$1" in
  upgrade) exec "$BUN" "$REPO/index.ts" "\$@" ;;
  version) echo '{"ok":true,"data":{"schema":"hack.version.v1","version":"5.0.0"}}' ;;
  daemon) echo '{"status":"stopped","running":false}'; exit 1 ;;
  *) echo '{"ok":false,"error":{"code":"E_FAKE","message":"not in the stand-in"}}'; exit 1 ;;
esac
STANDIN
  chmod 755 "$T/bin/hack"
  app() {
    env -i PATH="$T/bin:/usr/bin:/bin" HOME="$T/userhome" HACK_HOME="$H" \
      HACK_DAEMON_AUTOSTART_DISABLE=1 SHELL=/bin/sh TERM=xterm-256color \
      XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-}" WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-}" \
      DISPLAY="${DISPLAY:-}" "$APP" --drive "$HERE/$1" --hidden 2>&1 | grep '@drive' || true
  }
  cli() {
    env -i PATH=/usr/bin:/bin HOME="$T/userhome" HACK_HOME="$H" \
      HACK_DAEMON_AUTOSTART_DISABLE=1 HACK_NO_INTERACTIVE=1 "$BUN" "$REPO/index.ts" "$@"
  }
  ok=1
  cli config set dev_host demo.hack --path "$P" >/dev/null 2>&1 \
    || { ok=0; echo "pass $n: could not register the temp project"; }
  out=$(app save.steps)
  echo "$out" | grep -q '@drive result pass' || { ok=0; echo "pass $n save:"; echo "$out"; }
  manifests=$(find "$H/upgrade/snapshots" -name manifest.json 2>/dev/null | wc -l)
  [ "$manifests" -eq 1 ] || { ok=0; echo "pass $n: $manifests snapshot manifests in the temp home, expected 1"; }
  cli upgrade apply --only ignore-rules --json >/dev/null 2>&1 \
    || { ok=0; echo "pass $n: hack upgrade apply failed"; }
  if cmp -s "$T/seed" "$P/.hack/.gitignore"; then
    ok=0
    echo "pass $n: apply did not change .hack/.gitignore"
  fi
  out=$(app restore.steps)
  echo "$out" | grep -q '@drive result pass' || { ok=0; echo "pass $n restore:"; echo "$out"; }
  cmp -s "$T/seed" "$P/.hack/.gitignore" \
    || { ok=0; echo "pass $n: .hack/.gitignore did not come back byte for byte"; }
  printf '# edited after the restore\n' > "$P/.hack/.gitignore"
  cp "$P/.hack/.gitignore" "$T/edited"
  out=$(app keep.steps)
  echo "$out" | grep -q '@drive result pass' || { ok=0; echo "pass $n keep:"; echo "$out"; }
  cmp -s "$T/edited" "$P/.hack/.gitignore" \
    || { ok=0; echo "pass $n: a restore overwrote a file edited since the snapshot"; }
  rm -rf "$T"
  if [ "$ok" = 1 ]; then pass=$((pass + 1)); else fail=$((fail + 1)); fi
done
echo "upgrade drive: pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
