import { randomBytes, X509Certificate } from "node:crypto";
import { isRecord } from "../../../src/lib/guards.ts";
import { observeNativeComposeIngress } from "../../../src/lib/native-compose-ingress.ts";
import { nativeComposeProxyRoutesMatch } from "../../../src/lib/native-compose-proxy-routes.ts";
import { expect, runCommand, type ScenarioContext } from "../harness.ts";

const TIMEOUT = 180_000;
const OBSERVATION_WINDOW = 30_000;
const OBJECT_ID = /^[a-f0-9]{64}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const PROJECT_LABEL = "com.docker.compose.project";
const SERVICE_LABEL = "com.docker.compose.service";
const FIXTURE_LABEL = "hack.e2e.native-config-routing-owner";
const ROOT_CA = "/data/caddy/pki/authorities/local/root.crt";
const PROXY_PROJECT = "hack-dev-proxy";
const PROXY_SERVICE = "caddy";
const NETWORK = "hack-dev";
const ADMIN_URL = "http://127.0.0.1:2019/config/apps/http/servers";
const CADDY_IMAGE = "lucaslorentz/caddy-docker-proxy:2.10.0-alpine";
export const NATIVE_ROUTING_FIXTURE_TMPFS = "rw,noexec,nosuid,nodev,mode=700";
const PRIVATE_TMPFS = NATIVE_ROUTING_FIXTURE_TMPFS;
const PRESERVED_FORMAT =
  '{"id":{{json .Id}},"name":{{json .Name}},"running":{{json .State.Running}},"status":{{json .State.Status}},"started":{{json .State.StartedAt}},"finished":{{json .State.FinishedAt}}}';
const PROXY_FORMAT =
  '{"id":{{json .Id}},"name":{{json .Name}},"owner":{{json (index .Config.Labels "hack.e2e.native-config-routing-owner")}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"network":{{with (index .NetworkSettings.Networks "hack-dev")}}{{json .NetworkID}}{{else}}null{{end}},"networkMode":{{json .HostConfig.NetworkMode}},"running":{{json .State.Running}},"ports":{{json .HostConfig.PortBindings}},"publishAll":{{json .HostConfig.PublishAllPorts}},"runtimePorts":{{json .NetworkSettings.Ports}},"mounts":{{json .Mounts}},"tmpfs":{{json .HostConfig.Tmpfs}}}';

/** Explicit bindings alone miss Docker's dynamically published `-P` ports. */
export function proxyHasNoPublishedPorts(
  info: Readonly<Record<string, unknown>>
): boolean {
  return (
    info.publishAll === false &&
    (info.ports === null ||
      (isRecord(info.ports) && Object.keys(info.ports).length === 0)) &&
    (info.runtimePorts === null ||
      (isRecord(info.runtimePorts) &&
        Object.values(info.runtimePorts).every((value) => value === null)))
  );
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid fixture JSON response; values omitted");
  }
}

function object(text: string): Record<string, unknown> {
  const value = parsed(text);
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

/** Shared same-engine fixture ingress: no host ports, DNS or trust writes. */
export async function prepareNativeRoutingFixtureIngress(opts: {
  readonly ctx: ScenarioContext;
  readonly docker: (args: readonly string[]) => Promise<string>;
}) {
  const { ctx, docker } = opts;
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
  const token = randomBytes(16).toString("hex");
  const proxyName = `e2e-native-routing-proxy-${token}`;
  const canaryHost = `canary-${token}.test`;
  const canaryMarker = `proxy-canary-${token}`;
  let proxyId: string | null = null;
  let creationAttempted = false;
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
        proxyHasNoPublishedPorts(info) &&
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
      message: "Read-only live Caddy configuration probe must return HTTP 200",
    });
    return parsed(text.slice(0, -4));
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
  const start = async () => {
    if (creationAttempted) {
      throw new Error("Fixture ingress may be created only once");
    }
    creationAttempted = true;
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
        binding.proxyId === currentProxy() && binding.networkId === networkId,
      message:
        "Product ingress observer must select exactly the new fixture proxy/network",
    });
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
    return binding;
  };
  const cleanup = async () => {
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
  return {
    token,
    proxyName,
    canaryHost,
    canaryMarker,
    networkId,
    bunImage,
    get proxyId() {
      return proxyId;
    },
    start,
    admin,
    tls,
    absent,
    preservedUnchanged,
    cleanup,
  };
}
