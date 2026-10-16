#!/bin/sh
set -eu
install_deps() {
  # Serialize installation with tests using the shared dependency tree.
  mkdir -p /app/node_modules
  exec 9>/app/node_modules/.hack-toolchain.lock
  flock 9
  bun install --frozen-lockfile
}
task=${1:-models}
if [ "$#" -gt 0 ]; then shift; fi
case "$task" in
  models) exec bun run test:models "$@" ;;
  install) install_deps ;;
  test) install_deps; exec bun test "$@" ;;
  check) install_deps; bun run typecheck; exec bun run check ;;
  rust-check) cargo fmt --manifest-path packages/runtime-core/Cargo.toml --check; exec cargo clippy --locked --manifest-path packages/runtime-core/Cargo.toml --target-dir /build/rust --all-targets --all-features --jobs 2 -- -D warnings ;;
  rust) exec cargo test --all-features --locked --manifest-path packages/runtime-core/Cargo.toml --target-dir /build/rust --jobs 2 "$@" ;;
  build)
    install_deps
    # Bun 1.3.9 stages in cwd; its cross-device fallback can emit zero-filled
    # executables when cwd is the host bind mount and dist is a named volume.
    cd /app/dist
    bun build /app/index.ts --compile --outfile hack "$@"
    # A successful compiler exit does not prove the emitted executable can run.
    exec /app/dist/hack --version
    ;;
  exec) exec "$@" ;;
  *) echo "Tasks: models, install, test [paths], check, rust [args], rust-check, build, exec <command>" >&2; exit 2 ;;
esac
