import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { recoverNativeAuthoredProject } from "../src/backends/native-authored-project-recovery.ts";
import type { stopNativeAuthoredProject } from "../src/backends/native-authored-project-run.ts";
import {
  NativeAuthoredProjectStartError,
  type serveNativeAuthoredProject,
} from "../src/backends/native-authored-project-start.ts";
import { CliUsageError } from "../src/cli/command.ts";
import { HackCliError } from "../src/lib/cli-result.ts";
import { tryNativeAuthoredCommand } from "../src/lib/native-authored-command.ts";
import type { NativeComposeCommandOptions } from "../src/lib/native-compose-command.ts";
import { refuseUnsupportedNativeUpOptions } from "../src/lib/native-up-refusals.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
type Startup = Parameters<typeof serveNativeAuthoredProject>[0];
type Recovery = Parameters<typeof recoverNativeAuthoredProject>[0];
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-authored-command-"))
  );
  roots.push(root);
  await mkdir(join(root, ".hack"), { mode: 0o700 });
  const nativeHome = join(root, "candidate");
  await mkdir(nativeHome, { mode: 0o700 });
  return {
    root,
    selected: { kind: "native" as const, projectRoot: root },
    options: { cwd: root, operation: "up" as const },
    env: {
      HACK_RUNTIME_BACKEND: "native",
      HACK_NATIVE_BINARY: join(root, "explicit-native"),
      HACK_NATIVE_HOME: nativeHome,
      HACK_COMPOSE_STARTUP_TIMEOUT_MS: "1500",
    },
  };
}

test.each([
  undefined,
  "compose",
  "smol",
  "",
])("backend %s stays with the existing dispatch owner", async (backend) => {
  const selected = await fixture();
  let calls = 0;
  expect(
    await tryNativeAuthoredCommand({
      ...selected,
      env: { ...selected.env, HACK_RUNTIME_BACKEND: backend },
      serve: () => {
        calls++;
        return Promise.resolve(19);
      },
    })
  ).toBeNull();
  expect(calls).toBe(0);
  expect(await readdir(join(selected.root, ".hack"))).toEqual([]);
});

const unsupported: readonly Partial<NativeComposeCommandOptions>[] = [
  { operation: "restart", services: ["web"] },
  { operation: "restart", detach: true },
  { operation: "restart", json: true },
  { operation: "restart", recover: true },
  { operation: "restart", unsupportedOptions: true },
  { operation: "restart", service: "web" },
  { operation: "restart", command: [] },
  { operation: "restart", workdir: "/app" },
  { operation: "restart", follow: false },
  { operation: "restart", tail: 0 },
  { operation: "restart", logFormat: "plain" },
  { operation: "down", services: [] },
  { operation: "ps", profiles: [] },
  { operation: "ps", overlay: null },
  { operation: "ps", services: [] },
  { operation: "ps", service: "web" },
  { operation: "ps", recover: true },
  { operation: "ps", detach: true },
  { operation: "ps", command: [] },
  { operation: "ps", unsupportedOptions: true },
  { operation: "logs" },
  { operation: "exec" },
  { operation: "run", service: "web" },
  { operation: "run", service: "web", command: [] },
  { operation: "run", service: "web", command: ["true"], json: true },
  { operation: "run", service: "web", command: ["true"], detach: true },
  { operation: "run", service: "web", command: ["true"], profiles: [] },
  { operation: "run", service: "web", command: ["true"], overlay: null },
  { operation: "run", service: "web", command: ["true"], services: [] },
  { operation: "run", service: "web", command: ["true"], follow: false },
  { operation: "run", service: "web", command: ["true"], tail: 10 },
  { operation: "run", service: "web", command: ["true"], logFormat: "json" },
  { operation: "run", service: "web", command: ["true"], recover: true },
  { operation: "run", service: "web", command: ["true"], workdir: "app" },
  {
    operation: "run",
    service: "web",
    command: ["true"],
    unsupportedOptions: true,
  },
  { detach: true },
  { json: true },
  { recover: true },
  { unsupportedOptions: true },
  { services: ["web"] },
  { service: "web" },
  { command: [] },
  { workdir: "/app" },
  { follow: false },
  { tail: 0 },
  { logFormat: "plain" },
];
test.each([
  ...unsupported,
])("unsupported native request %j refuses before input selection or delegation", async (options) => {
  const selected = await fixture();
  let calls = 0;
  const result = await tryNativeAuthoredCommand({
    ...selected,
    selected: {
      ...selected.selected,
      projectRoot: join(selected.root, "absent"),
    },
    options: { ...selected.options, ...options },
    // Invalid pins must not supersede the unsupported-request refusal.
    env: { HACK_RUNTIME_BACKEND: "native" },
    serve: () => {
      calls++;
      return Promise.resolve(0);
    },
    stop: () => {
      calls++;
      return Promise.resolve();
    },
  }).catch((error: unknown) => error);
  // Where authored foreground starts are supported, a detached start gets the
  // image project's one-line E_USAGE refusal instead of the generic one.
  const detachedStart =
    process.platform === "darwin" &&
    options.detach === true &&
    ["up", "restart"].includes(options.operation ?? "up");
  expect(result).toBeInstanceOf(HackCliError);
  expect(result).toHaveProperty(
    "code",
    detachedStart ? "E_USAGE" : "E_NATIVE_PROJECT_UNSUPPORTED"
  );
  expect(calls).toBe(0);
  expect(await readdir(join(selected.root, ".hack"))).toEqual([]);
});

const macTest = process.platform === "darwin" ? test : test.skip;
macTest(
  "public ps suppresses success after its completed status owner is canceled",
  async () => {
    const selected = await fixture();
    const before = process.listenerCount("SIGINT");
    let calls = 0;
    const result = await tryNativeAuthoredCommand({
      ...selected,
      options: { ...selected.options, operation: "ps", json: true },
      env: {
        ...selected.env,
        HACK_COMPOSE_STARTUP_TIMEOUT_MS: "not-a-startup-budget",
      },
      serve: () => {
        throw new Error("No startup");
      },
      recover: () => {
        throw new Error("No cleanup");
      },
      observe: async ({ signal }) => {
        calls++;
        process.emit("SIGINT");
        expect(signal?.aborted).toBe(true);
        return {
          backend: "native",
          status: "not_started",
          run: null,
          phase: null,
          items: [],
        };
      },
    });
    expect(result).toBe(130);
    expect(calls).toBe(1);
    expect(process.listenerCount("SIGINT")).toBe(before);
    expect(await readdir(join(selected.root, ".hack"))).toEqual([]);
  }
);
macTest(
  "explicit down recovery captures saved scope and never delegates to startup",
  async () => {
    const selected = await fixture();
    const options = {
      ...selected.options,
      operation: "down" as const,
      recover: true,
      instance: "feature/$exact",
    };
    let calls = 0;
    let recovery: Recovery | undefined;
    const pending = tryNativeAuthoredCommand({
      ...selected,
      options,
      serve: () => {
        throw new Error("Recovery cannot invoke startup.");
      },
      recover: (value) => {
        calls++;
        recovery = value;
        return Promise.reject(new Error("Private diagnostic must not escape."));
      },
    }).catch((error: unknown) => error);
    options.instance = "replacement";
    selected.env.HACK_NATIVE_HOME = "/replacement";
    const result = await pending;
    expect(calls).toBe(1);
    expect(recovery?.scope).toEqual({
      projectRoot: selected.root,
      projectDir: join(selected.root, ".hack"),
      nativeHome: join(selected.root, "candidate"),
      branch: "feature/$exact",
    });
    expect(recovery?.timeoutMs).toBe(1500);
    expect(result).toHaveProperty("code", "E_LIFECYCLE_FAILED");
    expect(String(result)).not.toContain("Private diagnostic");
    expect(await readdir(join(selected.root, ".hack"))).toEqual([]);
  }
);

macTest(
  "recovery refuses env/profile/effect overrides before runtime pin or stored owner selection",
  async () => {
    for (const extra of [
      { overlay: null },
      { overlay: "qa" },
      { profiles: [] },
      { profiles: ["dev"] },
      { services: [] },
      { json: true },
      { detach: true },
      { unsupportedOptions: true },
    ]) {
      const selected = await fixture();
      let calls = 0;
      const result = await tryNativeAuthoredCommand({
        ...selected,
        options: {
          ...selected.options,
          operation: "down",
          recover: true,
          ...extra,
        },
        env: { HACK_RUNTIME_BACKEND: "native" },
        recover: () => {
          calls++;
          throw new Error("Owner must not run.");
        },
      }).catch((error: unknown) => error);
      expect(result).toHaveProperty("code", "E_NATIVE_PROJECT_UNSUPPORTED");
      expect(calls).toBe(0);
      expect(await readdir(join(selected.root, ".hack"))).toEqual([]);
    }
  }
);

macTest(
  "recovery cancellation awaits the selected owner and restores command signal listeners",
  async () => {
    const selected = await fixture();
    const before = [
      process.listenerCount("SIGINT"),
      process.listenerCount("SIGTERM"),
    ];
    const entered = Promise.withResolvers<void>();
    let aborted = false;
    const pending = tryNativeAuthoredCommand({
      ...selected,
      options: { ...selected.options, operation: "down", recover: true },
      recover: (value) =>
        new Promise((_, reject) => {
          value.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("Retained selected recovery."));
            },
            { once: true }
          );
          entered.resolve();
        }),
    }).catch((error: unknown) => error);
    await entered.promise;
    process.emit("SIGINT");
    expect(await pending).toHaveProperty("code", "E_LIFECYCLE_FAILED");
    expect(aborted).toBe(true);
    expect([
      process.listenerCount("SIGINT"),
      process.listenerCount("SIGTERM"),
    ]).toEqual(before);
  }
);
macTest(
  "foreground dispatch captures exact selection and delegates to the lifetime owner",
  async () => {
    const selected = await fixture();
    const options = {
      ...selected.options,
      instance: "feature/$exact",
      profiles: ["b", "a"],
      overlay: "dev",
    };
    const original = { ...selected.env };
    const observed: Startup[] = [];
    const result = tryNativeAuthoredCommand({
      ...selected,
      options,
      serve: (startup) => {
        observed.push(startup);
        return Promise.resolve(19);
      },
    });
    selected.selected.projectRoot = join(selected.root, "replacement");
    selected.env.HACK_NATIVE_BINARY = "/replacement";
    selected.env.HACK_NATIVE_HOME = "/replacement";
    selected.env.HACK_COMPOSE_STARTUP_TIMEOUT_MS = "99999";
    options.instance = "replacement";
    options.profiles.push("replacement");
    options.overlay = "replacement";
    expect(await result).toBe(19);
    expect(observed).toHaveLength(1);
    const startup = observed[0];
    if (!startup) {
      throw new Error("fixture requires the delegated startup");
    }
    expect(startup.runtime).toEqual({
      binary: original.HACK_NATIVE_BINARY,
      home: original.HACK_NATIVE_HOME,
    });
    expect(startup.scope).toEqual({
      projectRoot: selected.root,
      projectDir: join(selected.root, ".hack"),
      nativeHome: original.HACK_NATIVE_HOME,
      branch: "feature/$exact",
    });
    expect(startup.profiles).toEqual(["b", "a"]);
    expect(startup.overlay).toBe("dev");
    expect(startup.startupTimeoutMs).toBe(1500);
    expect(startup.run).toMatch(/^[a-f0-9]{32}$/);
    expect(startup.signal?.aborted).toBe(false);
    expect(await readdir(join(selected.root, ".hack"))).toEqual([]);
  }
);

macTest("unscoped command does not infer a Git branch", async () => {
  const selected = await fixture();
  expect(
    await tryNativeAuthoredCommand({
      ...selected,
      serve: (startup) => {
        expect(startup.scope.branch).toBeNull();
        expect(startup.profiles).toBeUndefined();
        expect(startup.overlay).toBeUndefined();
        return Promise.resolve(0);
      },
    })
  ).toBe(0);
});

macTest(
  "invalid explicit pins and over-budget startup refuse before the owner",
  async () => {
    const selected = await fixture();
    for (const env of [
      { ...selected.env, HACK_NATIVE_BINARY: "relative" },
      { ...selected.env, HACK_NATIVE_HOME: "relative" },
      { ...selected.env, HACK_COMPOSE_STARTUP_TIMEOUT_MS: "300001" },
    ]) {
      let calls = 0;
      await expect(
        tryNativeAuthoredCommand({
          ...selected,
          env,
          serve: () => {
            calls++;
            return Promise.resolve(0);
          },
        })
      ).rejects.toThrow();
      expect(calls).toBe(0);
    }
    expect(await readdir(join(selected.root, ".hack"))).toEqual([]);
  }
);

macTest(
  "signals await the exact owner result and remove command listeners",
  async () => {
    const selected = await fixture();
    for (const outcome of ["removed", "retained"] as const) {
      const before = [
        process.listenerCount("SIGINT"),
        process.listenerCount("SIGTERM"),
      ];
      const entered = Promise.withResolvers<void>();
      const result = tryNativeAuthoredCommand({
        ...selected,
        serve: (startup) =>
          new Promise((_, reject) => {
            startup.signal?.addEventListener(
              "abort",
              () =>
                reject(
                  new NativeAuthoredProjectStartError({
                    outcome,
                    canceled: true,
                  })
                ),
              { once: true }
            );
            entered.resolve();
          }),
      }).catch((error: unknown) => error);
      await entered.promise;
      process.emit("SIGINT");
      const value = await result;
      if (outcome === "removed") {
        expect(value).toBe(130);
      } else {
        expect(value).toBeInstanceOf(HackCliError);
        expect(value).toHaveProperty("code", "E_STARTUP_INCOMPLETE");
        expect(value).toHaveProperty("detail.outcome", "retained");
      }
      expect([
        process.listenerCount("SIGINT"),
        process.listenerCount("SIGTERM"),
      ]).toEqual(before);
    }
  }
);

macTest(
  "command retains only closed startup stage and compiler code",
  async () => {
    const selected = await fixture();
    const value = await tryNativeAuthoredCommand({
      ...selected,
      serve: () =>
        Promise.reject(
          new NativeAuthoredProjectStartError({
            outcome: "not-started",
            canceled: false,
            stage: "inputs",
            compilerCode: "E_COMPILER_RESPONSE",
          })
        ),
    }).catch((error: unknown) => error);
    expect(value).toBeInstanceOf(HackCliError);
    expect(value).toHaveProperty("code", "E_STARTUP_INCOMPLETE");
    expect(value).toHaveProperty("detail.stage", "inputs");
    expect(value).toHaveProperty("detail.compilerCode", "E_COMPILER_RESPONSE");
    expect(value).toHaveProperty("detail.outcome", "not-started");
  }
);

macTest(
  "command reports fixed owner outcomes and omits arbitrary failure details",
  async () => {
    const selected = await fixture();
    const privateDetail = "synthetic-private-command-detail";
    for (const error of [
      new Error(privateDetail),
      new NativeAuthoredProjectStartError({
        outcome: "not-started",
        canceled: false,
        nativeCode: "native_graph_subset",
      }),
    ]) {
      const value = await tryNativeAuthoredCommand({
        ...selected,
        serve: () => Promise.reject(error),
      }).catch((caught: unknown) => caught);
      expect(value).toBeInstanceOf(HackCliError);
      expect(String(value)).not.toContain(privateDetail);
      expect(JSON.stringify(value)).not.toContain(privateDetail);
      expect(value).toHaveProperty(
        "code",
        error instanceof NativeAuthoredProjectStartError
          ? "E_NATIVE_PROJECT_UNSUPPORTED"
          : "E_CONFIG_INVALID"
      );
    }
  }
);

macTest.each([
  {
    outcome: "not-started" as const,
    stage: "reservation" as const,
    nativeCode: "runtime_not_running",
    text: "Native runtime is not running; nothing was started. Start the native runtime, then run this command again.",
  },
  {
    outcome: "retained" as const,
    stage: "reservation" as const,
    nativeCode: "runtime_not_running",
    text: "so `hack ps` reports it as pending",
  },
  {
    // Authored foreground control wraps a runtime that stopped during serve.
    outcome: "retained" as const,
    stage: "runtime" as const,
    nativeCode: "native_graph_foreground",
    nativeCauseCode: "runtime_not_running",
    text: "so `hack ps` reports it as pending",
  },
])(
  "a start refused by a stopped runtime ($outcome, $nativeCode) reports the runtime, not incomplete startup",
  async ({ outcome, stage, nativeCode, nativeCauseCode, text }) => {
    const selected = await fixture();
    const value = await tryNativeAuthoredCommand({
      ...selected,
      serve: () =>
        Promise.reject(
          new NativeAuthoredProjectStartError({
            outcome,
            canceled: false,
            nativeCode,
            nativeCauseCode,
            stage,
          })
        ),
    }).catch((caught: unknown) => caught);
    expect(value).toBeInstanceOf(HackCliError);
    expect(value).toHaveProperty("code", "E_DOCKER_UNAVAILABLE");
    expect(value).toHaveProperty("message", expect.stringContaining(text));
    expect(value).toHaveProperty("detail", {
      outcome,
      canceled: false,
      stage,
      nativeCode: "runtime_not_running",
    });
  }
);

macTest.each(["up", "restart"] as const)(
  "a detached native %s gives the image project's one-line E_USAGE refusal",
  async (operation) => {
    const selected = await fixture();
    const value = await tryNativeAuthoredCommand({
      ...selected,
      options: { ...selected.options, operation, detach: true },
    }).catch((caught: unknown) => caught);
    // The image path refuses the same request before project discovery.
    let image: unknown;
    try {
      refuseUnsupportedNativeUpOptions({
        restart: operation === "restart",
        detach: true,
      });
    } catch (caught: unknown) {
      image = caught;
    }
    expect(image).toBeInstanceOf(HackCliError);
    expect(value).toBeInstanceOf(HackCliError);
    expect(value).toHaveProperty("code", "E_USAGE");
    expect(value).toHaveProperty("code", (image as HackCliError).code);
    expect(value).toHaveProperty("message", (image as HackCliError).message);
    const message = (value as HackCliError).message;
    // The foreground-only hint stands on its own, not after the generic sentence.
    expect(message).toStartWith(
      `Native \`hack ${operation}\` runs in the foreground only, so --detach is not supported. Run \`hack ${operation}\` without --detach in its own terminal and keep it open;`
    );
    expect(message).not.toContain("Native authored execution requires");
    expect(message).not.toContain("\n");
  }
);

if (process.platform !== "darwin") {
  test("unsupported host refuses native foreground startup before input or pins", async () => {
    const selected = await fixture();
    await expect(
      tryNativeAuthoredCommand({
        ...selected,
        env: { HACK_RUNTIME_BACKEND: "native" },
      })
    ).rejects.toThrow(
      "requires whole-project foreground up or restart, owner-mediated down, ps, finite single-service logs --no-follow, noninteractive single-service exec, or explicit stored-generation down --recover on macOS"
    );
    expect(await readdir(join(selected.root, ".hack"))).toEqual([]);
  });
}

macTest(
  "ordinary down delegates only to the live finite hook owner without reselecting input",
  async () => {
    const selected = await fixture();
    let calls = 0;
    const code = await tryNativeAuthoredCommand({
      ...selected,
      options: { ...selected.options, operation: "down" },
      serve: () => {
        throw new Error("Must not start");
      },
      recover: () => {
        throw new Error("Must not recover");
      },
      stop: async (opts) => {
        calls++;
        expect(opts.scope.projectRoot).toBe(selected.root);
        expect(opts.timeoutMs).toBe(1500);
      },
    });
    expect(code).toBe(0);
    expect(calls).toBe(1);
    expect(await readdir(join(selected.root, ".hack"))).toEqual([]);
  }
);

macTest(
  "foreground restart proves the owner-mediated stop before delegating a fresh startup with the exact selection",
  async () => {
    const selected = await fixture();
    const options = {
      ...selected.options,
      operation: "restart" as const,
      instance: "feature/$exact",
      profiles: ["b", "a"],
      overlay: "dev",
      services: [] as string[],
    };
    const events: string[] = [];
    const observed: Startup[] = [];
    let stop: Parameters<typeof stopNativeAuthoredProject>[0] | undefined;
    const result = tryNativeAuthoredCommand({
      ...selected,
      options,
      recover: () => {
        throw new Error("Must not recover");
      },
      stop: (value) => {
        events.push("stop");
        stop = value;
        return Promise.resolve();
      },
      serve: (startup) => {
        events.push("serve");
        observed.push(startup);
        return Promise.resolve(19);
      },
    });
    options.instance = "replacement";
    options.profiles.push("replacement");
    options.overlay = "replacement";
    expect(await result).toBe(19);
    expect(events).toEqual(["stop", "serve"]);
    const scope = {
      projectRoot: selected.root,
      projectDir: join(selected.root, ".hack"),
      nativeHome: join(selected.root, "candidate"),
      branch: "feature/$exact",
    };
    expect(stop?.scope).toEqual(scope);
    expect(stop?.timeoutMs).toBe(1500);
    const startup = observed[0];
    if (!startup) {
      throw new Error("fixture requires the delegated startup");
    }
    expect(startup.scope).toEqual(scope);
    expect(startup.runtime).toEqual({
      binary: selected.env.HACK_NATIVE_BINARY,
      home: selected.env.HACK_NATIVE_HOME,
    });
    expect(startup.profiles).toEqual(["b", "a"]);
    expect(startup.overlay).toBe("dev");
    expect(startup.startupTimeoutMs).toBe(1500);
    expect(startup.run).toMatch(/^[a-f0-9]{32}$/);
    expect(startup.signal?.aborted).toBe(false);
    expect(await readdir(join(selected.root, ".hack"))).toEqual([]);
  }
);

macTest(
  "restart after an unproven stop refuses with the fixed lifecycle contract and never starts",
  async () => {
    const selected = await fixture();
    const privateDetail = "private-restart-stop-canary";
    let calls = 0;
    const result = await tryNativeAuthoredCommand({
      ...selected,
      options: { ...selected.options, operation: "restart" },
      stop: () => Promise.reject(new Error(privateDetail)),
      serve: () => {
        calls++;
        return Promise.resolve(0);
      },
    }).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(HackCliError);
    expect(result).toHaveProperty("code", "E_LIFECYCLE_FAILED");
    expect(String(result)).toContain("nothing was restarted");
    expect(String(result)).not.toContain(privateDetail);
    expect(JSON.stringify(result)).not.toContain(privateDetail);
    expect(calls).toBe(0);
    expect(await readdir(join(selected.root, ".hack"))).toEqual([]);
  }
);

macTest(
  "restart cancellation after the proven stop returns 130 without a fresh start",
  async () => {
    const selected = await fixture();
    const before = [
      process.listenerCount("SIGINT"),
      process.listenerCount("SIGTERM"),
    ];
    let calls = 0;
    const result = await tryNativeAuthoredCommand({
      ...selected,
      options: { ...selected.options, operation: "restart" },
      stop: ({ signal }) => {
        process.emit("SIGINT");
        expect(signal?.aborted).toBe(true);
        return Promise.resolve();
      },
      serve: () => {
        calls++;
        return Promise.resolve(0);
      },
    });
    expect(result).toBe(130);
    expect(calls).toBe(0);
    expect([
      process.listenerCount("SIGINT"),
      process.listenerCount("SIGTERM"),
    ]).toEqual(before);
    expect(await readdir(join(selected.root, ".hack"))).toEqual([]);
  }
);

macTest(
  "restart startup refusals after the proven stop keep the foreground up contract",
  async () => {
    const selected = await fixture();
    for (const startup of [
      new NativeAuthoredProjectStartError({
        outcome: "not-started",
        canceled: false,
        stage: "inputs",
        compilerCode: "E_COMPILER_RESPONSE",
      }),
      new NativeAuthoredProjectStartError({
        outcome: "not-started",
        canceled: false,
        nativeCode: "native_graph_subset",
      }),
      new NativeAuthoredProjectStartError({
        outcome: "removed",
        canceled: true,
      }),
    ]) {
      let stops = 0;
      const value = await tryNativeAuthoredCommand({
        ...selected,
        options: { ...selected.options, operation: "restart" },
        stop: () => {
          stops++;
          return Promise.resolve();
        },
        serve: () => Promise.reject(startup),
      }).catch((error: unknown) => error);
      expect(stops).toBe(1);
      if (startup.canceled) {
        expect(value).toBe(130);
        continue;
      }
      expect(value).toBeInstanceOf(HackCliError);
      expect(value).toHaveProperty(
        "code",
        startup.nativeCode === "native_graph_subset"
          ? "E_NATIVE_PROJECT_UNSUPPORTED"
          : "E_STARTUP_INCOMPLETE"
      );
      expect(value).toHaveProperty("detail.stage", startup.stage);
      expect(value).toHaveProperty("detail.outcome", "not-started");
    }
    expect(await readdir(join(selected.root, ".hack"))).toEqual([]);
  }
);

macTest(
  "ordinary down preserves the fixed lifecycle failure contract",
  async () => {
    const selected = await fixture();
    const privateDetail = "private-stop-control-canary";
    const result = await tryNativeAuthoredCommand({
      ...selected,
      options: { ...selected.options, operation: "down" },
      stop: () => Promise.reject(new Error(privateDetail)),
    }).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(HackCliError);
    expect(result).toHaveProperty("code", "E_LIFECYCLE_FAILED");
    expect(String(result)).not.toContain(privateDetail);
    expect(JSON.stringify(result)).not.toContain(privateDetail);
    expect(await readdir(join(selected.root, ".hack"))).toEqual([]);
  }
);

macTest(
  "foreground up and restart carry the selected native HTTPS port for runtime metadata",
  async () => {
    const selected = await fixture();
    const https = {
      HACK_NATIVE_CADDY_BINARY: "/opt/native/caddy",
      HACK_NATIVE_CADDY_SHA256: "a".repeat(64),
      HACK_NATIVE_HTTPS_PORT: "8443",
    };
    const ports: (number | null | undefined)[] = [];
    for (const [operation, env] of [
      ["up", { ...selected.env, ...https }],
      ["up", selected.env],
      ["restart", { ...selected.env, ...https }],
    ] as const) {
      expect(
        await tryNativeAuthoredCommand({
          ...selected,
          options: { ...selected.options, operation },
          env,
          serve: (startup) => {
            ports.push(startup.httpsPort);
            return Promise.resolve(0);
          },
          stop: () => Promise.resolve(),
        })
      ).toBe(0);
    }
    expect(ports).toEqual([8443, null, 8443]);
  }
);

macTest(
  "a partial native HTTPS selection refuses before input or owner work",
  async () => {
    const selected = await fixture();
    let calls = 0;
    const error: unknown = await tryNativeAuthoredCommand({
      ...selected,
      env: { ...selected.env, HACK_NATIVE_HTTPS_PORT: "8443" },
      serve: () => {
        calls++;
        return Promise.resolve(0);
      },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CliUsageError);
    expect(String(error)).not.toContain("8443");
    expect(calls).toBe(0);
    expect(await readdir(join(selected.root, ".hack"))).toEqual([]);
  }
);
