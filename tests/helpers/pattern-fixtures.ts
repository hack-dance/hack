import { readdir } from "node:fs/promises";
import { join, normalize } from "node:path";
import type { PatternCard } from "../../src/agents/pattern-catalogue.ts";
import { builtinOptions, type CliSpec } from "../../src/cli/command.ts";
import { isRecord } from "../../src/lib/guards.ts";
import { extractHackInvocations } from "./cli-guidance-commands.ts";

/**
 * Static checks for the HACK-P example fixtures under `examples/patterns/`.
 * They read files only: no container runtime, no HOME, no network. Every
 * finding is a fixed code (plus a card id or Compose service name the fixture
 * authored); config values are never echoed.
 */

export const PATTERN_EXAMPLES_DIR = "examples/patterns";

/** Files every example fixture must provide. */
export const PATTERN_EXAMPLE_FILES = [
  "README.md",
  ".hack/hack.config.json",
  ".hack/docker-compose.yml",
] as const;

/**
 * Check that card `example` references resolve to fixture directories and
 * that every fixture directory belongs to exactly one card.
 */
export async function exampleReferenceIssues(opts: {
  readonly repoRoot: string;
  readonly cards: readonly PatternCard[];
}): Promise<string[]> {
  const issues: string[] = [];
  const referenced = new Map<string, string>();
  for (const card of opts.cards) {
    if (card.example === null) {
      continue;
    }
    const dir = normalize(card.example);
    const parent = `${PATTERN_EXAMPLES_DIR}/`;
    const name = dir.slice(parent.length);
    if (!dir.startsWith(parent) || name.length === 0 || name.includes("/")) {
      issues.push(`${card.id}: example-outside-patterns-dir`);
      continue;
    }
    if (referenced.has(name)) {
      issues.push(`${card.id}: example-shared-with-${referenced.get(name)}`);
      continue;
    }
    referenced.set(name, card.id);
    for (const file of PATTERN_EXAMPLE_FILES) {
      if (!(await Bun.file(join(opts.repoRoot, dir, file)).exists())) {
        issues.push(`${card.id}: missing-${file}`);
      }
    }
    const readme = Bun.file(join(opts.repoRoot, dir, "README.md"));
    if ((await readme.exists()) && !(await readme.text()).includes(card.id)) {
      issues.push(`${card.id}: readme-missing-card-id`);
    }
  }
  const entries = await readdir(join(opts.repoRoot, PATTERN_EXAMPLES_DIR), {
    withFileTypes: true,
  });
  for (const entry of entries) {
    if (entry.isDirectory() && !referenced.has(entry.name)) {
      issues.push("unreferenced-example-directory");
    }
  }
  return issues;
}

type ComposeService = Readonly<Record<string, unknown>>;

function composeServices(
  compose: unknown
): Readonly<Record<string, ComposeService>> {
  if (!(isRecord(compose) && isRecord(compose.services))) {
    return {};
  }
  const services: Record<string, ComposeService> = {};
  for (const [name, service] of Object.entries(compose.services)) {
    if (isRecord(service)) {
      services[name] = service;
    }
  }
  return services;
}

function serviceProfiles(service: ComposeService): readonly string[] {
  return Array.isArray(service.profiles)
    ? service.profiles.filter(
        (profile): profile is string => typeof profile === "string"
      )
    : [];
}

type Mount = { readonly source: string; readonly target: string };

function serviceMounts(service: ComposeService): Mount[] | null {
  if (service.volumes === undefined) {
    return [];
  }
  if (!Array.isArray(service.volumes)) {
    return null;
  }
  const mounts: Mount[] = [];
  for (const mount of service.volumes) {
    if (typeof mount === "string") {
      const [source = "", target = ""] = mount.split(":");
      mounts.push({ source, target });
    } else if (
      isRecord(mount) &&
      typeof mount.source === "string" &&
      typeof mount.target === "string"
    ) {
      mounts.push({ source: mount.source, target: mount.target });
    } else {
      return null;
    }
  }
  return mounts;
}

const DIGEST_PINNED_IMAGE = /@sha256:[a-f0-9]{64}$/;
const DOCKER_SOCKET = /docker\.sock|\/var\/run\/docker|orbstack/i;
const HOME_SOURCE = /^(?:~|\$\{?HOME\}?|\/Users\/|\/home\/|\/root(?:\/|$))/;
const SSH_SOURCE = /SSH_AUTH_SOCK|\.ssh(?:\/|$)|ssh-agent/i;
const CREDENTIAL_SOURCE =
  /\.(?:aws|config\/gcloud|kube|docker|npmrc|netrc|gnupg)(?:\/|$)|credentials/i;

function mountIssues(opts: {
  readonly mount: Mount;
  readonly namedVolumes: ReadonlySet<string>;
}): string[] {
  const { source } = opts.mount;
  if (DOCKER_SOCKET.test(source)) {
    return ["forbidden-mount-docker-socket"];
  }
  if (HOME_SOURCE.test(source)) {
    return ["forbidden-mount-home"];
  }
  if (SSH_SOURCE.test(source)) {
    return ["forbidden-mount-ssh"];
  }
  if (CREDENTIAL_SOURCE.test(source)) {
    return ["forbidden-mount-credentials"];
  }
  // The project checkout is the only permitted bind mount.
  if (source === "..") {
    return [];
  }
  return opts.namedVolumes.has(source) ? [] : ["cache-not-named-volume"];
}

/**
 * HACK-P02 static contract for a portable toolchain service: one-shot behind
 * an opt-in profile, digest-pinned image, explicit resource bounds, caches in
 * named volumes, and no Docker socket, home, SSH agent or credential mounts.
 * The project must not declare an always-on service.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: A flat list of independent card checks reads best in one place.
export function toolchainServiceIssues(opts: {
  readonly compose: unknown;
  readonly service: string;
}): string[] {
  const services = composeServices(opts.compose);
  const service = services[opts.service];
  if (service === undefined) {
    return ["missing-service"];
  }
  const issues: string[] = [];
  for (const [name, entry] of Object.entries(services)) {
    if (serviceProfiles(entry).length === 0) {
      issues.push(`always-on-service-${name}`);
    }
  }
  if (
    !(
      typeof service.image === "string" &&
      DIGEST_PINNED_IMAGE.test(service.image)
    )
  ) {
    issues.push("image-not-digest-pinned");
  }
  if (service.cpus === undefined) {
    issues.push("missing-cpu-bound");
  }
  if (service.mem_limit === undefined) {
    issues.push("missing-memory-bound");
  }
  if (service.restart !== undefined && service.restart !== "no") {
    issues.push("restart-policy");
  }
  if (service.ports !== undefined) {
    issues.push("published-ports");
  }
  if (service.env_file !== undefined) {
    issues.push("env-file");
  }
  if (service.privileged === true) {
    issues.push("privileged");
  }
  const compose = opts.compose;
  const namedVolumes = new Set(
    isRecord(compose) && isRecord(compose.volumes)
      ? Object.keys(compose.volumes)
      : []
  );
  const mounts = serviceMounts(service);
  if (mounts === null) {
    issues.push("unreadable-mounts");
  } else {
    for (const mount of mounts) {
      issues.push(...mountIssues({ mount, namedVolumes }));
    }
    if (!mounts.some((mount) => namedVolumes.has(mount.source))) {
      issues.push("no-named-cache-volume");
    }
  }
  return [...new Set(issues)];
}

const SERVICE_COMMANDS: ReadonlySet<string> = new Set(["run", "exec", "logs"]);

/**
 * Check that every `hack run|exec|logs <service>` in a README names a Compose
 * service, and that each `--profile` it passes is one of that service's
 * profiles (a profiled service also needs its profile on the command line).
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Token walking keeps option arity and positional selection in one pass.
export function readmeServiceIssues(opts: {
  readonly cli: CliSpec;
  readonly readme: string;
  readonly compose: unknown;
}): string[] {
  const services = composeServices(opts.compose);
  const issues: string[] = [];
  for (const invocation of extractHackInvocations(opts.readme)) {
    const tokens = invocation.split(/\s+/).slice(1);
    const name = tokens[0];
    if (name === undefined || !SERVICE_COMMANDS.has(name)) {
      continue;
    }
    const command = opts.cli.commands.find((entry) => entry.name === name);
    if (!command) {
      issues.push(`unknown-command-${name}`);
      continue;
    }
    const options = [
      ...builtinOptions(),
      ...opts.cli.globalOptions,
      ...command.options,
    ];
    const profiles: string[] = [];
    const positionals: string[] = [];
    for (let index = 1; index < tokens.length; index += 1) {
      const token = tokens[index] ?? "";
      if (token === "--") {
        break;
      }
      if (!token.startsWith("--")) {
        positionals.push(token);
        continue;
      }
      const [flag = "", inline] = token.split("=", 2);
      const option = options.find((entry) => entry.long === flag);
      if (option === undefined || option.type === "boolean") {
        continue;
      }
      const value = inline ?? tokens[index + 1] ?? "";
      if (inline === undefined) {
        index += 1;
      }
      if (option.long === "--profile") {
        profiles.push(...value.split(","));
      }
    }
    const serviceName = positionals[0];
    if (serviceName === undefined) {
      if (name !== "logs") {
        issues.push(`${name}-missing-service`);
      }
      continue;
    }
    const service = services[serviceName];
    if (service === undefined) {
      issues.push(`${name}-unknown-service`);
      continue;
    }
    const declared = serviceProfiles(service);
    if (profiles.some((profile) => !declared.includes(profile))) {
      issues.push(`${name}-undeclared-profile`);
    }
    if (
      name !== "logs" &&
      declared.length > 0 &&
      !profiles.some((profile) => declared.includes(profile))
    ) {
      issues.push(`${name}-missing-profile`);
    }
  }
  return issues;
}

/** Keys per scope in one parsed `hack.env.*.yaml` document. */
function envKeysByScope(document: unknown): Map<string, Set<string>> {
  const scopes = new Map<string, Set<string>>();
  const values =
    isRecord(document) && isRecord(document.values) ? document.values : {};
  for (const [scope, entries] of Object.entries(values)) {
    scopes.set(scope, new Set(isRecord(entries) ? Object.keys(entries) : []));
  }
  return scopes;
}

/** Issues of one overlay document plus its sorted `scope.KEY` signature. */
function overlayDocumentIssues(opts: {
  readonly name: string;
  readonly document: unknown;
  readonly sharedKeys: ReadonlySet<string>;
}): { readonly issues: string[]; readonly signature: string } {
  const { name, document } = opts;
  const issues: string[] = [];
  if (!isRecord(document) || document.environment !== name) {
    issues.push(`${name}: environment-mismatch`);
  }
  const values =
    isRecord(document) && isRecord(document.values) ? document.values : {};
  const keys: string[] = [];
  for (const [scope, entries] of Object.entries(values)) {
    const scoped = isRecord(entries) ? entries : {};
    for (const [key, value] of Object.entries(scoped)) {
      keys.push(`${scope}.${key}`);
      if (opts.sharedKeys.has(key)) {
        issues.push(`${name}: overrides-shared-key`);
      }
      if (typeof value !== "string") {
        issues.push(`${name}: non-plaintext-capability`);
      }
    }
  }
  return { issues, signature: keys.sort().join(",") };
}

/**
 * HACK-P07 static contract for capability overlays: the base env file holds
 * the shared topology values, and every overlay names its own environment,
 * holds plaintext capability values only, declares the same keys as every
 * other overlay (so switching never leaves a stale capability), and never
 * redefines a base key (an overlay must not change the shared topology).
 * Findings are closed codes plus the overlay name the fixture authored.
 */
export function overlayIssues(opts: {
  readonly base: unknown;
  readonly overlays: Readonly<Record<string, unknown>>;
}): string[] {
  const issues: string[] = [];
  const sharedKeys = new Set(
    [...envKeysByScope(opts.base).values()].flatMap((keys) => [...keys])
  );
  if (sharedKeys.size === 0) {
    issues.push("base-without-shared-values");
  }
  const signatures = new Set<string>();
  const overlays = Object.entries(opts.overlays);
  for (const [name, document] of overlays) {
    const checked = overlayDocumentIssues({ name, document, sharedKeys });
    issues.push(...checked.issues);
    signatures.add(checked.signature);
  }
  if (overlays.length < 2) {
    issues.push("fewer-than-two-overlays");
  }
  if (signatures.size > 1) {
    issues.push("overlay-key-sets-differ");
  }
  return [...new Set(issues)];
}

/**
 * Check that every card with an example names a registered Docker-tier E2E
 * scenario with a checked-in duration hint, and that no card without an
 * example claims one. Findings are closed codes plus the card id.
 */
export function e2eRegistrationIssues(opts: {
  readonly cards: readonly PatternCard[];
  readonly scenarios: readonly {
    readonly name: string;
    readonly tier: string;
  }[];
  readonly hints: Readonly<Record<string, number>>;
}): string[] {
  const issues: string[] = [];
  for (const card of opts.cards) {
    if (card.example === null) {
      if (card.e2eScenario !== null) {
        issues.push(`${card.id}: scenario-without-example`);
      }
      continue;
    }
    const name = card.e2eScenario;
    const scenario = opts.scenarios.find((entry) => entry.name === name);
    if (name === null || scenario === undefined) {
      issues.push(`${card.id}: scenario-not-registered`);
      continue;
    }
    if (scenario.tier !== "docker") {
      issues.push(`${card.id}: scenario-not-docker-tier`);
    }
    if (!Object.hasOwn(opts.hints, name)) {
      issues.push(`${card.id}: scenario-without-duration-hint`);
    }
  }
  return issues;
}
