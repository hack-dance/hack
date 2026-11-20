import {
  DEFAULT_INGRESS_NETWORK,
  GLOBAL_CADDY_PROJECT_NAME,
} from "../constants.ts";
import { isRecord } from "./guards.ts";

/**
 * Addresses of the global proxy (Caddy) and resolver (CoreDNS) containers on
 * the ingress network; `null` when that container is absent or not running.
 */
export interface IngressAddresses {
  readonly coreDns: string | null;
  readonly caddy: string | null;
}

type IngressService = "caddy" | "coredns";

export interface IngressAddressDeps {
  /** `HACK_COREDNS_IP` / `HACK_CADDY_IP` win over any Docker read. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** True when the global proxy stack is installed and `docker` is on PATH. */
  readonly stackInstalled: () => Promise<boolean>;
  readonly exec: (
    argv: readonly string[]
  ) => Promise<{ readonly exitCode: number; readonly stdout: string }>;
}

const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";
const COMPOSE_SERVICE_LABEL = "com.docker.compose.service";

/** One line per container: project, service, running, ingress networks. */
const INSPECT_FORMAT = [
  `{{index .Config.Labels "${COMPOSE_PROJECT_LABEL}"}}`,
  `{{index .Config.Labels "${COMPOSE_SERVICE_LABEL}"}}`,
  "{{.State.Running}}",
  "{{json .NetworkSettings.Networks}}",
].join("\t");

/**
 * Container names Compose gives the first replica of `service`: the default
 * `-` form and the `COMPOSE_COMPATIBILITY` `_` form. Inspecting both by name
 * costs nothing extra and the labels below decide identity, not the name.
 */
function candidateNames(service: IngressService): readonly string[] {
  return [
    `${GLOBAL_CADDY_PROJECT_NAME}-${service}-1`,
    `${GLOBAL_CADDY_PROJECT_NAME}_${service}_1`,
  ];
}

/**
 * Resolves both global addresses with at most one `docker inspect`.
 *
 * It replaces two `compose ps -q` plus `inspect` pairs (four Docker CLI
 * starts). A container counts only when its Compose labels name the global
 * proxy project and the service, and it is running, as `compose ps -q` (which
 * lists running containers) required before. A missing name is absence:
 * `docker inspect` exits 1 but still prints the containers it found.
 */
export async function resolveIngressAddresses(
  deps: IngressAddressDeps
): Promise<IngressAddresses> {
  const fromEnv = {
    coredns: (deps.env.HACK_COREDNS_IP ?? "").trim() || null,
    caddy: (deps.env.HACK_CADDY_IP ?? "").trim() || null,
  } as const;
  const needed = (["coredns", "caddy"] as const).filter(
    (service) => fromEnv[service] === null
  );
  if (needed.length === 0 || !(await deps.stackInstalled())) {
    return { coreDns: fromEnv.coredns, caddy: fromEnv.caddy };
  }

  const inspect = await deps.exec([
    "docker",
    "inspect",
    "--type",
    "container",
    "--format",
    INSPECT_FORMAT,
    ...needed.flatMap(candidateNames),
  ]);
  const found = parseInspectLines(inspect.stdout);
  return {
    coreDns: fromEnv.coredns ?? found.get("coredns") ?? null,
    caddy: fromEnv.caddy ?? found.get("caddy") ?? null,
  };
}

function parseInspectLines(stdout: string): Map<IngressService, string> {
  const out = new Map<IngressService, string>();
  for (const line of stdout.split("\n")) {
    const [project, service, running, networksJson] = line.split("\t");
    if (
      project !== GLOBAL_CADDY_PROJECT_NAME ||
      (service !== "caddy" && service !== "coredns") ||
      running !== "true" ||
      out.has(service)
    ) {
      continue;
    }
    const ip = ingressIp(networksJson ?? "");
    if (ip !== null) {
      out.set(service, ip);
    }
  }
  return out;
}

function ingressIp(networksJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(networksJson);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const network = parsed[DEFAULT_INGRESS_NETWORK];
  if (!isRecord(network)) {
    return null;
  }
  const ip = network.IPAddress;
  return typeof ip === "string" && ip.length > 0 ? ip : null;
}
