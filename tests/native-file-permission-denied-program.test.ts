import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNativeFileFixtureCommand } from "./e2e/native-file-permission-command.ts";
import { nativeFileFixtureDeniedProgram } from "./e2e/native-file-permission-guest.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

const row = {
  target: "/synthetic-private-target",
  mode: "0400",
  uid: 2001,
  gid: 2002,
};
const info = { mode: 0o10_0400, uid: row.uid, gid: row.gid };
type Observation = {
  readonly row?: typeof row;
  readonly info?: typeof info;
  readonly observerUid?: number;
  readonly readOutcome?: "EACCES" | "ENOENT" | "allowed";
  readonly forbidModeRead?: boolean;
  readonly forbidGidRead?: boolean;
};

/** Execute the emitted body with only its filesystem import redirected to an owned synthetic module. */
async function observe(opts: Observation = {}) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "denied-program-"))
  );
  directories.push(directory);
  const programPath = join(directory, "guest.mjs");
  const realImport = 'import {lstat,readFile} from "node:fs/promises";';
  const syntheticImport = 'import {lstat,readFile} from "./observation.mjs";';
  expect(nativeFileFixtureDeniedProgram.split(realImport)).toHaveLength(2);
  const syntheticProgram = nativeFileFixtureDeniedProgram.replace(
    realImport,
    syntheticImport
  );
  expect(syntheticProgram.replace(syntheticImport, realImport)).toBe(
    nativeFileFixtureDeniedProgram
  );
  await writeFile(programPath, syntheticProgram, {
    flag: "wx",
    mode: 0o600,
  });
  const selected = {
    row: opts.row ?? row,
    info: opts.info ?? info,
    observerUid: opts.observerUid ?? 3001,
    readOutcome: opts.readOutcome ?? "EACCES",
    forbidModeRead: opts.forbidModeRead ?? false,
    forbidGidRead: opts.forbidGidRead ?? false,
  };
  const observation = `
const selected=${JSON.stringify(selected)};
let statCalls=0,readCalls=0,forbiddenReads=0;
process.on("exit",()=>process.stderr.write(JSON.stringify({statCalls,readCalls,forbiddenReads})));
Object.defineProperty(process,"getuid",{value:()=>selected.observerUid});
if(selected.forbidModeRead)Object.defineProperty(selected.info,"mode",{get(){forbiddenReads++;throw new Error("Later metadata access refused")}});
if(selected.forbidGidRead)Object.defineProperty(selected.info,"gid",{get(){forbiddenReads++;throw new Error("Later metadata access refused")}});
export async function lstat(target){if(target!==selected.row.target)throw new Error("Unexpected synthetic target");statCalls++;return selected.info}
export async function readFile(target){if(target!==selected.row.target)throw new Error("Unexpected synthetic target");readCalls++;if(selected.readOutcome!=="allowed")throw Object.assign(new Error("Synthetic read refused"),{code:selected.readOutcome});return new Uint8Array()}
`;
  await writeFile(join(directory, "observation.mjs"), observation, {
    flag: "wx",
    mode: 0o600,
  });
  return runNativeFileFixtureCommand({
    argv: [process.execPath, "--no-env-file", programPath],
    cwd: directory,
    env: {},
    stdin: Buffer.from(JSON.stringify([selected.row])),
    timeoutMs: 2000,
  });
}

test.each([
  ["protected-mode", { row: { ...row, mode: "0444" }, forbidModeRead: true }],
  ["mode", { info: { ...info, mode: 0o10_0600, uid: 9001, gid: 9002 } }],
  [
    "owner-uid-other",
    { info: { ...info, uid: 9001, gid: 9002 }, forbidGidRead: true },
  ],
  [
    "owner-uid-is-observer",
    {
      info: { ...info, uid: 3001, gid: 9002 },
      observerUid: 3001,
      forbidGidRead: true,
    },
  ],
  ["owner-gid", { info: { ...info, gid: 9002 }, observerUid: row.uid }],
  ["nonowner-uid", { observerUid: row.uid }],
] as const)("nonowner metadata refuses at the first %s guard without reading content", async (guard, observation) => {
  const result = await observe(observation);
  expect(result.exitCode).toBe(52);
  expect(result.stdout).toBe(
    JSON.stringify({ version: 1, stage: "nonowner-metadata-refused", guard })
  );
  expect(JSON.parse(result.stderr)).toEqual({
    statCalls: 1,
    readCalls: 0,
    forbiddenReads: 0,
  });
  expect(result.stdout).not.toContain(row.target);
  expect(result.stdout).not.toContain(String(row.uid));
  expect(result.stdout).not.toContain(String(row.gid));
});

test.each([
  "0400",
  "0600",
])("nonowner %s read still requires actual EACCES", async (mode) => {
  const result = await observe({
    row: { ...row, mode },
    info: { ...info, mode: 0o10_0000 | Number.parseInt(mode, 8) },
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("exact-nonowner-read-refused");
  expect(JSON.parse(result.stderr)).toEqual({
    statCalls: 1,
    readCalls: 1,
    forbiddenReads: 0,
  });
});

test.each([
  ["allowed", 53],
  ["ENOENT", 54],
] as const)("nonowner read outcome %s remains refused", async (readOutcome, exitCode) => {
  const result = await observe({ readOutcome });
  expect(result.exitCode).toBe(exitCode);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr)).toEqual({
    statCalls: 1,
    readCalls: 1,
    forbiddenReads: 0,
  });
});

test("root observer still refuses before metadata or content access", async () => {
  const result = await observe({ observerUid: 0 });
  expect(result.exitCode).toBe(51);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr)).toEqual({
    statCalls: 0,
    readCalls: 0,
    forbiddenReads: 0,
  });
});
