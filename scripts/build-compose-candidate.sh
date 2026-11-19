#!/bin/sh
# Compose-only Linux candidate bundle, the counterpart of build-native-candidate.sh.
# Builds for the host (glibc Linux x86_64 or arm64); there is no cross build.
# Explicit bundle only: never modifies the installed hack, shell, or runtime state.
#
# The bundle holds the compiled CLI, the hack-v5 launcher, the config compiler
# and its schemas, the lifecycle supervisor, the install guide, prerelease.json
# and SHA256SUMS. It has no native executor, guest relay, storage witness,
# provider pins or MCP bundle, and nothing in it is code signed.
set -eu
umask 077
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
if [ "$#" -ne 2 ]; then
  echo "Usage: scripts/build-compose-candidate.sh /absolute/new/bundle-directory --version=5.MINOR.PATCH-next.N" >&2
  exit 64
fi
case "$2" in --version=*) version=${2#--version=} ;; *) echo "Unknown build option" >&2; exit 64 ;; esac
case "$1" in /*) ;; *) echo "Output must be an absolute new directory" >&2; exit 64 ;; esac
if [ "$(uname -s)" != Linux ]; then
  echo "Compose candidate bundle supports Linux x86_64 and arm64 only" >&2
  exit 69
fi
case "$(uname -m)" in
  x86_64|amd64) platform=linux-x86_64 ;;
  aarch64|arm64) platform=linux-arm64 ;;
  *) echo "Compose candidate bundle supports Linux x86_64 and arm64 only" >&2; exit 69 ;;
esac
source_revision=$(git -C "$repo" rev-parse HEAD)
if [ -n "$(git -C "$repo" status --porcelain --untracked-files=normal)" ]; then
  echo "Versioned prereleases require a clean source checkout" >&2
  exit 73
fi
metadata=$(HACK_PRERELEASE_VERSION="$version" HACK_PRERELEASE_SOURCE_REVISION="$source_revision" HACK_PRERELEASE_PLATFORM="$platform" bun "$repo/scripts/prerelease-plan.ts" metadata)
if [ -e "$1" ] || [ -L "$1" ]; then
  echo "Refusing to replace an existing output path" >&2
  exit 73
fi
parent=$(CDPATH= cd -- "$(dirname -- "$1")" && pwd -P)
out="$parent/$(basename -- "$1")"
cd "$repo"
case "$(rustc --version)" in "rustc 1.97.1 "*) ;; *) echo "Pinned Rust 1.97.1 is required" >&2; exit 69 ;; esac
if [ "$(bun --version)" != 1.4.4 ]; then
  echo "Pinned Bun 1.4.4 is required" >&2
  exit 69
fi
command -v sha256sum >/dev/null
# Exclusive mkdir refuses races; an interrupted bundle is retained for inspection.
mkdir -m 700 "$out"
# The CLI runs inside projects the user may not trust. Without these flags a
# compiled Bun program loads the working directory's bunfig.toml (its preloads
# run as the CLI) and .env (it fills in any variable the caller did not set,
# such as DOCKER_HOST or a HACK_* setting), and reads tsconfig.json and
# package.json.
# The bytecode cache spares each start a parse of the whole bundle; ESM output
# keeps top-level await working.
bun build index.ts --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig --no-compile-autoload-tsconfig --no-compile-autoload-package-json --bytecode --format=esm --define 'process.env.OPENTUI_LIBC="glibc"' --define "__HACK_BUILD_VERSION__=\"$version\"" --outfile "$out/hack-cli"
bun scripts/build-lifecycle-supervisor.ts
cp dist/hack-lifecycle-supervisor "$out/hack-lifecycle-supervisor"
bun scripts/build-config-compiler.ts
cp dist/hack-config-compiler "$out/hack-config-compiler"
cp packages/config-compiler/generated/hack.project.schema.json "$out/hack.project.schema.json"
cp packages/config-compiler/generated/hack.local.schema.json "$out/hack.local.schema.json"
cp scripts/hack-v5.sh "$out/hack-v5"
cp docs/guides/candidate-install.md "$out/README.md"
printf '%s\n' "$metadata" > "$out/prerelease.json"
chmod 755 "$out/hack-cli" "$out/hack-v5" "$out/hack-lifecycle-supervisor" "$out/hack-config-compiler"
chmod 600 "$out/README.md" "$out/prerelease.json" "$out/hack.project.schema.json" "$out/hack.local.schema.json"
if [ "$(git -C "$repo" rev-parse HEAD)" != "$source_revision" ] || [ -n "$(git -C "$repo" status --porcelain --untracked-files=normal)" ]; then
  echo "Candidate source changed during build; retaining incomplete output" >&2
  exit 73
fi
if [ "$("$out/hack-cli" --version)" != "hack v$version" ]; then
  echo "Compiled CLI did not report the prerelease version" >&2
  exit 65
fi
(
  cd "$out"
  sha256sum hack-cli hack-v5 README.md prerelease.json hack-lifecycle-supervisor hack-config-compiler hack.project.schema.json hack.local.schema.json > SHA256SUMS
)
echo "Compose candidate bundle ($platform): $out"
echo "Verify SHA256SUMS before copying. Run: $out/hack-v5 --version"
