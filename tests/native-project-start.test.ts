import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startNativeProject } from "../src/backends/native-project-start.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function fixture(withEnvironment = true) {
  const root = await mkdtemp(join(tmpdir(), "native-start-test-"));
  roots.push(root);
  await mkdir(join(root, ".hack"));
  await writeFile(
    join(root, "hack-relay-guest"),
    "synthetic public test artifact"
  );
  const events: string[] = [];
  let run = "";
  let ready = false;
  const planId = "a".repeat(64),
    namespace = "b".repeat(64),
    owner = "c".repeat(32);
  const managedEnvironment: Record<
    string,
    Record<string, string>
  > = withEnvironment ? { web: { TOKEN: "synthetic-secret" } } : {};
  const dependencies: NonNullable<
    Parameters<typeof startNativeProject>[0]["dependencies"]
  > = {
    load: async () => null,
    save: async () => {
      events.push("save");
    },
    remove: async () => {
      events.push("remove");
    },
    prepare: async () => ({
      originalSha256: "d".repeat(64),
      normalizedComposeJson: JSON.stringify({
        services: { web: { image: `sha256:${"e".repeat(64)}` } },
      }),
      managedEnvironment,
      lifecycleHostEnvironment: {},
      environmentFiles: [],
      effectiveEnvName: null,
      serviceNames: ["web"],
    }),
    review: async (opts) =>
      opts.run({
        planId,
        namespace,
        projectArgs: ["--project", root],
        report: {
          plan: {
            enrollment_compatible: true,
            services: { web: { active: true } },
          },
        },
      }),
    invoke: async (opts) => {
      events.push(opts.args.slice(0, 2).join(" "));
      if (opts.args[1] === "dependency-plan") {
        return { dependency_plan_id: "f".repeat(64) };
      }
      if (opts.args[1] === "inspect") {
        return {
          journal_incomplete: false,
          receipt: {
            run,
            owner,
            namespace,
            plan_id: planId,
            phase: ready ? "ready-observed" : "stopped-data-retained",
          },
          observations: {
            "container:web": { state: ready ? "running" : "absent" },
          },
        };
      }
      return {};
    },
    serve: async (opts) => {
      run = opts.run;
      ready = true;
      if (withEnvironment) {
        expect(new TextDecoder().decode(opts.privateInput)).toContain(
          "synthetic-secret"
        );
      } else {
        expect(opts.privateInput).toBeUndefined();
        expect(opts.args).not.toContain("--environment-stdin");
      }
      expect(opts.args.join(" ")).not.toContain("synthetic-secret");
      await opts.onReady();
      ready = false;
      return 0;
    },
  };
  const opts = {
    runtime: { binary: join(root, "hack-local"), home: root },
    scope: {
      projectRoot: root,
      projectDir: join(root, ".hack"),
      nativeHome: root,
      branch: null,
    },
    composeFile: join(root, ".hack/docker-compose.yml"),
    sharedSource: true,
    before: async () => {
      events.push("before");
      return {
        cleanup: async () => {
          events.push("cleanup");
        },
        ready: async () => {
          events.push("ready");
        },
      };
    },
    dependencies,
  };
  return { opts, events };
}
test("foreground saves only after authoritative readiness and removes only after cleanup", async () => {
  const { opts, events } = await fixture();
  expect(await startNativeProject(opts)).toBe(0);
  expect(events).toEqual([
    "before",
    "runtime up",
    "graph dependency-plan",
    "graph inspect",
    "save",
    "ready",
    "graph inspect",
    "remove",
    "cleanup",
  ]);
});
test("uncertain foreground failure retains published mapping and cleans lifecycle listeners", async () => {
  const { opts, events } = await fixture();
  const original = opts.dependencies.serve;
  const inspect = opts.dependencies.invoke;
  let failed = false;
  opts.dependencies.invoke = async (args) => {
    if (failed) {
      throw new Error("uncertain");
    }
    return await inspect?.(args);
  };
  opts.dependencies.serve = async (args) => {
    await original?.(args);
    failed = true;
    throw new Error("uncertain");
  };
  const int = process.listenerCount("SIGINT"),
    term = process.listenerCount("SIGTERM");
  await expect(startNativeProject(opts)).rejects.toThrow("uncertain");
  expect(events).toContain("save");
  expect(events).not.toContain("remove");
  expect(events.at(-1)).toBe("cleanup");
  expect(process.listenerCount("SIGINT")).toBe(int);
  expect(process.listenerCount("SIGTERM")).toBe(term);
});
test("source opt-in and occupied mapping refuse before lifecycle or runtime effects", async () => {
  const { opts, events } = await fixture();
  await expect(
    startNativeProject({ ...opts, sharedSource: false })
  ).rejects.toThrow("HACK_NATIVE_SHARED_SOURCE");
  opts.dependencies.load = async () => ({
    run: "a".repeat(32),
    owner: "b".repeat(32),
    namespace: "c".repeat(64),
    planId: "d".repeat(64),
  });
  await expect(startNativeProject(opts)).rejects.toThrow("already");
  expect(events).toEqual([]);
});
test("caller cancellation is forwarded and lifecycle cleanup remains owned", async () => {
  const { opts, events } = await fixture();
  const controller = new AbortController();
  opts.dependencies.serve = async (args) => {
    controller.abort();
    expect(args.signal?.aborted).toBe(true);
    throw new Error("cancelled");
  };
  await expect(
    startNativeProject({ ...opts, signal: controller.signal })
  ).rejects.toThrow();
  expect(events.at(-1)).toBe("cleanup");
  expect(events).not.toContain("save");
});

test("cancellation after readiness still retires mapping when final cleanup is authoritative", async () => {
  const { opts, events } = await fixture();
  const controller = new AbortController();
  const original = opts.dependencies.serve;
  opts.dependencies.serve = async (args) => {
    await original?.(args);
    controller.abort();
    throw new Error("cancelled after ready");
  };
  expect(await startNativeProject({ ...opts, signal: controller.signal })).toBe(
    130
  );
  expect(events).toContain("save");
  expect(events).toContain("remove");
  expect(events.at(-1)).toBe("cleanup");
});

test("projects without managed values omit the private environment envelope", async () => {
  const { opts, events } = await fixture(false);
  expect(await startNativeProject(opts)).toBe(0);
  expect(events).toContain("remove");
});

test("AWS profile export follows native login hooks and precedes runtime effects", async () => {
  const { opts, events } = await fixture();
  opts.dependencies.adaptAws = async ({ input, profile }) => {
    expect(profile).toBe("qa-test");
    events.push("aws");
    return {
      input,
      receipt: { profile, expiry: "2099-01-01T00:00:00Z", services: ["web"] },
    };
  };
  expect(
    await startNativeProject({ ...opts, aws: { profile: "qa-test" } })
  ).toBe(0);
  expect(events.indexOf("aws")).toBeGreaterThan(events.indexOf("before"));
  expect(events.indexOf("aws")).toBeLessThan(events.indexOf("runtime up"));
  events.length = 0;
  opts.dependencies.adaptAws = async () => {
    throw new Error("expired profile");
  };
  await expect(
    startNativeProject({ ...opts, aws: { profile: "qa-test" } })
  ).rejects.toThrow("expired profile");
  expect(events).toEqual(["before", "cleanup"]);
});

test("reviewed dependency caches bind published source and successful completion readiness", async () => {
  const { opts } = await fixture(false);
  const review = opts.dependencies.review,
    invoke = opts.dependencies.invoke,
    serve = opts.dependencies.serve;
  opts.dependencies.review = async (input) => {
    if (!review) {
      throw new Error("missing fixture review");
    }
    return await review({
      ...input,
      run: async (reviewed) =>
        input.run({
          ...reviewed,
          report: {
            plan: {
              enrollment_compatible: true,
              services: {
                web: { active: true, dependency_cache: { volume: "modules" } },
              },
            },
          },
        }),
    });
  };
  opts.dependencies.invoke = async (input) =>
    input.args[1] === "publish-source"
      ? {
          revision: "e".repeat(64),
          namespace: "b".repeat(64),
          state: "guest-content-verified-no-job-started",
        }
      : await invoke?.(input);
  opts.dependencies.serve = async (input) => {
    expect(input.args).toContain("--source-revision");
    expect(input.args).toContain("e".repeat(64));
    expect(input.args).toContain("web=completed");
    if (!serve) {
      throw new Error("missing fixture serve");
    }
    return await serve(input);
  };
  expect(await startNativeProject(opts)).toBe(0);
});
