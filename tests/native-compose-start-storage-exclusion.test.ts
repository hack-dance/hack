import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture, invoke } from "./helpers/native-compose-command.ts";

const START_BUDGET_MS = 3000;
// Longer than the whole start budget, far below the per-carrier storage budget.
const GUARD_CARRIER_DELAY_MS = 4000;

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

// Failure injection on the real source CLI: only the pre-spawn guard's storage
// carrier is slowed. The stand-in reads the CLI's own phase trace (written
// synchronously to its stderr file before the carrier spawns Docker) and delays
// a carrier dependency check (helper `image inspect`) only while a
// `guard.storage` span is open. Enrollment and finalization proofs are not
// delayed. Without the start deadline's storage exclusion, the guard alone
// would spend the start budget and the workload would never be admitted.
test("a pre-spawn guard storage proof longer than the start budget does not consume it", async () => {
  const root = await fixture("", false, {
    noHooks: true,
    storage: { data: { kind: "persistent", scope: "worktree" } },
  });
  const stderrFile = join(root, "cli-stderr");
  const docker = join(root, "docker");
  const source = await readFile(docker, "utf8");
  const anchor = "const args=process.argv.slice(2);";
  expect(source.includes(anchor)).toBe(true);
  await writeFile(
    docker,
    source.replace(
      anchor,
      `${anchor}
if(args[0]==="image"&&args[1]==="inspect"&&await Bun.file(${JSON.stringify(stderrFile)}).exists()){
 const open=new Map();
 for(const line of (await Bun.file(${JSON.stringify(stderrFile)}).text()).split("\\n")){
  if(!line.startsWith('{"diagnostic":"native-compose-phase",'))continue;
  const row=JSON.parse(line);if(row.boundary==="begin")open.set(row.span,row.phase);else open.delete(row.span);
 }
 if([...open.values()].includes("guard.storage")){await appendFile(root+"/guard-carrier-delays","1\\n");await Bun.sleep(${GUARD_CARRIER_DELAY_MS});}
}`
    )
  );
  const result = await invoke(
    root,
    ["up", "--detach", "--json"],
    START_BUDGET_MS,
    240_000,
    { HACK_NATIVE_COMPOSE_PHASE_TRACE: "1" },
    { stderrFile }
  );
  const delays = (
    await readFile(join(root, "guard-carrier-delays"), "utf8").catch(() => "")
  )
    .split("\n")
    .filter(Boolean).length;
  expect(delays).toBeGreaterThanOrEqual(1);
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
