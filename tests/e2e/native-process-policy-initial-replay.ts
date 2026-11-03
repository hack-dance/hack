import { chmod, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../../src/lib/guards.ts";
import { openNativeComposeGenerationStore } from "../../src/lib/native-compose-generation.ts";
import { readNativeComposeNetworkTopology } from "../../src/lib/native-compose-network-topology.ts";
import type {
  NativeComposeOwnershipOptions,
  NativeComposeOwnershipRefusal,
  NativeComposeTopologyPredicate,
} from "../../src/lib/native-compose-ownership.ts";
import { isNativeComposeTopologyPredicate } from "../../src/lib/native-compose-ownership.ts";
import { exec } from "../../src/lib/shell.ts";
import { testBudgetMs } from "../helpers/test-budget.ts";
import {
  type ProcessPolicyInitialTraceQuery,
  readProcessPolicyInitialTrace,
} from "./native-process-policy-initial-trace.ts";
import {
  classifyProcessPolicyMemberKeys,
  type ProcessPolicyMemberKeyClasses,
} from "./native-process-policy-startup-diagnostic.ts";

const REFUSAL = "Initial process-policy replay unavailable; values omitted";
/**
 * Aggregate probe bound the replayed ownership policy runs with, unless the
 * recorded selection names one: the largest the policy accepts. One query
 * spawns a stub engine per recorded reply under a single clock, 15 s by
 * default. The replay classifies recorded replies and never tests that clock;
 * at the default, a 36-worker churn (load 100-120) expired it
 * (`E_NATIVE_COMPOSE_PROBE_TIMEOUT`) and changed the replayed outcome.
 */
const REPLAY_PROBE_BUDGET_MS = 60_000;
/**
 * Harness budget for one replay child: a fresh Bun process that transpiles the
 * ownership policy and spawns one stub engine per recorded reply. It outlasts
 * the policy's own probe bound inside it. A fixed 5 s refused replays on
 * loaded hosts.
 */
const REPLAY_CHILD_BUDGET_MS = Math.max(
  testBudgetMs(5000),
  REPLAY_PROBE_BUDGET_MS + 10_000
);
/** Harness budget for every replay child of one trace summary together. */
const REPLAY_SUMMARY_BUDGET_MS = testBudgetMs(30_000);
const SERVICES = ["forced", "graceful", "reaper", "retry"] as const;
const CODES = [
  "E_NATIVE_COMPOSE_OWNERSHIP",
  "E_NATIVE_COMPOSE_PROBE",
  "E_NATIVE_COMPOSE_PROBE_TIMEOUT",
  "E_NATIVE_COMPOSE_PROBE_BUDGET",
  "E_NATIVE_COMPOSE_PROBE_CANCELLED",
] as const;
type Replay = {
  readonly outcome: "owned" | "unready" | "refused";
  readonly code: (typeof CODES)[number] | null;
  /** First replayed ownership predicate only; absent for success or unclassified probe errors. */
  readonly reason: NativeComposeOwnershipRefusal | null;
  readonly topologyPredicate: NativeComposeTopologyPredicate | null;
  readonly consumed: number;
  readonly protocolMatched: boolean;
  /** Member-key classes of the last consumed network reply (what `network-member-id` saw); null when none was consumed. */
  readonly memberKeyClasses: ProcessPolicyMemberKeyClasses | null;
  /** Fixed service names whose last consumed container reply reported state `restarting`. */
  readonly restartingServices: readonly (typeof SERVICES)[number][];
};
function replayCode(value: unknown): value is Replay["code"] {
  return value === null || CODES.some((code) => code === value);
}
function replayReason(value: unknown): value is Replay["reason"] {
  return (
    value === null ||
    value === "resource-label" ||
    value === "generation" ||
    value === "state" ||
    value === "volume-birth" ||
    value === "bridge-policy" ||
    value === "topology" ||
    value === "endpoint" ||
    value === "cross-scan-drift" ||
    value === "unknown"
  );
}

function recordedRows(
  query: ProcessPolicyInitialTraceQuery | undefined
): Record<string, unknown>[] {
  if (!query || query.stdout.length > 65_536) {
    return [];
  }
  const lines = query.stdout.trim() ? query.stdout.trim().split("\n") : [];
  if (lines.length > 64) {
    return [];
  }
  return lines.flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line);
      return isRecord(value) ? [value] : [];
    } catch {
      return [];
    }
  });
}
function lastConsumed(
  queries: readonly ProcessPolicyInitialTraceQuery[],
  kind: "container" | "network"
): ProcessPolicyInitialTraceQuery | undefined {
  for (let index = queries.length - 1; index >= 0; index--) {
    const query = queries[index];
    if (query && query.args[0] === kind && query.args[1] === "inspect") {
      return query;
    }
  }
  return undefined;
}
/** Counts and fixed service names from the consumed recorded replies only; no key, id or label value leaves this function. */
export function summarizeConsumedProcessPolicyReplies(
  queries: readonly ProcessPolicyInitialTraceQuery[],
  consumed: number
): Pick<Replay, "memberKeyClasses" | "restartingServices"> {
  const window = queries.slice(
    0,
    Math.max(0, Math.min(consumed, queries.length))
  );
  const network = lastConsumed(window, "network");
  const container = lastConsumed(window, "container");
  const keys = recordedRows(network).flatMap((row) =>
    isRecord(row.containers) ? Object.keys(row.containers) : []
  );
  const restarting = new Set(
    recordedRows(container)
      .filter((row) => row.state === "restarting")
      .map((row) => row.service)
  );
  return {
    memberKeyClasses: network ? classifyProcessPolicyMemberKeys(keys) : null,
    restartingServices: SERVICES.filter((service) => restarting.has(service)),
  };
}

const REPLAY_CALLS = {
  startup: 'await observeNativeComposeStartupOwned(selection,["retry"])',
  settled:
    'await observeNativeComposeStartupOwned(selection,["retry"],{membership:"settled"})',
  strict: "await assertNativeComposeOwned(selection)",
} as const;

/** Run the real ownership policy against original recorded replies, with no engine access. */
export async function replayProcessPolicyInitialOwnership(opts: {
  readonly directory: string;
  readonly queries: readonly ProcessPolicyInitialTraceQuery[];
  readonly selection: NativeComposeOwnershipOptions;
  /** `settled` is the startup check after the readiness deadline: no transient running-member admission. */
  readonly mode: "settled" | "startup" | "strict";
  readonly timeoutMs?: number;
}): Promise<Replay> {
  await mkdir(opts.directory, { mode: 0o700 });
  const inputs = join(opts.directory, "input.json");
  const handle = await open(inputs, "wx", 0o600);
  try {
    await handle.writeFile(
      JSON.stringify({ queries: opts.queries, selection: opts.selection })
    );
  } finally {
    await handle.close();
  }
  const cursor = join(opts.directory, "cursor");
  const mismatch = join(opts.directory, "mismatch");
  const docker = join(opts.directory, "docker");
  await Bun.write(
    docker,
    `#!${process.execPath} --no-env-file
import {readFileSync,writeFileSync,existsSync} from "node:fs";
const input=JSON.parse(readFileSync(${JSON.stringify(inputs)},"utf8"));
const path=${JSON.stringify(cursor)};
const index=existsSync(path)?Number(readFileSync(path,"utf8")):0;
const row=input.queries[index];
if(!row||JSON.stringify(process.argv.slice(2))!==JSON.stringify(row.args)){writeFileSync(${JSON.stringify(mismatch)},"refused");process.exit(99);}
writeFileSync(path,String(index+1));
await Bun.write(Bun.stdout,row.stdout);process.exit(row.exitCode);
`
  );
  await chmod(docker, 0o700);
  const program = `
import {assertNativeComposeOwned,observeNativeComposeStartupOwned,NativeComposeOwnershipError,nativeComposeOwnershipRefusal,nativeComposeTopologyPredicate} from ${JSON.stringify(join(import.meta.dir, "../../src/lib/native-compose-ownership.ts"))};
const {selection:recorded}=await Bun.file(${JSON.stringify(inputs)}).json();
const selection={timeoutMs:${REPLAY_PROBE_BUDGET_MS},...recorded};
let outcome="refused",code=null,reason=null,topologyPredicate=null;
try {const value=${REPLAY_CALLS[opts.mode]};outcome=value===null?"unready":"owned";}
catch(error){code=error instanceof NativeComposeOwnershipError?error.code:null;reason=nativeComposeOwnershipRefusal(error)??null;topologyPredicate=nativeComposeTopologyPredicate(error)??null;}
const consumed=(await Bun.file(${JSON.stringify(cursor)}).exists())?Number(await Bun.file(${JSON.stringify(cursor)}).text()):0;
process.stdout.write(JSON.stringify({outcome,code,reason,topologyPredicate,consumed,protocolMatched:!(await Bun.file(${JSON.stringify(mismatch)}).exists())}));
`;
  const result = await exec(
    [process.execPath, "--no-env-file", "-e", program],
    {
      cwd: opts.directory,
      env: { PATH: opts.directory },
      stdin: "ignore",
      timeoutMs: opts.timeoutMs ?? REPLAY_CHILD_BUDGET_MS,
    }
  );
  if (result.exitCode !== 0 || result.stdout.length > 1024) {
    throw new Error(REFUSAL);
  }
  const value: unknown = JSON.parse(result.stdout);
  if (
    !(
      isRecord(value) &&
      (value.outcome === "owned" ||
        value.outcome === "unready" ||
        value.outcome === "refused") &&
      replayCode(value.code) &&
      replayReason(value.reason) &&
      (value.topologyPredicate === null ||
        isNativeComposeTopologyPredicate(value.topologyPredicate)) &&
      (value.topologyPredicate === null ||
        (value.code === "E_NATIVE_COMPOSE_OWNERSHIP" &&
          value.reason === "topology" &&
          value.outcome === "refused")) &&
      (value.outcome === "refused" || value.reason === null) &&
      (value.code === "E_NATIVE_COMPOSE_OWNERSHIP" || value.reason === null) &&
      Number.isInteger(value.consumed) &&
      typeof value.consumed === "number" &&
      value.consumed >= 0 &&
      value.consumed <= opts.queries.length &&
      typeof value.protocolMatched === "boolean"
    )
  ) {
    throw new Error(REFUSAL);
  }
  return {
    outcome: value.outcome,
    code: value.code,
    reason: value.reason,
    topologyPredicate: value.topologyPredicate,
    consumed: value.consumed,
    protocolMatched: value.protocolMatched,
    ...summarizeConsumedProcessPolicyReplies(opts.queries, value.consumed),
  };
}

/** A replay describes the captured protocol/policies, never a guessed original caller or future authority. */
export async function summarizeProcessPolicyInitialTrace(opts: {
  readonly directory: string;
  readonly projectRoot: string;
  readonly replayRoot: string;
}) {
  const deadline = Date.now() + REPLAY_SUMMARY_BUDGET_MS;
  const remaining = (): number => {
    const budget = Math.floor(deadline - Date.now());
    if (budget <= 0) {
      throw new Error(REFUSAL);
    }
    return Math.min(budget, REPLAY_CHILD_BUDGET_MS);
  };
  const trace = await readProcessPolicyInitialTrace(opts.directory);
  const store = await openNativeComposeGenerationStore({
    projectRoot: opts.projectRoot,
    instance: null,
    mode: "saved",
  });
  try {
    const before = await store.loadCurrent();
    const generation = await store.loadPending();
    if (
      !(
        before.pending?.operation === "up" &&
        generation &&
        before.pending.generationId === generation.generationId
      )
    ) {
      throw new Error(REFUSAL);
    }
    const document = await store.readGenerationDocument(generation);
    if (
      !(
        isRecord(document.services) &&
        JSON.stringify(Object.keys(document.services).sort()) ===
          JSON.stringify(SERVICES) &&
        isRecord(document.volumes) &&
        Object.keys(document.volumes).length === 1 &&
        generation.profiles.length === 1 &&
        generation.profiles[0] === "exercise"
      )
    ) {
      throw new Error(REFUSAL);
    }
    const topology = readNativeComposeNetworkTopology(document, store.identity);
    if (
      topology.networks.length !== 1 ||
      topology.networks[0]?.name !==
        `${store.identity.composeProject}_default` ||
      topology.networks[0]?.internal !== false
    ) {
      throw new Error(REFUSAL);
    }
    const expectedVolumes = Object.entries(document.volumes).map(
      ([storage, volume]) => {
        if (
          !(
            storage === "evidence" &&
            isRecord(volume) &&
            typeof volume.name === "string"
          )
        ) {
          throw new Error(REFUSAL);
        }
        return { storage, name: volume.name };
      }
    );
    const selection: NativeComposeOwnershipOptions = {
      composeProject: store.identity.composeProject,
      runtimeIdentity: store.identity.composeProject,
      ownerToken: store.identity.ownerToken,
      generationIds: [generation.generationId],
      expectedServices: [...SERVICES],
      expectedVolumes,
      expectedNetworks: topology.networks,
      expectedWorkloadNetworks: topology.workloads.map((workload) => ({
        generationId: generation.generationId,
        service: workload.service,
        networks: workload.networks.map(({ name, aliases }) => ({
          name,
          aliases,
        })),
      })),
    };
    await mkdir(opts.replayRoot, { mode: 0o700 });
    const observations: {
      index: number;
      phase: "before-compose" | "during-compose" | "after-compose";
      startup: Replay;
      strict: Replay;
    }[] = [];
    let cursor = 0;
    while (cursor < trace.queries.length && observations.length < 64) {
      const first = trace.queries[cursor];
      if (!first || first.args[0] !== "container" || first.args[1] !== "ls") {
        throw new Error(REFUSAL);
      }
      const queries = trace.queries.slice(cursor);
      const index = observations.length;
      const startup = await replayProcessPolicyInitialOwnership({
        directory: join(opts.replayRoot, `${index}-startup`),
        queries,
        selection,
        mode: "startup",
        timeoutMs: remaining(),
      });
      const strict = await replayProcessPolicyInitialOwnership({
        directory: join(opts.replayRoot, `${index}-strict`),
        queries,
        selection,
        mode: "strict",
        timeoutMs: remaining(),
      });
      const phase =
        first.startOrder < trace.upStartOrder
          ? "before-compose"
          : first.startOrder > trace.upReapOrder
            ? "after-compose"
            : "during-compose";
      observations.push({ index, phase, startup, strict });
      // Mismatch/partial tails are evidence gaps, never fabricated completed scans.
      const matched = [startup, strict].filter(
        (value) => value.protocolMatched
      );
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
    return {
      status: "captured" as const,
      replayUsesRecordedReplies: true,
      replaysWallTiming: false,
      originalCallerModeKnown: false,
      queryCount: trace.queries.length,
      consumedQueries: cursor,
      observations,
      complete: cursor === trace.queries.length,
    };
  } finally {
    await store.close();
  }
}

/** Explicit opt-in persists only the first owner-issued refusal from matching after-Compose
 * recorded replies. This cannot identify the original caller mode or timing. */
export async function persistProcessPolicyFirstAfterComposeRefusal(opts: {
  readonly directory: string;
  readonly enabled: string | undefined;
  readonly summary: Awaited<
    ReturnType<typeof summarizeProcessPolicyInitialTrace>
  >;
}) {
  if (opts.enabled !== "1") {
    return null;
  }
  const row = opts.summary.observations.find(
    (observation) =>
      observation.phase === "after-compose" &&
      observation.startup.protocolMatched &&
      observation.strict.protocolMatched &&
      [observation.startup, observation.strict].some(
        (mode) =>
          mode.outcome === "refused" &&
          mode.code === "E_NATIVE_COMPOSE_OWNERSHIP"
      )
  );
  if (!row) {
    return null;
  }
  const capsule = {
    version: 1 as const,
    kind: "native-process-policy-after-compose-replay-refusal" as const,
    observationIndex: row.index,
    replayUsesRecordedReplies: true as const,
    replaysWallTiming: false as const,
    originalCallerModeKnown: false as const,
    startupReason:
      row.startup.code === "E_NATIVE_COMPOSE_OWNERSHIP"
        ? row.startup.reason
        : null,
    strictReason:
      row.strict.code === "E_NATIVE_COMPOSE_OWNERSHIP"
        ? row.strict.reason
        : null,
    startupTopologyPredicate: row.startup.topologyPredicate,
    strictTopologyPredicate: row.strict.topologyPredicate,
    startupMemberKeyClasses: row.startup.memberKeyClasses,
    strictMemberKeyClasses: row.strict.memberKeyClasses,
    startupRestartingServices: row.startup.restartingServices,
    strictRestartingServices: row.strict.restartingServices,
  };
  const handle = await open(
    join(opts.directory, "first-after-compose-replay-refusal.json"),
    "wx",
    0o600
  );
  try {
    await handle.writeFile(`${JSON.stringify(capsule)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return capsule;
}
