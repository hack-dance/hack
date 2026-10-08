import { expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeComposeOwnershipOptions } from "../src/lib/native-compose-ownership.ts";
import { exec } from "../src/lib/shell.ts";
import { replayProcessPolicyInitialOwnership } from "./e2e/native-process-policy-initial-replay.ts";
import {
  prepareProcessPolicyInitialTrace,
  processPolicyInitialTraceFormats,
  processPolicyInitialTraceQuery,
  readProcessPolicyInitialTrace,
  type ProcessPolicyInitialTraceQuery,
} from "./e2e/native-process-policy-initial-trace.ts";
import { restoreEnv } from "./helpers/env.ts";

const CANARY = "synthetic-unknown-docker-stdout-stderr-canary";
const id = "c".repeat(64);
const networkId = "d".repeat(64);
const owner = "a".repeat(32);
const generation = "b".repeat(32);
const project = "process-fixture";
const selection: NativeComposeOwnershipOptions = {
  composeProject: project,
  runtimeIdentity: project,
  ownerToken: owner,
  generationIds: [generation],
  expectedServices: ["retry"],
  expectedVolumes: [{ name: "process-fixture_evidence", storage: "evidence" }],
  expectedNetwork: `${project}_default`,
};

function list(kind: "container" | "volume" | "network"): string[] {
  return [kind, "ls", ...(kind === "container" ? ["--all"] : []), ...(kind === "volume" ? [] : ["--no-trunc"]), "--format", processPolicyInitialTraceFormats[kind].list];
}
function inspect(kind: "container" | "volume" | "network"): string[] {
  return [kind, "inspect", "--format", processPolicyInitialTraceFormats[kind].inspect, kind === "volume" ? "process-fixture_evidence" : kind === "container" ? id : networkId];
}

test("initial trace accepts only exact ownership read protocols", () => {
  for (const kind of ["container", "volume", "network"] as const) {
    expect(processPolicyInitialTraceQuery(list(kind))).toEqual({ kind, action: "ls" });
    const args = [kind, "inspect", "--format", processPolicyInitialTraceFormats[kind].inspect, kind === "volume" ? "fixture_evidence" : id];
    expect(processPolicyInitialTraceQuery(args)).toEqual({ kind, action: "inspect" });
    expect(processPolicyInitialTraceQuery([...args, args[4] ?? ""])).toBeNull();
  }
  for (const args of [["inspect", id], ["container", "inspect", "--format", "{{json .Config.Env}}", id], [...list("container"), "--filter", "label=private"], ["container", "rm", id], ["compose", "up", "-d"]]) {
    expect(processPolicyInitialTraceQuery(args)).toBeNull();
  }
});

test("initial forwarding preserves bytes/exits but records no unknown output, args or stderr", async () => {
  const root = await mkdtemp(join(tmpdir(), "process-initial-forwarding-"));
  const previous = process.env.PATH;
  const binary = join(root, "docker");
  const traceRoot = join(root, "trace");
  try {
    await Bun.write(binary, `#!${process.execPath} --no-env-file
const args=process.argv.slice(2); await Bun.sleep(20);
if(args[0]==="compose"){await Bun.write(Bun.stdout,"original compose bytes\\n");await Bun.write(Bun.stderr,${JSON.stringify(CANARY)});process.exit(17);}
if(args[1]==="ls"){await Bun.write(Bun.stdout,"original list bytes\\n");process.exit(0);}
await Bun.write(Bun.stdout,${JSON.stringify(CANARY)});await Bun.write(Bun.stderr,${JSON.stringify(CANARY)});process.exit(23);
`);
    await chmod(binary, 0o700);
    process.env.PATH = root;
    const prepared = await prepareProcessPolicyInitialTrace({ directory: traceRoot });
    const run = async (args: readonly string[]) => await exec([join(traceRoot, "docker"), ...args], { env: { PATH: prepared.path }, stdin: "ignore", timeoutMs: 3000 });
    expect(await run(list("container"))).toEqual({ exitCode: 0, stdout: "original list bytes\n", stderr: "" });
    expect(await run(["compose", "-p", project, "-f", CANARY, "up", "-d"])).toEqual({ exitCode: 17, stdout: "original compose bytes\n", stderr: CANARY });
    expect(await run(["inspect", id, "--format", "{{json .Config.Env}}"])).toEqual({ exitCode: 23, stdout: CANARY, stderr: CANARY });
    expect(await run(list("network"))).toEqual({ exitCode: 0, stdout: "original list bytes\n", stderr: "" });
    const trace = await readProcessPolicyInitialTrace(prepared.directory);
    expect(trace.queries.map((row) => row.args)).toEqual([list("container"), list("network")]);
    expect(BigInt(trace.queries[0]?.startedNs ?? "0") < BigInt(trace.upStartedNs)).toBe(true);
    expect(BigInt(trace.queries[1]?.startedNs ?? "0") > BigInt(trace.upReapedNs)).toBe(true);
    for (const name of await readdir(prepared.directory)) {
      expect(await Bun.file(join(prepared.directory, name)).text()).not.toContain(CANARY);
    }
    const row = trace.queries[0];
    if (!row) { throw new Error("Missing synthetic trace"); }
    await unlink(join(prepared.directory, `${row.token}.json.reap`));
    await expect(readProcessPolicyInitialTrace(prepared.directory)).rejects.toThrow();
  } finally {
    restoreEnv("PATH", previous);
    await rm(root, { recursive: true, force: true });
  }
});

test("trace replay exposes startup vs strict ownership without accepting a truncated or changed protocol", async () => {
  const root = await mkdtemp(join(tmpdir(), "process-initial-replay-"));
  const container = { id, name: `/${project}-retry-1`, project, version: "1", instance: project, owner, generation, service: "retry", oneoff: "False", state: "restarting", exitCode: 17, health: null, networks: { [`${project}_default`]: { NetworkID: networkId, Aliases: [`${project}-retry-1`, "retry"] } } };
  const network = { id: networkId, name: `${project}_default`, project, version: "1", instance: project, owner, driver: "bridge", internal: false, containers: {} };
  const volume = { id: "process-fixture_evidence", name: "process-fixture_evidence", project, version: "1", instance: project, owner, storage: "evidence", createdAt: "2026-10-08T12:00:00Z" };
  const volumeList = JSON.stringify({ id: volume.id, name: volume.name, project });
  const calls: [string[], string][] = [
    [list("container"), JSON.stringify({ id, name: `${project}-retry-1`, project })],
    [inspect("container"), JSON.stringify(container)],
    [list("volume"), volumeList],
    [inspect("volume"), JSON.stringify(volume)],
    [list("network"), JSON.stringify({ id: networkId, name: `${project}_default`, project })],
    [inspect("network"), JSON.stringify(network)],
    [inspect("container"), JSON.stringify(container)],
    [inspect("volume"), JSON.stringify(volume)],
    [inspect("network"), JSON.stringify(network)],
    [list("container"), JSON.stringify({ id, name: `${project}-retry-1`, project })],
    [list("volume"), volumeList],
    [list("network"), JSON.stringify({ id: networkId, name: `${project}_default`, project })],
  ];
  const queries: ProcessPolicyInitialTraceQuery[] = calls.map(([args, stdout], index) => ({ token: index.toString(16).padStart(32, "0"), startedAt: index, startedNs: String(index), reapedAt: index + 1, args, stdout, exitCode: 0 }));
  try {
    const startup = await replayProcessPolicyInitialOwnership({ directory: join(root, "startup"), queries, selection, mode: "startup" });
    expect(startup).toEqual({ outcome: "unready", code: null, consumed: calls.length, protocolMatched: true });
    const strict = await replayProcessPolicyInitialOwnership({ directory: join(root, "strict"), queries, selection, mode: "strict" });
    expect(strict).toEqual({ outcome: "refused", code: "E_NATIVE_COMPOSE_OWNERSHIP", consumed: 6, protocolMatched: true });
    expect(JSON.stringify({ startup, strict })).not.toContain(owner);
    expect(JSON.stringify({ startup, strict })).not.toContain(id);
    const missing = await replayProcessPolicyInitialOwnership({ directory: join(root, "missing"), queries: queries.slice(0, 1), selection, mode: "startup" });
    expect(missing.protocolMatched).toBe(false);
    expect(missing.outcome).toBe("refused");
    const first = queries[0];
    if (!first) { throw new Error("Missing synthetic query"); }
    const changed = await replayProcessPolicyInitialOwnership({ directory: join(root, "changed"), queries: [{ ...first, args: ["inspect", CANARY] }], selection, mode: "startup" });
    expect(changed.protocolMatched).toBe(false);
    expect(changed.outcome).toBe("refused");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
