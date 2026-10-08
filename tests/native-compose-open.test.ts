import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openNativeComposeGenerationStore } from "../src/lib/native-compose-generation.ts";
import { resolveNativeComposeOpenOrigin } from "../src/lib/native-compose-open.ts";
import { renderNativeCompose } from "../src/lib/native-compose-renderer.ts";
import { openNativeComposeRouteClaims } from "../src/lib/native-compose-route-claims.ts";
import { prepareNativeComposeRouteOwner } from "../src/lib/native-compose-route-owner.ts";
import type { NativeRoutingResolution } from "../src/lib/native-routing-plan-protocol.ts";
import { composeFixture } from "./helpers/native-compose.ts";

const PRIVATE_CANARY = "native-open-private-value-must-not-leak";
const roots: string[] = [];
const children: Bun.Subprocess<"ignore", "pipe", "pipe">[] = [];
const BINDING = {
  engineId: "native-open-fixture:1",
  proxyId: "a".repeat(64),
  networkId: "b".repeat(64),
  proxyIp: "172.30.0.2",
};
const RESOLUTION: NativeRoutingResolution = {
  domain: "dev.test",
  domain_origin: "project",
  project_origin: "https://fixture.dev.test",
  aliases: { oauth: "https://fixture.oauth.test" },
  oauth_alias: "oauth",
  open_preference: "auto",
  open_preference_origin: "default",
  open_origin: "https://fixture.oauth.test",
  routes: {
    app: {
      service: "web",
      port: 3000,
      protocol: "http",
      origin: "https://fixture.dev.test",
      aliases: { oauth: "https://fixture.oauth.test" },
    },
  },
};

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
    await child.exited;
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function fixture(): Promise<string> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-compose-open-"))
  );
  roots.push(root);
  await mkdir(join(root, ".hack"));
  await mkdir(join(root, "home"));
  await Bun.write(
    join(root, ".hack", "hack.project.json"),
    "malformed authored input must never be parsed for saved open"
  );
  for (const name of ["docker", "compiler", "open"]) {
    const path = join(root, name);
    await Bun.write(
      path,
      `#!${process.execPath}\nawait Bun.write(${JSON.stringify(join(root, "unexpected-effect"))}, ${JSON.stringify(name)}); process.exit(99);\n`
    );
    await chmod(path, 0o700);
  }
  return root;
}

/** Real private publication/leases with substituted ingress/engine observations only. */
async function save(opts: {
  readonly root: string;
  readonly instance?: string;
  readonly mode?: "valid" | "malformed" | "pending" | "unrouted";
}): Promise<void> {
  const store = await openNativeComposeGenerationStore({
    projectRoot: opts.root,
    instance: opts.instance ?? null,
  });
  try {
    await store.withMutation(async (mutation) => {
      const reservation = mutation.reserveGeneration();
      const input = composeFixture({
        services: {
          web: {
            image: "fixture/web:1",
            environment: { PRIVATE: { literal: PRIVATE_CANARY } },
          },
        },
      });
      input.environmentPlan.workloads.web = {
        PRIVATE: { kind: "literal", value: PRIVATE_CANARY },
      };
      const routed = opts.mode !== "unrouted";
      input.plan.worktree.auto_branch = false;
      if (routed) {
        input.plan.routes = {
          domain: "dev.test",
          aliases: { oauth: { domain: "oauth.test" } },
          oauth_alias: "oauth",
          http: {
            app: {
              service: "web",
              port: 3000,
              protocol: "http",
              hostname: "project",
            },
          },
        };
      }
      const rendered = renderNativeCompose({
        ...input,
        projectRoot: opts.root,
        runtimeIdentity: store.identity.composeProject,
        ownerToken: store.identity.ownerToken,
        generationIdentity: reservation.generationId,
        ...(routed
          ? {
              routingResolution: RESOLUTION,
              declaredWorkloads: { web: "service" },
            }
          : {}),
      });
      const routing = routed
        ? await prepareNativeComposeRouteOwner({
            owner: store.identity,
            generationId: reservation.generationId,
            document: rendered.document,
            plan: input.plan,
            resolution: RESOLUTION,
            declared: { web: "service" },
            previous: [],
            io: {
              ingress: async () => BINDING,
              inventory: async () => {},
              proxy: async () => {},
              claims: (claimOpts) =>
                openNativeComposeRouteClaims({
                  ...claimOpts,
                  root: join(opts.root, "fixture-claims"),
                }),
            },
          })
        : null;
      try {
        const document: Record<string, unknown> = structuredClone(
          routing?.document ?? rendered.document
        );
        if (opts.mode === "malformed") {
          document["x-hack-native-routing"] = {
            version: 1,
            resolution: { open_origin: PRIVATE_CANARY },
          };
        }
        const generation = await mutation.publish({
          reservation,
          composeJson: JSON.stringify(document),
          profiles: [],
          inputRevision: createHash("sha256")
            .update("synthetic native open revision")
            .digest("hex"),
          assertFresh: async () => {},
        });
        await mutation.runEffect({
          generation,
          operation: "up",
          assertFresh: async () => {},
          assertOwned: async () => {},
          effect: async () => {
            await routing?.markEffectsPossible();
            if (opts.mode === "pending") {
              return { outcome: "uncertain", value: 0 };
            }
            await routing?.complete({ deadline: Date.now() + 5000 });
            return { outcome: "complete", value: 0 };
          },
        });
      } finally {
        await routing?.close();
      }
    });
  } finally {
    await store.close();
  }
}

async function invoke(root: string, args: readonly string[]) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      resolve(import.meta.dir, "../index.ts"),
      "open",
      ...args,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${root}:/usr/bin:/bin`,
        HACK_HOME: join(root, "home"),
        HACK_GLOBAL_CONFIG_PATH: join(root, "home", "hack.config.json"),
        HACK_CONFIG_COMPILER_BINARY: join(root, "compiler"),
        HACK_RUNTIME_BACKEND: "compose",
        HACK_NO_INTERACTIVE: "1",
        HACK_LOGGER: "console",
        GIT_DIR: "",
        GIT_WORK_TREE: "",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  children.push(child);
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(`${stdout}\n${stderr}`).not.toContain(PRIVATE_CANARY);
  expect(await Bun.file(join(root, "unexpected-effect")).exists()).toBe(false);
  return { code, stdout, stderr };
}

test("native open JSON uses the saved compiler preference with no authored/env/compiler/engine/browser effects", async () => {
  const root = await fixture();
  await save({ root });
  for (const [args, origin] of [
    [["--json"], RESOLUTION.open_origin],
    [["--json", "--prefer", "dev"], RESOLUTION.project_origin],
    [["app", "--json", "--prefer", "alias"], RESOLUTION.aliases.oauth],
  ] as const) {
    const result = await invoke(root, args);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ url: origin });
  }
});

test("native open selects the exact named saved instance and does not substitute the default", async () => {
  const root = await fixture();
  await save({ root, instance: "review" });
  expect((await invoke(root, ["--json"])).code).toBe(1);
  const result = await invoke(root, ["--branch", "review", "--json"]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ url: RESOLUTION.open_origin });
});

test("native open refuses malformed, pending, unrouted and unsaved generations without fallback", async () => {
  for (const mode of ["malformed", "pending", "unrouted", "unsaved"] as const) {
    const root = await fixture();
    if (mode !== "unsaved") {
      await save({ root, mode });
    }
    const result = await invoke(root, ["--json"]);
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain("https://");
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      mode === "unrouted" ? "E_NATIVE_PROJECT_UNSUPPORTED" : "E_CONFIG_INVALID"
    );
  }
});

test("native open refuses unknown/arbitrary targets and invalid preferences", async () => {
  const root = await fixture();
  await save({ root });
  for (const args of [
    ["logs", "--json"],
    ["https://external.test", "--json"],
    ["constructor", "--json"],
    ["toString", "--json"],
    ["__proto__", "--json"],
    ["--prefer", "unknown", "--json"],
  ]) {
    expect((await invoke(root, args)).code).toBe(1);
  }
});

test("legacy open JSON preserves authored host behavior without a native store", async () => {
  const root = await fixture();
  await rm(join(root, ".hack", "hack.project.json"));
  await Bun.write(
    join(root, ".hack", "hack.config.json"),
    JSON.stringify({
      name: "fixture",
      dev_host: "legacy.dev.test",
      oauth: { enabled: false },
    })
  );
  await Bun.write(join(root, ".hack", "docker-compose.yml"), "services: {}\n");
  const result = await invoke(root, ["--json"]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ url: "https://legacy.dev.test" });
  expect(
    await Bun.file(
      join(root, ".hack", ".internal", "native-compose", ".gitignore")
    ).exists()
  ).toBe(false);
});

test("native/legacy conflict refuses before legacy host selection", async () => {
  const root = await fixture();
  await Bun.write(
    join(root, ".hack", "hack.config.json"),
    JSON.stringify({ name: "fixture", dev_host: "must-not-open.dev.test" })
  );
  const result = await invoke(root, ["--json"]);
  expect(result.code).toBe(1);
  expect(`${result.stdout}\n${result.stderr}`).toContain(
    "E_NATIVE_PROJECT_CONFLICT"
  );
  expect(result.stdout).not.toContain("must-not-open");
});

test("pure saved route selection refuses an unserved default origin or unavailable OAuth alias", () => {
  expect(() =>
    resolveNativeComposeOpenOrigin({
      resolution: { ...RESOLUTION, open_origin: "https://unserved.dev.test" },
    })
  ).toThrow("saved routed generation");
  expect(() =>
    resolveNativeComposeOpenOrigin({
      resolution: { ...RESOLUTION, oauth_alias: null },
      prefer: "alias",
    })
  ).toThrow("unavailable");
  expect(
    resolveNativeComposeOpenOrigin({
      resolution: RESOLUTION,
      target: "www",
      prefer: "dev",
    })
  ).toBe(RESOLUTION.project_origin);
});

test("saved route and alias selection require own members while a declared constructor route remains valid", () => {
  const route = RESOLUTION.routes.app;
  if (!route) {
    throw new Error("Fixture app route is missing");
  }
  const ownConstructor = { ...RESOLUTION, routes: { constructor: route } };
  expect(
    resolveNativeComposeOpenOrigin({
      resolution: ownConstructor,
      target: "constructor",
    })
  ).toBe(RESOLUTION.open_origin);
  expect(() =>
    resolveNativeComposeOpenOrigin({
      resolution: { ...RESOLUTION, aliases: {}, oauth_alias: "constructor" },
      prefer: "alias",
    })
  ).toThrow("unavailable");
});

test("explicit authored www route wins over the legacy default shorthand", () => {
  const route = RESOLUTION.routes.app;
  if (!route) {
    throw new Error("Fixture app route is missing");
  }
  const resolution = {
    ...RESOLUTION,
    routes: {
      ...RESOLUTION.routes,
      www: {
        ...route,
        origin: "https://www.fixture.dev.test",
        aliases: { oauth: "https://www.fixture.oauth.test" },
      },
    },
  };
  expect(resolveNativeComposeOpenOrigin({ resolution, target: "www" })).toBe(
    "https://www.fixture.oauth.test"
  );
  expect(
    resolveNativeComposeOpenOrigin({ resolution, target: "www", prefer: "dev" })
  ).toBe("https://www.fixture.dev.test");
  expect(resolveNativeComposeOpenOrigin({ resolution })).toBe(
    RESOLUTION.open_origin
  );
});
