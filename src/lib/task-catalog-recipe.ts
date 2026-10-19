import {
  HACK_PROJECT_DIR_LEGACY,
  HACK_PROJECT_DIR_PRIMARY,
} from "../constants.ts";
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

/**
 * How one program can evaluate text as code. The detector is a denylist of
 * known programs: a program missing from it is not inspected. For a known
 * program it is fail-closed: it cannot know every program's option grammar,
 * so an inline or stdin flag anywhere after the program counts, even one
 * that would be an option value or a script argument. A recipe that trips it
 * must run a reviewed script file without such arguments instead.
 */
type Evaluator = {
  /** Options whose argument (or the rest of argv) is inline code. */
  readonly inline: readonly string[];
  /** Options that read code from stdin or start an interactive session. */
  readonly stdin: readonly string[];
  /**
   * Words that make the program run a string as a command wherever they
   * appear after it (`git submodule foreach 'cmd'`). Matched lowercased.
   */
  readonly words: readonly string[];
  /**
   * Options that consume the next argument, so that argument is not the
   * script operand. Matched case-sensitively; used only to find the operand.
   */
  readonly valueOptions: readonly string[];
  /** First-operand subcommands that evaluate a string or start a REPL. */
  readonly subcommands: readonly string[];
  /** True when, without a script operand, the program reads code from stdin. */
  readonly needsOperand: boolean;
  /** True when every following argument is joined and run by a shell. */
  readonly evaluatesOperands: boolean;
};

function evaluator(spec: Partial<Evaluator>): Evaluator {
  return {
    inline: [],
    stdin: [],
    words: [],
    valueOptions: [],
    subcommands: [],
    needsOperand: false,
    evaluatesOperands: false,
    ...spec,
  };
}

const SHELL = evaluator({
  inline: ["-c", "--command"],
  stdin: ["-s", "-i"],
  valueOptions: ["-o", "+o", "-O", "+O", "--rcfile", "--init-file"],
  needsOperand: true,
});

const JS_INLINE = ["-e", "--eval", "-p", "--print"] as const;
const PWSH_INLINE = ["-c", "-command", "-encodedcommand", "-e", "-ec"] as const;

/**
 * Programs that can evaluate a string argument as code, keyed by their name
 * without a version suffix (`python3.12` is `python`). Every argv position
 * is checked, because a service entrypoint may pass any word on to `exec`
 * (this repository's toolchain service does).
 */
const EVALUATORS: Readonly<Record<string, Evaluator>> = {
  sh: SHELL,
  bash: SHELL,
  zsh: SHELL,
  dash: SHELL,
  ksh: SHELL,
  mksh: SHELL,
  ash: SHELL,
  fish: SHELL,
  csh: SHELL,
  tcsh: SHELL,
  node: evaluator({
    inline: JS_INLINE,
    stdin: ["-i", "--interactive"],
    valueOptions: [
      "-r",
      "--require",
      "--import",
      "--loader",
      "--experimental-loader",
      "-C",
      "--conditions",
      "--input-type",
      "--title",
      "--env-file",
    ],
    needsOperand: true,
  }),
  nodejs: evaluator({
    inline: JS_INLINE,
    stdin: ["-i", "--interactive"],
    needsOperand: true,
  }),
  bun: evaluator({
    inline: JS_INLINE,
    valueOptions: ["-r", "--preload", "--cwd", "--env-file", "--config"],
    // `bun exec` runs a string with Bun Shell.
    subcommands: ["repl", "exec"],
  }),
  // `deno run -` reads the program from stdin.
  deno: evaluator({
    stdin: ["-"],
    subcommands: ["eval", "repl"],
    needsOperand: true,
  }),
  tsx: evaluator({
    inline: JS_INLINE,
    stdin: ["-i", "--interactive"],
    valueOptions: ["--tsconfig", "--import", "--require", "-r", "--env-file"],
    needsOperand: true,
  }),
  "ts-node": evaluator({
    inline: JS_INLINE,
    stdin: ["-i", "--interactive"],
    valueOptions: ["-r", "--require", "-P", "--project", "-O"],
    needsOperand: true,
  }),
  // Package runners whose `-c` runs a string in a shell; `yarn exec` (Berry)
  // runs a string in Yarn's shell.
  npx: evaluator({ inline: ["-c", "--call"] }),
  npm: evaluator({ inline: ["-c", "--call"] }),
  pnpm: evaluator({ inline: ["-c", "--shell-mode"] }),
  yarn: evaluator({ subcommands: ["exec"] }),
  nodemon: evaluator({ inline: ["--exec", "-x"] }),
  python: evaluator({
    inline: ["-c"],
    stdin: ["-i"],
    valueOptions: ["-W", "-X", "--check-hash-based-pycs"],
    needsOperand: true,
  }),
  pypy: evaluator({ inline: ["-c"], stdin: ["-i"], needsOperand: true }),
  perl: evaluator({
    inline: ["-e", "-E"],
    valueOptions: ["-I", "-M", "-m"],
    needsOperand: true,
  }),
  ruby: evaluator({
    inline: ["-e"],
    valueOptions: ["-I", "-r", "-C"],
    needsOperand: true,
  }),
  irb: evaluator({ needsOperand: true }),
  php: evaluator({
    inline: ["-r", "-B", "-R", "-E"],
    stdin: ["-a"],
    valueOptions: ["-c", "-d", "-z"],
    needsOperand: true,
  }),
  lua: evaluator({
    inline: ["-e"],
    stdin: ["-i"],
    valueOptions: ["-l"],
    needsOperand: true,
  }),
  luajit: evaluator({ inline: ["-e"], stdin: ["-i"], needsOperand: true }),
  rscript: evaluator({ inline: ["-e"] }),
  // Bare `R` would also read stdin, but a one-letter word is too common as
  // an ordinary argument to refuse on its own.
  r: evaluator({ inline: ["-e"] }),
  osascript: evaluator({
    inline: ["-e"],
    valueOptions: ["-l", "-s"],
    needsOperand: true,
  }),
  expect: evaluator({ inline: ["-c"], stdin: ["-i"], needsOperand: true }),
  tclsh: evaluator({ needsOperand: true }),
  pwsh: evaluator({ inline: PWSH_INLINE, needsOperand: true }),
  powershell: evaluator({ inline: PWSH_INLINE, needsOperand: true }),
  cmd: evaluator({ inline: ["/c", "/k"], needsOperand: true }),
  elixir: evaluator({ inline: ["-e", "--eval", "--rpc-eval"] }),
  mix: evaluator({ inline: ["-e", "--eval"] }),
  erl: evaluator({ inline: ["-eval"] }),
  // Privilege wrappers: the named command is checked at its own position,
  // but `-s`/`-i` start a shell (`sudo -s cmd` runs `$SHELL -c cmd`).
  sudo: evaluator({ stdin: ["-s", "-i", "--shell", "--login"] }),
  doas: evaluator({ stdin: ["-s"] }),
  // Config values and subcommands that run a string in a shell:
  // `git -c alias.x='!cmd' x`, `rebase --exec`, `difftool --extcmd`,
  // `submodule foreach`.
  git: evaluator({
    inline: ["-c", "--config-env", "--exec", "-x", "--extcmd"],
    words: ["foreach"],
  }),
  nix: evaluator({
    inline: ["--expr"],
    subcommands: ["repl", "eval", "develop", "shell"],
  }),
  // GNU make `--eval` (`-E`) adds makefile text; `-f -` reads it from stdin.
  make: evaluator({ inline: ["--eval", "-E"], stdin: ["-"] }),
  entr: evaluator({ inline: ["-s"] }),
  flock: evaluator({ inline: ["-c", "--command"] }),
  script: evaluator({ inline: ["-c", "--command"] }),
  // These run their operands through a shell. Refused only when followed by
  // an argument, so the bare word (a `make` target, a script argument)
  // still passes.
  watch: evaluator({ evaluatesOperands: true }),
  parallel: evaluator({ evaluatesOperands: true }),
  sg: evaluator({ evaluatesOperands: true }),
};

/**
 * Programs refused wherever they appear: `eval`; `env`, which can rewrite
 * the scoped environment, split a string into a command (`-S`) or print
 * every value; `xargs`, which builds a command from stdin; `su`, `runuser`,
 * `ssh` and `nix-shell`, which hand a string to another shell or start one;
 * `concurrently`, `watchexec` and `tmux`, which run strings in a shell;
 * `iex` and the vi and Emacs editors, which are interactive and run
 * commands (`vim -c ':!id'`, `emacs --eval`); and the awk and sed families,
 * whose first operand is program text (`awk 'BEGIN{system(…)}'`, GNU sed's
 * `e`).
 */
const ALWAYS_EVALUATES: ReadonlySet<string> = new Set([
  "eval",
  "env",
  "xargs",
  "su",
  "runuser",
  "ssh",
  "nix-shell",
  "concurrently",
  "watchexec",
  "tmux",
  "iex",
  "vi",
  "vim",
  "nvim",
  "gvim",
  "emacs",
  "awk",
  "gawk",
  "mawk",
  "nawk",
  "sed",
  "gsed",
]);

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
const VERSION_SUFFIX = /[0-9.]+$/;
const SHORT_OPTION_CLUSTER = /^-[a-z]+$/;

/** Program basename, lowercased, without `.exe` or a version suffix. */
function programName(arg: string): string {
  const base = arg.split("/").at(-1) ?? arg;
  const name = base.toLowerCase().replace(EXE_SUFFIX, "");
  return name.replace(VERSION_SUFFIX, "") || name;
}

/**
 * An argument that selects one of `flags`: the flag itself, its `=` form,
 * or a single-dash cluster that contains a one-letter flag (`-Ic`, `-ec`).
 * Both sides are lowercased, so `-C` also matches `-c` (fail-closed).
 */
function matchesFlag(opts: {
  readonly arg: string;
  readonly flags: readonly string[];
}): boolean {
  const arg = opts.arg.toLowerCase();
  return opts.flags.some((raw) => {
    const flag = raw.toLowerCase();
    if (arg === flag || arg.startsWith(`${flag}=`)) {
      return true;
    }
    return (
      flag.length === 2 &&
      flag.startsWith("-") &&
      SHORT_OPTION_CLUSTER.test(arg) &&
      arg.includes(flag.slice(1))
    );
  });
}

/**
 * The first argument that is neither an option nor a known option's value:
 * the script operand, or null when there is none. `-` (read the script from
 * stdin) is returned as is.
 */
function firstOperand(opts: {
  readonly rest: readonly string[];
  readonly valueOptions: readonly string[];
}): string | null {
  for (let index = 0; index < opts.rest.length; index++) {
    const arg = opts.rest[index] ?? "";
    if (arg === "--") {
      return opts.rest[index + 1] ?? null;
    }
    if (arg === "-" || !(arg.startsWith("-") || arg.startsWith("+"))) {
      return arg;
    }
    if (opts.valueOptions.includes(arg)) {
      index += 1;
    }
  }
  return null;
}

function isShellSyntax(arg: string): boolean {
  return (
    SHELL_SYNTAX_TOKENS.has(arg) || arg.includes("$(") || arg.includes("`")
  );
}

/** True when argv[index], taken as a program, could evaluate code. */
function evaluatesCode(argv: readonly string[], index: number): boolean {
  const name = programName(argv[index] ?? "");
  if (ALWAYS_EVALUATES.has(name)) {
    return true;
  }
  const spec = Object.hasOwn(EVALUATORS, name) ? EVALUATORS[name] : undefined;
  if (spec === undefined) {
    return false;
  }
  const rest = argv.slice(index + 1);
  if (spec.evaluatesOperands) {
    return rest.length > 0;
  }
  const flags = [...spec.inline, ...spec.stdin];
  if (
    rest.some(
      (arg) =>
        matchesFlag({ arg, flags }) || spec.words.includes(arg.toLowerCase())
    )
  ) {
    return true;
  }
  const operand = firstOperand({ rest, valueOptions: spec.valueOptions });
  if (operand === null) {
    return spec.needsOperand;
  }
  return operand === "-" || spec.subcommands.includes(operand.toLowerCase());
}

/**
 * True when argv could evaluate a string as code or depend on a shell
 * parser: a shell or interpreter given an inline-code or stdin flag
 * (anywhere after it, even after an option value or a script path), given
 * `-` or no script operand, or a REPL/eval subcommand; a package runner,
 * privilege wrapper or tool given its string-to-shell option or word;
 * `eval`, `env`, `xargs`, `su`, `ssh`, awk, sed or another always-refused
 * program anywhere; or bare shell syntax copied from a log line. Recipes
 * must run a reviewed script file instead; there is no shell endpoint.
 * Programs missing from the tables are not inspected (a denylist).
 */
export function isInlineCommandArgv(argv: readonly string[]): boolean {
  return argv.some(
    (arg, index) => isShellSyntax(arg) || evaluatesCode(argv, index)
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
 * Hack project directory names: `.hack`, and the legacy `.dev` that Hack
 * still resolves (a catalog may live in `.dev/tasks.json`). Lowercase.
 */
const PROJECT_DIR_NAMES: ReadonlySet<string> = new Set([
  HACK_PROJECT_DIR_PRIMARY,
  HACK_PROJECT_DIR_LEGACY,
]);

/**
 * Entries of a project directory that are machine-local: generated state,
 * the materialized env and its state, local overlays and legacy caches
 * (the managed `.hack/.gitignore` block). Compared lowercased.
 */
const HACK_DIR_LOCAL_ENTRIES: ReadonlySet<string> = new Set([
  ".internal",
  ".branch",
  ".env",
  ".env.state.json",
  "hack.env.local.yaml",
  "tickets",
]);

/** `hack.env.<overlay>.local.yaml` local overlay files. Lowercased input. */
const HACK_ENV_LOCAL_OVERLAY = /^hack\.env\..+\.local\.yaml$/;

/**
 * Basenames that hold secrets or key material wherever they appear: the
 * project env secret key, Hack's legacy secrets files, dotenv files and
 * private-key files. Lowercased input.
 */
const SECRET_BASENAME =
  /^(?:\.hack\.secret\.key|\.hack-secrets-file\.key|\.hack-secrets\.enc\.json|\.env|\.env\..*|.*\.(?:key|pem|p8|p12|pfx))$/;

/**
 * A checkout-relative POSIX path to a reviewed repository file: no absolute
 * path, backslash, empty, `.` or `..` segment; nothing inside any `.git`;
 * nothing in a project directory's (`.hack` or legacy `.dev`) machine-local
 * entries; and no secret or key file. Pin digests are reported back on a
 * stale refusal, so a pin must never select a value-bearing machine-local
 * file. This is a lexical denylist; the catalog also requires every pin to
 * be a Git-tracked file (see `task-catalog.ts`). Segments are compared
 * lowercased and NFC-normalized, because the default macOS filesystem is
 * case- and normalization-insensitive (`.GIT/config` is `.git/config`).
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
  const folded = segments.map((s) => s.normalize("NFC").toLowerCase());
  if (folded.includes(".git")) {
    return false;
  }
  const inHackDirLocalState = folded.some(
    (segment, index) =>
      index > 0 &&
      PROJECT_DIR_NAMES.has(folded[index - 1] ?? "") &&
      (HACK_DIR_LOCAL_ENTRIES.has(segment) ||
        HACK_ENV_LOCAL_OVERLAY.test(segment))
  );
  return !(inHackDirLocalState || SECRET_BASENAME.test(folded.at(-1) ?? ""));
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
