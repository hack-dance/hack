import { isIP } from "node:net";
import { DEFAULT_INGRESS_NETWORK } from "../constants.ts";
import { isRecord } from "./guards.ts";
import { createNativeComposeProbe } from "./native-compose-ownership.ts";
import { NativeComposeRoutingError } from "./native-compose-routing.ts";

const ENGINE_ID = /^[A-Za-z0-9:-]{1,128}$/;
const OBJECT_ID = /^[a-f0-9]{64}$/;
const PROJECT = "hack-dev-proxy";
const NETWORK_FORMAT = '{"id":{{json .Id}},"name":{{json .Name}}}';
const PROXY_FORMAT =
  '{"id":{{json .Id}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"running":{{json .State.Running}},"network":{{with (index .NetworkSettings.Networks "hack-dev")}}{{json .NetworkID}}{{else}}null{{end}},"ip":{{with (index .NetworkSettings.Networks "hack-dev")}}{{json .IPAddress}}{{else}}null{{end}}}';

export type NativeComposeIngressBinding = {
  readonly engineId: string;
  readonly networkId: string;
  readonly proxyId: string;
  readonly proxyIp: string;
};

function refused(): never {
  throw new NativeComposeRoutingError();
}

function row(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  return isRecord(parsed) ? parsed : refused();
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).sort().join() === [...keys].sort().join();
}

function sameBinding(
  left: NativeComposeIngressBinding,
  right: NativeComposeIngressBinding
): boolean {
  return (
    left.engineId === right.engineId &&
    left.networkId === right.networkId &&
    left.proxyId === right.proxyId &&
    left.proxyIp === right.proxyIp
  );
}

/**
 * Bind to an already running same-engine global proxy. This never starts or repairs
 * global services, publishes a port, changes DNS/trust or reads container environment.
 * The caller rechecks this public identity immediately before its owned effects.
 */
export async function observeNativeComposeIngress(
  opts: {
    readonly expected?: NativeComposeIngressBinding;
    readonly signal?: AbortSignal;
  } = {}
): Promise<NativeComposeIngressBinding> {
  try {
    const probe = createNativeComposeProbe({ signal: opts.signal });
    const result = await inspectIngress(probe);
    const after = await inspectIngress(probe);
    if (
      !sameBinding(result, after) ||
      (opts.expected && !sameBinding(result, opts.expected))
    ) {
      return refused();
    }
    return result;
  } catch {
    return refused();
  }
}

async function inspectIngress(
  probe: ReturnType<typeof createNativeComposeProbe>
): Promise<NativeComposeIngressBinding> {
  const engineId: unknown = JSON.parse(
    await probe(["info", "--format", "{{json .ID}}"])
  );
  if (typeof engineId !== "string" || !ENGINE_ID.test(engineId)) {
    return refused();
  }
  const network = row(
    await probe([
      "network",
      "inspect",
      "--format",
      NETWORK_FORMAT,
      DEFAULT_INGRESS_NETWORK,
    ])
  );
  if (
    !exactKeys(network, ["id", "name"]) ||
    typeof network.id !== "string" ||
    !OBJECT_ID.test(network.id) ||
    network.name !== DEFAULT_INGRESS_NETWORK
  ) {
    return refused();
  }
  const ids = (
    await probe([
      "container",
      "ls",
      "--no-trunc",
      "--filter",
      `label=com.docker.compose.project=${PROJECT}`,
      "--filter",
      "label=com.docker.compose.service=caddy",
      "--format",
      "{{json .ID}}",
    ])
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  if (ids.length !== 1) {
    return refused();
  }
  const id: unknown = JSON.parse(ids[0] ?? "null");
  if (typeof id !== "string" || !OBJECT_ID.test(id)) {
    return refused();
  }
  const proxy = row(
    await probe(["container", "inspect", "--format", PROXY_FORMAT, id])
  );
  if (
    !exactKeys(proxy, [
      "id",
      "project",
      "service",
      "running",
      "network",
      "ip",
    ]) ||
    proxy.id !== id ||
    proxy.project !== PROJECT ||
    proxy.service !== "caddy" ||
    proxy.running !== true ||
    proxy.network !== network.id ||
    typeof proxy.ip !== "string" ||
    isIP(proxy.ip) !== 4
  ) {
    return refused();
  }
  return Object.freeze({
    engineId,
    networkId: network.id,
    proxyId: id,
    proxyIp: proxy.ip,
  });
}
