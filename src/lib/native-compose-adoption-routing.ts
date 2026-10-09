import { isIP } from "node:net";
import { DEFAULT_INGRESS_NETWORK } from "../constants.ts";
import { isRecord } from "./guards.ts";
import type { LegacyComposeVerifiedBinding } from "./native-compose-adoption-binding.ts";
import {
  type NativeComposeIngressBinding,
  observeNativeComposeIngress,
} from "./native-compose-ingress.ts";
import { createNativeComposeProbe } from "./native-compose-ownership.ts";
import {
  assertBoundNativeComposeProxyRoutes,
  assertNativeComposeProxyAccess,
  type BoundNativeComposeProxyRoute,
} from "./native-compose-proxy-routes.ts";
import { NativeComposeRoutingError } from "./native-compose-routing.ts";
import type { LegacyComposeRoutingIntent } from "./native-config-import-routing.ts";

const ID = /^[a-f0-9]{64}$/;
const SITE_SEPARATOR = /[\s,]+/;
const CREATED = /^\d{4}-\d\d-\d\dT/;
const CONTAINER =
  '{"id":{{json .Id}},"created":{{json .Created}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"native":{{json (index .Config.Labels "io.hack.native-config.owner")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"number":{{json (index .Config.Labels "com.docker.compose.container-number")}},"oneoff":{{json (index .Config.Labels "com.docker.compose.oneoff")}},"running":{{json .State.Running}},"paused":{{json .State.Paused}},"sites":[{{range $key,$value := .Config.Labels}}{{if or (eq $key "caddy") (and (ge (len $key) 6) (eq (slice $key 0 6) "caddy_")) (and (ge (len $key) 6) (eq (slice $key 0 6) "caddy."))}}{"key":{{json $key}},"value":{{json $value}}},{{end}}{{end}}null],"networks":[{{range $key,$value := .NetworkSettings.Networks}}{"name":{{json $key}},"id":{{json $value.NetworkID}},"ip":{{json $value.IPAddress}}},{{end}}null]}';
const BIRTH = '{"id":{{json .Id}},"created":{{json .Created}}}';
const NETWORK_BIRTH = '{"id":{{json .Id}},"created":{{json .Created}}}';
const SITES =
  '{"id":{{json .Id}},"sites":[{{range $key,$value := .Config.Labels}}{{if or (eq $key "caddy") (and (ge (len $key) 7) (eq (slice $key 0 6) "caddy_") (eq (len (split $key ".")) 1) (ne $key "caddy_ingress_network"))}}{{json $value}},{{end}}{{end}}null]}';

export type LegacyComposeRetainedRoutingProof = {
  readonly routing_version: 14;
  readonly ingress: NativeComposeIngressBinding;
  readonly proxyCreatedAt: string;
  readonly networkCreatedAt: string;
  readonly originals: readonly {
    readonly id: string;
    readonly service: string;
    readonly createdAt: string;
    readonly labels: Readonly<Record<string, string>>;
  }[];
};
type Binding = Pick<
  LegacyComposeVerifiedBinding,
  "engineId" | "composeProject" | "containers"
>;
type Observed = {
  readonly proof: LegacyComposeRetainedRoutingProof;
  readonly expected: readonly BoundNativeComposeProxyRoute[];
  readonly stopped: boolean;
};
function refuse(): never {
  throw new NativeComposeRoutingError();
}
function keys(value: Record<string, unknown>, wanted: string) {
  return Object.keys(value).sort().join(",") === wanted;
}
function rows(text: string): Record<string, unknown>[] {
  const values: unknown[] = text.trim()
    ? text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
  if (!values.every(isRecord)) {
    return refuse();
  }
  return values;
}
function birth(text: string, id: string): string {
  const values = rows(text),
    value = values[0];
  if (
    !(
      values.length === 1 &&
      value &&
      keys(value, "created,id") &&
      value.id === id &&
      typeof value.created === "string" &&
      CREATED.test(value.created) &&
      Number.isFinite(Date.parse(value.created))
    )
  ) {
    return refuse();
  }
  return value.created;
}
function labels(value: unknown): Readonly<Record<string, string>> {
  if (!(Array.isArray(value) && value.at(-1) === null)) {
    return refuse();
  }
  const result: Record<string, string> = {};
  for (const pair of value.slice(0, -1)) {
    if (
      !(
        isRecord(pair) &&
        keys(pair, "key,value") &&
        typeof pair.key === "string" &&
        typeof pair.value === "string" &&
        !Object.hasOwn(result, pair.key)
      )
    ) {
      return refuse();
    }
    result[pair.key] = pair.value;
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(result).sort(([a], [b]) => a.localeCompare(b))
    )
  );
}
function equal(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}
function covers(site: string, hostname: string): boolean {
  if (site.startsWith(":")) {
    return true;
  }
  const url = new URL(site.includes("://") ? site : `https://${site}`);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !["http:", "https:"].includes(url.protocol)
  ) {
    return refuse();
  }
  return (
    url.hostname === "*" ||
    url.hostname === hostname ||
    (url.hostname.startsWith("*.") && hostname.endsWith(url.hostname.slice(1)))
  );
}
/** Foreign existing site writers, including stopped containers, cannot inherit a retained ID exception. */
async function inventory(
  probe: ReturnType<typeof createNativeComposeProbe>,
  binding: Binding,
  routing: LegacyComposeRoutingIntent
) {
  const hosts = routing.routes.flatMap((route) =>
    route.origins.map((origin) => new URL(origin).hostname)
  );
  const owned = new Set(
    binding.containers
      .filter((item) =>
        routing.routes.some((route) => route.service === item.service)
      )
      .map((item) => item.id)
  );
  for (let pass = 0; pass < 2; pass++) {
    const selected = rows(
      await probe([
        "container",
        "ls",
        "--all",
        "--no-trunc",
        "--format",
        '{"id":{{json .ID}}}',
      ])
    );
    const ids = selected.map((row) => {
      if (!(keys(row, "id") && typeof row.id === "string" && ID.test(row.id))) {
        return refuse();
      }
      return row.id;
    });
    if (
      new Set(ids).size !== ids.length ||
      [...owned].some((id) => !ids.includes(id))
    ) {
      return refuse();
    }
    for (let offset = 0; offset < ids.length; offset += 64) {
      const batch = ids.slice(offset, offset + 64);
      const observed = rows(
        await probe(["container", "inspect", "--format", SITES, ...batch])
      );
      const seen = new Set<string>();
      if (observed.length !== batch.length) {
        return refuse();
      }
      for (const row of observed) {
        if (
          !(
            keys(row, "id,sites") &&
            typeof row.id === "string" &&
            batch.includes(row.id) &&
            !seen.has(row.id) &&
            Array.isArray(row.sites) &&
            row.sites.at(-1) === null &&
            row.sites.slice(0, -1).every((site) => typeof site === "string")
          )
        ) {
          return refuse();
        }
        seen.add(row.id);
        if (
          !owned.has(row.id) &&
          row.sites.slice(0, -1).some((site: string) =>
            site
              .split(SITE_SEPARATOR)
              .filter(Boolean)
              .some((value) =>
                hosts.some((hostname) => covers(value, hostname))
              )
          )
        ) {
          return refuse();
        }
      }
    }
  }
}
function snapshot(binding: Binding, routing: LegacyComposeRoutingIntent) {
  if (
    routing.version !== 14 ||
    !binding.containers.length ||
    new Set(binding.containers.map((row) => row.id)).size !==
      binding.containers.length ||
    binding.containers.some((row) => !ID.test(row.id))
  ) {
    return refuse();
  }
  const selectedBinding = Object.freeze({
    ...binding,
    containers: Object.freeze(
      binding.containers.map((item) => Object.freeze({ ...item }))
    ),
  });
  const selectedRouting = Object.freeze({
    ...routing,
    routes: Object.freeze(
      routing.routes.map((route) =>
        Object.freeze({
          ...route,
          origins: Object.freeze([...route.origins]),
          labels: Object.freeze({ ...route.labels }),
        })
      )
    ),
  });
  return { binding: selectedBinding, routing: selectedRouting };
}
async function observe(opts: {
  readonly binding: Binding;
  readonly routing: LegacyComposeRoutingIntent;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<Observed> {
  const { binding, routing } = snapshot(opts.binding, opts.routing);
  const signal = opts.signal;
  const probe = createNativeComposeProbe({ signal, timeoutMs: opts.timeoutMs });
  const ingress = await observeNativeComposeIngress({ signal });
  if (ingress.engineId !== binding.engineId) {
    return refuse();
  }
  const proxyCreatedAt = birth(
    await probe(["container", "inspect", "--format", BIRTH, ingress.proxyId]),
    ingress.proxyId
  );
  const networkCreatedAt = birth(
    await probe([
      "network",
      "inspect",
      "--format",
      NETWORK_BIRTH,
      ingress.networkId,
    ]),
    ingress.networkId
  );
  const originals: LegacyComposeRetainedRoutingProof["originals"][number][] =
    [];
  const expected: BoundNativeComposeProxyRoute[] = [];
  let stopped = true;
  for (const original of binding.containers) {
    const found = rows(
      await probe(["container", "inspect", "--format", CONTAINER, original.id])
    );
    const row = found[0];
    if (
      !(
        found.length === 1 &&
        row &&
        keys(
          row,
          "created,id,native,networks,number,oneoff,paused,project,running,service,sites"
        ) &&
        row.id === original.id &&
        row.project === binding.composeProject &&
        (row.native === null || row.native === "") &&
        row.service === original.service &&
        row.number === "1" &&
        (row.oneoff === "False" || row.oneoff === "false") &&
        typeof row.running === "boolean" &&
        row.paused === false &&
        typeof row.created === "string" &&
        CREATED.test(row.created) &&
        Number.isFinite(Date.parse(row.created)) &&
        Array.isArray(row.networks) &&
        row.networks.at(-1) === null
      )
    ) {
      return refuse();
    }
    const route = routing.routes.find(
      (item) => item.service === original.service
    );
    const observedLabels = labels(row.sites);
    const wantedLabels = Object.fromEntries(
      Object.entries(route?.labels ?? {}).sort(([a], [b]) => a.localeCompare(b))
    );
    if (!equal(observedLabels, wantedLabels)) {
      return refuse();
    }
    const configured = row.networks.slice(0, -1);
    const names = new Set<string>();
    for (const item of configured) {
      if (
        !(
          isRecord(item) &&
          keys(item, "id,ip,name") &&
          typeof item.name === "string" &&
          !names.has(item.name) &&
          typeof item.id === "string" &&
          ID.test(item.id) &&
          typeof item.ip === "string"
        )
      ) {
        return refuse();
      }
      names.add(item.name);
    }
    if (
      !(
        configured.length === (route ? 2 : 1) &&
        names.has(`${binding.composeProject}_default`) &&
        names.has(DEFAULT_INGRESS_NETWORK) === Boolean(route)
      )
    ) {
      return refuse();
    }
    const attached = configured.find(
      (item) => isRecord(item) && item.name === DEFAULT_INGRESS_NETWORK
    );
    if (route && !(isRecord(attached) && attached.id === ingress.networkId)) {
      return refuse();
    }
    originals.push({
      id: original.id,
      service: original.service,
      createdAt: row.created,
      labels: observedLabels,
    });
    stopped &&= !row.running;
    if (route && row.running) {
      if (
        !(
          isRecord(attached) &&
          typeof attached.ip === "string" &&
          isIP(attached.ip) === 4
        )
      ) {
        return refuse();
      }
      expected.push({
        service: route.service,
        port: route.port,
        protocol: "http",
        origins: route.origins,
        hostnames: route.origins.map((origin) => new URL(origin).hostname),
        dials: [`${attached.ip}:${route.port}`],
      });
    }
  }
  await inventory(probe, binding, routing);
  await observeNativeComposeIngress({ expected: ingress, signal });
  if (
    birth(
      await probe(["container", "inspect", "--format", BIRTH, ingress.proxyId]),
      ingress.proxyId
    ) !== proxyCreatedAt ||
    birth(
      await probe([
        "network",
        "inspect",
        "--format",
        NETWORK_BIRTH,
        ingress.networkId,
      ]),
      ingress.networkId
    ) !== networkCreatedAt
  ) {
    return refuse();
  }
  return {
    proof: Object.freeze({
      routing_version: 14,
      ingress,
      proxyCreatedAt,
      networkCreatedAt,
      originals: Object.freeze(
        originals.sort((a, b) => a.service.localeCompare(b.service))
      ),
    }),
    expected,
    stopped,
  };
}
/** Snapshot exact original labels/births and shared ingress. This performs no reservation, effect or repair. */
export async function inspectLegacyComposeRetainedRouting(
  opts: Parameters<typeof observe>[0]
): Promise<LegacyComposeRetainedRoutingProof> {
  const selected = {
    ...snapshot(opts.binding, opts.routing),
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
  };
  const first = await observe(selected);
  await assertNativeComposeProxyAccess({
    binding: first.proof.ingress,
    signal: selected.signal,
  });
  const second = await observe(selected);
  if (!equal(first.proof, second.proof)) {
    return refuse();
  }
  return first.proof;
}
/** Exact live/stopped dispatch under the saved owner. No hostname, ID or upstream is fabricated. */
export async function assertLegacyComposeRetainedRoutingState(
  opts: Parameters<typeof observe>[0] & {
    readonly proof: LegacyComposeRetainedRoutingProof;
    readonly phase: "active" | "stopped";
    readonly deadline: number;
    readonly assertOwner: () => Promise<void>;
  }
): Promise<void> {
  const selected = {
    ...snapshot(opts.binding, opts.routing),
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
  };
  const expectedProof = structuredClone(opts.proof),
    phase = opts.phase,
    deadline = opts.deadline,
    assertOwner = opts.assertOwner;
  if (
    !["active", "stopped"].includes(phase) ||
    typeof assertOwner !== "function" ||
    !Number.isFinite(deadline) ||
    deadline <= Date.now()
  ) {
    return refuse();
  }
  const remaining = AbortSignal.timeout(Math.ceil(deadline - Date.now()));
  const signal = selected.signal
    ? AbortSignal.any([selected.signal, remaining])
    : remaining;
  const observeExpected = async () => {
    await assertOwner();
    const current = await observe({ ...selected, signal });
    if (
      !equal(current.proof, expectedProof) ||
      (phase === "active"
        ? current.expected.length !== selected.routing.routes.length
        : !current.stopped)
    ) {
      return refuse();
    }
    await assertOwner();
    return phase === "active" ? current.expected : [];
  };
  await observeExpected();
  await assertBoundNativeComposeProxyRoutes({
    binding: expectedProof.ingress,
    observeExpected,
    absentHostnames:
      phase === "stopped"
        ? selected.routing.routes.flatMap((route) =>
            route.origins.map((origin) => new URL(origin).hostname)
          )
        : [],
    signal,
    deadline,
  });
  await observeExpected();
  if (signal.aborted || Date.now() >= deadline) {
    return refuse();
  }
}
