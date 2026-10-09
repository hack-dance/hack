import { test as boundedTest, expect, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../src/lib/guards.ts";
import { runLegacyComposeRetainedRoutingOperation } from "../src/lib/native-compose-adoption-routing-execution.ts";
import * as privateState from "../src/lib/native-compose-private-state.ts";
import {
  ROUTING_CANARY,
  ROUTING_IDS,
  retainedRoutingFixture,
  retainedRoutingFixtureLifetime,
} from "./helpers/retained-routing-adoption.ts";

let h: Awaited<ReturnType<typeof retainedRoutingFixture>>;
let fixtureActive = false;
let fixtureUncertain = false;
const test = (
  name: string,
  run: () => Promise<void>,
  opts: { readonly timeoutMs?: 30_000 | 60_000 } = {}
) => {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return boundedTest(
    name,
    async () => {
      if (fixtureActive || fixtureUncertain) {
        fixtureUncertain = true;
        throw new Error(
          "Prior retained routing fixture lifetime is unknown; values omitted."
        );
      }
      fixtureActive = true;
      const lifetime = retainedRoutingFixtureLifetime(Date.now() + timeoutMs);
      let issued = false;
      let failed = false;
      let failure: unknown;
      try {
        h = await retainedRoutingFixture(lifetime);
        issued = true;
        await run();
      } catch (error: unknown) {
        failed = true;
        failure = error;
      } finally {
        if (!lifetime.canRestore()) {
          fixtureUncertain = true;
          if (!failed) {
            failed = true;
            failure = new Error(
              "Retained routing fixture lifetime is unknown; values omitted."
            );
          }
        } else if (issued) {
          try {
            await h.cleanup();
            fixtureActive = false;
          } catch (error: unknown) {
            lifetime.retain();
            fixtureUncertain = true;
            if (!failed) {
              failed = true;
              failure = error;
            }
          }
        } else {
          // Setup did not issue a complete fixture; do not reuse its global context.
          lifetime.retain();
          fixtureUncertain = true;
          if (!failed) {
            failed = true;
            failure = new Error(
              "Retained routing fixture setup is incomplete; values omitted."
            );
          }
        }
      }
      if (failed) {
        throw failure;
      }
    },
    timeoutMs
  );
};
async function prepare() {
  const store = await h.store();
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
test(
  "v14 keeps original resources and data through stop/publication/up/down/up/rollback and saved open",
  async () => {
    const phase = (value: string) => {
      try {
        const inspections = (kind: string) =>
          h.commands.filter((args) => args[0] === kind && args[1] === "inspect")
            .length;
        console.info(
          JSON.stringify({
            fixture: "retained-routing-compound",
            phase: value,
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
    };
    phase("prepare-enter");
    const { store, generation } = await prepare();
    phase("prepare-return");
    try {
      expect(generation.report.adoption_generation_version).toBe(14);
      expect((await h.receipt()).routingHandoff).toBe("held");
      expect(
        await h.operation(store, generation, "stop", { preparation: true })
      ).toBe(0);
      phase("preparation-stop-return");
      await store.publish({ generation, binary: h.compiler });
      phase("publication-return");
      const active = await store.loadActive();
      if (!active) {
        throw new Error("Synthetic active generation missing");
      }
      phase("active-load-return");
      for (const operation of ["start", "stop", "start", "stop"] as const) {
        expect(await h.operation(store, active, operation)).toBe(0);
      }
      phase("four-lifecycle-operations-return");
      await store.withLease({
        generation: active,
        run: async (input) => {
          expect(input.retainedRouting).toBe(true);
          expect(input.routingResolution).toEqual(h.resolution);
          expect(JSON.stringify(input)).not.toContain("original.hack");
        },
      });
      phase("saved-lease-return");
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
      expect(h.commands.length).toBeLessThanOrEqual(9000);
      expect(
        h.commands.filter(
          (args) => args[0] === "volume" && args[1] === "inspect"
        ).length
      ).toBeLessThanOrEqual(136);
      phase("assertions-complete");
    } finally {
      await store.close();
      phase("store-close-return");
    }
    // One full cold preparation/publication, four lifecycle operations and rollback.
    // Canonical bracketed scans add four probes per stable binding observation.
  },
  { timeoutMs: 60_000 }
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
