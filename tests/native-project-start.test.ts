import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeProjectRun } from "../src/backends/native-project-run.ts";
import {
  parseNativeHttpsSelection,
  reviewedNativeHttpsRoutes,
  startNativeProject,
  verifyHttpsRoutes,
} from "../src/backends/native-project-start.ts";

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
      try {
        await opts.onReady();
        return 0;
      } finally {
        ready = false;
      }
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
  await expect(startNativeProject(opts)).rejects.toThrow(
    "cleanup is unconfirmed"
  );
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
    compose.services.worker = { ...compose.services.web };
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
      JSON.stringify({
        version: 1,
        dependencies: [binding, { ...binding, service: "worker" }],
      })
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
      expect(selected.dependencies).toEqual([
        { ...binding, slot: 0 },
        { ...binding, service: "worker", slot: 0 },
      ]);
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

const httpsSelection = {
  caddyBinary: "/synthetic/caddy",
  caddySha256: "a".repeat(64),
  httpsPort: 8443,
};
async function httpsFixture() {
  const result = await fixture(false);
  const { opts } = result;
  const prepare = opts.dependencies.prepare!;
  const review = opts.dependencies.review!;
  const probe = {
    port: 3000,
    path: "/health",
    interval_ms: 100,
    timeout_ms: 500,
    retries: 3,
    start_period_ms: 0,
  };
  opts.dependencies.prepare = async (request) => {
    const input = await prepare(request);
    return {
      ...input,
      normalizedComposeJson: JSON.stringify({
        services: {
          web: {
            image: `sha256:${"e".repeat(64)}`,
            labels: {
              caddy: "web.example.com",
              "caddy.reverse_proxy": "{{upstreams 3000}}",
              "caddy.tls": "internal",
            },
            healthcheck: { "x-hack-http": probe },
          },
        },
      }),
    };
  };
  opts.dependencies.review = async (request) =>
    review({
      ...request,
      run: async (checked) =>
        request.run({
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
  return result;
}
test("HTTPS selection requires all explicit canonical fields before effects", async () => {
  expect(parseNativeHttpsSelection({})).toBeUndefined();
  expect(
    parseNativeHttpsSelection({
      HACK_NATIVE_CADDY_BINARY: httpsSelection.caddyBinary,
      HACK_NATIVE_CADDY_SHA256: httpsSelection.caddySha256,
      HACK_NATIVE_HTTPS_PORT: "8443",
    })
  ).toEqual(httpsSelection);
  for (const env of [
    { HACK_NATIVE_CADDY_BINARY: "/caddy" },
    {
      HACK_NATIVE_CADDY_BINARY: "/caddy",
      HACK_NATIVE_CADDY_SHA256: "a".repeat(64),
      HACK_NATIVE_HTTPS_PORT: "08443",
    },
  ]) {
    expect(() => parseNativeHttpsSelection(env)).toThrow();
  }
  const { opts, events } = await fixture(false);
  await expect(
    startNativeProject({ ...opts, https: { ...httpsSelection, httpsPort: 0 } })
  ).rejects.toThrow();
  expect(events).toEqual([]);
});
test("unrouted graphs do not start the selected HTTPS frontend", async () => {
  const { opts } = await fixture(false);
  opts.dependencies.https = async () => {
    throw new Error("unexpected frontend");
  };
  expect(await startNativeProject({ ...opts, https: httpsSelection })).toBe(0);
});
test("routed HTTPS verification precedes readiness and closes after graph cleanup", async () => {
  const { opts, events } = await httpsFixture();
  opts.dependencies.https = async (selection) => {
    expect(selection).toEqual({ runtime: opts.runtime, ...httpsSelection });
    events.push("https-start");
    return {
      caPath: "/synthetic/root.crt",
      httpsPort: 8443,
      exited: new Promise(() => {}),
      verifyHostname: async (hostname, path) => {
        expect(path).toBe("/health");
        expect(hostname).toBe("web.example.com");
        events.push("https-verify");
        return { statusCode: 200 };
      },
      close: async () => {
        events.push("https-close");
      },
    };
  };
  expect(await startNativeProject({ ...opts, https: httpsSelection })).toBe(0);
  expect(events.indexOf("https-start")).toBeLessThan(
    events.indexOf("https-verify")
  );
  expect(events.indexOf("https-verify")).toBeLessThan(events.indexOf("save"));
  expect(events.indexOf("remove")).toBeLessThan(events.indexOf("https-close"));
  expect(events.indexOf("https-close")).toBeLessThan(events.indexOf("cleanup"));
});
test("unexpected HTTPS owner exit aborts the graph and fails instead of returning interrupt status", async () => {
  const { opts, events } = await httpsFixture();
  let exit!: (value: { component: string; code: number }) => void;
  const exited = new Promise<{ component: string; code: number }>((resolve) => {
    exit = resolve;
  });
  opts.dependencies.https = async () => ({
    caPath: "/synthetic/root.crt",
    httpsPort: 8443,
    exited,
    verifyHostname: async () => ({ statusCode: 200 }),
    close: async () => {
      events.push("https-close");
    },
  });
  const serve = opts.dependencies.serve!;
  opts.dependencies.serve = async (request) => {
    await serve(request);
    exit({ component: "caddy", code: 1 });
    await Promise.resolve();
    expect(request.signal?.aborted).toBe(true);
    return 0;
  };
  await expect(
    startNativeProject({ ...opts, https: httpsSelection })
  ).rejects.toThrow("HTTPS owner exited unexpectedly");
  expect(events.indexOf("remove")).toBeLessThan(events.indexOf("https-close"));
  expect(events.at(-1)).toBe("cleanup");
});

test("HTTPS readiness failure preserves its cause without removing an unpublished mapping", async () => {
  const { opts, events } = await httpsFixture();
  const failure = new Error("synthetic HTTPS verification failure");
  opts.dependencies.https = async () => ({
    caPath: "/synthetic/root.crt",
    httpsPort: 8443,
    exited: new Promise(() => {}),
    verifyHostname: async () => {
      throw failure;
    },
    close: async () => {
      events.push("https-close");
    },
  });
  opts.dependencies.remove = async () => {
    events.push("remove");
    throw new Error("mapping was never saved");
  };
  await expect(
    startNativeProject({ ...opts, https: httpsSelection })
  ).rejects.toBe(failure);
  expect(events).not.toContain("save");
  expect(events).not.toContain("remove");
  expect(events).not.toContain("ready");
  expect(events.slice(-2)).toEqual(["https-close", "cleanup"]);
});

test("mapping save failure preserves its cause without removing an unconfirmed mapping", async () => {
  const { opts, events } = await fixture();
  const failure = new Error("synthetic mapping publication failure");
  opts.dependencies.save = async () => {
    events.push("save-attempt");
    throw failure;
  };
  opts.dependencies.remove = async () => {
    events.push("remove");
    throw new Error("mapping was never saved");
  };
  await expect(startNativeProject(opts)).rejects.toBe(failure);
  expect(events).toContain("save-attempt");
  expect(events).not.toContain("remove");
  expect(events).not.toContain("ready");
  expect(events.at(-1)).toBe("cleanup");
});

test("failed cleanup reports sanitized TLS failure and retained state without removing mapping", async () => {
  const { opts, events } = await httpsFixture();
  const failure = new Error(
    "Native HTTPS verification failed (VERIFICATION_TIMEOUT_RESPONSE); peer values omitted."
  );
  opts.dependencies.https = async () => ({
    caPath: "/synthetic/root.crt",
    httpsPort: 8443,
    exited: new Promise(() => {}),
    verifyHostname: async () => {
      throw failure;
    },
    close: async () => {},
  });
  const serve = opts.dependencies.serve!;
  opts.dependencies.serve = async (request) => {
    try {
      return await serve(request);
    } finally {
      request.onExitDiagnostic?.({
        exitCode: 2,
        nativeCode: "graph_owner_recovery",
      });
    }
  };
  const invoke = opts.dependencies.invoke!;
  let inspections = 0;
  opts.dependencies.invoke = async (request) => {
    const value = await invoke(request);
    if (request.args[1] === "inspect" && ++inspections === 2) {
      return {
        ...(value as object),
        observations: { "container:web": { state: "running" } },
      };
    }
    return value;
  };
  let caught: unknown;
  try {
    await startNativeProject({ ...opts, https: httpsSelection });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toContain("cleanup is unconfirmed");
  expect((caught as Error).message).toContain(
    "runtime and bridge state may be retained"
  );
  expect((caught as Error).message).toContain("VERIFICATION_TIMEOUT_RESPONSE");
  expect((caught as Error).message).toContain(
    "Native exit diagnostic: graph_owner_recovery"
  );
  expect((caught as Error).cause).toBeUndefined();
  expect(events).not.toContain("remove");
});

test("final inspection failure reports uncertainty without echoing arbitrary failure values", async () => {
  const { opts, events } = await fixture();
  const invoke = opts.dependencies.invoke!;
  let inspections = 0;
  opts.dependencies.invoke = async (request) => {
    if (request.args[1] === "inspect" && ++inspections === 2) {
      throw new Error("synthetic-private-canary");
    }
    return invoke(request);
  };
  const failure = await startNativeProject(opts).catch(
    (error: unknown) => error
  );
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain("cleanup is unconfirmed");
  expect((failure as Error).message).not.toContain("synthetic-private-canary");
  expect((failure as Error).cause).toBeUndefined();
  expect(Bun.inspect(failure)).not.toContain("synthetic-private-canary");
  expect(JSON.stringify(failure)).not.toContain("synthetic-private-canary");
  expect(events).not.toContain("remove");
});

test("HTTPS route paths come only from reviewed native probes and conflicts refuse", () => {
  const service = (path: string) => ({
    routing: { hostnames: ["web.example.com"] },
    healthcheck: { native_http: { path } },
  });
  expect(
    reviewedNativeHttpsRoutes(
      { services: { web: service("/api/health") } },
      new Set(["web"])
    )
  ).toEqual([
    { hostname: "web.example.com", path: "/api/health", service: "web" },
  ]);
  expect(() =>
    reviewedNativeHttpsRoutes(
      { services: { web: service("/health"), other: service("/other") } },
      new Set(["web", "other"])
    )
  ).toThrow();
  expect(() =>
    reviewedNativeHttpsRoutes(
      { services: { web: { routing: { hostnames: ["web.example.com"] } } } },
      new Set(["web"])
    )
  ).toThrow();
});

test("HTTPS startup refuses a non-2xx reviewed health response", async () => {
  const { opts, events } = await httpsFixture();
  opts.dependencies.https = async () => ({
    caPath: "/synthetic/root.crt",
    httpsPort: 8443,
    exited: new Promise(() => {}),
    verifyHostname: async () => ({ statusCode: 403 }),
    close: async () => {
      events.push("https-close");
    },
  });
  await expect(
    startNativeProject({ ...opts, https: httpsSelection })
  ).rejects.toThrow("HTTP_STATUS_403");
  expect(events).not.toContain("save");
  expect(events).toContain("https-close");
});

test("HTTPS redirects terminate only at verified same-service reviewed aliases", async () => {
  const plan = {
    services: {
      web: {
        routing: {
          hostnames: ["legacy.hack", "canonical.hack.gy", "third.hack.local"],
        },
        healthcheck: { native_http: { path: "/health" } },
      },
      other: {
        routing: { hostnames: ["other.hack"] },
        healthcheck: { native_http: { path: "/health" } },
      },
    },
  };
  const responses = new Map<string, { statusCode: number; location?: string }>([
    [
      "legacy.hack",
      { statusCode: 307, location: "https://canonical.hack.gy/health" },
    ],
    [
      "canonical.hack.gy",
      { statusCode: 308, location: "https://third.hack.local:18443/health" },
    ],
    ["third.hack.local", { statusCode: 200 }],
    ["other.hack", { statusCode: 204 }],
  ]);
  const calls: string[] = [];
  const frontend = {
    caPath: "/public",
    httpsPort: 18_443,
    exited: new Promise<{ component: string; code: number }>(() => {}),
    close: async () => {},
    verifyHostname: async (hostname: string, path: string) => {
      expect(path).toBe("/health");
      calls.push(hostname);
      const response = responses.get(hostname);
      if (!response) {
        throw new Error("Unexpected network target");
      }
      return response;
    },
  };
  await verifyHttpsRoutes(frontend, plan, new Set(["web", "other"]));
  expect(calls.length).toBe(4);
  for (const location of [
    "http://canonical.hack.gy/health",
    "https://external.invalid/health",
    "https://other.hack/health",
    "https://user:pass@canonical.hack.gy/health",
    "https://canonical.hack.gy:1234/health",
    "https://canonical.hack.gy/wrong",
    "https://canonical.hack.gy/health?q=1",
    "https://canonical.hack.gy/health#fragment",
    "https://legacy.hack/health",
  ]) {
    responses.set("legacy.hack", { statusCode: 307, location });
    await expect(
      verifyHttpsRoutes(frontend, plan, new Set(["web", "other"]))
    ).rejects.toThrow();
  }
  responses.set("legacy.hack", {
    statusCode: 307,
    location: "https://canonical.hack.gy/health",
  });
  responses.set("third.hack.local", { statusCode: 503 });
  await expect(
    verifyHttpsRoutes(frontend, plan, new Set(["web", "other"]))
  ).rejects.toThrow();
});

test("startup persists resolved environment selection only after readiness", async () => {
  const { opts } = await fixture();
  const prepare = opts.dependencies.prepare!;
  opts.dependencies.prepare = async (request) => ({
    ...(await prepare(request)),
    effectiveEnvName: "qa",
  });
  let saved: NativeProjectRun | undefined;
  opts.dependencies.save = async (request) => {
    saved = request.run;
  };
  opts.dependencies.remove = async (request) => {
    expect(saved).toBe(request.expected);
  };
  expect(await startNativeProject(opts)).toBe(0);
  expect(saved).toMatchObject({ effectiveEnvName: "qa" });
});
