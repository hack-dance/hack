import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { chmod, lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { Project } from "../../../packages/config-compiler/generated/native-config.ts";
import { isRecord } from "../../../src/lib/guards.ts";
import { openNativeComposeGenerationStore } from "../../../src/lib/native-compose-generation.ts";
import { observeNativeComposeIngress } from "../../../src/lib/native-compose-ingress.ts";
import { nativeComposeProxyRoutesMatch } from "../../../src/lib/native-compose-proxy-routes.ts";
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

const TIMEOUT = 180_000;
const OBSERVATION_WINDOW = 30_000;
const OBJECT_ID = /^[a-f0-9]{64}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const TOKEN = /^[a-f0-9]{32}$/;
const PROJECT_LABEL = "com.docker.compose.project";
const SERVICE_LABEL = "com.docker.compose.service";
const OWNER_LABEL = "io.hack.native-config.owner";
const INSTANCE_LABEL = "io.hack.native-config.instance";
const FIXTURE_LABEL = "hack.e2e.native-config-routing-owner";
const ROOT_CA = "/data/caddy/pki/authorities/local/root.crt";
const PROXY_PROJECT = "hack-dev-proxy";
const PROXY_SERVICE = "caddy";
const NETWORK = "hack-dev";
const ADMIN_URL = "http://127.0.0.1:2019/config/apps/http/servers";
const CADDY_IMAGE = "lucaslorentz/caddy-docker-proxy:2.10.0-alpine";
const PRIVATE_TMPFS = "rw,noexec,nosuid,nodev,mode=700";
const APP =
  "Bun.serve({hostname:'0.0.0.0',port:3000,fetch(){return new Response(process.env.BRANCH_MARKER)}})";
const PRESERVED_FORMAT =
  '{"id":{{json .Id}},"name":{{json .Name}},"running":{{json .State.Running}},"status":{{json .State.Status}},"started":{{json .State.StartedAt}},"finished":{{json .State.FinishedAt}}}';
const PROXY_FORMAT =
  '{"id":{{json .Id}},"name":{{json .Name}},"owner":{{json (index .Config.Labels "hack.e2e.native-config-routing-owner")}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"network":{{with (index .NetworkSettings.Networks "hack-dev")}}{{json .NetworkID}}{{else}}null{{end}},"networkMode":{{json .HostConfig.NetworkMode}},"running":{{json .State.Running}},"ports":{{json .HostConfig.PortBindings}},"mounts":{{json .Mounts}},"tmpfs":{{json .HostConfig.Tmpfs}}}';

type Docker = (args: readonly string[]) => Promise<string>;
type Runtime = {
  readonly composeProject: string;
  readonly ownerToken: string;
  readonly hasGeneration: boolean;
  readonly needsDown: boolean;
};
type Checkout = { readonly root: string; readonly marker: string };

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
    services: {
      web: {
        image: opts.image,
        pull_policy: "never",
        command: { exec: ["bun", "-e", APP] },
        restart: { kind: "no" },
        environment: { BRANCH_MARKER: { literal: opts.marker } },
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

async function claimSnapshot(root: string): Promise<string> {
  const names = await readdir(root).catch((error: unknown) => {
    if (isRecord(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  const hashes: string[] = [];
  for (const name of names.sort()) {
    expect({
      that: /^[a-f0-9]{64}\.json$/.test(name),
      message: "Fixture hostname claims must contain only complete claim files",
    });
    hashes.push(
      `${name}:${createHash("sha256")
        .update(await Bun.file(join(root, name)).text())
        .digest("hex")}`
    );
  }
  return hashes.join("\n");
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
    const selectors = [
      "--filter",
      `label=${PROJECT_LABEL}=${PROXY_PROJECT}`,
      "--filter",
      `label=${SERVICE_LABEL}=${PROXY_SERVICE}`,
    ];
    // Stopped user selectors are not ingress candidates. Snapshot them; never adopt,
    // start, rename or remove them merely to make this scenario runnable.
    expect({
      that: (await docker(["ps", "--no-trunc", "-q", ...selectors])) === "",
      message:
        "Refuse native routing fixture while any global Caddy selector is running",
    });
    const preserved = ids(
      await docker(["ps", "--no-trunc", "-aq", ...selectors])
    );
    const preservedSnapshots = new Map<string, string>();
    for (const id of preserved) {
      const text = await docker(["inspect", "--format", PRESERVED_FORMAT, id]);
      expect({
        that: object(text).running === false,
        message: "Pre-existing proxy must be stopped",
      });
      preservedSnapshots.set(id, text);
    }
    expect({
      that: (await docker(["info", "--format", "{{.OSType}}"])) === "linux",
      message: "Native routing fixture requires a Linux Docker daemon",
    });
    await docker(["compose", "version"]);
    const networkId = await docker([
      "network",
      "inspect",
      NETWORK,
      "--format",
      "{{.Id}}",
    ]);
    expect({
      that: OBJECT_ID.test(networkId),
      message: "Existing hack-dev network identity is required",
    });
    const image = async (tag: string): Promise<string> => {
      const id = await docker(["image", "inspect", tag, "--format", "{{.Id}}"]);
      expect({
        that: IMAGE_ID.test(id),
        message:
          "Fixture images must already be cached; never pull during acceptance",
      });
      return id;
    };
    const bunImage = await image("oven/bun:1.4.2-slim");
    const caddyImage = await image(CADDY_IMAGE);
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
    const token = randomBytes(16).toString("hex");
    const proxyName = `e2e-native-routing-proxy-${token}`;
    const canaryHost = `canary-${token}.test`;
    const canaryMarker = `proxy-canary-${token}`;
    const privateRoot = await realpath(ctx.tempRoot);
    let proxyId: string | null = null;
    let claimsRoot: string | null = null;
    const attempted = new Set<string>();
    const successfulStarts = new Set<string>();
    const knownOwners = new Map<string, Runtime>();
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
    const raw = (root: string, args: readonly string[]): Promise<CliResult> =>
      ctx.cli({ args, cwd: root, timeoutMs: TIMEOUT, env });
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
    const currentProxy = (): string => {
      if (!(proxyId && OBJECT_ID.test(proxyId))) {
        throw new Error("Exact owned fixture proxy ID is unavailable");
      }
      return proxyId;
    };
    const preservedUnchanged = async (): Promise<void> => {
      expect({
        that:
          (await docker([
            "network",
            "inspect",
            NETWORK,
            "--format",
            "{{.Id}}",
          ])) === networkId,
        message: "External hack-dev network must retain its exact identity",
      });
      for (const [id, before] of preservedSnapshots) {
        expect({
          that:
            (await docker(["inspect", "--format", PRESERVED_FORMAT, id])) ===
            before,
          message: "Stopped user Caddy selectors must remain unchanged",
        });
      }
    };
    const proxyOwned = async (): Promise<void> => {
      const info = object(
        await docker(["inspect", "--format", PROXY_FORMAT, currentProxy()])
      );
      expect({
        that:
          info.id === currentProxy() &&
          info.name === `/${proxyName}` &&
          info.owner === token &&
          info.project === PROXY_PROJECT &&
          info.service === PROXY_SERVICE &&
          info.networkMode === networkId &&
          (info.running === false || info.network === networkId) &&
          (info.ports === null ||
            (isRecord(info.ports) && Object.keys(info.ports).length === 0)) &&
          Array.isArray(info.mounts) &&
          info.mounts.length === 1 &&
          info.mounts.every(
            (mount: unknown) =>
              isRecord(mount) &&
              mount.Type === "bind" &&
              mount.Destination === "/var/run/docker.sock" &&
              mount.Source === "/var/run/docker.sock" &&
              mount.RW === false
          ) &&
          isRecord(info.tmpfs) &&
          Object.keys(info.tmpfs).length === 2 &&
          info.tmpfs["/data"] === PRIVATE_TMPFS &&
          info.tmpfs["/config"] === PRIVATE_TMPFS,
        message:
          "Proxy effects require exact fixture ownership/network, no published ports or anonymous volumes",
      });
    };
    const admin = async (): Promise<unknown> => {
      await proxyOwned();
      const text = await docker([
        "exec",
        currentProxy(),
        "curl",
        "--disable",
        "--silent",
        "--show-error",
        "--fail",
        "--proxy",
        "",
        "--noproxy",
        "*",
        "--proto",
        "=http",
        "--max-time",
        "10",
        "--max-redirs",
        "0",
        "--write-out",
        "\n%{http_code}",
        "--url",
        ADMIN_URL,
      ]);
      expect({
        that: text.endsWith("\n200"),
        message:
          "Read-only live Caddy configuration probe must return HTTP 200",
      });
      return JSON.parse(text.slice(0, -4));
    };
    const absent = async (hosts: readonly string[]): Promise<void> => {
      expect({
        that: nativeComposeProxyRoutesMatch({
          servers: await admin(),
          expected: [],
          absentHostnames: hosts,
        }),
        message:
          "Retired exact fixture origins must be absent from active Caddy routing",
      });
    };
    const tls = async (origin: string, marker: string): Promise<void> => {
      const url = new URL(origin);
      expect({
        that:
          url.protocol === "https:" && url.port === "" && url.pathname === "/",
        message: "Fixture TLS probes require exact standard HTTPS origins",
      });
      const deadline = Date.now() + OBSERVATION_WINDOW;
      while (Date.now() < deadline) {
        await proxyOwned();
        const result = await runCommand({
          argv: [
            "docker",
            "exec",
            currentProxy(),
            "curl",
            "--disable",
            "--silent",
            "--show-error",
            "--fail",
            "--proxy",
            "",
            "--noproxy",
            "*",
            "--proto",
            "=https",
            "--max-redirs",
            "0",
            "--connect-timeout",
            "2",
            "--max-time",
            "5",
            "--cacert",
            ROOT_CA,
            "--resolve",
            `${url.hostname}:443:127.0.0.1`,
            "--url",
            `${origin}/`,
          ],
          cwd: ctx.tempRoot,
          timeoutMs: TIMEOUT,
        });
        if (
          result.exitCode === 0 &&
          !result.timedOut &&
          result.stdout === marker
        ) {
          return;
        }
        await Bun.sleep(250);
      }
      throw new Error(
        "Exact routed TLS marker was not observed; no insecure or app-local fallback permitted"
      );
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
        for (const id of resources) {
          const labels = object(
            await docker([
              kind,
              "inspect",
              id,
              "--format",
              kind === "container"
                ? "{{json .Config.Labels}}"
                : "{{json .Labels}}",
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
        }
        expect({
          that: resources.length === 0,
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
      if (proxyId) {
        await proxyOwned();
        await docker(["container", "stop", currentProxy()]);
        await proxyOwned();
        await docker(["container", "rm", currentProxy()]);
        proxyId = null;
      }
      expect({
        that:
          (await docker([
            "ps",
            "--no-trunc",
            "-aq",
            "--filter",
            `label=${FIXTURE_LABEL}=${token}`,
          ])) === "",
        message:
          "Exact proxy fixture and its ephemeral filesystem must be absent after cleanup",
      });
      await preservedUnchanged();
    };
    await runWithOwnedCleanup({
      run: async () => {
        // Repeat ingress absence at the only fixture-global creation boundary.
        expect({
          that: (await docker(["ps", "--no-trunc", "-q", ...selectors])) === "",
          message:
            "Refuse a newly appeared running global Caddy before fixture creation",
        });
        proxyId = await docker([
          "create",
          "--pull=never",
          "--name",
          proxyName,
          "--network",
          networkId,
          "--label",
          `${FIXTURE_LABEL}=${token}`,
          "--label",
          `${PROJECT_LABEL}=${PROXY_PROJECT}`,
          "--label",
          `${SERVICE_LABEL}=${PROXY_SERVICE}`,
          "--label",
          `caddy=https://${canaryHost}`,
          "--label",
          `caddy.respond=${canaryMarker} 200`,
          "--label",
          "caddy.tls=internal",
          "--env",
          `CADDY_INGRESS_NETWORKS=${NETWORK}`,
          "--mount",
          "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock,readonly",
          // Caddy writes private root-owned files. Keep these in the disposable
          // container so Linux cleanup never needs host chown or sudo.
          "--tmpfs",
          `/data:${PRIVATE_TMPFS}`,
          "--tmpfs",
          `/config:${PRIVATE_TMPFS}`,
          caddyImage,
          "docker-proxy",
          "--polling-interval",
          "1s",
        ]);
        await proxyOwned();
        await docker(["container", "start", currentProxy()]);
        await tls(`https://${canaryHost}`, canaryMarker);
        const binding = await observeNativeComposeIngress();
        expect({
          that:
            binding.proxyId === currentProxy() &&
            binding.networkId === networkId,
          message:
            "Product ingress observer must select exactly the new fixture proxy/network",
        });
        claimsRoot = join(
          ctx.hackHome,
          "compose-routing",
          createHash("sha256").update(binding.engineId).digest("hex"),
          "claims"
        );
        await admin();
        const certificate = new X509Certificate(
          await docker(["exec", currentProxy(), "cat", ROOT_CA])
        );
        expect({
          that:
            certificate.ca &&
            certificate.verify(certificate.publicKey) &&
            Date.parse(certificate.validFrom) <= Date.now() &&
            Date.parse(certificate.validTo) > Date.now(),
          message:
            "Only the current valid self-signed fixture CA may validate routed HTTPS",
        });
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
          projectDomain = domain
        ): Promise<void> => {
          await Bun.write(
            join(checkout.root, ".hack", "hack.project.json"),
            `${JSON.stringify(authored({ name: fixture.name, image: bunImage, domain: projectDomain, aliasDomain, marker: checkout.marker }), null, 2)}\n`
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
        await cli(primary.root, ["down", "--json"]);
        await absent(hostnames(renamed));
        for (const checkout of siblings) {
          await check(checkout);
        }
        await up(primary.root);
        await check(primary);
        stage(
          "primary domain replacement and down/up preserve aliases, siblings and proxy canary"
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
                proxy: { id: proxyId, name: proxyName, token, networkId },
                privateTmpfs: {
                  "/data": PRIVATE_TMPFS,
                  "/config": PRIVATE_TMPFS,
                },
                roots: [...attempted],
                owners: Object.fromEntries(knownOwners),
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
