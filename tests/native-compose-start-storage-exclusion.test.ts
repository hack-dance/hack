import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture, invoke } from "./helpers/native-compose-command.ts";

const START_BUDGET_MS = 3000;
// Longer than the whole start budget, far below the per-carrier storage budget.
const GUARD_CARRIER_DELAY_MS = 4000;
// Longer than the whole start budget, far below the storage exclusion cap.
const GUARD_FRESHNESS_DELAY_MS = 4000;
const STORAGE_BUDGET_MS = 120_000;

function phaseRows(text: string) {
  return text
    .split("\n")
    .filter((line) => line.startsWith('{"diagnostic":"native-compose-phase",'))
    .map(
      (line) =>
        JSON.parse(line) as {
          readonly phase: string;
          readonly boundary: string;
          readonly durationMs: number | null;
        }
    );
}

/**
 * Stand-in source that sets `guardStorageOpen` from the CLI's own phase trace,
 * which the CLI writes synchronously to its stderr file before any stand-in it
 * spawns runs: true only while a `guard.storage` span is open.
 */
function guardStorageOpenSource(stderrFile: string): string {
  return `let guardStorageOpen=false;
if(await Bun.file(${JSON.stringify(stderrFile)}).exists()){
 const open=new Map();
 for(const line of (await Bun.file(${JSON.stringify(stderrFile)}).text()).split("\\n")){
  if(!line.startsWith('{"diagnostic":"native-compose-phase",'))continue;
  const row=JSON.parse(line);if(row.boundary==="begin")open.set(row.span,row.phase);else open.delete(row.span);
 }
 guardStorageOpen=[...open.values()].includes("guard.storage");
}`;
}

async function injectAfter(opts: {
  readonly file: string;
  readonly anchor: string;
  readonly source: string;
}) {
  const text = await readFile(opts.file, "utf8");
  expect(text.includes(opts.anchor)).toBe(true);
  await writeFile(
    opts.file,
    text.replace(opts.anchor, `${opts.anchor}\n${opts.source}`)
  );
}

async function countLines(file: string) {
  return (await readFile(file, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean).length;
}

// Failure injection on the real source CLI: only the pre-spawn guard's storage
// carrier is slowed. The Docker stand-in delays a carrier dependency check
// (helper `image inspect`) only while a `guard.storage` span is open.
// Enrollment and finalization proofs are not delayed. Without the start
// deadline's storage exclusion, the guard alone would spend the start budget
// and the workload would never be admitted.
test("a pre-spawn guard storage proof longer than the start budget does not consume it", async () => {
  const root = await fixture("", false, {
    noHooks: true,
    storage: { data: { kind: "persistent", scope: "worktree" } },
  });
  const stderrFile = join(root, "cli-stderr");
  await injectAfter({
    file: join(root, "docker"),
    anchor: "const args=process.argv.slice(2);",
    source: `if(args[0]==="image"&&args[1]==="inspect"){
${guardStorageOpenSource(stderrFile)}
 if(guardStorageOpen){await appendFile(root+"/guard-carrier-delays","1\\n");await Bun.sleep(${GUARD_CARRIER_DELAY_MS});}
}`,
  });
  const result = await invoke(
    root,
    ["up", "--detach", "--json"],
    START_BUDGET_MS,
    240_000,
    { HACK_NATIVE_COMPOSE_PHASE_TRACE: "1" },
    { stderrFile }
  );
  expect(
    await countLines(join(root, "guard-carrier-delays"))
  ).toBeGreaterThanOrEqual(1);
  // The delayed guard storage proof outlasted the whole start budget.
  const guard = phaseRows(result.stderr).filter(
    (row) => row.phase === "guard.storage" && row.boundary === "end"
  );
  expect(guard.length).toBeGreaterThanOrEqual(1);
  expect(guard[0]?.durationMs ?? 0).toBeGreaterThan(START_BUDGET_MS);
  // The workload was still admitted and started within its own start budget.
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    data: { status: "ready" },
  });
  expect(
    (await readFile(join(root, "storage-events"), "utf8")).split("\n")
  ).toContain("workload");
}, 300_000);

// The converse wiring check: only carrier proofs are excluded, so the guard
// storage proof's own freshness check (outside every carrier span) still
// consumes the start budget. The compiler stand-in, which that freshness check
// re-runs, is slowed once, only while a `guard.storage` span is open. If the
// guard's whole storage proof were excluded again, this delay would extend the
// deadline and the workload would start.
test("a pre-spawn guard storage freshness check longer than the start budget consumes it", async () => {
  const root = await fixture("", false, {
    noHooks: true,
    storage: { data: { kind: "persistent", scope: "worktree" } },
  });
  const stderrFile = join(root, "cli-stderr");
  const delays = join(root, "guard-freshness-delays");
  await injectAfter({
    file: join(root, "compiler"),
    anchor: 'import {createHash} from "node:crypto";',
    source: `${guardStorageOpenSource(stderrFile)}
if(guardStorageOpen&&!(await Bun.file(${JSON.stringify(delays)}).exists())){await Bun.write(${JSON.stringify(delays)},"1\\n");await Bun.sleep(${GUARD_FRESHNESS_DELAY_MS});}`,
  });
  const result = await invoke(
    root,
    ["up", "--detach", "--json"],
    START_BUDGET_MS,
    240_000,
    {
      HACK_NATIVE_COMPOSE_PHASE_TRACE: "1",
      // A slow shared host must not exhaust enrollment's carrier first.
      HACK_NATIVE_STORAGE_TIMEOUT_MS: String(STORAGE_BUDGET_MS),
    },
    { stderrFile }
  );
  expect(await countLines(delays)).toBe(1);
  const guard = phaseRows(result.stderr).filter(
    (row) => row.phase === "guard.storage" && row.boundary === "end"
  );
  expect(guard.length).toBeGreaterThanOrEqual(1);
  expect(guard[0]?.durationMs ?? 0).toBeGreaterThan(START_BUDGET_MS);
  // The start budget ran out, so the owned child's admission check after the
  // guard refused before the workload was spawned.
  expect(result.code).not.toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    error: {
      detail: {
        native_compose_effect_refusal: {
          stage: "compose-child",
          reason: "private-uncertain",
        },
      },
    },
  });
  expect(
    (await readFile(join(root, "storage-events"), "utf8")).split("\n")
  ).not.toContain("workload");
}, 300_000);
