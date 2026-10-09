import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nativeFileBindExperimentProgram,
  readBindExperiment,
  selectBindExperimentNonowner,
} from "./e2e/native-file-bind-experiment.ts";
import { runNativeFileFixtureCommand } from "./e2e/native-file-permission-command.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});
const input = ["0400", "0600"].map((mode, slot) => ({
  slot,
  target: `/synthetic-unpublished-target-${slot}`,
  mode,
  bytes: [81, 82, 83],
}));

async function observe(
  opts: {
    readonly uid?: number;
    readonly owner?: number;
    readonly read?: "success" | "EACCES" | "ENOENT";
    readonly write?: "EROFS" | "success" | "EACCES";
    readonly requestWrite?: boolean;
  } = {}
) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "bind-experiment-"))
  );
  directories.push(directory);
  const original = 'import {lstat,readFile,writeFile} from "node:fs/promises";';
  const replacement =
    'import {lstat,readFile,writeFile} from "./observations.mjs";';
  expect(nativeFileBindExperimentProgram.split(original)).toHaveLength(2);
  const program = nativeFileBindExperimentProgram.replace(
    original,
    replacement
  );
  expect(program.replace(replacement, original)).toBe(
    nativeFileBindExperimentProgram
  );
  const selected = {
    uid: opts.uid ?? 65_534,
    owner: opts.owner ?? 0,
    read: opts.read ?? "EACCES",
    write: opts.write ?? "EROFS",
  };
  await writeFile(
    join(directory, "observations.mjs"),
    `
const selected=${JSON.stringify(selected)},input=${JSON.stringify(input)};
let stats=0,reads=0,writes=0;
process.on("exit",()=>process.stderr.write(JSON.stringify({stats,reads,writes})));
Object.defineProperty(process,"getuid",{value:()=>selected.uid});
function row(target){const found=input.find(row=>row.target===target);if(!found)throw new Error("Unexpected synthetic path");return found}
export async function lstat(target){const value=row(target);stats++;return{isFile:()=>true,isSymbolicLink:()=>false,dev:123,ino:value.slot+456,uid:selected.owner,gid:0,mode:0o100000|Number.parseInt(value.mode,8),size:3}}
export async function readFile(target){row(target);reads++;if(selected.read!=="success")throw Object.assign(new Error("Synthetic refusal"),{code:selected.read});return Uint8Array.from([81,82,83])}
export async function writeFile(target){row(target);writes++;if(selected.write!=="success")throw Object.assign(new Error("Synthetic refusal"),{code:selected.write})}
`,
    { flag: "wx", mode: 0o600 }
  );
  const path = join(directory, "program.mjs");
  await writeFile(path, program, { flag: "wx", mode: 0o600 });
  const result = await runNativeFileFixtureCommand({
    argv: [process.execPath, "--no-env-file", path],
    cwd: directory,
    env: {},
    timeoutMs: 2000,
    stdin: Buffer.from(
      JSON.stringify({ rows: input, write: opts.requestWrite ?? false })
    ),
  });
  expect(result.exitCode).toBe(0);
  for (const value of [
    input[0]!.target,
    '"uid"',
    '"gid"',
    '"dev"',
    '"ino"',
    "81,82,83",
  ]) {
    expect(result.stdout).not.toContain(value);
  }
  return { result, observation: readBindExperiment(result.stdout, [0, 1]) };
}

test("owner-is-observer metadata still reaches the actual synthetic read", async () => {
  const { result, observation } = await observe({
    owner: 65_534,
    read: "success",
  });
  expect(
    observation.rows.map((row) => [
      row.owner,
      row.ownerIsSelf,
      row.read,
      row.bytesMatched,
    ])
  ).toEqual([
    ["selected-a", true, "success", true],
    ["selected-a", true, "success", true],
  ]);
  expect(JSON.parse(result.stderr)).toEqual({ stats: 4, reads: 2, writes: 0 });
});
test("actual EACCES remains distinct from owner metadata", async () => {
  const { result, observation } = await observe({ read: "EACCES" });
  expect(
    observation.rows.map((row) => [
      row.owner,
      row.ownerIsSelf,
      row.read,
      row.bytesMatched,
    ])
  ).toEqual([
    ["root", false, "EACCES", null],
    ["root", false, "EACCES", null],
  ]);
  expect(JSON.parse(result.stderr)).toEqual({ stats: 4, reads: 2, writes: 0 });
});
test("unexpected read refusal is unknown, never EACCES", async () => {
  const { observation } = await observe({ read: "ENOENT" });
  expect(observation.rows.map((row) => row.read)).toEqual([
    "unknown",
    "unknown",
  ]);
});
test.each([
  "EROFS",
  "success",
  "EACCES",
] as const)("privileged write result %s is recorded exactly", async (write) => {
  const { result, observation } = await observe({
    uid: 0,
    read: "success",
    write,
    requestWrite: true,
  });
  expect(observation.rows.map((row) => row.write)).toEqual([
    write === "EACCES" ? "unknown" : write,
    write === "EACCES" ? "unknown" : write,
  ]);
  expect(JSON.parse(result.stderr)).toEqual({ stats: 4, reads: 2, writes: 2 });
});
test("nonowner selection excludes every root-observed owner and refuses both occupied candidates", async () => {
  const { observation } = await observe({
    uid: 0,
    owner: 65_534,
    read: "success",
  });
  expect(selectBindExperimentNonowner(observation.rows)).toBe(65_533);
  expect(() =>
    selectBindExperimentNonowner([
      observation.rows[0]!,
      { ...observation.rows[1]!, owner: "selected-b" },
    ])
  ).toThrow();
});
test("closed result codec refuses malformed and forged success facts", async () => {
  const { result } = await observe();
  const value = JSON.parse(result.stdout);
  for (const change of [
    { read: "allowed" },
    { bytesMatched: true },
    { identity: "raw-stat" },
    { slot: 9 },
    { extra: "untrusted" },
  ]) {
    const changed = {
      ...value,
      rows: [{ ...value.rows[0], ...change }, value.rows[1]],
    };
    expect(() => readBindExperiment(JSON.stringify(changed), [0, 1])).toThrow();
  }
  expect(() => readBindExperiment("{}", [0, 1])).toThrow();
});
