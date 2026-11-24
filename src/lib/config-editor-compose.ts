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
const PORT_MAX = 65_535;
const PORT_RANGE = /^([\d*]+)(?:-([\d*]+))?$/;
const PORT_NUMBER = /^[\d*]+$/;
const IPV6_TEMPLATE = /^[a-f\d:.*]+$/i;
const ADJACENT_VARIABLES = /\*+/g;
// Eight IPv6 groups, with space for an embedded IPv4 tail and brackets.
const MAX_PORT_HOST_LENGTH = 47;
const VARIABLE_REFERENCE =
  /\$(?:\$|\{[A-Za-z_]\w*(?:\}|(:?[-+?]))|[A-Za-z_]\w*)/y;
const PORT_PROTOCOLS = ["tcp", "udp", "sctp"];
const DEPENDENCY_CONDITIONS = [
  "service_started",
  "service_healthy",
  "service_completed_successfully",
];

export const validHost = (host: string): boolean =>
  host.length <= 253 && host.split(".").every((part) => HOST_LABEL.test(part));

export const validPort = (port: unknown): port is number =>
  typeof port === "number" &&
  Number.isInteger(port) &&
  port >= 1 &&
  port <= PORT_MAX;

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
    (protocol !== undefined && !matchesComposeOption(protocol, PORT_PROTOCOLS))
  ) {
    return false;
  }
  return (
    validPortMapping(mapping) ||
    validInterpolatedPortPair(mapping) ||
    validInterpolatedHostMapping(mapping)
  );
}

function validPortMapping(mapping: string): boolean {
  // Split from the target end because a host can be an unbracketed IPv6 address.
  const [target, published, ...address] = mapping.split(":").toReversed();
  const host = address.toReversed().join(":");
  return validOptionalPortHost(host) && validPortNumbers(published, target);
}

function validPortNumbers(
  published: string | undefined,
  target: string | undefined
): boolean {
  return (
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

function validOptionalPortHost(host: string): boolean {
  return host === "" || host === "[]" || validPortHost(host);
}

function validInterpolatedPortPair(mapping: string): boolean {
  const separator = mapping.lastIndexOf(":");
  return (
    validOptionalPortHost(mapping.slice(0, Math.max(separator, 0))) &&
    validVariablePortPair(mapping.slice(separator + 1))
  );
}

function validVariablePortPair(tail: string): boolean {
  if (!tail.includes("*")) {
    return false;
  }
  const published = new Set(portVariableSplits(tail, false));
  for (const target of portVariableSplits(tail, true)) {
    if (published.has(target)) {
      return true;
    }
  }
  return false;
}

function validInterpolatedHostMapping(mapping: string): boolean {
  const template = mapping.replace(ADJACENT_VARIABLES, "*");
  let hostLength = 0;
  for (
    let index = 0;
    index < template.length && hostLength <= MAX_PORT_HOST_LENGTH;
    index += 1
  ) {
    if (template[index] !== "*") {
      hostLength += 1;
      continue;
    }
    const prefix = template.slice(0, index);
    if (
      validHostBeforeVariable(prefix) &&
      validPortsAfterVariable(template.slice(index))
    ) {
      return true;
    }
  }
  return false;
}

function validHostBeforeVariable(prefix: string): boolean {
  // A variable can finish the host before supplying its separator.
  return (
    validOptionalPortHost(prefix) ||
    validPortHost(`${prefix}*`) ||
    (prefix.startsWith("[") && validPortHost(`${prefix}*]`))
  );
}

function validPortsAfterVariable(tail: string): boolean {
  const separator = tail.indexOf(":");
  if (separator < 0) {
    return validVariablePortPair(tail);
  }
  return (
    separator === tail.lastIndexOf(":") &&
    validPortNumbers(tail.slice(0, separator), tail.slice(separator + 1))
  );
}

/** A split variable can supply the colon and digits on either side of it. */
function* portVariableSplits(template: string, reverse: boolean) {
  let minimum = 0;
  let place = 1;
  let hasVariable = false;
  let hasRange = false;
  const step = reverse ? -1 : 1;
  for (
    let index = reverse ? template.length - 1 : 0;
    index >= 0 && index < template.length;
    index += step
  ) {
    const token = template[index];
    if (token === "*") {
      hasVariable = true;
      yield index;
      continue;
    }
    if (token === "-") {
      if (hasRange || (!hasVariable && minimum === 0)) {
        return;
      }
      hasRange = true;
      hasVariable = false;
      minimum = 0;
      place = 1;
      continue;
    }
    const digit = template.charCodeAt(index) - 48;
    minimum = reverse ? minimum + digit * place : minimum * 10 + digit;
    if (digit < 0 || digit > 9 || minimum > PORT_MAX) {
      return;
    }
    place = Math.min(place * 10, PORT_MAX + 1);
  }
}

function validPortHost(value: string): boolean {
  if (value.includes("%")) {
    return false;
  }
  const bracketed = value.startsWith("[") && value.endsWith("]");
  const host = bracketed ? value.slice(1, -1) : value;
  if (!host.includes("*")) {
    return isIP(host) !== 0;
  }
  return bracketed || host.includes(":") || !host.includes(".")
    ? validIpv6Template(host)
    : validIpv4Template(host);
}

function validIpv6Template(host: string): boolean {
  const sides = host.split("::");
  if (
    !IPV6_TEMPLATE.test(host) ||
    sides.length > 2 ||
    (host.startsWith(":") && !host.startsWith("::")) ||
    (host.endsWith(":") && !host.endsWith("::"))
  ) {
    return false;
  }
  const parts = sides.filter(Boolean).flatMap((side) => side.split(":"));
  let groups = sides.length === 2 ? 1 : 0;
  for (const [index, part] of parts.entries()) {
    if (!part.includes(".")) {
      groups += minimumIpv6Groups(part);
      continue;
    }
    if (index !== parts.length - 1 || !validIpv4Template(part)) {
      return false;
    }
    groups += 2;
  }
  return groups <= 8;
}

/** A substitution can supply a separator between fixed runs of hex digits. */
function minimumIpv6Groups(part: string): number {
  if (!part) {
    return Number.POSITIVE_INFINITY;
  }
  let groups = 1;
  let width = 0;
  for (const run of part.split("*")) {
    if (run.length > 4) {
      return Number.POSITIVE_INFINITY;
    }
    if (width + run.length > 4) {
      groups += 1;
      width = 0;
    }
    width += run.length;
  }
  return groups;
}

function validIpv4Template(host: string): boolean {
  let octets = 0;
  for (const part of host.split(".")) {
    octets += minimumIpv4Octets(part);
    if (octets > 4) {
      return false;
    }
  }
  return true;
}

/** A substitution can fill out the current octet or insert a dot. */
function minimumIpv4Octets(part: string): number {
  if (!PORT_NUMBER.test(part)) {
    return Number.POSITIVE_INFINITY;
  }
  const [first = "", ...rest] = part.split("*");
  let octet = first;
  let mayHavePrefix = first === "";
  let count = 1;
  for (const run of rest) {
    if (canFitIpv4Octet(octet + run, mayHavePrefix)) {
      octet += run;
      continue;
    }
    if (!canFitIpv4Octet(octet, mayHavePrefix)) {
      return Number.POSITIVE_INFINITY;
    }
    count += 1;
    octet = run;
    mayHavePrefix = true;
  }
  return canFitIpv4Octet(octet, mayHavePrefix)
    ? count
    : Number.POSITIVE_INFINITY;
}

function canFitIpv4Octet(digits: string, mayHavePrefix: boolean): boolean {
  if (digits.length < 2) {
    return true;
  }
  return (
    digits.length <= 3 &&
    (digits.startsWith("0")
      ? mayHavePrefix && digits.length === 2
      : Number(digits) <= 255)
  );
}

function matchesComposeOption(
  template: string,
  options: readonly string[]
): boolean {
  const pattern = template
    .split("*")
    .map((part) => RegExp.escape(part))
    .join(".*");
  const match = new RegExp(`^${pattern}$`);
  return options.some((option) => match.test(option));
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
    ((value.includes("*") && Number(value.replaceAll("*", "")) <= PORT_MAX) ||
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
      } else {
        depth -= Number(character === "}");
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
    const root = isRecord(compose) ? compose : {};
    const services = isRecord(root.services) ? root.services : null;
    const includes = root.include ?? undefined;
    const valid =
      (includes === undefined || validComposeIncludes(includes)) &&
      (services !== null ||
        (root.services === undefined &&
          Array.isArray(includes) &&
          includes.length > 0));
    return {
      doc,
      lines,
      invalid: valid ? null : 1,
      services: services ?? {},
      checksDependencies:
        services !== null &&
        includes === undefined &&
        !Object.values(services).some(
          (service) => isRecord(service) && service.extends !== undefined
        ),
    };
  } catch {
    return { doc, lines, invalid: 1, services: {}, checksDependencies: false };
  }
}

function validComposeIncludes(value: unknown): boolean {
  return Array.isArray(value) && value.every(validComposeInclude);
}

function validComposeInclude(entry: unknown): boolean {
  if (!isRecord(entry)) {
    return nonemptyIncludePath(entry);
  }
  const { path, project_directory, env_file } = entry;
  return (
    (nonemptyIncludePath(path) ||
      (Array.isArray(path) &&
        path.length > 0 &&
        path.every(nonemptyIncludePath))) &&
    (project_directory === undefined ||
      project_directory === null ||
      typeof project_directory === "string") &&
    (env_file === undefined ||
      env_file === null ||
      nonemptyIncludePath(env_file) ||
      (Array.isArray(env_file) && env_file.every(nonemptyIncludePath)))
  );
}

function nonemptyIncludePath(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
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

function publicCaddySites(value: string): string {
  const sites = splitCaddySites(value);
  const visible = sites.filter((site) => !isConfigSecret("", site));
  return visible.length === sites.length ? value : visible.join(", ");
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
    if (!isCaddySiteLabel(key)) {
      continue;
    }
    const sites = publicCaddySites(value);
    const resolved =
      branch === null
        ? sites
        : rewriteCaddyLabelForBranch({ value: sites, branch, baseHosts }).value;
    if (branch !== null && sites.trim() && !resolved) {
      droppedAll = true;
    }
    const port = upstreamPort(labels.get(`${key}.reverse_proxy`));
    for (const site of splitCaddySites(resolved)) {
      const address = parseRouteAddress(site);
      if (address && !isConfigSecret("", address.host)) {
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
    (condition !== null &&
      matchesComposeOption(condition, DEPENDENCY_CONDITIONS)) ||
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
      message: "Expected Compose YAML with a services map or an include list.",
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
    const dependencies = serviceNames(service.depends_on);
    issues.push(...composeServiceIssues(source, name, service, dependencies));
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
    const route = directlyEditable ? simpleRoute(service, labels) : null;
    return [
      {
        name,
        image:
          typeof service.image === "string" &&
          !isConfigSecret("", service.image)
            ? service.image
            : null,
        ports: composePorts(service.ports),
        depends_on: dependencies.filter((name) => !isConfigSecret("", name)),
        routes,
        route_edit: route && { ...route, sites: publicCaddySites(route.sites) },
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
  return {
    services: rows.filter(({ name }) => !isConfigSecret("", name)),
    issues: issues.map((issue) => ({
      ...issue,
      path: issue.path.map((part) =>
        isConfigSecret("", part) ? "[redacted]" : part
      ),
    })),
  };
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
  if (!(isRecord(model) && isMap(rawService)) || rawService.has("<<")) {
    return false;
  }
  const route = simpleRoute(model, composeLabels(model));
  if (!route) {
    return false;
  }
  // Route edits contain the visible sites, so retain hidden sites on disk.
  const privateSites = splitCaddySites(route.sites).filter((site) =>
    isConfigSecret("", site)
  );
  const editedSites =
    privateSites.length === 0
      ? sites
      : [...new Set([...splitCaddySites(sites), ...privateSites])].join(", ");
  const edits = new Map([
    ["caddy", editedSites],
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
