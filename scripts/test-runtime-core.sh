#!/usr/bin/env bash
set -euo pipefail
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
cd "$root"
version=$(bash scripts/install-cargo-nextest.sh --print-version)
install="cargo install --locked --version $version cargo-nextest"
runner=${HACK_RUST_TEST_RUNNER:-auto}
repetitions=${HACK_RUST_TEST_REPETITIONS:-1}
case "$runner" in auto|nextest) ;; *) echo 'HACK_RUST_TEST_RUNNER must be auto or nextest.' >&2; exit 2 ;; esac
case "$repetitions" in 1|20) ;; *) echo 'HACK_RUST_TEST_REPETITIONS must be 1 or 20.' >&2; exit 2 ;; esac
common=(--locked --manifest-path packages/runtime-core/Cargo.toml --target-dir "${HACK_RUST_TEST_TARGET_DIR:-.hack-local/target}")
if ! command -v cargo-nextest >/dev/null 2>&1; then
  if [[ "$runner" == nextest || "$repetitions" != 1 ]]; then
    echo "Pinned cargo-nextest $version is required. Install: $install" >&2
    exit 2
  fi
  echo "cargo-nextest absent; using cargo test. For process isolation install: $install" >&2
  # A single libtest thread avoids cross-test spawn/close races in the fallback.
  if [[ "$(uname -s)" == Darwin ]]; then export RUST_TEST_THREADS=1; fi
  exec cargo test "${common[@]}" --jobs 2 "$@"
fi
actual=$(cargo-nextest --version)
case "$actual" in
  "cargo-nextest $version"|"cargo-nextest $version ("*) ;;
  *) echo "Pinned cargo-nextest $version is required. Install: $install" >&2; exit 2 ;;
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
  exec cargo test "${common[@]}" --jobs 2 "$@"
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
  if [[ "$(uname -s)" == Darwin ]] && ! grep -q 'provider::lifecycle::admission_pool::tests::' "$HACK_RUST_TEST_REPORT_DIR/$mode-groups.txt"; then
    echo 'The macOS disk-probe tests are missing their serial nextest group.' >&2
    exit 2
  fi
  cargo test "${common[@]}" --jobs 2 "$@" -- --list > "$HACK_RUST_TEST_REPORT_DIR/$mode-libtest.txt"
  cargo test "${common[@]}" --jobs 2 "$@" -- --list --ignored > "$HACK_RUST_TEST_REPORT_DIR/$mode-ignored.txt"
fi
for ((iteration=1; iteration<=repetitions; iteration++)); do
  echo "Rust $mode suite $iteration/$repetitions: process per test, retries=0"
  if [[ -n "${HACK_RUST_TEST_REPORT_DIR:-}" ]]; then
    # nextest's store is relative to Cargo's workspace (this standalone crate),
    # independently of the shared Cargo --target-dir.
    source="$root/packages/runtime-core/target/nextest/ci/junit.xml"
    # This is nextest's regenerable result, not a user file. A build failure
    # must never copy a previous successful iteration as the failed one's proof.
    rm -f -- "$source"
  fi
  status=0
  cargo nextest run "${common[@]}" --build-jobs 2 \
    --config-file "$root/.config/nextest.toml" --profile ci --retries 0 "$@" || status=$?
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
  # Never reset a failing streak, retry, or continue to another suite after failure.
  if [[ "$status" != 0 ]]; then exit "$status"; fi
  # Nextest excludes doctests. Cargo excludes them for explicit target selection
  # too, and rejects --doc combined with those selectors.
  if [[ "$run_doctests" == true ]]; then cargo test --doc "${common[@]}" --jobs 2 "$@"; fi
done
