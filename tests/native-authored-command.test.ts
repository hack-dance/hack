import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { recoverNativeAuthoredProject } from "../src/backends/native-authored-project-recovery.ts";
import {
  NativeAuthoredProjectStartError,
  type serveNativeAuthoredProject,
} from "../src/backends/native-authored-project-start.ts";
import { HackCliError } from "../src/lib/cli-result.ts";
import { tryNativeAuthoredCommand } from "../src/lib/native-authored-command.ts";
import type { NativeComposeCommandOptions } from "../src/lib/native-compose-command.ts";

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
  { operation: "restart" },
  { operation: "down" },
  { operation: "ps" },
  { operation: "logs" },
  { operation: "exec" },
  { operation: "run" },
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
  }).catch((error: unknown) => error);
  expect(result).toBeInstanceOf(HackCliError);
  expect(result).toHaveProperty("code", "E_NATIVE_PROJECT_UNSUPPORTED");
  expect(calls).toBe(0);
  expect(await readdir(join(selected.root, ".hack"))).toEqual([]);
});

const macTest = process.platform === "darwin" ? test : test.skip;
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

if (process.platform !== "darwin") {
  test("unsupported host refuses native foreground startup before input or pins", async () => {
    const selected = await fixture();
    await expect(
      tryNativeAuthoredCommand({
        ...selected,
        env: { HACK_RUNTIME_BACKEND: "native" },
      })
    ).rejects.toThrow("requires whole-project foreground up on macOS");
    expect(await readdir(join(selected.root, ".hack"))).toEqual([]);
  });
}
