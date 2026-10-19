import { isRecord } from "./guards.ts";

/**
 * Recipe grammar and policy tables for the read-only task catalog
 * (HACK-1157, WU26-CATALOG). This module is pure: it parses untrusted
 * catalog values and classifies them, and never touches the filesystem,
 * the engine or a child process. Target-dependent checks (env scope,
 * service, pinned inputs) live in `task-catalog.ts`.
 *
 * Trust model: `.hack/tasks.json` is repository text. Repository or log text
 * never grants execution authority, so a recipe that passes every check is
 * reported as `reviewed` (its pins still match what a reviewer approved) and
 * still carries `authority: "none"`. There is no execution path here.
 *
 * Contract status: every schema name, field, reason and vocabulary value is
 * PROVISIONAL until the AX compatibility review. See
 * docs/reference/ax-task-catalog.md.
 */

/** Schema id a catalog file must declare. Provisional. */
export const TASK_CATALOG_FILE_SCHEMA = "hack.tasks.v0" as const;

/** Task id grammar: lowercase, starts alphanumeric, never starts with `-`. */
export const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Compose service grammar, identical to the target inspector's rule. */
const SERVICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,252}$/;

/** Env overlay grammar (names only; values never appear in a recipe). */
const OVERLAY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,252}$/;

/** Env key names a recipe may scope; values are never accepted. */
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Capability and host-profile token grammar (closed vocabularies). */
const TOKEN_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** Bounds on one recipe. A recipe beyond them is invalid, not truncated. */
const MAX_ARGV = 64;
const MAX_ARG_LENGTH = 1024;
const MAX_TEXT_ENTRIES = 8;
const MAX_TEXT_LENGTH = 280;
const MAX_ENV_KEYS = 32;
const MAX_INPUTS = 16;
const MAX_INPUT_PATH_LENGTH = 512;
const MAX_POINTER_LENGTH = 256;
const MAX_TOKENS = 16;

/**
 * Capabilities a `compose_service` runner may grant a reviewed recipe. A
 * recipe that requires anything else is refused as `missing_capability`:
 * there is no silent fallback to a broader runner.
 */
export const COMPOSE_SERVICE_GRANTS = [
  "checkout_read",
  "checkout_write",
  "named_volumes",
  "network_egress",
  "managed_env",
] as const;

/**
 * Capabilities Hack recognizes but never grants to a catalog recipe (WU26:
 * no default host ports, privileged sockets, home mounts or credential
 * stores). Listed so a refusal can name them; unknown tokens are counted.
 */
export const UNGRANTED_CAPABILITIES = [
  "host_ports",
  "host_network",
  "docker_socket",
  "home_mount",
  "privileged",
  "ssh_agent",
  "credential_store",
] as const;

export type TaskCapability =
  | (typeof COMPOSE_SERVICE_GRANTS)[number]
  | (typeof UNGRANTED_CAPABILITIES)[number];

const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set<string>([
  ...COMPOSE_SERVICE_GRANTS,
  ...UNGRANTED_CAPABILITIES,
]);

const GRANTED: ReadonlySet<string> = new Set<string>(COMPOSE_SERVICE_GRANTS);

/**
 * Closed effect vocabulary and the capability each effect depends on. A
 * recipe must require the capability behind every effect it declares, so the
 * declared effects cannot understate what the recipe needs.
 */
export const TASK_EFFECTS = {
  reads_checkout: "checkout_read",
  writes_checkout: "checkout_write",
  writes_named_volumes: "named_volumes",
  network_egress: "network_egress",
  creates_ephemeral_container: null,
} as const satisfies Record<string, TaskCapability | null>;

export type TaskEffect = keyof typeof TASK_EFFECTS;

/** The only provenance a catalog recipe may claim. */
export const TRUSTED_PROVENANCE = "repository_script" as const;

/** One pinned input: a whole file, or one JSON value inside a file. */
export type TaskInputPin = {
  /** Checkout-relative POSIX path. */
  readonly path: string;
  /** RFC 6901 pointer into a JSON file; null pins the whole file. */
  readonly pointer: string | null;
  readonly sha256: string;
};

export type TaskRunner =
  | {
      readonly kind: "compose_service";
      readonly service: string;
      /** Digest of the canonical JSON of the reviewed service definition. */
      readonly definition_sha256: string;
    }
  | { readonly kind: "host"; readonly profile: string };

/** A recipe whose shape is valid. Policy and target checks come later. */
export type TaskRecipe = {
  readonly id: string;
  readonly summary: string;
  readonly runner: TaskRunner;
  readonly argv: readonly string[];
  /** Absolute working directory inside the service; null keeps its default. */
  readonly workdir: string | null;
  readonly env: {
    /** The env overlay the recipe was reviewed for; null is base layers. */
    readonly overlay: string | null;
    /** Key names the recipe may receive; never values. */
    readonly keys: readonly string[];
  };
  /** Capability tokens. Unknown tokens are kept so they can be refused. */
  readonly requires: readonly string[];
  readonly effects: readonly TaskEffect[];
  readonly prerequisites: readonly string[];
  readonly checks: readonly string[];
  readonly cleanup: readonly string[];
  readonly provenance: {
    readonly source: typeof TRUSTED_PROVENANCE;
    readonly inputs: readonly TaskInputPin[];
    /** Review reference (for example an issue id). Descriptive only. */
    readonly review: string;
  };
};

/** A recipe that passed every check. Only compose-service runners qualify. */
export type ReviewedTaskRecipe = TaskRecipe & {
  readonly runner: Extract<TaskRunner, { kind: "compose_service" }>;
};

const RECIPE_KEYS: ReadonlySet<string> = new Set([
  "id",
  "summary",
  "runner",
  "argv",
  "workdir",
  "env",
  "requires",
  "effects",
  "prerequisites",
  "checks",
  "cleanup",
  "provenance",
]);

/** Control characters (C0, DEL, C1) never appear in recipe text or argv. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function boundedText(value: unknown, max: number): string | null {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > max ||
    CONTROL_CHARACTER.test(value)
  ) {
    return null;
  }
  return value;
}

function textList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_TEXT_ENTRIES) {
    return null;
  }
  const out: string[] = [];
  for (const entry of value) {
    const text = boundedText(entry, MAX_TEXT_LENGTH);
    if (text === null) {
      return null;
    }
    out.push(text);
  }
  return out;
}

function tokenList(
  value: unknown,
  pattern: RegExp,
  max: number
): string[] | null {
  if (!Array.isArray(value) || value.length > max) {
    return null;
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !pattern.test(entry)) {
      return null;
    }
    if (out.includes(entry)) {
      return null;
    }
    out.push(entry);
  }
  return out;
}

/** Valid task id or null. */
export function parseTaskId(value: unknown): string | null {
  return typeof value === "string" && TASK_ID_PATTERN.test(value)
    ? value
    : null;
}

/**
 * The provenance source a recipe claims, when it claims one as a string.
 * Read before the full shape check so a log- or agent-sourced recipe is
 * classified as untrusted even when the rest of it is malformed.
 */
export function claimedProvenanceSource(value: unknown): string | null {
  if (!(isRecord(value) && isRecord(value.provenance))) {
    return null;
  }
  const source = value.provenance.source;
  return typeof source === "string" ? source : null;
}

/** Shell inline-code flags: `sh -c '<code>'` and its clusters (`-ec`). */
const SHELL_FLAGS = ["-c", "--command"] as const;

/**
 * Program names whose options can evaluate a string argument as code: a
 * shell, or a second scripting language's inline-code flag.
 */
const INLINE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  sh: SHELL_FLAGS,
  bash: SHELL_FLAGS,
  zsh: SHELL_FLAGS,
  dash: SHELL_FLAGS,
  ksh: SHELL_FLAGS,
  mksh: SHELL_FLAGS,
  ash: SHELL_FLAGS,
  fish: SHELL_FLAGS,
  csh: SHELL_FLAGS,
  tcsh: SHELL_FLAGS,
  node: ["-e", "--eval", "-p", "--print"],
  nodejs: ["-e", "--eval", "-p", "--print"],
  bun: ["-e", "--eval", "-p", "--print"],
  perl: ["-e", "-E"],
  ruby: ["-e"],
  php: ["-r"],
  lua: ["-e"],
  osascript: ["-e"],
  pwsh: ["-c", "-command", "-encodedcommand", "-e", "-ec"],
  powershell: ["-c", "-command", "-encodedcommand", "-e", "-ec"],
  python: ["-c"],
};

/** Argv elements that only make sense to a shell parser. */
const SHELL_SYNTAX_TOKENS: ReadonlySet<string> = new Set([
  "|",
  "||",
  "&&",
  "&",
  ";",
  ";;",
  ">",
  ">>",
  "<",
  "<<",
  "2>",
  "2>&1",
]);

const EXE_SUFFIX = /\.exe$/;
const PYTHON_NAME = /^python[0-9.]*$/;
const SHORT_OPTION_CLUSTER = /^-[a-z]+$/;

function programName(arg: string): string {
  const base = arg.split("/").at(-1) ?? arg;
  return base.toLowerCase().replace(EXE_SUFFIX, "");
}

function inlineFlagsFor(name: string): readonly string[] | null {
  if (PYTHON_NAME.test(name)) {
    return INLINE_FLAGS.python ?? null;
  }
  return Object.hasOwn(INLINE_FLAGS, name)
    ? (INLINE_FLAGS[name] ?? null)
    : null;
}

/**
 * An option that selects inline code: the flag itself, its `=` form, or a
 * single-dash cluster that contains a one-letter flag (`-Ic`, `-ec`).
 */
function matchesInlineFlag(opts: {
  readonly option: string;
  readonly flags: readonly string[];
}): boolean {
  return opts.flags.some((flag) => {
    if (opts.option === flag || opts.option.startsWith(`${flag}=`)) {
      return true;
    }
    return (
      flag.length === 2 &&
      SHORT_OPTION_CLUSTER.test(opts.option) &&
      opts.option.includes(flag.slice(1))
    );
  });
}

/** Leading option arguments that follow argv[index], lowercased. */
function optionsAfter(argv: readonly string[], index: number): string[] {
  const out: string[] = [];
  for (let next = index + 1; next < argv.length; next++) {
    const arg = argv[next] ?? "";
    if (!arg.startsWith("-") || arg === "--") {
      break;
    }
    out.push(arg.toLowerCase());
  }
  return out;
}

function isShellSyntax(arg: string): boolean {
  return (
    SHELL_SYNTAX_TOKENS.has(arg) || arg.includes("$(") || arg.includes("`")
  );
}

/** True when argv[index] is a program invoked with inline code. */
function evaluatesInlineCode(argv: readonly string[], index: number): boolean {
  const name = programName(argv[index] ?? "");
  if (name === "eval") {
    return true;
  }
  if (name === "deno" && argv[index + 1] === "eval") {
    return true;
  }
  const flags = inlineFlagsFor(name);
  if (flags === null) {
    return false;
  }
  return optionsAfter(argv, index).some((option) =>
    matchesInlineFlag({ option, flags })
  );
}

/**
 * True when argv would evaluate a string as code or depend on a shell
 * parser: a shell with `-c`, an interpreter's inline-code flag, `eval`,
 * an `env` wrapper (which can rewrite the scoped environment or split a
 * string), or bare shell syntax copied from a log line. Recipes must run a
 * reviewed script file instead; there is no shell endpoint.
 */
export function isInlineCommandArgv(argv: readonly string[]): boolean {
  if (argv.length > 0 && programName(argv[0] ?? "") === "env") {
    return true;
  }
  return argv.some(
    (arg, index) => isShellSyntax(arg) || evaluatesInlineCode(argv, index)
  );
}

/** Argv as a string list when it has that shape (for the inline check). */
export function argvStrings(value: unknown): string[] | null {
  if (!(isRecord(value) && Array.isArray(value.argv))) {
    return null;
  }
  const out: string[] = [];
  for (const entry of value.argv) {
    if (typeof entry !== "string") {
      return null;
    }
    out.push(entry);
  }
  return out;
}

function parseArgv(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ARGV) {
    return null;
  }
  const out: string[] = [];
  for (const entry of value) {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.length > MAX_ARG_LENGTH ||
      CONTROL_CHARACTER.test(entry)
    ) {
      return null;
    }
    out.push(entry);
  }
  if ((out[0] ?? "").startsWith("-")) {
    return null;
  }
  return out;
}

function parseWorkdir(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.length > MAX_INPUT_PATH_LENGTH ||
    CONTROL_CHARACTER.test(value) ||
    value.split("/").some((segment) => segment === "..")
  ) {
    return undefined;
  }
  return value;
}

function parseRunner(value: unknown): TaskRunner | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.kind === "compose_service") {
    if (
      !hasOnlyKeys(value, new Set(["kind", "service", "definition_sha256"])) ||
      typeof value.service !== "string" ||
      !SERVICE_PATTERN.test(value.service) ||
      typeof value.definition_sha256 !== "string" ||
      !SHA256_PATTERN.test(value.definition_sha256)
    ) {
      return null;
    }
    return {
      kind: "compose_service",
      service: value.service,
      definition_sha256: value.definition_sha256,
    };
  }
  if (value.kind === "host") {
    if (
      !hasOnlyKeys(value, new Set(["kind", "profile"])) ||
      typeof value.profile !== "string" ||
      !TOKEN_PATTERN.test(value.profile)
    ) {
      return null;
    }
    return { kind: "host", profile: value.profile };
  }
  return null;
}

function parseEnvScope(value: unknown): TaskRecipe["env"] | null {
  if (!(isRecord(value) && hasOnlyKeys(value, new Set(["overlay", "keys"])))) {
    return null;
  }
  const overlay = value.overlay;
  if (
    !(
      overlay === null ||
      (typeof overlay === "string" && OVERLAY_PATTERN.test(overlay))
    )
  ) {
    return null;
  }
  const keys = tokenList(value.keys, ENV_KEY_PATTERN, MAX_ENV_KEYS);
  if (keys === null) {
    return null;
  }
  return { overlay, keys };
}

/**
 * A checkout-relative POSIX path: no absolute path, backslash, empty, `.` or
 * `..` segment, nothing inside `.git`, and nothing in Hack's machine-local
 * generated state.
 */
export function isSafeInputPath(path: string): boolean {
  if (
    path.length === 0 ||
    path.length > MAX_INPUT_PATH_LENGTH ||
    path.startsWith("/") ||
    path.includes("\\") ||
    CONTROL_CHARACTER.test(path)
  ) {
    return false;
  }
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    return false;
  }
  if (segments[0] === ".git") {
    return false;
  }
  const generated = new Set([".internal", ".branch"]);
  return !segments.some(
    (segment, index) =>
      index > 0 && segments[index - 1] === ".hack" && generated.has(segment)
  );
}

function parsePointer(value: unknown): string | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.length > MAX_POINTER_LENGTH ||
    CONTROL_CHARACTER.test(value)
  ) {
    return undefined;
  }
  return value;
}

function parseInputs(value: unknown): TaskInputPin[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_INPUTS
  ) {
    return null;
  }
  const out: TaskInputPin[] = [];
  for (const entry of value) {
    if (
      !(
        isRecord(entry) &&
        hasOnlyKeys(entry, new Set(["path", "pointer", "sha256"]))
      )
    ) {
      return null;
    }
    const pointer = parsePointer(entry.pointer);
    if (
      typeof entry.path !== "string" ||
      !isSafeInputPath(entry.path) ||
      pointer === undefined ||
      typeof entry.sha256 !== "string" ||
      !SHA256_PATTERN.test(entry.sha256)
    ) {
      return null;
    }
    if (out.some((pin) => pin.path === entry.path && pin.pointer === pointer)) {
      return null;
    }
    out.push({ path: entry.path, pointer, sha256: entry.sha256 });
  }
  return out;
}

function parseProvenance(value: unknown): TaskRecipe["provenance"] | null {
  if (
    !(
      isRecord(value) &&
      hasOnlyKeys(value, new Set(["source", "inputs", "review"])) &&
      value.source === TRUSTED_PROVENANCE
    )
  ) {
    return null;
  }
  const inputs = parseInputs(value.inputs);
  const review = boundedText(value.review, MAX_TEXT_LENGTH);
  if (inputs === null || review === null) {
    return null;
  }
  return { source: TRUSTED_PROVENANCE, inputs, review };
}

function parseEffects(value: unknown): TaskEffect[] | null {
  const tokens = tokenList(value, TOKEN_PATTERN, MAX_TOKENS);
  if (tokens === null || tokens.length === 0) {
    return null;
  }
  const out: TaskEffect[] = [];
  for (const token of tokens) {
    if (!Object.hasOwn(TASK_EFFECTS, token)) {
      return null;
    }
    out.push(token as TaskEffect);
  }
  return out;
}

/**
 * Parse one recipe's shape. Returns null for any unknown key, missing field,
 * out-of-bound value or inconsistent declaration:
 * - every declared effect's capability must be in `requires`;
 * - a recipe that scopes env keys must require `managed_env`;
 * - `creates_ephemeral_container` needs a compose-service runner.
 * Provenance must be `repository_script` here; callers classify other
 * claimed sources as untrusted before calling this.
 */
export function parseTaskRecipe(value: unknown): TaskRecipe | null {
  if (!(isRecord(value) && hasOnlyKeys(value, RECIPE_KEYS))) {
    return null;
  }
  const id = parseTaskId(value.id);
  const summary = boundedText(value.summary, MAX_TEXT_LENGTH);
  const runner = parseRunner(value.runner);
  const argv = parseArgv(value.argv);
  const workdir = parseWorkdir(value.workdir);
  const env = parseEnvScope(value.env);
  const requires = tokenList(value.requires, TOKEN_PATTERN, MAX_TOKENS);
  const effects = parseEffects(value.effects);
  const prerequisites = textList(value.prerequisites);
  const checks = textList(value.checks);
  const cleanup = textList(value.cleanup);
  const provenance = parseProvenance(value.provenance);
  if (
    id === null ||
    summary === null ||
    runner === null ||
    argv === null ||
    workdir === undefined ||
    env === null ||
    requires === null ||
    effects === null ||
    prerequisites === null ||
    checks === null ||
    checks.length === 0 ||
    cleanup === null ||
    cleanup.length === 0 ||
    provenance === null
  ) {
    return null;
  }
  for (const effect of effects) {
    const capability = TASK_EFFECTS[effect];
    if (capability !== null && !requires.includes(capability)) {
      return null;
    }
    if (
      effect === "creates_ephemeral_container" &&
      runner.kind !== "compose_service"
    ) {
      return null;
    }
  }
  if (env.keys.length > 0 && !requires.includes("managed_env")) {
    return null;
  }
  return {
    id,
    summary,
    runner,
    argv,
    workdir,
    env,
    requires,
    effects,
    prerequisites,
    checks,
    cleanup,
    provenance,
  };
}

/**
 * Capabilities the recipe requires that its runner does not grant: known
 * ungranted tokens by name, unknown tokens by count only (never echoed).
 */
export function missingCapabilities(requires: readonly string[]): {
  readonly known: readonly TaskCapability[];
  readonly unknown: number;
} {
  const known: TaskCapability[] = [];
  let unknown = 0;
  for (const token of requires) {
    if (GRANTED.has(token)) {
      continue;
    }
    if (KNOWN_CAPABILITIES.has(token)) {
      known.push(token as TaskCapability);
    } else {
      unknown += 1;
    }
  }
  return { known, unknown };
}

/** True when `token` is one of the recognized capability names. */
export function isKnownCapability(token: string): token is TaskCapability {
  return KNOWN_CAPABILITIES.has(token);
}
