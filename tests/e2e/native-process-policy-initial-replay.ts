import { chmod, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../../src/lib/guards.ts";
import { openNativeComposeGenerationStore } from "../../src/lib/native-compose-generation.ts";
import { readNativeComposeNetworkTopology } from "../../src/lib/native-compose-network-topology.ts";
import type { NativeComposeOwnershipOptions } from "../../src/lib/native-compose-ownership.ts";
import { exec } from "../../src/lib/shell.ts";
import { readProcessPolicyInitialTrace, type ProcessPolicyInitialTraceQuery } from "./native-process-policy-initial-trace.ts";

const REFUSAL = "Initial process-policy replay unavailable; values omitted";
const SERVICES = ["forced", "graceful", "reaper", "retry"] as const;
const CODES = ["E_NATIVE_COMPOSE_OWNERSHIP", "E_NATIVE_COMPOSE_PROBE", "E_NATIVE_COMPOSE_PROBE_TIMEOUT", "E_NATIVE_COMPOSE_PROBE_BUDGET", "E_NATIVE_COMPOSE_PROBE_CANCELLED"] as const;
type Replay = {
  readonly outcome: "owned" | "unready" | "refused";
  readonly code: (typeof CODES)[number] | null;
  readonly consumed: number;
  readonly protocolMatched: boolean;
};
function replayCode(value: unknown): value is Replay["code"] {
  return value === null || CODES.some((code) => code === value);
}

/** Run the real ownership policy against original recorded replies, with no engine access. */
export async function replayProcessPolicyInitialOwnership(opts: {
  readonly directory: string;
  readonly queries: readonly ProcessPolicyInitialTraceQuery[];
  readonly selection: NativeComposeOwnershipOptions;
  readonly mode: "startup" | "strict";
  readonly timeoutMs?: number;
}): Promise<Replay> {
  await mkdir(opts.directory, { mode: 0o700 });
  const inputs = join(opts.directory, "input.json");
  const handle = await open(inputs, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify({ queries: opts.queries, selection: opts.selection }));
  } finally {
    await handle.close();
  }
  const cursor = join(opts.directory, "cursor");
  const mismatch = join(opts.directory, "mismatch");
  const docker = join(opts.directory, "docker");
  await Bun.write(docker, `#!${process.execPath} --no-env-file
import {readFileSync,writeFileSync,existsSync} from "node:fs";
const input=JSON.parse(readFileSync(${JSON.stringify(inputs)},"utf8"));
const path=${JSON.stringify(cursor)};
const index=existsSync(path)?Number(readFileSync(path,"utf8")):0;
const row=input.queries[index];
if(!row||JSON.stringify(process.argv.slice(2))!==JSON.stringify(row.args)){writeFileSync(${JSON.stringify(mismatch)},"refused");process.exit(99);}
writeFileSync(path,String(index+1));
await Bun.write(Bun.stdout,row.stdout);process.exit(row.exitCode);
`);
  await chmod(docker, 0o700);
  const program = `
import {assertNativeComposeOwned,observeNativeComposeStartupOwned,NativeComposeOwnershipError} from ${JSON.stringify(join(import.meta.dir, "../../src/lib/native-compose-ownership.ts"))};
const {selection}=await Bun.file(${JSON.stringify(inputs)}).json();
let outcome="refused",code=null;
try {const value=${opts.mode === "startup" ? 'await observeNativeComposeStartupOwned(selection,["retry"])' : "await assertNativeComposeOwned(selection)"};outcome=value===null?"unready":"owned";}
catch(error){code=error instanceof NativeComposeOwnershipError?error.code:null;}
const consumed=(await Bun.file(${JSON.stringify(cursor)}).exists())?Number(await Bun.file(${JSON.stringify(cursor)}).text()):0;
process.stdout.write(JSON.stringify({outcome,code,consumed,protocolMatched:!(await Bun.file(${JSON.stringify(mismatch)}).exists())}));
`;
  const result = await exec([process.execPath, "--no-env-file", "-e", program], { cwd: opts.directory, env: { PATH: opts.directory }, stdin: "ignore", timeoutMs: opts.timeoutMs ?? 5000 });
  if (result.exitCode !== 0 || result.stdout.length > 1024) {
    throw new Error(REFUSAL);
  }
  const value: unknown = JSON.parse(result.stdout);
  if (!(isRecord(value) && (value.outcome === "owned" || value.outcome === "unready" || value.outcome === "refused") && replayCode(value.code) && Number.isInteger(value.consumed) && typeof value.consumed === "number" && value.consumed >= 0 && value.consumed <= opts.queries.length && typeof value.protocolMatched === "boolean")) {
    throw new Error(REFUSAL);
  }
  return { outcome: value.outcome, code: value.code, consumed: value.consumed, protocolMatched: value.protocolMatched };
}

/** A replay describes the captured protocol/policies, never a guessed original caller or future authority. */
export async function summarizeProcessPolicyInitialTrace(opts: {
  readonly directory: string;
  readonly projectRoot: string;
  readonly replayRoot: string;
}) {
  const deadline = Date.now() + 30_000;
  const remaining = (): number => {
    const budget = Math.floor(deadline - Date.now());
    if (budget <= 0) { throw new Error(REFUSAL); }
    return Math.min(budget, 5000);
  };
  const trace = await readProcessPolicyInitialTrace(opts.directory);
  const store = await openNativeComposeGenerationStore({ projectRoot: opts.projectRoot, instance: null, mode: "saved" });
  try {
    const before = await store.loadCurrent();
    const generation = await store.loadPending();
    if (!(before.pending?.operation === "up" && generation && before.pending.generationId === generation.generationId)) {
      throw new Error(REFUSAL);
    }
    const document = await store.readGenerationDocument(generation);
    if (!(isRecord(document.services) && JSON.stringify(Object.keys(document.services).sort()) === JSON.stringify(SERVICES) && isRecord(document.volumes) && Object.keys(document.volumes).length === 1 && generation.profiles.length === 1 && generation.profiles[0] === "exercise")) {
      throw new Error(REFUSAL);
    }
    const topology = readNativeComposeNetworkTopology(document, store.identity);
    if (topology.networks.length !== 1 || topology.networks[0]?.name !== `${store.identity.composeProject}_default` || topology.networks[0]?.internal !== false) {
      throw new Error(REFUSAL);
    }
    const expectedVolumes = Object.entries(document.volumes).map(([storage, volume]) => {
      if (!(storage === "evidence" && isRecord(volume) && typeof volume.name === "string")) {
        throw new Error(REFUSAL);
      }
      return { storage, name: volume.name };
    });
    const selection: NativeComposeOwnershipOptions = {
      composeProject: store.identity.composeProject,
      runtimeIdentity: store.identity.composeProject,
      ownerToken: store.identity.ownerToken,
      generationIds: [generation.generationId],
      expectedServices: [...SERVICES],
      expectedVolumes,
      expectedNetworks: topology.networks,
      expectedWorkloadNetworks: topology.workloads.map((workload) => ({ generationId: generation.generationId, service: workload.service, networks: workload.networks.map(({ name, aliases }) => ({ name, aliases })) })),
    };
    await mkdir(opts.replayRoot, { mode: 0o700 });
    const observations: { index: number; phase: "before-compose" | "during-compose" | "after-compose"; startup: Replay; strict: Replay }[] = [];
    let cursor = 0;
    while (cursor < trace.queries.length && observations.length < 64) {
      const first = trace.queries[cursor];
      if (!first || first.args[0] !== "container" || first.args[1] !== "ls") {
        throw new Error(REFUSAL);
      }
      const queries = trace.queries.slice(cursor);
      const index = observations.length;
      const startup = await replayProcessPolicyInitialOwnership({ directory: join(opts.replayRoot, `${index}-startup`), queries, selection, mode: "startup", timeoutMs: remaining() });
      const strict = await replayProcessPolicyInitialOwnership({ directory: join(opts.replayRoot, `${index}-strict`), queries, selection, mode: "strict", timeoutMs: remaining() });
      const phase = BigInt(first.startedNs) < BigInt(trace.upStartedNs) ? "before-compose" : BigInt(first.startedNs) > BigInt(trace.upReapedNs) ? "after-compose" : "during-compose";
      observations.push({ index, phase, startup, strict });
      // Mismatch/partial tails are evidence gaps, never fabricated completed scans.
      const matched = [startup, strict].filter((value) => value.protocolMatched);
      const consumed = Math.max(0, ...matched.map((value) => value.consumed));
      if (consumed === 0) {
        break;
      }
      cursor += consumed;
    }
    if (JSON.stringify(await store.loadCurrent()) !== JSON.stringify(before)) {
      throw new Error(REFUSAL);
    }
    remaining();
    return { status: "captured" as const, replayUsesRecordedReplies: true, replaysWallTiming: false, originalCallerModeKnown: false, queryCount: trace.queries.length, consumedQueries: cursor, observations, complete: cursor === trace.queries.length };
  } finally {
    await store.close();
  }
}
