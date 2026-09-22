import { expect, test } from "bun:test";
import { restartNativeProject } from "../src/backends/native-project-restart.ts";
import { nativeRestartSelection } from "../src/backends/native-project-restart-preflight.ts";
import type { NativeRestartIntent } from "../src/backends/native-project-run.ts";

const run = {
  run: "a".repeat(32),
  owner: "b".repeat(32),
  namespace: "c".repeat(64),
  planId: "d".repeat(64),
  effectiveEnvName: "qa",
  profiles: ["app"],
  aws: null,
};
const token = {
  version: 1 as const,
  attempt: "e".repeat(32),
  scope: "f".repeat(64),
  run: run.run,
  owner: run.owner,
  namespace: run.namespace,
  planId: run.planId,
};
const scope = {
  projectRoot: "/fixture",
  projectDir: "/fixture/.hack",
  nativeHome: "/candidate",
  branch: null,
};
function fixture(pending: NativeRestartIntent | null = null) {
  const events: string[] = [];
  const state = { pending };
  const options: Parameters<typeof restartNativeProject>[0] = {
    scope,
    preflight: async () => {
      events.push("preflight");
    },
    down: async () => {
      events.push("down");
    },
    start: async ({ run: selected, onReady }) => {
      expect(selected).toEqual(run);
      events.push("start");
      await onReady();
      events.push("serving");
      return 0;
    },
    dependencies: {
      load: async () => (pending ? null : run),
      pending: async () => state.pending,
      save: async ({ intent }) => {
        state.pending = intent;
        events.push("intent");
      },
      cleaned: async ({ expected }) => {
        state.pending = { ...expected, phase: "cleaned" };
        return state.pending;
      },
      remove: async () => {
        state.pending = null;
        events.push("remove");
      },
      capture: async () => {
        events.push("capture");
        return token;
      },
      wait: async ({ token: selected }) => {
        expect(selected).toEqual(token);
        events.push("finalized");
      },
      lock: async (_scope, action) =>
        await action(async () => {
          events.push("unlock");
        }),
    },
  };
  return { options, events, state };
}
test("restart preflights before retaining cleanup and waits for frontend finalization", async () => {
  const f = fixture();
  expect(await restartNativeProject(f.options)).toBe(0);
  expect(f.events).toEqual([
    "preflight",
    "capture",
    "intent",
    "down",
    "finalized",
    "start",
    "remove",
    "unlock",
    "serving",
  ]);
});
test("changed selection and preflight failure do not stop the app", async () => {
  for (const options of [{ envName: "prod" }, { profiles: [] }]) {
    const f = fixture();
    await expect(
      restartNativeProject({ ...f.options, ...options })
    ).rejects.toThrow();
    expect(f.events).toEqual([]);
  }
  const f = fixture();
  await expect(
    restartNativeProject({
      ...f.options,
      preflight: async () => {
        throw new Error("changed plan");
      },
    })
  ).rejects.toThrow("changed plan");
  expect(f.events).toEqual([]);
});
test("failed finalization keeps pending data and never starts replacement", async () => {
  const f = fixture();
  await expect(
    restartNativeProject({
      ...f.options,
      dependencies: {
        ...f.options.dependencies,
        wait: async () => {
          throw new Error("not finalized");
        },
      },
    })
  ).rejects.toThrow("not finalized");
  expect(f.state.pending?.run).toEqual(run);
  expect(f.events).not.toContain("start");
});
test("resume uses persisted intent without new capture or cleanup", async () => {
  const f = fixture({ run, finalization: token, phase: "cleaned" });
  await restartNativeProject(f.options);
  expect(f.events).toEqual([
    "preflight",
    "finalized",
    "start",
    "remove",
    "unlock",
    "serving",
  ]);
});
test("failed replacement never drops intent or falls back to a fresh run", async () => {
  const f = fixture();
  await expect(
    restartNativeProject({
      ...f.options,
      start: async () => {
        throw new Error("admission failed");
      },
    })
  ).rejects.toThrow("admission failed");
  expect(f.state.pending?.run.run).toBe(run.run);
  expect(f.events).not.toContain("remove");
});
test("legacy unknown selections refuse and omitted flags preserve saved values", () => {
  expect(nativeRestartSelection({ run })).toEqual({
    envName: "qa",
    profiles: ["app"],
    aws: undefined,
  });
  expect(() =>
    nativeRestartSelection({ run: { ...run, profiles: undefined } })
  ).toThrow("legacy");
});

test("preflight compares actual reviewed identity before cleanup eligibility", async () => {
  const { preflightNativeRestart } = await import(
    "../src/backends/native-project-restart-preflight.ts"
  );
  const calls: string[] = [];
  const image = `sha256:${"9".repeat(64)}`;
  const input = {
    originalSha256: "1".repeat(64),
    environmentFiles: [],
    serviceNames: ["app"],
    normalizedComposeJson: JSON.stringify({ services: { app: { image } } }),
    managedEnvironment: {},
    lifecycleHostEnvironment: {},
    effectiveEnvName: "qa",
  };
  const options: Parameters<typeof preflightNativeRestart>[0] = {
    runtime: { binary: "/unused", home: "/candidate" },
    scope,
    composeFile: "/fixture/.hack/docker-compose.yml",
    run,
    dependencies: {
      prepare: async ({ envName }) => {
        expect(envName).toBe("qa");
        return input;
      },
      adapt: async ({ input: prepared }) => prepared,
      dependencies: async () => [],
      invoke: async ({ args }) => {
        if (args[1] === "probe") {
          expect(args).toEqual([
            "runtime",
            "probe",
            "--profile",
            "development",
            "--json",
          ]);
          return { admitted: true };
        }
        expect(args).toEqual(["runtime", "status", "--json"]);
        return { network: "internet" };
      },
      review: async (options) => {
        calls.push("review");
        expect(options.profiles).toEqual(["app"]);
        return await options.run({
          planId: "0".repeat(64),
          namespace: run.namespace,
          report: {},
          projectArgs: [],
        });
      },
    },
  };
  await expect(preflightNativeRestart(options)).rejects.toThrow(
    "configuration changed"
  );
  expect(calls).toEqual(["review"]);
});

test("unconfirmed down hooks cannot be silently skipped on resume", async () => {
  const f = fixture({ run, finalization: token, phase: "prepared" });
  await expect(restartNativeProject(f.options)).rejects.toThrow("down hooks");
  expect(f.events).not.toContain("start");
});

test("network mismatch refuses before an otherwise valid restart", async () => {
  const { requireNativeRestartNetwork } = await import(
    "../src/backends/native-project-restart-preflight.ts"
  );
  expect(() =>
    requireNativeRestartNetwork({
      network: { "approved-hosts": { hosts: ["example.com"] } },
    })
  ).toThrow("not stopped");
  expect(() =>
    requireNativeRestartNetwork({ network: "internet" })
  ).not.toThrow();
  expect(() =>
    requireNativeRestartNetwork(
      { network: { "approved-hosts": { hosts: ["example.com"] } } },
      ["example.com"]
    )
  ).not.toThrow();
});

test("restart preflight refuses failed or unknown admission before reading environment", async () => {
  const { preflightNativeRestart } = await import(
    "../src/backends/native-project-restart-preflight.ts"
  );
  for (const admission of [{ admitted: false }, {}, null]) {
    const calls: string[] = [];
    await expect(
      preflightNativeRestart({
        runtime: { binary: "/unused", home: "/candidate" },
        scope,
        composeFile: "/fixture/.hack/docker-compose.yml",
        run,
        dependencies: {
          invoke: async ({ args }) => {
            calls.push(String(args[1]));
            return args[1] === "status" ? { network: "internet" } : admission;
          },
          prepare: async () => {
            throw new Error("environment should not be read");
          },
        },
      })
    ).rejects.toThrow("admission failed before cleanup");
    expect(calls).toEqual(["status", "probe"]);
  }
});
