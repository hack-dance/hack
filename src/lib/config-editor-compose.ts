import { isIP } from "node:net";
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
const PORT_RANGE = /^([\d*]+)(?:-([\d*]+))?$/;
const PORT_NUMBER = /^[\d*]+$/;
const VARIABLE_REFERENCE =
  /\$(?:\$|\{[A-Za-z_]\w*(?:\}|(:?[-+?]))|[A-Za-z_]\w*)/y;
const PORT_PROTOCOLS = new Set(["tcp", "udp", "sctp", "*"]);
const DEPENDENCY_CONDITIONS = new Set([
  "service_started",
  "service_healthy",
  "service_completed_successfully",
  "*",
]);

export const validHost = (host: string): boolean =>
  host.length <= 253 && host.split(".").every((part) => HOST_LABEL.test(part));

export const validPort = (port: unknown): port is number =>
  typeof port === "number" &&
  Number.isInteger(port) &&
  port >= 1 &&
  port <= 65_535;

export function validComposePort(value: unknown): boolean {
  if (typeof value !== "string") {
    return validPort(value);
  }
  const template = portTemplate(value);
  if (template === null) {
    return false;
  }
  const [mapping, protocol, extra] = template.split("/");
  if (
    mapping === undefined ||
    extra !== undefined ||
    (protocol !== undefined && !PORT_PROTOCOLS.has(protocol))
  ) {
    return false;
  }
  // Split from the target end because a host can be an unbracketed IPv6 address.
  const [target, published, ...address] = mapping.split(":").toReversed();
  const host = address.toReversed().join(":");
  return (
    (address.length === 0 || validPortHost(host)) &&
    (!published || validPortRange(published, true)) &&
    target !== undefined &&
    validPortRange(target) &&
    (!published ||
      published.includes("*") ||
      target.includes("*") ||
      portRangeSpan(target) === 0 ||
      portRangeSpan(target) === portRangeSpan(published))
  );
}

function validPortHost(value: string): boolean {
  const host =
    value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  return host === "*" || isIP(host) !== 0;
}

function portRangeSpan(value: string): number {
  const [first, last = first] = value.split("-");
  return Number(last) - Number(first);
}

function validPortRange(value: string, allowZero = false): boolean {
  const match = PORT_RANGE.exec(value);
  const first = match?.[1];
  const last = match?.[2];
  if (!first) {
    return false;
  }
  return (
    validPortNumber(first, allowZero && last === undefined) &&
    (last === undefined ||
      (validPortNumber(last) &&
        (first.includes("*") ||
          last.includes("*") ||
          Number(first) <= Number(last))))
  );
}

function validPortNumber(value: string, allowZero = false): boolean {
  return (
    PORT_NUMBER.test(value) &&
    (value.includes("*") ||
      (allowZero && value === "0") ||
      validPort(Number(value)))
  );
}

/** Replace well-formed references with an unknown component without reading any env. */
function portTemplate(value: unknown): string | null {
  if (typeof value !== "string" || value.includes("*")) {
    return null;
  }
  let template = "";
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "$") {
      if (depth === 0) {
        template += character;
      } else if (character === "}") {
        depth -= 1;
      }
      continue;
    }
    VARIABLE_REFERENCE.lastIndex = index;
    const match = VARIABLE_REFERENCE.exec(value);
    if (!match) {
      return null;
    }
    const [reference, operator] = match;
    if (depth === 0) {
      template += reference === "$$" ? "$" : "*";
    }
    depth += operator === undefined ? 0 : 1;
    index += reference.length - 1;
  }
  return depth === 0 ? template : null;
}

function validSourcePort(port: unknown): boolean {
  if (!isRecord(port)) {
    return validComposePort(port);
  }
  const { target, published, host_ip } = port;
  const targetTemplate = portTemplate(target);
  const publishedTemplate = portTemplate(
    typeof published === "number" ? String(published) : published
  );
  const hostTemplate = portTemplate(host_ip);
  return (
    (validPort(target) ||
      (targetTemplate !== null && validPortNumber(targetTemplate))) &&
    (published === undefined ||
      (publishedTemplate !== null &&
        validPortRange(publishedTemplate, true))) &&
    (host_ip === undefined ||
      (hostTemplate !== null && validPortHost(hostTemplate)))
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
  const { branch, baseHosts } = opts;
  // Compose reduces repeated list labels to the last assignment.
  const labels = new Map(opts.labels.map(({ key, value }) => [key, value]));
  const routes: RouteView[] = [];
  let droppedAll = false;
  for (const [key, value] of labels) {
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
    const port = upstreamPort(labels.get(`${key}.reverse_proxy`));
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

function validDependencies(value: unknown, complete: boolean): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every(
        (entry) => typeof entry === "string" && SERVICE_NAME.test(entry)
      )) ||
    (isRecord(value) &&
      Object.entries(value).every(
        ([name, options]) =>
          SERVICE_NAME.test(name) &&
          isRecord(options) &&
          validDependencyCondition(options.condition, complete)
      ))
  );
}

function validDependencyCondition(value: unknown, complete: boolean): boolean {
  const condition = portTemplate(value);
  return (
    (condition !== null && DEPENDENCY_CONDITIONS.has(condition)) ||
    (value === undefined && !complete)
  );
}

function composeDependencyIssue(
  source: ComposeSource,
  service: string,
  dependencies: readonly string[]
): ConfigIssue | null {
  const path = ["services", service, "depends_on"];
  if (dependencies.includes(service)) {
    return composeFieldIssue(
      source,
      path,
      "A service cannot depend on itself."
    );
  }
  if (!source.checksDependencies) {
    return null;
  }
  const missing = dependencies.find(
    (dependency) => !Object.hasOwn(source.services, dependency)
  );
  if (missing === undefined) {
    return null;
  }
  return composeFieldIssue(
    source,
    path,
    SERVICE_NAME.test(missing)
      ? `depends_on names a service that is not defined: ${missing}`
      : "depends_on names a service that is not defined."
  );
}

function composeDependencyCycle(source: ComposeSource): ConfigIssue | null {
  if (!source.checksDependencies) {
    return null;
  }
  const pending = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const [name, service] of Object.entries(source.services)) {
    if (!isRecord(service)) {
      continue;
    }
    const dependencies = new Set(serviceNames(service.depends_on));
    dependencies.delete(name);
    let count = 0;
    for (const dependency of dependencies) {
      if (
        !(
          Object.hasOwn(source.services, dependency) &&
          isRecord(source.services[dependency])
        )
      ) {
        continue;
      }
      const downstream = dependents.get(dependency) ?? [];
      downstream.push(name);
      dependents.set(dependency, downstream);
      count += 1;
    }
    pending.set(name, count);
  }
  const ready = [...pending]
    .filter(([, count]) => count === 0)
    .map(([name]) => name);
  for (const name of ready) {
    pending.delete(name);
    for (const downstream of dependents.get(name) ?? []) {
      const count = (pending.get(downstream) ?? 0) - 1;
      pending.set(downstream, count);
      if (count === 0) {
        ready.push(downstream);
      }
    }
  }
  const unresolved = pending.keys().next().value;
  return unresolved === undefined
    ? null
    : composeFieldIssue(
        source,
        ["services", unresolved, "depends_on"],
        "The service graph has a dependency cycle."
      );
}

export function composeModel(opts: {
  readonly text: string;
  readonly branch: string | null;
  readonly baseHosts: readonly string[];
}) {
  const source = parseComposeSource(opts.text);
  const { doc, services } = source;
  const issues: ConfigIssue[] = [];
  const resolveRoutes = opts.branch === null || opts.baseHosts.length > 0;
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
    const depends_on = serviceNames(service.depends_on);
    issues.push(...composeServiceIssues(source, name, service, depends_on));
    const labels = composeLabels(service);
    const { routes, droppedAll } = resolveRoutes
      ? serviceRoutes({
          labels,
          branch: opts.branch,
          baseHosts: opts.baseHosts,
        })
      : { routes: [], droppedAll: false };
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
  const cycle = composeDependencyCycle(source);
  if (cycle) {
    issues.push(cycle);
  }
  return { services: rows, issues };
}

function composeServiceIssues(
  source: ComposeSource,
  name: string,
  service: Record<string, unknown>,
  dependencies: readonly string[]
): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  if (
    service.ports != null &&
    !(Array.isArray(service.ports) && service.ports.every(validSourcePort))
  ) {
    issues.push(
      composeFieldIssue(
        source,
        ["services", name, "ports"],
        "Use valid port mappings with a target port between 1 and 65535."
      )
    );
  }
  const dependencyIssue = validDependencies(
    service.depends_on,
    source.checksDependencies
  )
    ? composeDependencyIssue(source, name, dependencies)
    : composeFieldIssue(
        source,
        ["services", name, "depends_on"],
        "Use a list of services or give each mapped dependency a valid condition."
      );
  if (dependencyIssue) {
    issues.push(dependencyIssue);
  }
  return issues;
}
/** Reuse surviving scalar nodes, including each node's comments and style. */
export function updateComposeServiceField(opts: {
  readonly source: ComposeSource;
  readonly path: string[];
  readonly value: string | (string | number)[];
}): void {
  const { doc } = opts.source;
  const { path, value } = opts;
  const node = doc.getIn(path, true);
  if (!(Array.isArray(value) && isSeq(node))) {
    doc.setIn(path, value);
    return;
  }
  const previous = node.items.filter(isScalar);
  const retained = new Set<(typeof previous)[number]>();
  const matching = value.map((entry) => {
    const item = previous.find(
      (old) =>
        !retained.has(old) &&
        (old.value === entry ||
          (path[2] === "ports" &&
            typeof old.value === "number" &&
            typeof entry === "string" &&
            String(old.value) === entry))
    );
    if (item) {
      retained.add(item);
    }
    return item;
  });
  const remaining = previous.filter((item) => !retained.has(item));
  node.items = value.map((entry, index) => {
    const retainedItem = matching[index];
    if (retainedItem) {
      return retainedItem;
    }
    const item = remaining.shift();
    if (!item) {
      return doc.createNode(entry);
    }
    item.value = entry;
    return item;
  });
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
