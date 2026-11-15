import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { Glob } from "bun";

/**
 * Every synchronous spawn in `tests/` and `scripts/check-*.ts` carries a time
 * bound (HACK-2247).
 *
 * A synchronous spawn blocks the event loop, so Bun's per-test timeout cannot
 * fire while it waits. On macOS a child once hung before it started (the
 * system policy daemon stalled) and an unbounded spawn held a test file for
 * hours. New call sites use `spawnSyncBounded` from
 * `tests/helpers/bounded-spawn-sync.ts`, which throws naming the command, or
 * pass `timeout` to `Bun.spawnSync` / `spawnSync` / `execFileSync` /
 * `execSync` directly.
 *
 * The check is textual: a call counts as bounded when the text of its
 * argument list contains `timeout`. Options built elsewhere and passed as a
 * variable are not followed, so such a site counts as unbounded; give it an
 * explicit `timeout` or use the helper. Sites that already existed are listed
 * in KNOWN_UNBOUNDED, a ratchet: a file may not gain a site, and when a file
 * loses one its count here must be lowered so it cannot be spent again.
 */

const ROOT = resolve(import.meta.dir, "..");
const SCANNED = ["tests/**/*.ts", "scripts/check-*.ts"] as const;
const SELF = "tests/sync-spawn-bound.test.ts";
const SYNC_SPAWN = /\b(?:Bun\.spawnSync|spawnSync|execFileSync|execSync)\s*\(/g;

/** Unbounded sites that predate this check, per file. Lower, never raise. */
const KNOWN_UNBOUNDED: Readonly<Record<string, number>> = {
  "tests/background-command-journal.test.ts": 1,
  "tests/background-command-process.test.ts": 1,
  "tests/checkout-write-guard.test.ts": 1,
  "tests/ci-change-scope.test.ts": 5,
  "tests/cli-spawn-env-isolation.test.ts": 2,
  "tests/compose-startup-phases.test.ts": 1,
  "tests/daemon-detach.test.ts": 1,
  "tests/docker-context.test.ts": 1,
  "tests/doctor-adopted-generated-files.test.ts": 1,
  "tests/doctor-fix-adopted-project.test.ts": 1,
  "tests/e2e-shard.test.ts": 2,
  "tests/e2e/run-dependency-cache.test.ts": 1,
  "tests/e2e/scenarios/dependency-cache-package.ts": 2,
  "tests/env-protection.test.ts": 1,
  "tests/env-value-stdin-cli.test.ts": 1,
  "tests/fixture-hermeticity.test.ts": 7,
  "tests/gateway-tokens.test.ts": 1,
  "tests/git-info-exclude.test.ts": 1,
  "tests/global-state-guard.test.ts": 1,
  "tests/lifecycle-command-child.test.ts": 2,
  "tests/lifecycle-json.test.ts": 1,
  "tests/lifecycle-private-output.test.ts": 3,
  "tests/mcp-native-adapter.test.ts": 3,
  "tests/mcp-native-owner.test.ts": 1,
  "tests/mcp-startup-supervision.test.ts": 2,
  "tests/native-compose-adoption-worktrees-fixture.test.ts": 1,
  "tests/native-interactive-launcher.test.ts": 1,
  "tests/native-preflight-cli.test.ts": 1,
  "tests/native-project-branch-cli.test.ts": 1,
  "tests/native-up-already-running-cli.test.ts": 1,
  "tests/portable-bootstrap-env-refusal.test.ts": 1,
  "tests/pre-commit-hook.test.ts": 2,
  "tests/prerelease-plan.test.ts": 1,
  "tests/project-down-worktree-safety.test.ts": 1,
  "tests/project-env-layer-lock.test.ts": 1,
  "tests/project-env-worktree-local.test.ts": 1,
  "tests/project-target-inspect.test.ts": 1,
  "tests/projects-registry-worktrees.test.ts": 1,
  "tests/projects-registry.test.ts": 1,
  "tests/qualify-provider-pin.test.ts": 1,
  "tests/registry-touch-worktrees.test.ts": 1,
  "tests/run-child-exit-status.test.ts": 1,
  "tests/run-exec-branch-default.test.ts": 1,
  "tests/session-list-stop-tmux.test.ts": 2,
  "tests/test-shard.test.ts": 4,
  "tests/tmux-backend-locale.test.ts": 2,
  "tests/tmux-private-input.test.ts": 1,
  "tests/upgrade-apply.test.ts": 1,
  "tests/upgrade-check.test.ts": 7,
};

/** The text of a call from its name to its matching close parenthesis. */
function callText(source: string, start: number): string {
  let index = source.indexOf("(", start) + 1;
  let depth = 1;
  while (index < source.length && depth > 0) {
    const char = source[index];
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
    }
    index += 1;
  }
  return source.slice(start, index);
}

/** Number of synchronous spawn calls in `source` whose arguments name no `timeout`. */
function countUnboundedSyncSpawns(source: string): number {
  let count = 0;
  for (const match of source.matchAll(SYNC_SPAWN)) {
    if (!/\btimeout\b/.test(callText(source, match.index))) {
      count += 1;
    }
  }
  return count;
}

async function scan(): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  for (const pattern of SCANNED) {
    for (const file of new Glob(pattern).scanSync({ cwd: ROOT })) {
      if (file === SELF) {
        continue;
      }
      const count = countUnboundedSyncSpawns(
        await Bun.file(resolve(ROOT, file)).text()
      );
      if (count > 0) {
        found.set(file, count);
      }
    }
  }
  return found;
}

test("the scanner tells bounded from unbounded synchronous spawns", () => {
  expect(countUnboundedSyncSpawns('Bun.spawnSync(["true"])')).toBe(1);
  expect(
    countUnboundedSyncSpawns('Bun.spawnSync(["true"], { timeout: 1000 })')
  ).toBe(0);
  expect(
    countUnboundedSyncSpawns(
      'spawnSync("git", ["status"], { env: f(g(1)) }); execFileSync("ls")'
    )
  ).toBe(2);
  expect(
    countUnboundedSyncSpawns('execSync("ls", { timeout: 5, cwd: dir(a) })')
  ).toBe(0);
  expect(
    countUnboundedSyncSpawns('Bun.spawnSync({ cmd: ["true"], timeout: 1 })')
  ).toBe(0);
  // The bounded helper itself is not a match.
  expect(countUnboundedSyncSpawns('spawnSyncBounded(["true"])')).toBe(0);
});

test("no new synchronous spawn without a timeout in tests/ or scripts/check-*.ts", async () => {
  const found = await scan();
  const added: string[] = [];
  const lowered: string[] = [];
  for (const [file, count] of found) {
    const known = KNOWN_UNBOUNDED[file] ?? 0;
    if (count > known) {
      added.push(`${file}: ${count} unbounded (${known} known)`);
    }
  }
  for (const [file, known] of Object.entries(KNOWN_UNBOUNDED)) {
    const count = found.get(file) ?? 0;
    if (count < known) {
      lowered.push(`${file}: now ${count}, listed as ${known}`);
    }
  }
  expect(
    added,
    "Synchronous spawn without a timeout. Use spawnSyncBounded from tests/helpers/bounded-spawn-sync.ts or pass timeout (HACK-2247)."
  ).toEqual([]);
  expect(
    lowered,
    "Fewer unbounded spawns than listed: lower KNOWN_UNBOUNDED in tests/sync-spawn-bound.test.ts."
  ).toEqual([]);
});
