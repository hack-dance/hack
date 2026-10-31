import { test as boundedTest, expect, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_COMPOSE_STARTUP_TIMEOUT_MS } from "../src/lib/compose-startup-budget.ts";
import { isRecord } from "../src/lib/guards.ts";
import * as admission from "../src/lib/native-compose-adoption-compiler.ts";
import { LegacyComposeAdoptedGenerationError } from "../src/lib/native-compose-adoption-generation.ts";
import { legacyComposePublicationRefusal } from "../src/lib/native-compose-adoption-publication-diagnostics.ts";
import { runLegacyComposeRetainedRoutingOperation } from "../src/lib/native-compose-adoption-routing-execution.ts";
import * as privateState from "../src/lib/native-compose-private-state.ts";
import { restoreEnv } from "./helpers/env.ts";
import {
  type RetainedRoutingStoreTimeoutMs,
  ROUTING_CANARY,
  ROUTING_IDS,
  retainedRoutingFixture,
  retainedRoutingFixtureLifetime,
} from "./helpers/retained-routing-adoption.ts";

/** The compound tests' store proof deadline: the product's 60 s cap. */
const COMPOUND_STORE_TIMEOUT_MS = 60_000;
/** The caller deadline of each compound operation: the product's own default
 * (`hack up`/`down` pass the 90 s Compose startup budget to `withMutation`). */
const COMPOUND_OPERATION_DEADLINE_MS = DEFAULT_COMPOSE_STARTUP_TIMEOUT_MS;
/** A compound test's budget: six `COMPOUND_OPERATION_DEADLINE_MS` (540 s), for at
 * most five caller-bounded operations plus preparation, publication and the
 * lease or rollback. It must not be shorter than the bounds of the operations it
 * runs in sequence: a 60 s budget let suite load end a slow but unchanged run
 * before its operations' own deadlines, and the timed-out fixture then failed every
 * later test in this file as an unknown lifetime. A hosted run takes about 40 s. */
const COMPOUND_TEST_BUDGET_MS = 540_000;
/** A single-operation regression test's budget: two operation deadlines (180 s),
 * for preparation, the one caller-bounded operation and a publication. */
const SINGLE_OPERATION_TEST_BUDGET_MS = 180_000;
/** A synthetic clock advance past the harness's 15 s default operation deadline
 * but well inside the product's default caller deadline: a slow but unchanged
 * operation. */
const SLOW_OPERATION_ADVANCE_MS = 16_000;
type RoutingFixture = Awaited<ReturnType<typeof retainedRoutingFixture>>;
type RoutingFixtureLifetime = ReturnType<typeof retainedRoutingFixtureLifetime>;
let h: RoutingFixture;
let fixtureActive = false;
let fixtureUncertain = false;
/**
 * The file's fixture gate. A case refuses while an earlier case's fixture is
 * still active or its lifetime is unknown, because that fixture's global
 * doubles may still be installed. `run` calls `restored()` only once every
 * global double and root it created is restored; otherwise the gate stays
 * closed and every later gated case in this file refuses.
 */
const gatedTest = (
  name: string,
  run: (restored: () => void) => Promise<void>,
  timeoutMs: number
) =>
  boundedTest(
    name,
    async () => {
      if (fixtureActive || fixtureUncertain) {
        fixtureUncertain = true;
        throw new Error(
          "Prior retained routing fixture lifetime is unknown; values omitted."
        );
      }
      fixtureActive = true;
      let isRestored = false;
      try {
        await run(() => {
          isRestored = true;
        });
      } finally {
        if (isRestored) {
          fixtureActive = false;
        } else {
          fixtureUncertain = true;
        }
      }
    },
    timeoutMs
  );
/**
 * Ends a gated case's fixture. With a known lifetime it runs the full
 * teardown. With an unknown lifetime it keeps the spies and root for the
 * unsettled work but still restores HACK_HOME, so later files never inherit
 * the fixture home (HACK-1327). `failure` is set whenever not everything was
 * restored.
 */
async function endRoutingFixture(
  lifetime: RoutingFixtureLifetime,
  fixture: RoutingFixture | undefined
): Promise<{ readonly restored: boolean; readonly failure?: unknown }> {
  if (!lifetime.canRestore()) {
    fixture?.releaseEnvironment();
    return {
      restored: false,
      failure: new Error(
        "Retained routing fixture lifetime is unknown; values omitted."
      ),
    };
  }
  if (fixture === undefined) {
    // Setup did not issue a complete fixture; do not reuse its global context.
    lifetime.retain();
    return {
      restored: false,
      failure: new Error(
        "Retained routing fixture setup is incomplete; values omitted."
      ),
    };
  }
  try {
    await fixture.cleanup();
    return { restored: true };
  } catch (error: unknown) {
    lifetime.retain();
    return { restored: false, failure: error };
  }
}
const test = (
  name: string,
  run: () => Promise<void>,
  opts: {
    readonly timeoutMs?:
      | 30_000
      | 60_000
      | typeof SINGLE_OPERATION_TEST_BUDGET_MS
      | typeof COMPOUND_TEST_BUDGET_MS;
  } = {}
) => {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return gatedTest(
    name,
    async (restored) => {
      const lifetime = retainedRoutingFixtureLifetime(Date.now() + timeoutMs);
      let fixture: RoutingFixture | undefined;
      let failed = false;
      let failure: unknown;
      try {
        h = await retainedRoutingFixture(lifetime);
        fixture = h;
        await run();
      } catch (error: unknown) {
        failed = true;
        failure = error;
      }
      const end = await endRoutingFixture(lifetime, fixture);
      if (end.restored) {
        restored();
      }
      if (failed) {
        throw failure;
      }
      if (!end.restored) {
        throw end.failure;
      }
    },
    timeoutMs
  );
};
async function prepare(
  opts: { readonly timeoutMs?: RetainedRoutingStoreTimeoutMs } = {}
) {
  const store = await h.store(opts);
  try {
    return { store, generation: await store.prepare({ binary: h.compiler }) };
  } catch (error: unknown) {
    await store.close();
    throw error;
  }
}
async function red(value: Promise<unknown>) {
  try {
    await value;
    throw new Error("unexpected synthetic success");
  } catch (error: unknown) {
    expect(String(error)).toMatch(/values omitted/i);
    expect(String(error)).not.toContain(ROUTING_CANARY);
    expect(String(error)).not.toContain(h.root);
  }
}
test("publication diagnostics preserve a reached private input refusal after the switching receipt", async () => {
  const { store, generation } = await prepare();
  let reached = false;
  let restoreRead: (() => void) | undefined;
  try {
    const originalRead = privateState.readPrivate;
    const readSpy = spyOn(privateState, "readPrivate").mockImplementation(
      async (...args) => {
        const value = await originalRead(...args);
        if (!reached && args[0].endsWith("/manifest.json")) {
          const saved = await h.receipt();
          if (saved.publication?.phase === "switching") {
            reached = true;
            throw new privateState.NativeComposeGenerationError(
              "E_NATIVE_COMPOSE_STALE"
            );
          }
        }
        return value;
      }
    );
    restoreRead = () => readSpy.mockRestore();
    let caught: unknown;
    try {
      await store.publish({ generation, binary: h.compiler });
    } catch (error: unknown) {
      caught = error;
    }
    expect(reached).toBe(true);
    expect(caught).toBeInstanceOf(LegacyComposeAdoptedGenerationError);
    expect(legacyComposePublicationRefusal(caught)).toEqual({
      stage: "publication-inputs",
      reason: "private-stale",
    });
    const saved = await h.receipt();
    expect(saved.publication?.phase).toBe("switching");
    expect(saved.publication?.native).toBeNull();
    expect(saved.routingHandoff).toBe("held");
    expect(h.effects).toEqual([]);
    expect(await readFile(join(h.root, ".hack/hack.config.json"), "utf8")).toBe(
      h.config
    );
    expect(
      await readFile(join(h.root, ".hack/docker-compose.yml"), "utf8")
    ).toBe(h.compose);
  } finally {
    if (h.canRestore()) {
      restoreRead?.();
    }
    await store.close();
  }
});
test("publication diagnostics distinguish compiler refusal after switching from earlier admission", async () => {
  const { store, generation } = await prepare();
  let earlierAdmissions = 0;
  let refusedAdmissions = 0;
  let restoreCompiler: (() => void) | undefined;
  try {
    const originalAdmission = admission.admitLegacyComposeCandidate;
    const compilerSpy = spyOn(
      admission,
      "admitLegacyComposeCandidate"
    ).mockImplementation(async (opts) => {
      if ((await h.receipt()).publication?.phase === "switching") {
        refusedAdmissions += 1;
        return false;
      }
      earlierAdmissions += 1;
      return await originalAdmission(opts);
    });
    restoreCompiler = () => compilerSpy.mockRestore();
    let caught: unknown;
    try {
      await store.publish({ generation, binary: h.compiler });
    } catch (error: unknown) {
      caught = error;
    }
    expect(earlierAdmissions).toBeGreaterThan(0);
    expect(refusedAdmissions).toBe(1);
    expect(caught).toBeInstanceOf(LegacyComposeAdoptedGenerationError);
    expect(legacyComposePublicationRefusal(caught)).toEqual({
      stage: "publication-compiler",
      reason: "legacy-unsupported",
    });
    const saved = await h.receipt();
    expect(saved.publication?.phase).toBe("switching");
    expect(saved.publication?.native).toBeNull();
    expect(saved.routingHandoff).toBe("held");
    expect(h.effects).toEqual([]);
    expect(await readFile(join(h.root, ".hack/hack.config.json"), "utf8")).toBe(
      h.config
    );
    expect(
      await readFile(join(h.root, ".hack/docker-compose.yml"), "utf8")
    ).toBe(h.compose);
  } finally {
    if (h.canRestore()) {
      restoreCompiler?.();
    }
    await store.close();
  }
});
/** Per-phase timing for the compound lifecycle tests. Each marker logs the elapsed
 * and per-phase ms with the probe counts, and `attribute` names the phase in
 * progress and the last operation's timing (including whether its caller deadline
 * had expired) when a failure (such as a proof-deadline overrun) surfaces. Only
 * timings, counts and the refusal code are added to the already value-free
 * diagnostic; values stay omitted. */
function compoundPhases(fixture: string) {
  const started = Date.now();
  let lastPhase = "enter";
  let lastPhaseAt = started;
  return {
    phase: (value: string) => {
      const now = Date.now();
      try {
        const inspections = (kind: string) =>
          h.commands.filter((args) => args[0] === kind && args[1] === "inspect")
            .length;
        console.info(
          JSON.stringify({
            fixture,
            phase: value,
            elapsedMs: now - started,
            phaseMs: now - lastPhaseAt,
            probes: h.commands.length,
            containerInspections: inspections("container"),
            networkInspections: inspections("network"),
            volumeInspections: inspections("volume"),
            effects: h.effects.length,
          })
        );
      } catch {
        // Diagnostic failure must not skip close or replace an original test error.
      }
      lastPhase = value;
      lastPhaseAt = now;
    },
    attribute: (error: unknown) => {
      const now = Date.now();
      return new Error(
        `${fixture} failed ${now - lastPhaseAt} ms after phase "${lastPhase}" (${now - started} ms elapsed of ${COMPOUND_TEST_BUDGET_MS} ms budget; last operation ${JSON.stringify(h.lastOperation() ?? null)}): ${String(error)}`,
        { cause: error }
      );
    },
  };
}
/** Cold v14 preparation stop and publication, returning the active generation. */
async function publishStoppedV14(
  phase: (value: string) => void,
  store: Awaited<ReturnType<typeof prepare>>["store"],
  generation: Awaited<ReturnType<typeof prepare>>["generation"]
) {
  expect(generation.report.adoption_generation_version).toBe(14);
  expect((await h.receipt()).routingHandoff).toBe("held");
  expect(
    await h.operation(store, generation, "stop", {
      preparation: true,
      deadlineMs: COMPOUND_OPERATION_DEADLINE_MS,
    })
  ).toBe(0);
  phase("preparation-stop-return");
  await store.publish({ generation, binary: h.compiler });
  phase("publication-return");
  expect((await h.receipt()).publication?.phase).toBe("active");
  const active = await store.loadActive();
  if (!active) {
    throw new Error("Synthetic active generation missing");
  }
  phase("active-load-return");
  return active;
}
/** Retained data survives, every child effect names only the retained db/web
 * containers, and no probe pulls, builds, creates or removes a resource. */
function expectRetainedResourcesOnly() {
  expect(h.model.sqlRow).toBe(ROUTING_CANARY);
  expect(
    h.effects.every(
      (args) =>
        args.length === 5 &&
        args[3] === ROUTING_IDS.db &&
        args[4] === ROUTING_IDS.web
    )
  ).toBe(true);
  expect(
    h.commands.some(
      (args) =>
        args.includes("pull") ||
        args.includes("build") ||
        args.includes("create") ||
        args.includes("rm")
    )
  ).toBe(false);
}
function volumeInspections() {
  return h.commands.filter(
    (args) => args[0] === "volume" && args[1] === "inspect"
  ).length;
}
// The former single compound run (cold preparation/publication, four lifecycle
// operations, the saved lease and rollback through one store) reached 46 s under
// suite load and overran its 15 s rollback routing proof in hosted CI (run
// 37999833592). It is split into the two tests below, each on a fresh fixture: the
// first covers publication, the lifecycle operations and the saved lease; the
// second covers rollback after a lifecycle cycle. Both open their store at the 60 s
// product cap and give each operation the product's default caller deadline. With
// the harness's former fixed 15 s operation deadline, the fourth lifecycle operation
// under suite load expired it and the product's fail-closed deadline guard refused
// as E_LEGACY_ADOPTION_CHANGED (HACK-1283, run 39289575897); no binding had changed.
// Each retained routing operation also costs more than the one before it, because
// every route-claim scan rereads every prior attempt in the fixture's fresh home.
// Their per-test budget is `COMPOUND_TEST_BUDGET_MS`. The deadline-refusal controls
// in this file keep the 15 s default.
test(
  "v14 keeps original resources and data through stop/publication/up/down/up and saved open",
  async () => {
    const { phase, attribute } = compoundPhases(
      "retained-routing-compound-lifecycle"
    );
    phase("prepare-enter");
    const { store, generation } = await prepare({
      timeoutMs: COMPOUND_STORE_TIMEOUT_MS,
    });
    phase("prepare-return");
    try {
      const active = await publishStoppedV14(phase, store, generation);
      for (const [index, operation] of (
        ["start", "stop", "start", "stop"] as const
      ).entries()) {
        expect(
          await h.operation(store, active, operation, {
            deadlineMs: COMPOUND_OPERATION_DEADLINE_MS,
          })
        ).toBe(0);
        phase(`lifecycle-${index + 1}-${operation}-return`);
      }
      await store.withLease({
        generation: active,
        run: async (input) => {
          expect(input.retainedRouting).toBe(true);
          expect(input.routingResolution).toEqual(h.resolution);
          expect(JSON.stringify(input)).not.toContain("original.hack");
        },
      });
      phase("saved-lease-return");
      expect((await h.receipt()).publication?.phase).toBe("active");
      expectRetainedResourcesOnly();
      expect(h.commands.length).toBeLessThanOrEqual(7300);
      expect(volumeInspections()).toBeLessThanOrEqual(114);
      phase("assertions-complete");
    } catch (error: unknown) {
      throw attribute(error);
    } finally {
      await store.close();
      phase("store-close-return");
    }
    // One full cold preparation/publication, four lifecycle operations and a saved lease.
    // Canonical bracketed scans add four probes per stable binding observation.
  },
  { timeoutMs: COMPOUND_TEST_BUDGET_MS }
);
test(
  "v14 rollback after publication and one up/down restores originals and keeps data and the routing hold",
  async () => {
    const { phase, attribute } = compoundPhases(
      "retained-routing-compound-rollback"
    );
    phase("prepare-enter");
    const { store, generation } = await prepare({
      timeoutMs: COMPOUND_STORE_TIMEOUT_MS,
    });
    phase("prepare-return");
    try {
      const active = await publishStoppedV14(phase, store, generation);
      for (const operation of ["start", "stop"] as const) {
        expect(
          await h.operation(store, active, operation, {
            deadlineMs: COMPOUND_OPERATION_DEADLINE_MS,
          })
        ).toBe(0);
        phase(`lifecycle-${operation}-return`);
      }
      await store.rollback();
      phase("rollback-return");
      expect(
        await readFile(join(h.root, ".hack/hack.config.json"), "utf8")
      ).toBe(h.config);
      expect(
        await readFile(join(h.root, ".hack/docker-compose.yml"), "utf8")
      ).toBe(h.compose);
      expect((await h.receipt()).publication?.phase).toBe("rolled-back");
      expect((await h.receipt()).routingHandoff).toBe("releasing");
      expectRetainedResourcesOnly();
      expect(h.commands.length).toBeLessThanOrEqual(6600);
      expect(volumeInspections()).toBeLessThanOrEqual(99);
      phase("assertions-complete");
    } catch (error: unknown) {
      throw attribute(error);
    } finally {
      await store.close();
      phase("store-close-return");
    }
    // One full cold preparation/publication, one lifecycle cycle and rollback.
    // Canonical bracketed scans add four probes per stable binding observation.
  },
  { timeoutMs: COMPOUND_TEST_BUDGET_MS }
);
/** Runs one harness operation while a synthetic clock jumps
 * `SLOW_OPERATION_ADVANCE_MS` ahead after the operation's first probe, so the
 * operation is slow by the product's own clock but otherwise unchanged. */
async function slowOperation(run: () => Promise<number>): Promise<number> {
  const realNow = Date.now;
  let offset = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => realNow() + offset);
  h.hooks.afterProbe = async () => {
    offset = SLOW_OPERATION_ADVANCE_MS;
  };
  try {
    return await run();
  } finally {
    h.hooks.afterProbe = undefined;
    clock.mockRestore();
  }
}
test(
  "HACK-1283: an unchanged operation slower than 15 s completes under the product's default caller deadline",
  async () => {
    const { store, generation } = await prepare({
      timeoutMs: COMPOUND_STORE_TIMEOUT_MS,
    });
    try {
      expect(
        await slowOperation(() =>
          h.operation(store, generation, "stop", {
            preparation: true,
            deadlineMs: COMPOUND_OPERATION_DEADLINE_MS,
          })
        )
      ).toBe(0);
      expect(h.lastOperation()).toMatchObject({
        outcome: "returned",
        deadlineMs: COMPOUND_OPERATION_DEADLINE_MS,
        deadlineExpired: false,
        bindingUnchanged: true,
      });
      expect(h.lastOperation()?.elapsedMs).toBeGreaterThanOrEqual(
        SLOW_OPERATION_ADVANCE_MS
      );
      expect(h.effects).toHaveLength(1);
      expect((await h.receipt()).pendingOperation).toBeNull();
      await store.publish({ generation, binary: h.compiler });
      expect((await h.receipt()).publication?.phase).toBe("active");
    } finally {
      await store.close();
    }
  },
  { timeoutMs: SINGLE_OPERATION_TEST_BUDGET_MS }
);
test(
  "HACK-1283: the same slow operation under the 15 s default refuses as DEADLINE, not CHANGED, when only its deadline expired",
  async () => {
    const { store, generation } = await prepare({
      timeoutMs: COMPOUND_STORE_TIMEOUT_MS,
    });
    try {
      await red(
        slowOperation(() =>
          h.operation(store, generation, "stop", { preparation: true })
        )
      );
      expect(h.lastOperation()).toMatchObject({
        outcome: "refused",
        code: "E_LEGACY_ADOPTION_DEADLINE",
        deadlineMs: 15_000,
        deadlineExpired: true,
        // Nothing in the synthetic binding moved, so HACK-1340 reports the deadline.
        bindingUnchanged: true,
      });
      expect((await h.receipt()).routingHandoff).toBe("held");
    } finally {
      await store.close();
    }
  },
  { timeoutMs: SINGLE_OPERATION_TEST_BUDGET_MS }
);
test(
  "HACK-1283: a real binding change still refuses as CHANGED within the product's default caller deadline",
  async () => {
    const { store, generation } = await prepare({
      timeoutMs: COMPOUND_STORE_TIMEOUT_MS,
    });
    try {
      h.hooks.afterEffect = async () => {
        h.model.volumeBirth = "2026-02-02T01:02:03Z";
      };
      await red(
        h.operation(store, generation, "stop", {
          preparation: true,
          deadlineMs: COMPOUND_OPERATION_DEADLINE_MS,
        })
      );
      expect(h.lastOperation()).toMatchObject({
        outcome: "refused",
        code: "E_LEGACY_ADOPTION_CHANGED",
        deadlineMs: COMPOUND_OPERATION_DEADLINE_MS,
        deadlineExpired: false,
        bindingUnchanged: false,
      });
      expect(h.effects).toHaveLength(1);
    } finally {
      h.hooks.afterEffect = undefined;
      await store.close();
    }
  },
  { timeoutMs: SINGLE_OPERATION_TEST_BUDGET_MS }
);
test("read-only routing phase refuses volume birth drift at its complete final binding", async () => {
  const { store, generation } = await prepare();
  let adminReads = 0;
  let effectCommandOffset = 0;
  let windowVolumeReads: number | undefined;
  let changedAtVolumeRead: number | undefined;
  try {
    h.hooks.afterEffect = async () => {
      effectCommandOffset = h.commands.length;
    };
    h.hooks.afterProbe = async (args) => {
      if (
        h.effects.length === 1 &&
        args[0] === "exec" &&
        args.at(-1) === "http://127.0.0.1:2019/config/apps/http/servers" &&
        ++adminReads === 3
      ) {
        windowVolumeReads = h.commands
          .slice(effectCommandOffset)
          .filter(
            (command) => command[0] === "volume" && command[1] === "inspect"
          ).length;
        changedAtVolumeRead = h.commands.filter(
          (command) => command[0] === "volume" && command[1] === "inspect"
        ).length;
        h.model.volumeBirth = "2026-02-02T01:02:03Z";
      }
    };
    await red(h.operation(store, generation, "stop", { preparation: true }));
    expect(changedAtVolumeRead).toBeDefined();
    expect(windowVolumeReads).toBe(4);
    expect(
      h.commands.filter((args) => args[0] === "volume" && args[1] === "inspect")
        .length
    ).toBeGreaterThan(changedAtVolumeRead ?? Number.POSITIVE_INFINITY);
    expect(h.effects).toHaveLength(1);
    expect((await h.receipt()).pendingOperation?.operation).toBe("stop");
    expect((await h.receipt()).routingHandoff).toBe("held");
  } finally {
    h.hooks.afterEffect = undefined;
    h.hooks.afterProbe = undefined;
    await store.close();
  }
});
test("read-only routing phase still inspects a newly introduced foreign site writer", async () => {
  const { store, generation } = await prepare();
  let adminReads = 0;
  let effectCommandOffset = 0;
  let windowVolumeReads: number | undefined;
  let introduced = false;
  let observed = false;
  try {
    h.hooks.afterEffect = async () => {
      effectCommandOffset = h.commands.length;
    };
    h.hooks.afterProbe = async (args) => {
      if (
        h.effects.length === 1 &&
        args[0] === "exec" &&
        args.at(-1) === "http://127.0.0.1:2019/config/apps/http/servers" &&
        ++adminReads === 3
      ) {
        windowVolumeReads = h.commands
          .slice(effectCommandOffset)
          .filter(
            (command) => command[0] === "volume" && command[1] === "inspect"
          ).length;
        introduced = true;
        h.model.foreign = true;
      } else if (
        introduced &&
        args[0] === "container" &&
        args[1] === "inspect" &&
        args.includes(ROUTING_IDS.foreign)
      ) {
        observed = true;
      }
    };
    await red(h.operation(store, generation, "stop", { preparation: true }));
    expect(introduced).toBe(true);
    expect(windowVolumeReads).toBe(4);
    expect(observed).toBe(true);
    expect(h.effects).toHaveLength(1);
    expect((await h.receipt()).pendingOperation?.operation).toBe("stop");
    expect((await h.receipt()).routingHandoff).toBe("held");
  } finally {
    h.hooks.afterEffect = undefined;
    h.hooks.afterProbe = undefined;
    await store.close();
  }
});
test("completed routing observation cannot carry a resource proof into a later operation", async () => {
  const { store, generation } = await prepare();
  try {
    expect(
      await h.operation(store, generation, "stop", { preparation: true })
    ).toBe(0);
    expect((await h.receipt()).pendingOperation).toBeNull();
    h.model.volumeBirth = "2026-02-02T01:02:03Z";
    await red(h.operation(store, generation, "stop", { preparation: true }));
    expect(h.effects).toHaveLength(1);
    expect((await h.receipt()).pendingOperation).toBeNull();
  } finally {
    await store.close();
  }
});
for (const changed of ["source", "receipt"] as const) {
  test(`read-only routing phase rechecks ${changed} authority inside its observation window`, async () => {
    const { store, generation } = await prepare();
    let adminReads = 0;
    let effectCommandOffset = 0;
    let windowVolumeReads: number | undefined;
    let changedAtVolumeRead: number | undefined;
    try {
      h.hooks.afterEffect = async () => {
        effectCommandOffset = h.commands.length;
      };
      h.hooks.afterProbe = async (args) => {
        if (
          h.effects.length === 1 &&
          args[0] === "exec" &&
          args.at(-1) === "http://127.0.0.1:2019/config/apps/http/servers" &&
          ++adminReads === 3
        ) {
          windowVolumeReads = h.commands
            .slice(effectCommandOffset)
            .filter(
              (command) => command[0] === "volume" && command[1] === "inspect"
            ).length;
          const path =
            changed === "source"
              ? join(h.root, ".hack/hack.config.json")
              : h.receiptPath;
          const bytes = await readFile(path);
          await fs.rename(path, join(h.outer, `replaced-${changed}`));
          await fs.writeFile(path, bytes, { mode: 0o600, flag: "wx" });
          changedAtVolumeRead = h.commands.filter(
            (command) => command[0] === "volume" && command[1] === "inspect"
          ).length;
        }
      };
      await red(h.operation(store, generation, "stop", { preparation: true }));
      expect(changedAtVolumeRead).toBeDefined();
      expect(windowVolumeReads).toBe(4);
      if (changedAtVolumeRead === undefined) {
        throw new Error("Synthetic authority replacement was not reached");
      }
      // A cheap inner authority check must refuse before the final resource scan.
      expect(
        h.commands.filter(
          (args) => args[0] === "volume" && args[1] === "inspect"
        ).length
      ).toBe(changedAtVolumeRead);
      expect(h.effects).toHaveLength(1);
      expect((await h.receipt()).pendingOperation?.operation).toBe("stop");
      expect((await h.receipt()).routingHandoff).toBe("held");
    } finally {
      h.hooks.afterEffect = undefined;
      h.hooks.afterProbe = undefined;
      await store.close();
    }
  });
}
test("numeric callback cannot settle a prospective child; explicit stop containment retains original uncertainty", async () => {
  const { store, generation } = await prepare();
  try {
    await red(
      h.operation(store, generation, "stop", {
        preparation: true,
        numeric: true,
      })
    );
    const before = await readFile(h.receiptPath, "utf8");
    expect((await h.receipt()).routingOperation?.disposition).toBe(
      "prospective"
    );
    expect(h.effects).toEqual([]);
    const pending = await store.loadPrepared({ recoverOperation: true });
    if (!pending) {
      throw new Error("Synthetic prepared generation missing");
    }
    await red(
      h.operation(store, pending, "stop", { preparation: true, recover: true })
    );
    expect(await readFile(h.receiptPath, "utf8")).toBe(before);
    expect(h.effects).toHaveLength(1);
    await red(store.publish({ generation: pending, binary: h.compiler }));
  } finally {
    await store.close();
  }
});
test("a source read resumed after callback return cannot spawn an original-ID child", async () => {
  const { store, generation } = await prepare();
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let armed = false;
  let paused = false;
  let late: Promise<unknown> | undefined;
  let restoreRead: (() => void) | undefined;
  try {
    const originalRead = privateState.readPrivate;
    const readSpy = spyOn(privateState, "readPrivate").mockImplementation(
      async (...args) => {
        const value = await originalRead(...args);
        if (armed && !paused && args[0].includes("/generations/")) {
          paused = true;
          entered.resolve();
          await released.promise;
        }
        return value;
      }
    );
    restoreRead = () => readSpy.mockRestore();
    const deadline = Date.now() + 15_000;
    await red(
      store.withPreparationStop({
        generation,
        binary: h.compiler,
        deadline,
        run: async (input) => {
          armed = true;
          late = h.track(
            runLegacyComposeRetainedRoutingOperation({
              input,
              operation: "stop",
              deadline,
            })
          );
          await entered.promise;
          return 0;
        },
      })
    );
    expect(paused).toBe(true);
    expect((await h.receipt()).routingOperation?.disposition).toBe(
      "prospective"
    );
    const retained = await readFile(h.receiptPath, "utf8");
    released.resolve();
    if (!late) {
      throw new Error("Synthetic delayed operation was not reached");
    }
    await red(late);
    expect(h.effects).toEqual([]);
    expect(await readFile(h.receiptPath, "utf8")).toBe(retained);
  } finally {
    released.resolve();
    await late?.catch(() => undefined);
    if (h.canRestore()) {
      restoreRead?.();
    }
    await store.close();
  }
});
test("known nonzero child retains a settled journal and exact explicit stop recovery can clear it", async () => {
  const { store, generation } = await prepare();
  try {
    h.model.partial = true;
    expect(
      await h.operation(store, generation, "stop", { preparation: true })
    ).toBe(7);
    expect((await h.receipt()).routingOperation).toMatchObject({
      disposition: "settled",
      code: 7,
    });
    const pending = await store.loadPrepared({ recoverOperation: true });
    if (!pending) {
      throw new Error("Synthetic prepared generation missing");
    }
    h.model.partial = false;
    expect(
      await h.operation(store, pending, "stop", {
        preparation: true,
        recover: true,
      })
    ).toBe(0);
    expect((await h.receipt()).pendingOperation).toBeNull();
    expect((await h.receipt()).routingOperation).toMatchObject({
      disposition: "settled",
      code: 0,
    });
    await store.publish({ generation: pending, binary: h.compiler });
  } finally {
    await store.close();
  }
});

boundedTest(
  "fixture teardown stays refused after an unfinished continuation later settles",
  async () => {
    const lifetime = retainedRoutingFixtureLifetime(Date.now() + 1000);
    const pending = Promise.withResolvers<void>();
    const work = lifetime.track(pending.promise);
    expect(lifetime.canRestore()).toBe(false);
    pending.resolve();
    await work;
    expect(lifetime.canRestore()).toBe(false);
  },
  1000
);
boundedTest(
  "expired fixture lifetime never restores even without pending work",
  () => {
    const lifetime = retainedRoutingFixtureLifetime(Date.now() - 1);
    expect(lifetime.canRestore()).toBe(false);
    expect(lifetime.canRestore()).toBe(false);
  },
  1000
);
gatedTest(
  "a refused teardown still restores HACK_HOME so later files never inherit the fixture home",
  async (restored) => {
    // This case installs the fixture's global doubles, so it must hold the
    // file's fixture gate: as a plain test it could run while an earlier
    // fixture's lifetime is unknown, and a later case would not see this one
    // still open (HACK-1455).
    expect(fixtureActive).toBe(true);
    expect(fixtureUncertain).toBe(false);
    const before = process.env.HACK_HOME;
    // Stands in for another fixture's spy that is kept on purpose while its
    // settlement is unknown: this case must restore only its own spies.
    const foreign = spyOn(privateState, "readPrivate");
    try {
      const lifetime = retainedRoutingFixtureLifetime(Date.now() + 5000);
      const fixture = await retainedRoutingFixture(lifetime);
      try {
        expect(process.env.HACK_HOME).toBe(fixture.home);
        lifetime.retain();
        // The gated runner's own teardown path for an unknown lifetime.
        const end = await endRoutingFixture(lifetime, fixture);
        expect(end.restored).toBe(false);
        expect(end.failure).toBeInstanceOf(Error);
        expect<string | undefined>(process.env.HACK_HOME).toBe(before);
        expect(fixture.doublesInstalled()).toBe(true);
        process.env.HACK_HOME = fixture.home;
        await expect(fixture.cleanup()).rejects.toThrow();
        expect<string | undefined>(process.env.HACK_HOME).toBe(before);
        expect(fixture.doublesInstalled()).toBe(true);
      } finally {
        restoreEnv("HACK_HOME", before);
        fixture.restoreDoubles();
        await rm(fixture.outer, { recursive: true, force: true });
        restored();
      }
      expect(fixture.doublesInstalled()).toBe(false);
      expect(privateState.readPrivate).toBe(foreign);
    } finally {
      foreign.mockRestore();
    }
  },
  5000
);
boundedTest(
  "known callback settlement permits fixture teardown before its unchanged deadline",
  async () => {
    const lifetime = retainedRoutingFixtureLifetime(Date.now() + 1000);
    await lifetime.track(Promise.resolve());
    expect(lifetime.canRestore()).toBe(true);
  },
  1000
);
test("foreign route writer and missing proxy reader refuse preparation before claims or effects", async () => {
  for (const kind of ["foreign", "proxy"]) {
    const before = h.commands.length;
    h.model.foreign = kind === "foreign";
    h.model.proxyAccess = kind !== "proxy";
    const store = await h.store();
    try {
      await red(store.prepare({ binary: h.compiler }));
    } finally {
      await store.close();
    }
    expect(
      h.commands
        .slice(before)
        .some((args) =>
          kind === "foreign"
            ? args[0] === "container" &&
              args[1] === "inspect" &&
              args[3]?.includes('"sites"') &&
              args.includes(ROUTING_IDS.foreign)
            : args[0] === "exec" &&
              args.at(-1) === "http://127.0.0.1:2019/config/apps/http/servers"
        )
    ).toBe(true);
    expect(h.effects).toEqual([]);
  }
});
test("late original birth or upstream drift never clears pending or grants rollback", async () => {
  const { store, generation } = await prepare();
  try {
    await store.publish({ generation, binary: h.compiler });
    const active = await store.loadActive();
    if (!active) {
      throw new Error("Synthetic active generation missing");
    }
    h.hooks.afterEffect = async () => {
      h.model.webBirth = "2026-02-01T01:02:03Z";
    };
    await red(h.operation(store, active, "start"));
    expect((await h.receipt()).pendingOperation?.operation).toBe("start");
    await red(store.rollback());
    expect(h.model.sqlRow).toBe(ROUTING_CANARY);
    expect(
      await readFile(join(h.root, ".hack/hack.project.json"), "utf8")
    ).not.toBe("");
  } finally {
    await store.close();
  }
});
test("same-byte receipt substitution during final routing admission cannot clear pending", async () => {
  const { store, generation } = await prepare();
  const saved = `${h.receiptPath}.original`;
  let substituted = false;
  let finalSave = false;
  let restoreRead: (() => void) | undefined;
  try {
    await store.publish({ generation, binary: h.compiler });
    const active = await store.loadActive();
    if (!active) {
      throw new Error("Synthetic active generation missing");
    }
    const originalRead = privateState.readPrivate;
    const readSpy = spyOn(privateState, "readPrivate").mockImplementation(
      async (...args) => {
        const value = await originalRead(...args);
        if (args[0].endsWith(".receipt")) {
          const staged: unknown = JSON.parse(value.text);
          if (
            isRecord(staged) &&
            staged.pendingOperation === null &&
            isRecord(staged.routingOperation) &&
            staged.routingOperation.disposition === "settled"
          ) {
            finalSave = true;
          }
        }
        return value;
      }
    );
    restoreRead = () => readSpy.mockRestore();
    h.hooks.afterProbe = async (args) => {
      if (!(finalSave && !substituted && args[0] === "exec")) {
        return;
      }
      substituted = true;
      const bytes = await readFile(h.receiptPath);
      await fs.rename(h.receiptPath, saved);
      await fs.writeFile(h.receiptPath, bytes, { mode: 0o600, flag: "wx" });
    };
    await red(h.operation(store, active, "start"));
    expect(substituted).toBe(true);
    expect((await h.receipt()).pendingOperation?.operation).toBe("start");
    expect(await readFile(h.receiptPath)).toEqual(await readFile(saved));
    expect(h.effects).toHaveLength(1);
  } finally {
    if (h.canRestore()) {
      restoreRead?.();
      h.hooks.afterProbe = undefined;
      if (substituted) {
        await fs.unlink(h.receiptPath);
        await fs.rename(saved, h.receiptPath);
      }
    }
    await store.close();
  }
});
test("restored routing proof refuses same-byte original inode replacement before claim handoff", async () => {
  const { store, generation } = await prepare();
  try {
    await store.publish({ generation, binary: h.compiler });
    const configPath = join(h.root, ".hack/hack.config.json");
    const nativePath = join(h.root, ".hack/hack.project.json");
    let replaced = false;
    h.hooks.afterProbe = async (args) => {
      if (
        !replaced &&
        args[0] === "info" &&
        (await h.receipt()).publication?.phase === "rolling-back" &&
        !(await Bun.file(nativePath).exists()) &&
        (await Bun.file(configPath).exists())
      ) {
        const bytes = await readFile(configPath);
        await fs.rename(configPath, join(h.outer, "original-config-test"));
        await fs.writeFile(configPath, bytes, { mode: 0o600 });
        replaced = true;
      }
    };
    await red(store.rollback());
    expect(replaced).toBe(true);
    expect((await h.receipt()).publication?.phase).toBe("rolling-back");
    expect((await h.receipt()).routingHandoff).toBe("held");
    expect(h.effects).toEqual([]);
  } finally {
    await store.close();
  }
});
test("interrupted claim handoff retries from durable releasing state after exact source restore", async () => {
  const { store, generation } = await prepare();
  let restoreUnlink: (() => void) | undefined;
  try {
    await store.publish({ generation, binary: h.compiler });
    const originalUnlink = fs.unlink;
    let interrupted = false;
    const unlinkSpy = spyOn(fs, "unlink").mockImplementation(async (path) => {
      await originalUnlink(path);
      if (
        !interrupted &&
        String(path).includes("/compose-routing/") &&
        String(path).includes("/claims/")
      ) {
        interrupted = true;
        throw new Error("Synthetic handoff interruption; values omitted.");
      }
    });
    restoreUnlink = () => unlinkSpy.mockRestore();
    await red(store.rollback());
    expect(interrupted).toBe(true);
    expect((await h.receipt()).routingHandoff).toBe("releasing");
    expect((await h.receipt()).publication?.phase).toBe("rolling-back");
    expect(await readFile(join(h.root, ".hack/hack.config.json"), "utf8")).toBe(
      h.config
    );
    expect(
      await readFile(join(h.root, ".hack/docker-compose.yml"), "utf8")
    ).toBe(h.compose);
    if (!h.canRestore()) {
      throw new Error("Synthetic handoff lifetime is unknown; values omitted.");
    }
    restoreUnlink();
    restoreUnlink = undefined;
    await store.repairPublication({ action: "rollback" });
    expect((await h.receipt()).publication?.phase).toBe("rolled-back");
    expect(h.effects).toEqual([]);
    expect(h.model.sqlRow).toBe(ROUTING_CANARY);
  } finally {
    if (h.canRestore()) {
      restoreUnlink?.();
    }
    await store.close();
  }
});

test("publication uses its just-observed entry binding within the unchanged proof deadline", async () => {
  const { store, generation } = await prepare();
  const originalNow = Date.now;
  let virtualNow: number | undefined;
  let charged = 0;
  const clock = spyOn(Date, "now").mockImplementation(
    () => virtualNow ?? originalNow()
  );
  try {
    h.hooks.afterProbe = async (args) => {
      const saved = await h.receipt();
      if (
        args[0] === "volume" &&
        args[1] === "inspect" &&
        saved.publication?.phase === "switching" &&
        saved.publication.native === null
      ) {
        charged += 1;
        virtualNow ??= originalNow();
        virtualNow += 2600;
      }
    };
    await store.publish({ generation, binary: h.compiler });
    expect(charged).toBe(4);
    expect((await h.receipt()).publication?.phase).toBe("active");
    expect(h.effects).toEqual([]);
  } finally {
    clock.mockRestore();
    Reflect.deleteProperty(h.hooks, "afterProbe");
    await store.close();
  }
});

test("publication keeps the fixed deadline when its first full proof already expires", async () => {
  const { store, generation } = await prepare();
  const originalNow = Date.now;
  let virtualNow: number | undefined;
  let reached = false;
  const clock = spyOn(Date, "now").mockImplementation(
    () => virtualNow ?? originalNow()
  );
  try {
    h.hooks.afterProbe = async (args) => {
      if (
        !reached &&
        args[0] === "volume" &&
        args[1] === "inspect" &&
        (await h.receipt()).publication?.phase === "switching"
      ) {
        reached = true;
        virtualNow = originalNow() + 16_000;
      }
    };
    let error: unknown;
    try {
      await store.publish({ generation, binary: h.compiler });
    } catch (caught: unknown) {
      error = caught;
    }
    expect(reached).toBe(true);
    expect(legacyComposePublicationRefusal(error)).toEqual({
      stage: "publication-routing",
      reason: "legacy-state",
    });
    expect((await h.receipt()).publication).toMatchObject({
      phase: "switching",
      native: null,
    });
    expect(await readFile(join(h.root, ".hack/hack.config.json"), "utf8")).toBe(
      h.config
    );
    expect(h.effects).toEqual([]);
  } finally {
    clock.mockRestore();
    Reflect.deleteProperty(h.hooks, "afterProbe");
    await store.close();
  }
});

test("publication repeats full volume authority after its observed-entry routing window", async () => {
  const { store, generation } = await prepare();
  let admins = 0;
  let volumeReads = 0;
  let reached = false;
  try {
    h.hooks.afterProbe = async (args) => {
      const saved = await h.receipt();
      if (
        saved.publication?.phase !== "switching" ||
        saved.publication.native !== null
      ) {
        return;
      }
      if (args[0] === "volume" && args[1] === "inspect") {
        volumeReads += 1;
      }
      if (
        args[0] === "exec" &&
        args.at(-1) === "http://127.0.0.1:2019/config/apps/http/servers"
      ) {
        admins += 1;
        if (admins === 2) {
          expect(volumeReads).toBe(2);
          reached = true;
          h.model.volumeBirth = "2026-02-02T02:03:04Z";
        }
      }
    };
    await red(store.publish({ generation, binary: h.compiler }));
    expect(reached).toBe(true);
    expect((await h.receipt()).publication).toMatchObject({
      phase: "switching",
      native: null,
    });
    expect(await readFile(join(h.root, ".hack/hack.config.json"), "utf8")).toBe(
      h.config
    );
    expect(h.effects).toEqual([]);
  } finally {
    Reflect.deleteProperty(h.hooks, "afterProbe");
    await store.close();
  }
});

test("save-active uses its newly observed binding within the unchanged publication deadline", async () => {
  const { store, generation } = await prepare();
  const originalNow = Date.now;
  let virtualNow = originalNow();
  let charged = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => virtualNow);
  try {
    h.hooks.afterProbe = async (args) => {
      const saved = await h.receipt();
      if (
        args[0] === "volume" &&
        args[1] === "inspect" &&
        saved.publication?.phase === "switching" &&
        saved.publication.native !== null
      ) {
        charged += 1;
        virtualNow += 2600;
      }
    };
    await store.publish({ generation, binary: h.compiler });
    expect(charged).toBe(4);
    expect((await h.receipt()).publication?.phase).toBe("active");
    expect(h.effects).toEqual([]);
  } finally {
    if (h.canRestore()) {
      clock.mockRestore();
      Reflect.deleteProperty(h.hooks, "afterProbe");
    }
    await store.close();
  }
});

test("save-active classifies its original deadline guard after staging without active rename", async () => {
  const { store, generation } = await prepare();
  const originalNow = Date.now;
  let virtualNow = originalNow();
  let reached = false;
  const clock = spyOn(Date, "now").mockImplementation(() => virtualNow);
  let restoreRead: (() => void) | undefined;
  try {
    const originalRead = privateState.readPrivate;
    const readSpy = spyOn(privateState, "readPrivate").mockImplementation(
      async (...args) => {
        const value = await originalRead(...args);
        if (!reached && args[0].endsWith(".receipt")) {
          const staged: unknown = JSON.parse(value.text);
          if (
            isRecord(staged) &&
            isRecord(staged.publication) &&
            staged.publication.phase === "active"
          ) {
            expect((await h.receipt()).publication).toMatchObject({
              phase: "switching",
            });
            reached = true;
            virtualNow += 16_000;
          }
        }
        return value;
      }
    );
    restoreRead = () => readSpy.mockRestore();
    let error: unknown;
    try {
      await store.publish({ generation, binary: h.compiler });
    } catch (caught: unknown) {
      error = caught;
    }
    expect(reached).toBe(true);
    expect(legacyComposePublicationRefusal(error)).toEqual({
      stage: "publication-save-active-routing",
      reason: "proof-deadline",
    });
    const saved = await h.receipt();
    expect(saved.publication?.phase).toBe("switching");
    expect(saved.publication?.native).not.toBeNull();
    expect(saved.routingHandoff).toBe("held");
    expect(h.effects).toEqual([]);
  } finally {
    if (h.canRestore()) {
      clock.mockRestore();
      restoreRead?.();
    }
    await store.close();
  }
});

test("save-active rechecks receipt incarnation after the staged-write await", async () => {
  const { store, generation } = await prepare();
  let reached = false;
  let restoreRead: (() => void) | undefined;
  try {
    const originalRead = privateState.readPrivate;
    const readSpy = spyOn(privateState, "readPrivate").mockImplementation(
      async (...args) => {
        const value = await originalRead(...args);
        if (!reached && args[0].endsWith(".receipt")) {
          const staged: unknown = JSON.parse(value.text);
          if (
            isRecord(staged) &&
            isRecord(staged.publication) &&
            staged.publication.phase === "active"
          ) {
            const path = join(
              h.root,
              ".hack/.internal/legacy-compose-adoption-v1/receipt.json"
            );
            const previous = await readFile(path, "utf8");
            await fs.rename(
              path,
              join(h.outer, "receipt-before-save-active-rebirth")
            );
            await fs.writeFile(path, previous, { flag: "wx", mode: 0o600 });
            reached = true;
          }
        }
        return value;
      }
    );
    restoreRead = () => readSpy.mockRestore();
    let error: unknown;
    try {
      await store.publish({ generation, binary: h.compiler });
    } catch (caught: unknown) {
      error = caught;
    }
    expect(reached).toBe(true);
    expect(legacyComposePublicationRefusal(error)).toEqual({
      stage: "publication-save-active-latest",
      reason: "legacy-state",
    });
    const saved = await h.receipt();
    expect(saved.publication?.phase).toBe("switching");
    expect(saved.publication?.native).not.toBeNull();
    expect(saved.routingHandoff).toBe("held");
    expect(h.effects).toEqual([]);
  } finally {
    if (h.canRestore()) {
      restoreRead?.();
    }
    await store.close();
  }
});

test("save-active repeats full volume authority after its scoped routing observations", async () => {
  const { store, generation } = await prepare();
  let admins = 0;
  let volumeReads = 0;
  let readsAtInjection: number | undefined;
  let reached = false;
  try {
    h.hooks.afterProbe = async (args) => {
      const saved = await h.receipt();
      if (
        saved.publication?.phase !== "switching" ||
        saved.publication.native === null
      ) {
        return;
      }
      if (args[0] === "volume" && args[1] === "inspect") {
        volumeReads += 1;
      }
      if (
        args[0] === "exec" &&
        args.at(-1) === "http://127.0.0.1:2019/config/apps/http/servers"
      ) {
        admins += 1;
        if (admins === 2) {
          readsAtInjection = volumeReads;
          reached = true;
          h.model.volumeBirth = "2026-02-02T02:03:04Z";
        }
      }
    };
    let error: unknown;
    try {
      await store.publish({ generation, binary: h.compiler });
    } catch (caught: unknown) {
      error = caught;
    }
    expect(reached).toBe(true);
    expect(readsAtInjection).toBe(2);
    expect(legacyComposePublicationRefusal(error)).toEqual({
      stage: "publication-save-active-routing",
      reason: "legacy-changed",
    });
    const saved = await h.receipt();
    expect(saved.publication?.phase).toBe("switching");
    expect(saved.publication?.native).not.toBeNull();
    expect(saved.routingHandoff).toBe("held");
    expect(h.effects).toEqual([]);
  } finally {
    if (h.canRestore()) {
      Reflect.deleteProperty(h.hooks, "afterProbe");
    }
    await store.close();
  }
});
/** Every synthetic binding fact except the running state, which a stop
 * legitimately changes. Compared, never reported. */
function bindingFacts() {
  const { running: _running, ...facts } = h.model;
  return JSON.stringify(facts);
}
/** The closed refusal code of a rejected retained operation. */
async function refusalCode(
  value: Promise<unknown>
): Promise<LegacyComposeAdoptedGenerationError["code"]> {
  try {
    await value;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(LegacyComposeAdoptedGenerationError);
    expect(String(error)).toMatch(/values omitted/i);
    expect(String(error)).not.toContain(ROUTING_CANARY);
    expect(String(error)).not.toContain(h.root);
    if (error instanceof LegacyComposeAdoptedGenerationError) {
      return error.code;
    }
  }
  throw new Error("unexpected synthetic success");
}
// HACK-1340: the harness gives each operation a 15 s caller deadline. A
// synthetic clock jumps past it after the operation's first probe, so the
// operation is slow by the product's own clock while nothing it observes moves.
test("HACK-1340: an unchanged retained v14 operation past its caller deadline refuses as a deadline, not a binding change", async () => {
  const { store, generation } = await prepare();
  const realNow = Date.now;
  let offset = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => realNow() + offset);
  const before = bindingFacts();
  try {
    h.hooks.afterProbe = async () => {
      offset = 16_000;
    };
    const code = await refusalCode(
      h.operation(store, generation, "stop", { preparation: true })
    );
    expect(offset).toBe(16_000);
    expect(bindingFacts()).toBe(before);
    expect(code).toBe("E_LEGACY_ADOPTION_DEADLINE");
    expect(new LegacyComposeAdoptedGenerationError(code).message).toBe(
      "Legacy adoption operation reached its caller deadline before it could finish; values omitted."
    );
    expect((await h.receipt()).routingHandoff).toBe("held");
  } finally {
    h.hooks.afterProbe = undefined;
    clock.mockRestore();
    await store.close();
  }
});
test("HACK-1340: a real binding drift within the caller deadline still refuses as a binding change", async () => {
  const { store, generation } = await prepare();
  const before = bindingFacts();
  try {
    h.hooks.afterEffect = async () => {
      h.model.volumeBirth = "2026-02-02T01:02:03Z";
    };
    const code = await refusalCode(
      h.operation(store, generation, "stop", { preparation: true })
    );
    expect(bindingFacts()).not.toBe(before);
    expect(code).toBe("E_LEGACY_ADOPTION_CHANGED");
    expect(h.effects).toHaveLength(1);
    expect((await h.receipt()).pendingOperation?.operation).toBe("stop");
  } finally {
    h.hooks.afterEffect = undefined;
    await store.close();
  }
});
// HACK-1391: the two deadline guards of a retained v14 operation, each proven on
// its own. The caller-deadline catch in `mutateRetainedContainers` keeps an
// observed drift's code even when the drift is reported after the deadline, and
// `requireMutationDeadline` issues the deadline code, not a drift, when the
// callback's revocation fence finds the deadline passed.
test("HACK-1391: a binding drift reported after the caller deadline keeps its binding-change code", async () => {
  const { store, generation } = await prepare();
  const realNow = Date.now;
  let offset = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => realNow() + offset);
  const before = bindingFacts();
  let driftedReads = 0;
  try {
    h.hooks.afterEffect = async () => {
      h.model.volumeBirth = "2026-02-02T01:02:03Z";
    };
    h.hooks.afterProbe = async (args) => {
      // The first read of the drifted volume returns the changed birth; the
      // clock then passes the deadline before the store compares it (the
      // bracketed scan may reread the volume once more before comparing).
      if (
        h.effects.length === 1 &&
        args[0] === "volume" &&
        args[1] === "inspect" &&
        ++driftedReads === 1
      ) {
        offset = SLOW_OPERATION_ADVANCE_MS;
      }
    };
    const code = await refusalCode(
      h.operation(store, generation, "stop", { preparation: true })
    );
    expect(driftedReads).toBeGreaterThanOrEqual(1);
    expect(bindingFacts()).not.toBe(before);
    expect(h.lastOperation()).toMatchObject({
      outcome: "refused",
      deadlineExpired: true,
      bindingUnchanged: false,
    });
    expect(code).toBe("E_LEGACY_ADOPTION_CHANGED");
    expect(h.effects).toHaveLength(1);
    expect((await h.receipt()).pendingOperation?.operation).toBe("stop");
  } finally {
    h.hooks.afterEffect = undefined;
    h.hooks.afterProbe = undefined;
    clock.mockRestore();
    await store.close();
  }
});
test("HACK-1391: the callback revocation fence past the caller deadline refuses as a deadline, not a binding change", async () => {
  const { store, generation } = await prepare();
  const realNow = Date.now;
  let offset = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => realNow() + offset);
  const before = bindingFacts();
  let fenced = false;
  try {
    const deadline = Date.now() + 15_000;
    const code = await refusalCode(
      store.withPreparationStop({
        generation,
        binary: h.compiler,
        deadline,
        run: async (input) => {
          // No probe or check runs between the jump and the fence, so only
          // `requireMutationDeadline` can refuse here.
          offset = SLOW_OPERATION_ADVANCE_MS;
          fenced = true;
          input.assertActive();
          return 0;
        },
      })
    );
    expect(fenced).toBe(true);
    expect(bindingFacts()).toBe(before);
    expect(code).toBe("E_LEGACY_ADOPTION_DEADLINE");
    expect(h.effects).toHaveLength(0);
    expect((await h.receipt()).pendingOperation?.operation).toBe("stop");
  } finally {
    clock.mockRestore();
    await store.close();
  }
});
