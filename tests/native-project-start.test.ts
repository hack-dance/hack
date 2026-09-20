import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("approved outbound hosts are forwarded exactly and sorted before runtime admission", async () => {
  const { opts } = await fixture(false);
  const invoke = opts.dependencies.invoke!;
  let up: readonly string[] = [];
  opts.dependencies.invoke = async (call) => {
    if (call.args[0] === "runtime" && call.args[1] === "up") {
      up = call.args;
    }
    return await invoke(call);
  };
  expect(
    await startNativeProject({
      ...opts,
      allowedHosts: ["registry.npmjs.org", "example.com"],
    })
  ).toBe(0);
  expect(up).toEqual([
    "runtime",
    "up",
    "--profile",
    "development",
    "--project-share",
    opts.scope.projectRoot,
    "--unfiltered-source",
    "--allow-host",
    "example.com",
    "--allow-host",
    "registry.npmjs.org",
    "--json",
  ]);
});
test("invalid outbound selection refuses before lifecycle or preparation effects", async () => {
  const { opts, events } = await fixture();
  opts.dependencies.load = async () => {
    throw new Error("load must not run");
  };
  opts.dependencies.prepare = async () => {
    throw new Error("prepare must not run");
  };
  for (const allowedHosts of [
    [""],
    ["*.example.com"],
    ["127.0.0.1"],
    ["host.local"],
    ["host.localhost"],
    ["EXAMPLE.com"],
    ["example.com."],
    ["example.com", "example.com"],
    Array.from({ length: 33 }, (_, i) => `h${i}.example.com`),
  ]) {
    await expect(startNativeProject({ ...opts, allowedHosts })).rejects.toThrow(
      "HACK_NATIVE_ALLOW_HOSTS"
    );
  }
  expect(events).toEqual([]);
});

test("host listener selections are read after hooks and bound to the exact reviewed plan", async () => {
  const { opts } = await fixture(false);
  const path = join(opts.scope.projectRoot, "host-selection.json");
  const prepare = opts.dependencies.prepare!;
  opts.dependencies.prepare = async (request) => {
    const input = await prepare(request);
    const compose = JSON.parse(input.normalizedComposeJson);
    compose.services.web.extra_hosts = ["search.example.com:host-gateway"];
    return { ...input, normalizedComposeJson: JSON.stringify(compose) };
  };
  const binding = {
    service: "web",
    binding: "search",
    guest_port: 443,
    host_pid: 123,
    host_port: 8443,
    aliases: ["search.example.com"],
  };
  const before = opts.before;
  opts.before = async () => {
    await writeFile(
      path,
      JSON.stringify({ version: 1, dependencies: [binding] })
    );
    return await before();
  };
  const invoke = opts.dependencies.invoke!;
  opts.dependencies.invoke = async (request) => {
    if (request.args[1] === "up") {
      expect(request.args).toContain("--dependency-sockets");
      expect(
        request.args[request.args.indexOf("--dependency-sockets") + 1]
      ).toBe("1");
    }
    if (request.args[1] === "dependency-plan") {
      const selected = JSON.parse(
        await readFile(String(request.args[3]), "utf8")
      );
      expect(selected.plan).toBe("a".repeat(64));
      expect(selected.dependencies).toEqual([{ ...binding, slot: 0 }]);
    }
    return await invoke(request);
  };
  await expect(startNativeProject(opts)).rejects.toThrow("cannot admit");
  expect(await startNativeProject({ ...opts, dependencyFile: path })).toBe(0);
});

test("invalid listener selection cleans lifecycle hooks before runtime effects", async () => {
  const { opts, events } = await fixture(false);
  const path = join(opts.scope.projectRoot, "host-selection.json");
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      dependencies: [{ password: "synthetic-private" }],
    })
  );
  await expect(
    startNativeProject({ ...opts, dependencyFile: path })
  ).rejects.toThrow("values omitted");
  expect(events).toEqual(["before", "cleanup"]);
});

test("retained startup failure preserves its diagnostic and never removes the run mapping", async () => {
  const { opts, events } = await fixture(false);
  const serve = opts.dependencies.serve!;
  const invoke = opts.dependencies.invoke!;
  let failed = false;
  opts.dependencies.serve = async (request) => {
    await serve(request);
    failed = true;
    throw new Error(
      "Native graph startup failed (graph_network_intent); inspect owned state before retrying."
    );
  };
  opts.dependencies.invoke = async (request) => {
    const result = await invoke(request);
    if (failed && request.args[1] === "inspect") {
      return {
        ...(result as Record<string, unknown>),
        receipt: {
          ...(result as { receipt: Record<string, unknown> }).receipt,
          phase: "failed-retained",
        },
      };
    }
    return result;
  };
  await expect(startNativeProject(opts)).rejects.toThrow(
    "graph_network_intent"
  );
  expect(events).not.toContain("remove");
  expect(events.at(-1)).toBe("cleanup");
});

test("routed startup reserves bridges and enrolls reviewed healthy services without dropping labels", async () => {
  const { opts } = await fixture(false);
  const prepare = opts.dependencies.prepare!;
  const review = opts.dependencies.review!;
  const invoke = opts.dependencies.invoke!;
  const serve = opts.dependencies.serve!;
  const labels = {
    caddy: "web.example.com",
    "caddy.reverse_proxy": "{{upstreams 3000}}",
    "caddy.tls": "internal",
  };
  const probe = {
    port: 3000,
    path: "/health",
    interval_ms: 100,
    timeout_ms: 500,
    retries: 3,
    start_period_ms: 0,
  };
  opts.dependencies.prepare = async (call) => {
    const input = await prepare(call);
    const compose = JSON.parse(input.normalizedComposeJson);
    compose.services.web.labels = labels;
    compose.services.web.healthcheck = { "x-hack-http": probe };
    return { ...input, normalizedComposeJson: JSON.stringify(compose) };
  };
  opts.dependencies.review = async (call) => {
    expect(
      JSON.parse(call.input.normalizedComposeJson).services.web.labels
    ).toEqual(labels);
    return await review({
      ...call,
      run: async (checked) =>
        call.run({
          ...checked,
          report: {
            plan: {
              enrollment_compatible: true,
              services: {
                web: {
                  active: true,
                  routing: { port: 3000, hostnames: ["web.example.com"] },
                  healthcheck: { native_http: probe, disabled: false },
                },
              },
            },
          },
        }),
    });
  };
  opts.dependencies.invoke = async (call) => {
    if (call.args[0] === "runtime" && call.args[1] === "up") {
      expect(call.args).toContain("--bridge-sockets");
      expect(call.args[call.args.indexOf("--bridge-sockets") + 1]).toBe("1");
    }
    return await invoke(call);
  };
  opts.dependencies.serve = async (call) => {
    expect(call.args).toContain("web=0");
    expect(call.args).toContain("web=healthy");
    return await serve(call);
  };
  expect(await startNativeProject(opts)).toBe(0);
});
