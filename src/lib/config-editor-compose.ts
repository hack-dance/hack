import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  type YAMLSeq,
} from "yaml";
import {
  isCaddySiteLabel,
  rewriteCaddyLabelForBranch,
  splitCaddySites,
} from "./branch-hosts.ts";
import { isConfigSecret } from "./config-editor-source.ts";
import { isRecord } from "./guards.ts";

const ADDRESS =
  /^(?:(https?):\/\/)?([a-z\d](?:[a-z\d.-]*[a-z\d])?)(?::(\d+))?$/i;
const UPSTREAM = /^\{\{upstreams ([0-9]+)\}\}$/;
const HOST_LABEL = /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i;
const SERVICE_NAME = /^[\w.-]+$/;
const ROUTE_LABEL = /^caddy(?:[._]|$)/;
const SHORT_PORT =
  /^(?:(?:\[[\da-f.:]+\]|[\d.]+):(?=\d+(?:-\d+)?:))?(\d+)(?:-(\d+))?(?::(\d+)(?:-(\d+))?)?(?:\/(?:tcp|udp|sctp))?$/iu;

export const validHost = (host: string): boolean =>
  host.length <= 253 && host.split(".").every((part) => HOST_LABEL.test(part));

export const validPort = (port: unknown): port is number =>
  typeof port === "number" &&
  Number.isInteger(port) &&
  port >= 1 &&
  port <= 65_535;

export function validComposeShortPort(value: unknown): boolean {
  if (typeof value !== "string") {
    return validPort(value);
  }
  const endpoints = SHORT_PORT.exec(value);
  return (
    endpoints
      ?.slice(1)
      .every((port) => port === undefined || validPort(Number(port))) ?? false
  );
}

export function parseRouteAddress(site: string) {
  const match = ADDRESS.exec(site);
  const host = match?.[2];
  const port = match?.[3] === undefined ? null : Number(match[3]);
  if (!(host && validHost(host)) || (port !== null && !validPort(port))) {
    return null;
  }
  return { host, port, tls: match?.[1]?.toLowerCase() !== "http" };
}

export type ConfigIssue = {
  readonly layer: string | null;
  readonly path: readonly string[];
  readonly line: number | null;
  readonly code: string;
  readonly message: string;
};

export function parseComposeSource(text: string) {
  const lines = new LineCounter();
  const doc = parseDocument(text, {
    lineCounter: lines,
    merge: true,
    prettyErrors: false,
  });
  const error = doc.errors[0];
  if (error) {
    return {
      doc,
      lines,
      invalid: lines.linePos(error.pos[0]).line,
      services: {},
      checksDependencies: false,
    };
  }
  try {
    const compose: unknown = doc.toJS();
    return {
      doc,
      lines,
      invalid: isRecord(compose) && isRecord(compose.services) ? null : 1,
      services:
        isRecord(compose) && isRecord(compose.services) ? compose.services : {},
      checksDependencies:
        isRecord(compose) &&
        compose.include === undefined &&
        !(
          isRecord(compose.services) &&
          Object.values(compose.services).some(
            (service) => isRecord(service) && service.extends !== undefined
          )
        ),
    };
  } catch {
    return { doc, lines, invalid: 1, services: {}, checksDependencies: false };
  }
}

type ComposeSource = ReturnType<typeof parseComposeSource>;
type Site = { readonly key: string; readonly value: string };

function composeLabels(service: Record<string, unknown>): readonly Site[] {
  if (isRecord(service.labels)) {
    return Object.entries(service.labels).flatMap(([key, value]) =>
      typeof value === "string" ? [{ key, value }] : [{ key, value: "" }]
    );
  }
  if (!Array.isArray(service.labels)) {
    return [];
  }
  return service.labels.flatMap((label: unknown) => {
    if (typeof label !== "string") {
      return [];
    }
    const separator = label.indexOf("=");
    return separator < 0
      ? [{ key: label, value: "" }]
      : [{ key: label.slice(0, separator), value: label.slice(separator + 1) }];
  });
}

function simpleRoute(
  service: Record<string, unknown>,
  labels: readonly Site[]
) {
  const caddy = labels.filter((label) => ROUTE_LABEL.test(label.key));
  const site = caddy.find((label) => label.key === "caddy");
  const upstream = caddy.find((label) => label.key === "caddy.reverse_proxy");
  if (
    service.extends !== undefined ||
    (service.labels !== undefined &&
      !isRecord(service.labels) &&
      !Array.isArray(service.labels))
  ) {
    return null;
  }
  if (caddy.length === 0) {
    return { sites: "", port: null };
  }
  if (caddy.length !== 2 || !site || !upstream) {
    return null;
  }
  const port = upstreamPort(upstream.value);
  const sites = splitCaddySites(site.value);
  return port !== null && sites.length > 0 && sites.every(parseRouteAddress)
    ? { sites: site.value, port }
    : null;
}

function upstreamPort(value: string | undefined): number | null {
  const port = Number(value?.match(UPSTREAM)?.[1]);
  return validPort(port) ? port : null;
}

type RouteView = {
  readonly host: string;
  readonly port: number | null;
  readonly tls: boolean;
  readonly from: readonly string[];
};

function serviceRoutes(opts: {
  readonly labels: readonly Site[];
  readonly branch: string | null;
  readonly baseHosts: readonly string[];
}): { readonly routes: readonly RouteView[]; readonly droppedAll: boolean } {
  const { labels, branch, baseHosts } = opts;
  const routes: RouteView[] = [];
  if (branch !== null && baseHosts.length === 0) {
    return { routes, droppedAll: false };
  }
  let droppedAll = false;
  for (const { key, value } of labels) {
    if (!(isCaddySiteLabel(key) && value.trim())) {
      continue;
    }
    const resolved =
      branch === null
        ? value
        : rewriteCaddyLabelForBranch({ value, branch, baseHosts }).value;
    if (branch !== null && !resolved) {
      droppedAll = true;
    }
    const port = upstreamPort(
      labels.find((label) => label.key === `${key}.reverse_proxy`)?.value
    );
    for (const site of splitCaddySites(resolved)) {
      const address = parseRouteAddress(site);
      if (address) {
        routes.push({
          ...address,
          port: port ?? address.port,
          from: branch === null ? ["2"] : ["2", "6"],
        });
      }
    }
  }
  return { routes, droppedAll };
}

function composePorts(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((port: unknown): unknown[] => {
    if (
      typeof port === "number" ||
      (typeof port === "string" && !isConfigSecret("", port))
    ) {
      return [port];
    }
    if (!isRecord(port)) {
      return [];
    }
    return [
      Object.fromEntries(
        Object.entries(port).filter(
          ([key, item]) =>
            [
              "target",
              "published",
              "host_ip",
              "protocol",
              "mode",
              "name",
              "app_protocol",
            ].includes(key) &&
            (typeof item === "number" ||
              (typeof item === "string" && !isConfigSecret("", item)))
        )
      ),
    ];
  });
}

export const COMPOSE_EDIT_FIELDS = ["image", "ports", "depends_on"] as const;

export function editableComposeField(opts: {
  readonly source: ComposeSource;
  readonly service: string;
  readonly field: (typeof COMPOSE_EDIT_FIELDS)[number];
}): boolean {
  const path = ["services", opts.service];
  const node = opts.source.doc.getIn(path, true);
  const raw = opts.source.services[opts.service];
  if (
    !isMap(node) ||
    node.has("<<") ||
    !isRecord(raw) ||
    raw.extends !== undefined
  ) {
    return false;
  }
  const field = opts.source.doc.getIn([...path, opts.field], true);
  return !(
    isMap(field) ||
    isAlias(field) ||
    (isSeq(field) && field.items.some((entry) => !isScalar(entry)))
  );
}

function serviceNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter(
      (entry: unknown): entry is string => typeof entry === "string"
    );
  }
  return isRecord(value) ? Object.keys(value) : [];
}

function composeDependencyIssue(
  source: ComposeSource,
  service: string,
  dependencies: readonly string[]
): ConfigIssue | null {
  if (!source.checksDependencies) {
    return null;
  }
  const missing = dependencies.find(
    (dependency) => !Object.hasOwn(source.services, dependency)
  );
  if (missing === undefined) {
    return null;
  }
  const path = ["services", service, "depends_on"];
  const node = source.doc.getIn(path, true);
  return {
    layer: "2",
    path,
    line:
      isSeq(node) || isMap(node) || isScalar(node)
        ? source.lines.linePos(node.range?.[0] ?? 0).line
        : null,
    code: "E_CONFIG_INVALID",
    message: SERVICE_NAME.test(missing)
      ? `depends_on names a service that is not defined: ${missing}`
      : "depends_on names a service that is not defined.",
  };
}

export function composeModel(opts: {
  readonly text: string;
  readonly branch: string | null;
  readonly baseHosts: readonly string[];
}) {
  const source = parseComposeSource(opts.text);
  const { doc, services } = source;
  const issues: ConfigIssue[] = [];
  if (source.invalid !== null) {
    issues.push({
      layer: "2",
      path: [],
      line: source.invalid,
      code: "E_CONFIG_PARSE",
      message: "Expected a Compose YAML document with a services map.",
    });
  }
  const rows = Object.entries(services).flatMap(([name, service]) => {
    if (!isRecord(service)) {
      issues.push(
        composeFieldIssue(
          source,
          ["services", name],
          "A Compose service must be an object.",
          "E_CONFIG_PARSE"
        )
      );
      return [];
    }
    if (
      Array.isArray(service.ports) &&
      service.ports.some(
        (port: unknown) =>
          !(
            isRecord(port) ||
            (typeof port === "string" && port.includes("$")) ||
            validComposeShortPort(port)
          )
      )
    ) {
      issues.push(
        composeFieldIssue(
          source,
          ["services", name, "ports"],
          "Use ports between 1 and 65535."
        )
      );
    }
    const depends_on = serviceNames(service.depends_on);
    const missingDependency = composeDependencyIssue(source, name, depends_on);
    if (missingDependency) {
      issues.push(missingDependency);
    }
    const labels = composeLabels(service);
    const { routes, droppedAll } = serviceRoutes({
      labels,
      branch: opts.branch,
      baseHosts: opts.baseHosts,
    });
    if (droppedAll) {
      issues.push({
        layer: "2",
        path: ["services", name, "route"],
        line: null,
        code: "E_CONFIG_INVALID",
        message:
          "A Caddy label has no host in this project's route namespaces.",
      });
    }
    const rawService = doc.getIn(["services", name], true);
    const labelsNode = doc.getIn(["services", name, "labels"], true);
    const directlyEditable =
      isMap(rawService) &&
      (isMap(labelsNode) ||
        isSeq(labelsNode) ||
        (labelsNode === undefined && service.labels === undefined)) &&
      !rawService.has("<<") &&
      !(isMap(labelsNode) && labelsNode.has("<<"));
    return [
      {
        name,
        image:
          typeof service.image === "string" &&
          !isConfigSecret("", service.image)
            ? service.image
            : null,
        ports: composePorts(service.ports),
        depends_on,
        routes,
        route_edit: directlyEditable ? simpleRoute(service, labels) : null,
        source_fields: COMPOSE_EDIT_FIELDS.filter(
          (field) => !editableComposeField({ source, service: name, field })
        ),
      },
    ];
  });
  return { services: rows, issues };
}

function composeFieldIssue(
  source: ComposeSource,
  path: string[],
  message: string,
  code = "E_CONFIG_INVALID"
): ConfigIssue {
  const node = source.doc.getIn(path, true);
  return {
    layer: "2",
    path,
    line:
      (isSeq(node) || isMap(node) || isScalar(node)) && node.range
        ? source.lines.linePos(node.range[0]).line
        : null,
    code,
    message,
  };
}

/** Update only the label nodes in the parsed document, keeping pair/item order and comments. */
export function changeComposeRoute(opts: {
  readonly source: ComposeSource;
  readonly service: string;
  readonly sites: string;
  readonly port: number;
}): boolean {
  const { source, service, sites, port } = opts;
  const path = ["services", service, "labels"];
  const model = source.services[service];
  const node = source.doc.getIn(path, true);
  const rawService = source.doc.getIn(path.slice(0, -1), true);
  if (
    !(
      isRecord(model) &&
      simpleRoute(model, composeLabels(model)) &&
      isMap(rawService)
    ) ||
    rawService.has("<<")
  ) {
    return false;
  }
  const edits = new Map([
    ["caddy", sites],
    ["caddy.reverse_proxy", `{{upstreams ${port}}}`],
  ]);
  if (isSeq(node)) {
    updateComposeLabelList(node, edits);
    return true;
  }
  if (node === undefined && model.labels === undefined) {
    source.doc.setIn(path, Object.fromEntries(edits));
    return true;
  }
  if (!isMap(node) || node.has("<<")) {
    return false;
  }
  for (const [key, value] of edits) {
    node.set(key, value);
  }
  return true;
}

function updateComposeLabelList(
  node: YAMLSeq,
  edits: Map<string, string>
): void {
  for (const item of node.items) {
    if (isScalar(item) && typeof item.value === "string") {
      const key = item.value.split("=", 1)[0] ?? "";
      const value = edits.get(key);
      if (value !== undefined) {
        item.value = `${key}=${value}`;
        edits.delete(key);
      }
    }
  }
  for (const [key, value] of edits) {
    node.add(`${key}=${value}`);
  }
}
