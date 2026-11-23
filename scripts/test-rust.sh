#!/usr/bin/env bash
set -euo pipefail
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
cd "$root"
crate=runtime-core
case "${1-}" in
  --crate=runtime-core|--crate=config-compiler) crate=${1#--crate=}; shift ;;
  --crate=*) echo 'Unsupported Rust test crate.' >&2; exit 2 ;;
esac
case "$crate" in
  runtime-core) target=.hack-local/target ;;
  config-compiler) target=.hack-local/config-compiler-target ;;
esac
version=$(bash scripts/install-cargo-nextest.sh --print-version)
install="cargo install --locked --version $version cargo-nextest"
runner=${HACK_RUST_TEST_RUNNER:-auto}
repetitions=${HACK_RUST_TEST_REPETITIONS:-1}
case "$runner" in auto|nextest) ;; *) echo 'HACK_RUST_TEST_RUNNER must be auto or nextest.' >&2; exit 2 ;; esac
case "$repetitions" in 1|20) ;; *) echo 'HACK_RUST_TEST_REPETITIONS must be 1 or 20.' >&2; exit 2 ;; esac
cargo_test_flags=(--jobs 2)
nextest_run_flags=(--retries 0)
if [[ "${HACK_RUST_TEST_KEEP_GOING:-0}" == 1 ]]; then
  cargo_test_flags+=(--no-fail-fast)
  nextest_run_flags+=(--no-fail-fast)
fi
common=(--locked --manifest-path "packages/$crate/Cargo.toml" --target-dir "${HACK_RUST_TEST_TARGET_DIR:-$target}")
# Cargo's subcommand lookup can differ from a direct PATH lookup. Probe the
# same command used below, and leave a contributor's other nextest version alone.
actual=$(cargo nextest --version 2>/dev/null) || actual=""
case "$actual" in
  "cargo-nextest $version"|"cargo-nextest $version ("*) ;;
  *)
    if [[ "$runner" == nextest || "$repetitions" != 1 || -n "${HACK_RUST_TEST_REPORT_DIR:-}" ]]; then
      echo "Pinned cargo-nextest $version is required. Install: $install" >&2
      exit 2
    fi
    echo "cargo nextest $version unavailable; using cargo test. Optional install: $install" >&2
    # A single libtest thread avoids cross-test spawn/close races in the fallback.
    if [[ "$(uname -s)" == Darwin ]]; then export RUST_TEST_THREADS=1; fi
    exec cargo test "${common[@]}" "${cargo_test_flags[@]}" "$@"
    ;;
esac
mode=default
run_doctests=true
doc_only=false
for argument in "$@"; do
  case "$argument" in
    --) break ;;
    --all-features) mode=all-features ;;
    --doc) doc_only=true ;;
    --lib|--bins|--bin|--bin=*|--tests|--test|--test=*|--examples|--example|--example=*|--benches|--bench|--bench=*|--all-targets)
      run_doctests=false ;;
  esac
done
# Documentation-only selection has no libtest process for nextest to isolate.
if [[ "$doc_only" == true ]]; then
  if [[ "$repetitions" != 1 || -n "${HACK_RUST_TEST_REPORT_DIR:-}" ]]; then
    echo 'Documentation-only selection cannot produce nextest qualification evidence.' >&2
    exit 2
  fi
  exec cargo test "${common[@]}" "${cargo_test_flags[@]}" "$@"
fi
if [[ -n "${HACK_RUST_TEST_REPORT_DIR:-}" ]]; then
  mkdir -p "$HACK_RUST_TEST_REPORT_DIR"
  # JUnit contains executed tests; keep discovery separately to count ignored
  # fixtures and compare names with the stock libtest inventory.
  cargo nextest list "${common[@]}" --build-jobs 2 --config-file "$root/.config/nextest.toml" \
    --message-format json "$@" > "$HACK_RUST_TEST_REPORT_DIR/$mode-inventory.json"
  cargo nextest show-config test-groups "${common[@]}" --build-jobs 2 \
    --config-file "$root/.config/nextest.toml" --profile ci --groups host-disk-probes "$@" \
    > "$HACK_RUST_TEST_REPORT_DIR/$mode-groups.txt"
  if [[ "$crate" == runtime-core && "$(uname -s)" == Darwin ]] && ! grep -q 'provider::lifecycle::admission_pool::tests::' "$HACK_RUST_TEST_REPORT_DIR/$mode-groups.txt"; then
    echo 'The macOS disk-probe tests are missing their serial nextest group.' >&2
    exit 2
  fi
  cargo test "${common[@]}" "${cargo_test_flags[@]}" "$@" -- --list > "$HACK_RUST_TEST_REPORT_DIR/$mode-libtest.txt"
  cargo test "${common[@]}" "${cargo_test_flags[@]}" "$@" -- --list --ignored > "$HACK_RUST_TEST_REPORT_DIR/$mode-ignored.txt"
fi
for ((iteration=1; iteration<=repetitions; iteration++)); do
  echo "Rust $mode suite $iteration/$repetitions: process per test, retries=0"
  if [[ -n "${HACK_RUST_TEST_REPORT_DIR:-}" ]]; then
    # nextest's store is relative to Cargo's workspace (this standalone crate),
    # independently of the shared Cargo --target-dir.
    source="$root/packages/$crate/target/nextest/ci/junit.xml"
    # This is nextest's regenerable result, not a user file. A build failure
    # must never copy a previous successful iteration as the failed one's proof.
    rm -f -- "$source"
  fi
  status=0
  cargo nextest run "${common[@]}" --build-jobs 2 \
    --config-file "$root/.config/nextest.toml" --profile ci "${nextest_run_flags[@]}" "$@" || status=$?
  if [[ -n "${HACK_RUST_TEST_REPORT_DIR:-}" ]]; then
    if [[ -f "$source" ]]; then
      mkdir -p "$HACK_RUST_TEST_REPORT_DIR"
      report="$HACK_RUST_TEST_REPORT_DIR/$mode-$iteration.xml"
      if [[ -e "$report" ]]; then echo 'Rust report already exists; refusing to replace it.' >&2; exit 2; fi
      cp -n "$source" "$report"
    elif [[ "$status" == 0 ]]; then
      echo 'Nextest succeeded without its required JUnit evidence.' >&2
      exit 2
    fi
  fi
  # Keep the first failed status. In Candidate core, doctests still run after
  # a red nextest pass, but the qualification loop stops at that pass.
  if [[ "$run_doctests" == true && ( "$status" == 0 || "${HACK_RUST_TEST_KEEP_GOING:-0}" == 1 ) ]]; then
    doc_status=0
    cargo test --doc "${common[@]}" "${cargo_test_flags[@]}" "$@" || doc_status=$?
    if [[ "$status" == 0 ]]; then status=$doc_status; fi
  fi
  if [[ "$status" != 0 ]]; then exit "$status"; fi
done
