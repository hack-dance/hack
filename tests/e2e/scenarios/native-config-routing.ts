import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { Project } from "../../../packages/config-compiler/generated/native-config.ts";
import { isRecord } from "../../../src/lib/guards.ts";
import { openNativeComposeGenerationStore } from "../../../src/lib/native-compose-generation.ts";
import {
  type NativeRoutingResolution,
  parseNativeRoutingResolution,
} from "../../../src/lib/native-routing-plan-protocol.ts";
import {
  addLinkedWorktree,
  commitAll,
  createMonorepoFixture,
} from "../fixture.ts";
import {
  type CliResult,
  expect,
  expectExit,
  resolveCliSpawnArgs,
  runCommand,
  type Scenario,
} from "../harness.ts";
import {
  nativeRoutedDownClaimSnapshot as claimSnapshot,
  qualifyNativeComposeRoutedDownHooks,
} from "./native-config-routed-down-hooks.ts";
import {
  nativeRoutedRunPinnedOriginCheck,
  qualifyNativeComposeRoutedRun,
  ROUTED_RUN_LITERAL,
} from "./native-config-routed-run.ts";

import {
  NATIVE_ROUTING_FIXTURE_TMPFS as PRIVATE_TMPFS,
  prepareNativeRoutingFixtureIngress,
} from "./native-routing-fixture-ingress.ts";

const TIMEOUT = 180_000;
const OBJECT_ID = /^[a-f0-9]{64}$/;
const TOKEN = /^[a-f0-9]{32}$/;
const PROJECT_LABEL = "com.docker.compose.project";
const OWNER_LABEL = "io.hack.native-config.owner";
const INSTANCE_LABEL = "io.hack.native-config.instance";
const STORAGE_LABEL = "io.hack.native-config.storage";
const APP =
  "Bun.serve({hostname:'0.0.0.0',port:3000,fetch(){return new Response(process.env.BRANCH_MARKER)}})";
type Docker = (args: readonly string[]) => Promise<string>;
type Runtime = {
  readonly composeProject: string;
  readonly ownerToken: string;
  readonly hasGeneration: boolean;
  readonly needsDown: boolean;
};
type Checkout = { readonly root: string; readonly marker: string };
type VolumePin = { readonly name: string; readonly createdAt: string };

async function expectedVolumeName(
  root: string,
  owner: Runtime
): Promise<string> {
  const store = await openNativeComposeGenerationStore({
    projectRoot: root,
    instance: null,
    mode: "saved",
  });
  try {
    const generation = (await store.loadCurrent()).generation;
    if (
      !generation ||
      store.identity.composeProject !== owner.composeProject ||
      store.identity.ownerToken !== owner.ownerToken
    ) {
      throw new Error("Saved fixture storage identity is unavailable");
    }
    return await store.withLease({
      generation,
      run: async () => {
        const document = await store.readGenerationDocument(generation);
        if (
          !(
            isRecord(document.volumes) &&
            Object.keys(document.volumes).join() === "state" &&
            isRecord(document.volumes.state) &&
            typeof document.volumes.state.name === "string"
          )
        ) {
          throw new Error(
            "Fixture requires exactly its declared physical state volume"
          );
        }
        return document.volumes.state.name;
      },
    });
  } finally {
    await store.close();
  }
}

export function nativeRoutingFixtureVolumeMatches(opts: {
  readonly value: unknown;
  readonly name: string;
  readonly owner: Pick<Runtime, "composeProject" | "ownerToken">;
}): boolean {
  const { value, name, owner } = opts;
  return (
    isRecord(value) &&
    value.name === name &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    isRecord(value.labels) &&
    value.labels[OWNER_LABEL] === owner.ownerToken &&
    value.labels[INSTANCE_LABEL] === owner.composeProject &&
    value.labels[PROJECT_LABEL] === owner.composeProject &&
    value.labels[STORAGE_LABEL] === "state"
  );
}

async function observedVolume(
  name: string,
  owner: Runtime,
  docker: Docker
): Promise<VolumePin> {
  const value = object(
    await docker([
      "volume",
      "inspect",
      name,
      "--format",
      '{"name":{{json .Name}},"createdAt":{{json .CreatedAt}},"labels":{{json .Labels}}}',
    ])
  );
  expect({
    that: nativeRoutingFixtureVolumeMatches({ value, name, owner }),
    message:
      "Fixture storage requires the exact declared name, creation identity and logical storage owner",
  });
  if (typeof value.createdAt !== "string") {
    throw new Error("Missing fixture volume creation identity");
  }
  return { name, createdAt: value.createdAt };
}

export function nativeRoutingFixtureVolumeSelectionMatches(
  resources: readonly string[],
  pin: VolumePin | undefined
): boolean {
  return pin === undefined
    ? resources.length === 0
    : resources.length === 1 && resources[0] === pin.name;
}

function volumeSelection(
  resources: readonly string[],
  pin: VolumePin | undefined
): void {
  expect({
    that: nativeRoutingFixtureVolumeSelectionMatches(resources, pin),
    message:
      "Refuse extra or unpinned same-project volumes before any fixture deletion",
  });
}

function object(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) {
    throw new Error("Expected a complete JSON object; values omitted");
  }
  return value;
}

function ids(text: string): readonly string[] {
  const found = text.split(/\s+/).filter(Boolean).sort();
  expect({
    that:
      found.every((id) => OBJECT_ID.test(id)) &&
      new Set(found).size === found.length,
    message: "Docker must return unique complete fixture resource IDs",
  });
  return found;
}

function origins(resolution: NativeRoutingResolution): readonly string[] {
  const route = resolution.routes.app;
  if (!route) {
    throw new Error("Native app route resolution is missing");
  }
  return [route.origin, ...Object.values(route.aliases)].sort();
}

function hostnames(resolution: NativeRoutingResolution): readonly string[] {
  return origins(resolution).map((origin) => new URL(origin).hostname);
}

function authored(opts: {
  readonly name: string;
  readonly image: string;
  readonly domain: string;
  readonly aliasDomain: string;
  readonly marker: string;
}): Project {
  return {
    schema_version: 1,
    name: opts.name,
    source: { root: ".", mode: "host-mounted" },
    worktree: { auto_branch: true, inherit_local: true },
    storage: { state: { kind: "persistent", scope: "worktree" } },
    services: {
      web: {
        image: opts.image,
        pull_policy: "never",
        command: { exec: ["bun", "-e", APP] },
        restart: { kind: "no" },
        environment: {
          BRANCH_MARKER: { literal: opts.marker },
          RUN_LITERAL: { literal: ROUTED_RUN_LITERAL },
        },
        mounts: [{ storage: "state", target: "/state", access: "read-write" }],
        readiness: {
          kind: "exec",
          command: {
            exec: [
              "bun",
              "-e",
              "const r=await fetch('http://127.0.0.1:3000/',{signal:AbortSignal.timeout(4000)});process.exit(r.ok?0:1)",
            ],
          },
          interval: "1s",
          timeout: "5s",
          retries: 30,
        },
      },
    },
    routes: {
      domain: opts.domain,
      aliases: { oauth: { domain: opts.aliasDomain } },
      oauth_alias: "oauth",
      http: {
        app: {
          service: "web",
          port: 3000,
          protocol: "http",
          hostname: "project",
        },
      },
    },
  };
}

/** An earlier failure remains primary, while cleanup failure also fails a passing run. */
async function runWithOwnedCleanup(opts: {
  readonly run: () => Promise<void>;
  readonly cleanup: () => Promise<void>;
  readonly cleanupFailure: () => Promise<void>;
}): Promise<void> {
  let failed = false;
  let failure: unknown;
  try {
    await opts.run();
  } catch (error: unknown) {
    failed = true;
    failure = error;
  }
  try {
    await opts.cleanup();
  } catch (error: unknown) {
    await opts.cleanupFailure();
    if (!failed) {
      throw error;
    }
  }
  if (failed) {
    throw failure;
  }
}

async function runtime(root: string): Promise<Runtime | null> {
  try {
    const store = await openNativeComposeGenerationStore({
      projectRoot: root,
      instance: null,
      mode: "saved",
    });
    try {
      const state = await store.loadCurrent();
      const pending = await store.loadPending();
      expect({
        that: TOKEN.test(store.identity.ownerToken),
        message: "Native fixture store must retain a valid random owner token",
      });
      return {
        composeProject: store.identity.composeProject,
        ownerToken: store.identity.ownerToken,
        hasGeneration: state.generation !== null || pending !== null,
        needsDown: !state.stopped || state.pending !== null,
      };
    } finally {
      await store.close();
    }
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/** Same-engine Caddy routing/TLS acceptance, with no host port, DNS or trust effects. */
export const nativeConfigRoutingScenario: Scenario = {
  name: "native-config-routing",
  tier: "docker",
  summary:
    "native Caddy TLS routes/OAuth alias, linked worktrees, replacement and owned retirement",
  run: async (ctx) => {
    const started = performance.now();
    const stage = (message: string): void =>
      ctx.log(
        `${message} (elapsed ${Math.round(performance.now() - started)}ms)`
      );
    expect({
      that: resolveCliSpawnArgs([]).length === 1,
      message:
        "Native routing acceptance requires the current compiled CLI and companion compiler",
    });
    const docker: Docker = async (args) => {
      const result = await runCommand({
        argv: ["docker", ...args],
        cwd: ctx.tempRoot,
        timeoutMs: TIMEOUT,
      });
      expectExit({
        result,
        codes: [0],
        message: `Fixture Docker ${args[0]} must succeed`,
      });
      return result.stdout.trim();
    };
    const ingress = await prepareNativeRoutingFixtureIngress({ ctx, docker });
    const {
      token,
      proxyName,
      canaryHost,
      canaryMarker,
      networkId,
      bunImage,
      admin,
      tls,
      absent,
      preservedUnchanged,
    } = ingress;
    const nativeInventory = async (): Promise<string> =>
      ids(
        await docker([
          "ps",
          "--no-trunc",
          "-aq",
          "--filter",
          "label=io.hack.native-config.version=1",
        ])
      ).join("\n");
    const nativeBefore = await nativeInventory();
    const privateRoot = await realpath(ctx.tempRoot);
    let claimsRoot: string | null = null;
    const attempted = new Set<string>();
    const successfulStarts = new Set<string>();
    const knownOwners = new Map<string, Runtime>();
    const volumePins = new Map<string, VolumePin>();
    const env = {
      HACK_RUNTIME_BACKEND: "compose",
      HACK_DAEMON_DISABLE_DOCKER_EVENTS: "1",
      ...(process.env.HACK_CONFIG_COMPILER_BINARY
        ? {
            HACK_CONFIG_COMPILER_BINARY:
              process.env.HACK_CONFIG_COMPILER_BINARY,
          }
        : {}),
    };
    const raw = (
      root: string,
      args: readonly string[],
      extra: Readonly<Record<string, string>> = {}
    ): Promise<CliResult> =>
      ctx.cli({
        args,
        cwd: root,
        timeoutMs: TIMEOUT,
        env: { ...env, ...extra },
      });
    const cli = async (
      root: string,
      args: readonly string[]
    ): Promise<CliResult> => {
      const result = await raw(root, args);
      expectExit({
        result,
        codes: [0],
        message: `Native hack ${args[0]} must succeed`,
      });
      return result;
    };
    const plan = async (root: string): Promise<NativeRoutingResolution> => {
      const payload = object(
        (await cli(root, ["config", "plan", "--json"])).stdout
      );
      const resolution = parseNativeRoutingResolution(
        payload.routing_resolution
      );
      if (!(payload.ok === true && resolution)) {
        throw new Error(
          "Current compiler routing report is missing or malformed"
        );
      }
      const open = object((await cli(root, ["open", "--json"])).stdout);
      expect({
        that: open.url === resolution.open_origin,
        message: "Native open must select the compiler's OAuth-aware origin",
      });
      return resolution;
    };
    const check = async (
      checkout: Checkout
    ): Promise<NativeRoutingResolution> => {
      const resolution = await plan(checkout.root);
      expect({
        that:
          origins(resolution).length === 2 &&
          resolution.oauth_alias === "oauth",
        message: "Native project and OAuth alias must both be resolved",
      });
      for (const origin of origins(resolution)) {
        await tls(origin, checkout.marker);
      }
      await tls(`https://${canaryHost}`, canaryMarker);
      await preservedUnchanged();
      return resolution;
    };
    const up = async (root: string): Promise<void> => {
      attempted.add(root);
      await cli(root, ["up", "--detach", "--json"]);
      successfulStarts.add(root);
      const owner = await runtime(root);
      if (owner) {
        knownOwners.set(root, owner);
        const pin = await observedVolume(
          await expectedVolumeName(root, owner),
          owner,
          docker
        );
        const previous = volumePins.get(root);
        expect({
          that:
            previous === undefined ||
            JSON.stringify(previous) === JSON.stringify(pin),
          message:
            "Every fixture restart must preserve the pinned physical volume creation identity",
        });
        volumePins.set(root, pin);
      }
    };
    const list = (
      owner: Runtime,
      kind: "container" | "network" | "volume"
    ): Promise<string> =>
      docker([
        ...(kind === "container"
          ? ["ps", "--no-trunc", "-aq"]
          : [kind, "ls", "-q"]),
        "--filter",
        `label=${PROJECT_LABEL}=${owner.composeProject}`,
      ]);
    const unpreparedWithoutEffects = async (root: string): Promise<boolean> => {
      if (successfulStarts.has(root) || knownOwners.has(root)) {
        return false;
      }
      const absentStore = await lstat(
        join(root, ".hack", ".internal", "native-compose")
      )
        .then(() => false)
        .catch((error: unknown) => {
          if (isRecord(error) && error.code === "ENOENT") {
            return true;
          }
          throw error;
        });
      if (!absentStore) {
        return false;
      }
      expect({
        that:
          (await nativeInventory()) === nativeBefore &&
          (claimsRoot === null || (await claimSnapshot(claimsRoot)) === ""),
        message:
          "A missing unprepared store permits fixture teardown only after native container inventory and hostname claims prove no effects",
      });
      return true;
    };
    const cleanupResource = async (
      owner: Runtime,
      kind: "container" | "network" | "volume",
      id: string,
      pin: VolumePin | undefined
    ): Promise<void> => {
      const labels = object(
        await docker([
          kind,
          "inspect",
          id,
          "--format",
          kind === "container" ? "{{json .Config.Labels}}" : "{{json .Labels}}",
        ])
      );
      expect({
        that:
          labels[OWNER_LABEL] === owner.ownerToken &&
          labels[INSTANCE_LABEL] === owner.composeProject &&
          labels[PROJECT_LABEL] === owner.composeProject,
        message:
          "Cleanup refuses any resource outside exact native fixture ownership",
      });
      if (kind === "volume") {
        expect({
          that:
            pin !== undefined &&
            id === pin.name &&
            JSON.stringify(await observedVolume(id, owner, docker)) ===
              JSON.stringify(pin),
          message:
            "Fixture volume cleanup refuses name, logical storage or creation-identity drift",
        });
        // Non-forced deletion follows a fresh exact creation/owner inspection;
        // Docker also refuses a volume attached to any remaining container.
        await docker(["volume", "rm", id]);
      }
    };
    const cleanupCheckout = async (root: string): Promise<void> => {
      if (await unpreparedWithoutEffects(root)) {
        return;
      }
      const owner = await runtime(root);
      if (!owner) {
        return;
      }
      if (owner.hasGeneration && owner.needsDown) {
        await cli(root, ["down", "--recover", "--json"]);
      }
      for (const kind of ["container", "network", "volume"] as const) {
        const resources = (await list(owner, kind))
          .split(/\s+/)
          .filter(Boolean);
        const pin = volumePins.get(root);
        if (kind === "volume") {
          volumeSelection(resources, pin);
        }
        for (const id of resources) {
          await cleanupResource(owner, kind, id, pin);
        }
        expect({
          that: (await list(owner, kind)) === "",
          message:
            "Native routed fixture teardown must leave no engine resources",
        });
      }
    };
    const cleanup = async (): Promise<void> => {
      // Keep ingress alive until every native route owner has proved retirement.
      for (const root of [...attempted].reverse()) {
        await cleanupCheckout(root);
      }
      if (claimsRoot) {
        expect({
          that: (await claimSnapshot(claimsRoot)) === "",
          message:
            "Native hostname claims must be absent before fixture ingress removal",
        });
      }
      await ingress.cleanup();
    };
    await runWithOwnedCleanup({
      run: async () => {
        const binding = await ingress.start();
        claimsRoot = join(
          ctx.hackHome,
          "compose-routing",
          createHash("sha256").update(binding.engineId).digest("hex"),
          "claims"
        );
        stage(
          "isolated Caddy has no host ports and serves a verified TLS canary"
        );
        const created = await createMonorepoFixture({
          parentDir: ctx.tempRoot,
          withHackConfig: false,
          name: `routing-${token.slice(0, 12)}`,
        });
        const primaryRoot = await realpath(created.root);
        const fixture = {
          ...created,
          root: primaryRoot,
          hackDir: join(primaryRoot, ".hack"),
        };
        await mkdir(fixture.hackDir);
        const domain = `native-${token}.test`;
        const aliasDomain = `oauth-${token}.test`;
        const writeProject = async (
          checkout: Checkout,
          projectDomain = domain,
          host?: Project["host"]
        ): Promise<void> => {
          await Bun.write(
            join(checkout.root, ".hack", "hack.project.json"),
            `${JSON.stringify({ ...authored({ name: fixture.name, image: bunImage, domain: projectDomain, aliasDomain, marker: checkout.marker }), ...(host ? { host } : {}) }, null, 2)}\n`
          );
          for (const name of [
            "hack.config.json",
            "docker-compose.yml",
            "compose.yaml",
          ]) {
            expect({
              that: !(await Bun.file(
                join(checkout.root, ".hack", name)
              ).exists()),
              message:
                "Routing fixture must have no legacy authored config/Compose fallback",
            });
          }
        };
        const primary = { root: fixture.root, marker: `primary-${token}` };
        await writeProject(primary);
        await commitAll({
          root: fixture.root,
          message: "test: native routing fixture",
        });
        await up(primary.root);
        const original = await check(primary);
        const siblings: Checkout[] = [];
        for (const branch of ["alpha", "beta"]) {
          const root = await realpath(
            await addLinkedWorktree({ fixture, branch })
          );
          const checkout = { root, marker: `${branch}-${token}` };
          siblings.push(checkout);
          await writeProject(checkout);
          await up(checkout.root);
          await check(checkout);
        }
        const resolutions = await Promise.all([
          plan(primary.root),
          ...siblings.map((checkout) => plan(checkout.root)),
        ]);
        expect({
          that: new Set(resolutions.flatMap(origins)).size === 6,
          message:
            "Primary and two linked worktrees must have six isolated project/alias origins",
        });
        await check(primary);
        stage(
          "primary/OAuth alias and two linked worktrees route distinct TLS markers"
        );
        await qualifyNativeComposeRoutedRun({
          root: primary.root,
          primary,
          siblings,
          tempRoot: privateRoot,
          docker,
          raw,
          check: nativeRoutedRunPinnedOriginCheck({
            checkouts: [primary, ...siblings].map((checkout, index) => {
              const resolution = resolutions[index];
              if (!resolution) {
                throw new Error("Prepared routed fixture origins are missing");
              }
              return { ...checkout, origins: origins(resolution) };
            }),
            tls,
            assertIngress: async () => {
              await tls(`https://${canaryHost}`, canaryMarker);
              await preservedUnchanged();
            },
          }),
          claims: async () => await claimSnapshot(claimsRoot ?? ""),
        });
        stage(
          "warm one-off has no route exposure; literal argv/env, exit17, retained data and owned cleanup recovery preserve sibling TLS routes"
        );
        const renamedDomain = `renamed-${token}.test`;
        await writeProject(primary, renamedDomain);
        await up(primary.root);
        const renamed = await check(primary);
        expect({
          that:
            renamed.project_origin !== original.project_origin &&
            renamed.aliases.oauth === original.aliases.oauth,
          message:
            "Primary domain replacement must retain its existing OAuth alias",
        });
        await absent([new URL(original.project_origin).hostname]);
        for (const checkout of siblings) {
          await check(checkout);
        }
        await qualifyNativeComposeRoutedDownHooks({
          primary,
          siblings,
          tempRoot: privateRoot,
          claimsRoot,
          docker,
          raw,
          configure: (host) => writeProject(primary, renamedDomain, host),
          up,
          check,
          absent,
        });
        stage(
          "routed down hooks observe retained data/live routes before stop and exact absence/held claims after; env freshness, exit17 recovery and down/up preserve sibling TLS/data/IDs"
        );
        const beforeClaims = await claimSnapshot(claimsRoot);
        const beforeConfig = createHash("sha256")
          .update(JSON.stringify(await admin()))
          .digest("hex");
        const beforeContainers = await docker([
          "ps",
          "--no-trunc",
          "-aq",
          "--filter",
          "label=io.hack.native-config.version=1",
        ]);
        const collision = {
          root: join(privateRoot, `collision-${token}`),
          marker: "must-never-run",
        };
        await mkdir(join(collision.root, ".hack"), { recursive: true });
        await writeProject(collision, renamedDomain);
        const collisionPayload = object(
          (await cli(collision.root, ["config", "plan", "--json"])).stdout
        );
        const collisionResolution = parseNativeRoutingResolution(
          collisionPayload.routing_resolution
        );
        expect({
          that:
            collisionPayload.ok === true &&
            collisionResolution !== null &&
            JSON.stringify(origins(collisionResolution)) ===
              JSON.stringify(origins(renamed)),
          message:
            "Foreign fixture must be valid native input requesting the exact admitted origins",
        });
        attempted.add(collision.root);
        const refused = await raw(collision.root, ["up", "--detach", "--json"]);
        const collisionOwner = await runtime(collision.root);
        if (collisionOwner) {
          knownOwners.set(collision.root, collisionOwner);
        }
        expectExit({
          result: refused,
          codes: [1],
          message:
            "Another native owner must not claim admitted project/OAuth origins",
        });
        expect({
          that:
            refused.combined.includes("E_CONFIG_INVALID") &&
            refused.combined.includes("routing"),
          message:
            "Foreign claimant must fail native routing admission, not an unrelated fixture prerequisite",
        });
        expect({
          that: (await claimSnapshot(claimsRoot)) === beforeClaims,
          message:
            "Foreign claimant refusal must preserve exact existing hostname claims",
        });
        expect({
          that:
            createHash("sha256")
              .update(JSON.stringify(await admin()))
              .digest("hex") === beforeConfig,
          message:
            "Foreign claimant refusal must leave live Caddy routes unchanged",
        });
        expect({
          that:
            (await docker([
              "ps",
              "--no-trunc",
              "-aq",
              "--filter",
              "label=io.hack.native-config.version=1",
            ])) === beforeContainers,
          message:
            "Foreign claimant must refuse before creating or replacing native containers",
        });
        await check(primary);
        for (const checkout of siblings) {
          await check(checkout);
        }
        for (const root of [...attempted].reverse()) {
          const owner = await runtime(root);
          if (owner?.hasGeneration) {
            await cli(root, ["down", "--recover", "--json"]);
          }
        }
        await absent([
          ...hostnames(original),
          ...resolutions.flatMap(hostnames),
          ...hostnames(renamed),
        ]);
        expect({
          that: (await claimSnapshot(claimsRoot)) === "",
          message:
            "All fixture hostname claims must retire after verified native down",
        });
        await tls(`https://${canaryHost}`, canaryMarker);
        stage(
          "foreign native claimant refused before effects; all fixture routes and claims retired"
        );
      },
      cleanup,
      cleanupFailure: async () => {
        ctx.retainFixtures("Native routing owner cleanup is incomplete");
        const path = join(ctx.hackHome, "native-routing-fixture-recovery.json");
        try {
          // Capture already known ownership before any fresh engine read: an
          // unavailable daemon must not erase the proxy ID needed for recovery.
          await Bun.write(
            path,
            JSON.stringify(
              {
                version: 1,
                proxy: {
                  id: ingress.proxyId,
                  name: proxyName,
                  token,
                  networkId,
                },
                privateTmpfs: {
                  "/data": PRIVATE_TMPFS,
                  "/config": PRIVATE_TMPFS,
                },
                roots: [...attempted],
                owners: Object.fromEntries(knownOwners),
                volumes: Object.fromEntries(volumePins),
                claimsRoot,
              },
              null,
              2
            )
          );
          await chmod(path, 0o600);
          ctx.log(
            "Private recovery identity receipt retained in isolated HACK_HOME"
          );
          const resources: Record<string, unknown> = {};
          for (const [root, owner] of knownOwners) {
            const found: Record<string, readonly string[]> = {};
            for (const kind of ["container", "network", "volume"] as const) {
              const selector =
                kind === "container"
                  ? ["ps", "--no-trunc", "-aq"]
                  : [
                      kind,
                      "ls",
                      ...(kind === "network" ? ["--no-trunc"] : []),
                      "-q",
                    ];
              found[kind] = (
                await docker([
                  ...selector,
                  "--filter",
                  `label=${PROJECT_LABEL}=${owner.composeProject}`,
                  "--filter",
                  `label=${OWNER_LABEL}=${owner.ownerToken}`,
                  "--filter",
                  `label=${INSTANCE_LABEL}=${owner.composeProject}`,
                ])
              )
                .split(/\s+/)
                .filter(Boolean);
            }
            resources[root] = found;
          }
          const observationPath = join(
            ctx.hackHome,
            "native-routing-fixture-resources.json"
          );
          await Bun.write(
            observationPath,
            JSON.stringify(
              { version: 1, observedOwnedResources: resources },
              null,
              2
            )
          );
          await chmod(observationPath, 0o600);
          ctx.log(
            "Owned cleanup incomplete; private recovery identity receipt retained in isolated HACK_HOME"
          );
        } catch {
          ctx.log(
            "Owned cleanup incomplete; recovery roots retained, but additional fixture observation could not be recorded"
          );
        }
      },
    });
    stage(
      "exact proxy/native cleanup verified; stopped user selectors and hack-dev preserved"
    );
  },
};
