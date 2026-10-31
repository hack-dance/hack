import { afterEach, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeComposeEffectRefusal } from "../src/lib/native-compose-effect-diagnostics.ts";
import * as generationOwner from "../src/lib/native-compose-generation.ts";
import { holdDirectory } from "../src/lib/native-compose-private-state.ts";
import {
  beginNativeComposeStorageCarrierIntent,
  initializeNativeComposeStorageCarrierJournal,
} from "../src/lib/native-compose-storage-carrier-journal.ts";
import * as commandRecord from "../src/lib/native-compose-storage-command-record.ts";
import {
  createNativeComposeDockerStorageXattrCarrier,
  nativeComposeStorageCarrierBudgetReason,
} from "../src/lib/native-compose-storage-witness-docker.ts";
import {
  type NativeComposeStorageXattrInvocation,
  type NativeComposeStorageXattrTarget,
  nativeComposeStorageXattrCarrierArtifact,
  nativeComposeStorageXattrCarrierPorts,
} from "../src/lib/native-compose-storage-witness-xattr-carrier.ts";
import { createNativeComposeStorageXattrMarker } from "../src/lib/native-compose-storage-witness-xattr-codec.ts";
import { isolatedDockerClientEnv } from "./helpers/docker-client.ts";
import { restoreEnv } from "./helpers/env.ts";
import { nativeComposeStorageDockerFixtureScript } from "./helpers/native-compose-storage-docker.ts";

/**
 * Pins each saved-binding check of the real Docker storage carrier
 * (`createNativeComposeDockerStorageXattrCarrier`) and its carrier state
 * checks (HACK-1455). The carrier runs in process against the synthetic daemon
 * of `tests/helpers/native-compose-storage-docker.ts`; only the saved material
 * binding is a stand-in. Every binding read answers one fixed binding, except
 * the chosen read, which answers it with another receipt hash, as a receipt
 * publication between two reads would.
 *
 * A carrier step compares its reads with `assertNativeComposeStorageBindingUnchanged`,
 * which refuses as `private-state` at the step's stage. A call site that went
 * back to an untagged `if (!same(before, x)) return refuse();` reports
 * `unclassified` instead, and `storage-budget` once caught after the carrier
 * deadline, which sends an operator to raise the wrong budget.
 *
 * Binding reads are numbered in the order the carrier makes them. The tables
 * name the call site each chosen read reaches; the baseline case pins the total
 * count, so a change to the read order fails there first and the tables must be
 * reviewed with it.
 */

/**
 * Bun budget of one case: one carrier run spawns about forty synthetic
 * `docker` children (a Bun process each) plus host `ps` reads. A hosted run
 * takes a few seconds; a host loaded far beyond its CPU count took 30-40 s, so
 * this is a hang guard, not a speed assertion.
 */
const CASE_BUDGET_MS = 180_000;
/** Carrier deadline: past every case budget, so a slow host fails a case as a
 * clean Bun timeout and never by exhausting the carrier's storage budget. */
const CARRIER_LIFETIME_MS = 2 * CASE_BUDGET_MS;
/** Binding reads of one complete original readonly verify (inspect, invoke and
 * its deferred finish), and of one cold provision. */
const VERIFY_READS = 53;
const PROVISION_READS = 4;
const ENGINE_ID = "fixture-engine";
const SELECTION = { name: "fixture_data", storage: "data" } as const;
const roots: string[] = [];
// Live carriers of the current case. A timed-out case's carrier is cancelled
// here, so its leftover work refuses before another synthetic or host command.
const lifetimes = new Set<AbortController>();
afterEach(async () => {
  for (const lifetime of lifetimes) {
    lifetime.abort();
  }
  lifetimes.clear();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Fault = "fault-carrier-state-changed";

async function fixture(opts: { readonly volume: boolean }) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-storage-binding-"))
  );
  roots.push(root);
  const checkoutRoot = join(root, "checkout");
  const instanceId = randomBytes(16).toString("hex");
  await mkdir(
    join(checkoutRoot, ".hack/.internal/native-compose", instanceId),
    {
      recursive: true,
      mode: 0o700,
    }
  );
  const bin = join(root, "bin");
  await mkdir(bin, { mode: 0o700 });
  const docker = join(bin, "docker");
  await Bun.write(
    docker,
    `#!${process.execPath}
import {appendFile} from "node:fs/promises";
${nativeComposeStorageDockerFixtureScript(root)}
process.exit(99);
`
  );
  await chmod(docker, 0o700);
  const identity: generationOwner.NativeComposeIdentity = {
    checkoutRoot,
    repositoryRoot: checkoutRoot,
    instance: null,
    instanceId,
    composeProject: "fixture",
    ownerToken: randomBytes(16).toString("hex"),
  };
  if (opts.volume) {
    await Bun.write(
      join(root, "volumes"),
      JSON.stringify([
        {
          id: SELECTION.name,
          name: SELECTION.name,
          project: identity.composeProject,
          version: "1",
          instance: identity.composeProject,
          owner: identity.ownerToken,
          storage: SELECTION.storage,
          createdAt: "2026-10-08T12:00:00.000Z",
          attributes: {},
          root: { device: "1", inode: "42", uid: 0, gid: 0 },
        },
      ])
    );
  }
  const generationId = randomBytes(16).toString("hex");
  const binding = Object.freeze({
    identity,
    generationId,
    checkout: { dev: 1, ino: 2 },
    receipt: { dev: 1, ino: 3, hash: "1".repeat(64) },
    lease: {
      token: randomBytes(16).toString("hex"),
      directory: { dev: 1, ino: 4 },
      owner: { dev: 1, ino: 5 },
    },
    generation: null,
    documentHash: null,
    currentGenerationId: generationId,
    pendingGenerationId: null,
    pendingToken: null,
  }) as unknown as generationOwner.NativeComposeMaterialBinding;
  // Only what the carrier's binding read consults: the selected generation
  // and its document's declaration of the selected volume.
  const store = {
    identity,
    loadCurrent: async () => ({
      generation: { identity, generationId },
      storageWitnesses: null,
    }),
    loadPending: async () => null,
    readGenerationDocument: async () => ({
      volumes: { [SELECTION.storage]: { name: SELECTION.name } },
    }),
  } as unknown as generationOwner.NativeComposeGenerationStore;
  return { root, bin, identity, binding, store };
}

/**
 * Runs `work` with the synthetic `docker` first on PATH, an isolated Docker
 * client config (the engine-ID admission then keeps the synthetic CLI and
 * never dials a real socket) and the binding stand-in. Read `perturb`
 * (1-based; 0 for none) answers a changed receipt hash.
 */
async function withCarrierEnvironment<T>(
  f: Fixture,
  perturb: number,
  work: (reads: () => number) => Promise<T>
): Promise<T> {
  const keys = [
    "PATH",
    "DOCKER_CONFIG",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
  ] as const;
  const saved = new Map(keys.map((key) => [key, process.env[key]] as const));
  let count = 0;
  const authority = spyOn(
    generationOwner,
    "assertNativeComposeMaterialAuthority"
  ).mockImplementation(async () => {
    count += 1;
    if (count === perturb) {
      return {
        ...f.binding,
        receipt: { ...f.binding.receipt, hash: "2".repeat(64) },
      };
    }
    return f.binding;
  });
  try {
    for (const key of keys) {
      restoreEnv(key, undefined);
    }
    process.env.PATH = `${f.bin}:/usr/bin:/bin`;
    process.env.DOCKER_CONFIG = isolatedDockerClientEnv(f.root).DOCKER_CONFIG;
    return await work(() => count);
  } finally {
    authority.mockRestore();
    for (const [key, value] of saved) {
      restoreEnv(key, value);
    }
  }
}

async function carrier(f: Fixture) {
  const lifetime = new AbortController();
  lifetimes.add(lifetime);
  const deadline = Date.now() + CARRIER_LIFETIME_MS;
  return {
    deadline,
    handle: await createNativeComposeDockerStorageXattrCarrier({
      // The binding read is the stand-in above; nothing else reads authority.
      authority: {} as generationOwner.NativeComposeMaterialAuthority,
      store: f.store,
      engineId: ENGINE_ID,
      signal: lifetime.signal,
      deadline,
      originalCommandRecords: true,
    }),
  };
}

function outcomeOf(error: unknown, deadline: number) {
  if (error === undefined) {
    return null;
  }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("values omitted");
  return {
    refusal: nativeComposeEffectRefusal(error),
    // The reason the same refusal reports when caught after its deadline.
    late: nativeComposeStorageCarrierBudgetReason({
      error,
      signal: new AbortController().signal,
      deadline,
      now: () => deadline + 1,
    }),
  };
}

/**
 * One original readonly verify through the real carrier: inspect, a journaled
 * invoke and its deferred finish (evidence retirement).
 */
async function verifyOnce(opts: {
  readonly perturb: number;
  readonly fault?: { readonly name: Fault; readonly inspection: number };
  /** Invalidate the real original command owner once the invoke returned,
   * before its deferred finish, as a live owner veto would. */
  readonly vetoOwner?: true;
}) {
  const f = await fixture({ volume: true });
  if (opts.fault) {
    await Bun.write(
      join(f.root, opts.fault.name),
      String(opts.fault.inspection)
    );
  }
  return await withCarrierEnvironment(f, opts.perturb, async (reads) => {
    // The real owner, captured as it is created; nothing else changes.
    const owners: commandRecord.NativeComposeStorageCommandOwner[] = [];
    const createOwner = commandRecord.createNativeComposeStorageCommandOwner;
    const ownerCreation = spyOn(
      commandRecord,
      "createNativeComposeStorageCommandOwner"
    ).mockImplementation(async (owner) => {
      const created = await createOwner(owner);
      owners.push(created);
      return created;
    });
    const { deadline, handle } = await carrier(f);
    const ports = nativeComposeStorageXattrCarrierPorts(handle);
    const journalPath = join(f.root, "journal");
    await mkdir(journalPath, { mode: 0o700 });
    const directory = await holdDirectory(journalPath, true);
    let caught: unknown;
    try {
      const target = (await ports.inspect(
        SELECTION
      )) as NativeComposeStorageXattrTarget;
      const token = randomBytes(16).toString("hex");
      const check = async () => {};
      await initializeNativeComposeStorageCarrierJournal({
        directory,
        token,
        check,
      });
      const captured = Object.freeze({
        invocationId: randomBytes(16).toString("hex"),
        artifact: nativeComposeStorageXattrCarrierArtifact(handle),
        target,
        readonly: true,
        uid: 0,
        gid: 0,
        request: Object.freeze({
          ...createNativeComposeStorageXattrMarker(),
          operation: "verify" as const,
          root: Object.freeze({ device: "1", inode: "42", uid: 0, gid: 0 }),
        }),
        scope: Object.freeze({
          generationId: f.binding.generationId,
          currentGenerationId: f.binding.currentGenerationId,
          pendingGenerationId: null,
          pendingToken: null,
        }),
      });
      const journal = await beginNativeComposeStorageCarrierIntent({
        directory,
        token,
        check,
        input: captured,
      });
      const input: NativeComposeStorageXattrInvocation = Object.freeze({
        ...captured,
        recordCreated: journal.recordCreated,
      });
      const result = (await ports.invoke(input)) as {
        readonly carrierId: string;
        readonly carrierCreatedAt: string;
      };
      const completion = await journal.complete({
        id: result.carrierId,
        createdAt: result.carrierCreatedAt,
      });
      const finish = ports.finish;
      if (!finish) {
        throw new Error("Expected an original deferred finish");
      }
      if (opts.vetoOwner) {
        expect(owners).toHaveLength(1);
        for (const owner of owners) {
          commandRecord.invalidateNativeComposeStorageCommandOwner(owner);
        }
      }
      await finish({ input, completion });
    } catch (error: unknown) {
      caught = error;
    } finally {
      ownerCreation.mockRestore();
      await directory.file.close();
    }
    return {
      root: f.root,
      reads: reads(),
      outcome: outcomeOf(caught, deadline),
    };
  });
}

/** One original cold provision through the real carrier. */
async function provisionOnce(perturb: number) {
  const f = await fixture({ volume: false });
  return await withCarrierEnvironment(f, perturb, async (reads) => {
    const { deadline, handle } = await carrier(f);
    const provision = nativeComposeStorageXattrCarrierPorts(handle).provision;
    if (!provision) {
      throw new Error("Expected an original provision port");
    }
    let caught: unknown;
    try {
      await provision({
        ...SELECTION,
        engineId: ENGINE_ID,
        runtimeIdentity: f.identity.composeProject,
        ownerToken: f.identity.ownerToken,
      });
    } catch (error: unknown) {
      caught = error;
    }
    return {
      root: f.root,
      reads: reads(),
      outcome: outcomeOf(caught, deadline),
    };
  });
}

async function helperOperations(root: string): Promise<string[]> {
  const file = Bun.file(join(root, "storage-operations"));
  return (await file.exists())
    ? (await file.text()).split("\n").filter(Boolean)
    : [];
}

test(
  "an unchanged saved binding verifies, retires its evidence and provisions through the real carrier",
  async () => {
    const verified = await verifyOnce({ perturb: 0 });
    expect(verified.outcome).toBeNull();
    expect(verified.reads).toBe(VERIFY_READS);
    expect(await helperOperations(verified.root)).toEqual(["verify"]);
    const provisioned = await provisionOnce(0);
    expect(provisioned.outcome).toBeNull();
    expect(provisioned.reads).toBe(PROVISION_READS);
  },
  CASE_BUDGET_MS
);

// Each row: the changed read, the call site whose comparison sees it, and that
// step's stage. Reads 6 and 12 reach the original command owner's check (at
// owner creation and after the create arm is published); the record keeps the
// check's boundary on its fixed refusal (`refuseFrom`).
test.each([
  [2, "the target observation", "storage-target"],
  [6, "the command owner's creation check", "storage-target"],
  [8, "the read admitting the create command", "storage-target"],
  [9, "the create command's admission", "storage-helper-create"],
  [
    12,
    "the command owner's check of the published create arm",
    "storage-helper-create",
  ],
  [21, "the read admitting the start command", "storage-helper-policy"],
  [22, "the start command's admission", "storage-helper-start"],
  [34, "the cleanup authority read", "storage-helper-cleanup"],
  [35, "the remove command's admission", "storage-helper-cleanup"],
  [49, "the deferred evidence retirement", "storage-helper-cleanup"],
] as const)(
  "a verify binding changed at read %i (%s) refuses as private-state at %s, even after its deadline",
  async (perturb, _, stage) => {
    const verified = await verifyOnce({ perturb });
    expect(verified.reads).toBe(perturb);
    expect(verified.outcome).toEqual({
      refusal: { stage, reason: "private-state" },
      late: "private-state",
    });
  },
  CASE_BUDGET_MS
);

test.each([
  [2, "the read admitting the volume create"],
  [3, "the volume create's admission"],
  [4, "the read after the volume was created"],
] as const)(
  "a provision binding changed at read %i (%s) refuses as private-state, even after its deadline",
  async (perturb) => {
    const provisioned = await provisionOnce(perturb);
    // The changed read is the last one: its own step refuses.
    expect(provisioned.reads).toBe(perturb);
    expect(provisioned.outcome).toEqual({
      refusal: { stage: "storage-provision", reason: "private-state" },
      late: "private-state",
    });
  },
  CASE_BUDGET_MS
);

// An original verify carrier is policy-inspected after creation (1), before
// start (2), at each of its start command's three admissions (3-5: before the
// arm, after it and once the stopped child is spawned), after it stopped (6),
// once more (7) and at each of its remove command's three admissions (8-10).
// The chosen inspection shows another stopped state under the same creation
// time and policy.
//
// The reported refusal is asserted first: it is the property, and a carrier
// that refused before the fault (for example a host identity read refused
// under load, HACK-1463) then fails with its own stage and reason instead of a
// bare inspection count. Only the fault reports `helper-policy-stability`, and
// it refuses at once, so given that refusal the count pins which inspection
// reached the tagged call site.
test.each([
  ["on its repeated stopped inspection", 7],
  ["at its remove command's first admission", 8],
  ["once its remove child is spawned", 10],
] as const)(
  "a stopped helper carrier whose state changed %s refuses with its policy stability reason, even after its deadline",
  async (_, inspection) => {
    const verified = await verifyOnce({
      perturb: 0,
      fault: { name: "fault-carrier-state-changed", inspection },
    });
    expect(verified.outcome).toEqual({
      refusal: {
        stage: "storage-helper-policy",
        reason: "helper-policy-stability",
      },
      late: "helper-policy-stability",
    });
    expect(
      Number(
        await Bun.file(join(verified.root, "carrier-state-inspects")).text()
      )
    ).toBe(inspection);
    // The helper ran once; nothing proved or retired the witness afterwards.
    expect(await helperOperations(verified.root)).toEqual(["verify"]);
  },
  CASE_BUDGET_MS
);

// The deferred finish checks the live original command owner before its
// binding read (read 49). An owner vetoed after every command settled is the
// invocation's saved private state, so the finish refuses as `private-state` at
// the carrier's own cleanup stage; untagged, it would report `unclassified`,
// and `storage-budget` once caught after the carrier deadline.
test(
  "a verify whose original command owner was vetoed before its deferred finish refuses as private-state at storage-helper-cleanup, even after its deadline",
  async () => {
    const verified = await verifyOnce({ perturb: 0, vetoOwner: true });
    expect(verified.outcome).toEqual({
      refusal: { stage: "storage-helper-cleanup", reason: "private-state" },
      late: "private-state",
    });
    // It refused before the finish's binding read and evidence retirement.
    expect(verified.reads).toBe(48);
    expect(await helperOperations(verified.root)).toEqual(["verify"]);
  },
  CASE_BUDGET_MS
);
