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
  /**
   * True when a `data:` URL argument is a module given inline
   * (`node --import data:text/javascript,…`, `deno run data:…`).
   */
  readonly dataUrlModules: boolean;
  /**
   * True when one-dash arguments are single-letter clusters (`-ec`), so a
   * one-letter inline flag inside a cluster counts. False for programs whose
   * one-dash options are words (`sqlite3 -csv`, `duckdb -json`).
   */
  readonly clusters: boolean;
  /**
   * True when the program's option parser accepts an unambiguous prefix of
   * a long option (Git's parse-options, `getopt_long`): `--upl=cmd` is
   * `--upload-pack=cmd`. A long inline flag then also matches any prefix of
   * it. MySQL 8 and later require exact names; refusing a prefix there is
   * only fail-closed.
   */
  readonly abbreviates: boolean;
  /**
   * The one-letter options that take a value, for a program whose parser
   * accepts that value attached in the same argument (getopt `h:`:
   * `-hlocalhost`, `-cSQL`), or null when attached values are not modeled.
   * When set, a one-letter inline flag matches wherever it appears in a
   * one-dash argument (`-1c`, `-Xcselect`, `-u/path/cmd`), scanning letters
   * and digits up to the first option listed here, which takes the rest of
   * the argument as its value (`psql -hlocalhost` is host `localhost`, not
   * `-c`). Unlisted letters are scanned as flags (fail-closed), so a list
   * must hold only options that take a value in every version.
   * Case-sensitive.
   */
  readonly shortValueOptions: readonly string[] | null;
  /**
   * True for MySQL's `my_getopt` parser (`mysql`, `mariadb`): before a long
   * option is looked up, any number of `loose-`/`loose_` prefixes are
   * stripped, and `-` and `_` in its name are the same character
   * (`--loose_init_command=SQL` is `--init-command=SQL`). Long arguments are
   * normalized that way before matching. The `skip-`, `disable-` and
   * `enable-` prefixes replace the value with `0` or `1`, so they cannot
   * carry SQL and are kept.
   */
  readonly myGetopt: boolean;
  /**
   * Flags that select module mode with the module given as a later operand
   * rather than as the flag's own value (`uv run -m code`,
   * `uv run --module code`). Every argument after such a flag is checked
   * against `replModules` (fail-closed), because the program's value
   * options are not modeled.
   */
  readonly moduleFlags: readonly string[];
  /**
   * True when the option parser strips one leading dash from a two-dash
   * option, so `--cmd` is `-cmd` and `--c` is `-c` (the `sqlite3` shell and
   * DuckDB, which shares its argument parser). Flags and value options are
   * then listed in their one-dash form and match either spelling.
   */
  readonly foldsDoubleDash: boolean;
  /**
   * Operands after this many are inline code (`sqlite3 db.sqlite 'SQL'`,
   * `duckdb db.duckdb 'SQL'`), or null when operands are never code.
   */
  readonly codeOperandsAfter: number | null;
  /**
   * Modules that, run with `-m` (`python -m code`), start a REPL or evaluate
   * an argument as code. Matched lowercased on the module's first dotted
   * segment, wherever `-m` appears after the program.
   */
  readonly replModules: readonly string[];
  /**
   * Modules that run another module, script or callable named in their own
   * arguments (`python -m runpy timeit 'code'`). Every argument after one
   * is checked against `replModules` (fail-closed). Matched like
   * `replModules`.
   */
  readonly trampolineModules: readonly string[];
  /**
   * Options whose value is an output file name that, when it starts with
   * `|`, is run as a shell command (`psql -o '|cmd'`, which `psql` opens
   * with `popen` while it is still parsing options, before it connects).
   * Every spelling of the value counts: separate, attached, in a cluster
   * (`-qo|cmd`) and, for a program that abbreviates, under a prefix of the
   * long name (`--out=|cmd`).
   */
  readonly pipeOptions: readonly string[];
  /**
   * Inline flags that count only under one subcommand, because the same
   * letter is harmless elsewhere: `git clone -u <cmd>` runs a command, while
   * `git push -u` sets an upstream. They count after any operand that names
   * the subcommand, not only the first, so a global option missing from
   * `valueOptions` (whose value would be taken as the subcommand) cannot
   * hide it (fail-closed). They do not count before it: Git reads a
   * subcommand's options only after the subcommand's name and rejects an
   * unknown option before it, so `git push -u origin clone` (a branch named
   * `clone`) passes. Keys are lowercase and operands are lowercased before
   * lookup, because Git finds a non-builtin subcommand (`git-send-email`,
   * `git-instaweb`) as a file in its exec path, and on a case-insensitive
   * filesystem `git Send-Email` runs it.
   */
  readonly subcommandInline: Readonly<Record<string, readonly string[]>>;
  /**
   * Inline options of a subcommand that is a Perl script reading its
   * options with Getopt::Long's defaults (`git send-email`), keyed like
   * `subcommandInline` and scoped the same way. Getopt::Long's grammar
   * differs from Git's, so these are matched by `getoptLongSelects`.
   */
  readonly subcommandGetoptLong: Readonly<Record<string, GetoptLongOptions>>;
  /**
   * True when a value starting with `!` (a whole argument, or after `=`)
   * is a shell command: a Git alias defined as `!cmd`, through
   * `git config alias.x '!cmd'` or `git -c alias.x=!cmd`.
   */
  readonly bangCommands: boolean;
  /**
   * True when an `ext::` remote URL (a whole argument, or after `=`) is a
   * command: Git's `ext` remote helper runs the rest of the URL
   * (`git ls-remote 'ext::sh -c cmd'`) when `protocol.ext.allow` permits.
   */
  readonly extUrls: boolean;
};

/**
 * Inline options of a Getopt::Long subcommand, as option names without a
 * prefix, lowercase.
 */
type GetoptLongOptions = {
  /** Options whose value is a command the script runs. */
  readonly inline: readonly string[];
  /**
   * Other options of the same script whose whole name is a prefix of an
   * inline option (`to` for `to-cmd`). Getopt::Long takes an exact name
   * as that option, so `--to` is not an abbreviation of `--to-cmd`.
   */
  readonly exact: readonly string[];
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
    dataUrlModules: false,
    clusters: true,
    abbreviates: false,
    shortValueOptions: null,
    myGetopt: false,
    moduleFlags: [],
    foldsDoubleDash: false,
    codeOperandsAfter: null,
    replModules: [],
    trampolineModules: [],
    pipeOptions: [],
    subcommandInline: {},
    subcommandGetoptLong: {},
    bangCommands: false,
    extUrls: false,
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

/**
 * Python modules that start an interactive or eval REPL (`code`, `idlelib`,
 * `asyncio`, `_pyrepl`, the IPython family, the `sqlite3` shell, the `pdb`
 * debugger) or evaluate a statement argument (`timeit`). `builtins` and
 * `sys` are listed for the trampolines below: `unittest` calls a named
 * callable, so `python -m unittest builtins.breakpoint` (or
 * `sys.breakpointhook`) starts `pdb`.
 */
const PYTHON_REPL_MODULES = [
  "code",
  "idlelib",
  "asyncio",
  "_pyrepl",
  "pdb",
  "timeit",
  "sqlite3",
  "ipython",
  "bpython",
  "ptpython",
  "builtins",
  "sys",
] as const;

/**
 * Python modules that run another module, script or callable named in
 * their own arguments: `runpy <module>`, `trace --module <module>`,
 * `cProfile`/`profile -m <module>`, `profiling.tracing`/`profiling.sampling`
 * (Python 3.15), and `unittest`, which imports a dotted name and calls it
 * when it is callable (`unittest code.interact` starts a REPL). Their
 * option grammars are not modeled, so every argument after one is checked
 * against the REPL modules (fail-closed), which also covers a trampoline
 * naming another trampoline (`runpy runpy timeit …`). `pdb` takes a target
 * too and is refused outright. Matched lowercased, like the REPL modules.
 */
const PYTHON_TRAMPOLINE_MODULES = [
  "runpy",
  "trace",
  "cprofile",
  "profile",
  "profiling",
  "unittest",
] as const;

/**
 * `mysql`/`mariadb` options that run SQL text: `-e`/`--execute`, and
 * `--init-command` and MariaDB's `--init-command-add`, which run at connect
 * and again on every reconnect. Their `my_getopt` parser also accepts
 * `--loose-execute` and `--init_command`. MariaDB's `my_getopt` still
 * accepts a unique prefix of a long name (`mariadb --exec=SQL` is
 * `--execute`), so refusing a prefix is required there; MySQL 8 and later
 * reject an abbreviated name, so for `mysql` it is only fail-closed. The
 * short options that take a value (`-uroot`, `-psecret`,
 * `-Dname`, `-hhost`) end a letter cluster, so `-e` inside their value is
 * not `-e`.
 */
const MYSQL = evaluator({
  inline: ["-e", "--execute", "--init-command", "--init-command-add"],
  abbreviates: true,
  shortValueOptions: ["D", "h", "p", "P", "S", "u"],
  myGetopt: true,
});

/**
 * CPython's interpreter: `-c` code, `-i` and `-` or no script for an
 * interactive session, the REPL modules, and a REPL module named after a
 * trampoline (`-m runpy code`). `-m`, `-W` and `-X` take a value attached
 * in a cluster (`-mcompileall`, `-Wdefault`); an attached module is the
 * operand, so `-mpytest` does not read stdin.
 */
const PYTHON = evaluator({
  inline: ["-c"],
  stdin: ["-i"],
  valueOptions: ["-W", "-X", "--check-hash-based-pycs"],
  needsOperand: true,
  shortValueOptions: ["m", "W", "X"],
  replModules: PYTHON_REPL_MODULES,
  trampolineModules: PYTHON_TRAMPOLINE_MODULES,
});

/**
 * `sqlite3` options that consume the next argument (also used by DuckDB),
 * in their one-dash form; the two-dash spelling folds onto it.
 */
const SQLITE_VALUE_OPTIONS = [
  "-cmd",
  "-init",
  "-separator",
  "-newline",
  "-nullvalue",
  "-vfs",
  "-mmap",
  "-maxsize",
  "-lookaside",
  "-pagecache",
  "-heap",
] as const;
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
    dataUrlModules: true,
  }),
  nodejs: evaluator({
    inline: JS_INLINE,
    stdin: ["-i", "--interactive"],
    needsOperand: true,
    dataUrlModules: true,
  }),
  bun: evaluator({
    inline: JS_INLINE,
    valueOptions: ["-r", "--preload", "--cwd", "--env-file", "--config"],
    // `bun exec` runs a string with Bun Shell.
    subcommands: ["repl", "exec"],
    dataUrlModules: true,
  }),
  // `deno run -` reads the program from stdin.
  deno: evaluator({
    stdin: ["-"],
    subcommands: ["eval", "repl"],
    needsOperand: true,
    dataUrlModules: true,
  }),
  tsx: evaluator({
    inline: JS_INLINE,
    stdin: ["-i", "--interactive"],
    valueOptions: ["--tsconfig", "--import", "--require", "-r", "--env-file"],
    needsOperand: true,
    dataUrlModules: true,
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
  // `python3.13t` and `python3t` (free-threaded) lose their suffix with the
  // version; `pythonw` is the Windows launcher without a console.
  python: PYTHON,
  pythonw: PYTHON,
  pypy: PYTHON,
  // `uv run -m code` and `uv run --module code` run `python -m code`;
  // `uv run -` reads the script from stdin.
  uv: evaluator({
    stdin: ["-"],
    moduleFlags: ["-m", "--module"],
    replModules: PYTHON_REPL_MODULES,
    trampolineModules: PYTHON_TRAMPOLINE_MODULES,
  }),
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
  julia: evaluator({
    inline: ["-e", "--eval", "--print"],
    stdin: ["-i"],
    valueOptions: ["-L", "--load", "-J", "--sysimage", "-t", "--threads"],
    needsOperand: true,
  }),
  // Privilege wrappers: the named command is checked at its own position,
  // but `-s`/`-i` start a shell (`sudo -s cmd` runs `$SHELL -c cmd`).
  sudo: evaluator({ stdin: ["-s", "-i", "--shell", "--login"] }),
  doas: evaluator({ stdin: ["-s"] }),
  // Config values and subcommands that run a string in a shell:
  // `git -c alias.x='!cmd' x`, `clone -c`/`--config`, `rebase --exec`,
  // `difftool --extcmd`, `submodule foreach`, `bisect run`, the
  // `filter-branch` filters, the remote-side commands of
  // `fetch`/`clone`/`ls-remote --upload-pack` (`clone -u`) and
  // `push --receive-pack`, and `!` alias values (`git config alias.x '!cmd'`).
  // Git accepts abbreviated long options (`--upl=cmd`) and a value attached
  // to a short option (`-u/path/cmd`). A dashed builtin (`git-clone`,
  // `/usr/lib/git-core/git-config`) is read as `git <sub>`, and a plumbing
  // helper (`git-bisect--helper`, `git submodule--helper`, Git 2.20-2.33's
  // `git rebase--interactive`) as its porcelain, so Git 2.13-2.19's
  // `rebase--helper --add-exec-commands cmd` meets a `rebase`-scoped flag.
  // That flag is scoped because, as a `git` inline flag, it would also
  // match `git config --add` (Git abbreviates options). The
  // `rebase--interactive --cmd cmd` option is not scoped: no other Git
  // option starts with `--cm`, and a repository alias for the helper
  // (`git ri --cmd cmd`) would hide the subcommand.
  // HACK-1438 adds the remaining porcelain options that run a command, each
  // scoped to its subcommand: `send-email --to-cmd`/`--cc-cmd`/
  // `--header-cmd`/`--sendmail-cmd` and `--smtp-server` (an absolute path
  // there is a sendmail program), `grep -O`/`--open-files-in-pager`,
  // `daemon --access-hook`, `instaweb -d`/`--httpd` and
  // `svn --authors-prog`; the `remote-ext` helper and its `ext::` URLs;
  // and `archimport`, which pastes its operands into a shell pipeline.
  git: evaluator({
    inline: [
      "-c",
      "--config",
      "--config-env",
      "--exec",
      "-x",
      "--extcmd",
      "--upload-pack",
      "--receive-pack",
      "--cmd",
    ],
    words: ["foreach", "bisect", "filter-branch", "remote-ext", "archimport"],
    // Global options before the subcommand that consume the next argument.
    valueOptions: [
      "-C",
      "-c",
      "--git-dir",
      "--work-tree",
      "--namespace",
      "--config-env",
      "--super-prefix",
      "--attr-source",
    ],
    abbreviates: true,
    // Which short options take a value depends on the subcommand (`-m` is a
    // message for `commit` but a flag in `rebase -mx cmd`), so none ends a
    // cluster: `git log -Scache` and `git commit -mcleanup` are refused
    // (fail-closed); pass the value as its own argument instead.
    shortValueOptions: [],
    subcommandInline: {
      clone: ["-u"],
      rebase: ["--add-exec-commands"],
      // `-O<pager>` and `--open-files-in-pager=<pager>` run the pager
      // through the shell with the matching file names.
      grep: ["-O", "--open-files-in-pager"],
      // Run through the shell for each connection.
      daemon: ["--access-hook"],
      // The HTTP daemon command line instaweb starts.
      instaweb: ["-d", "--httpd"],
      // git-svn runs it in backticks for each unknown SVN author.
      svn: ["--authors-prog"],
    },
    subcommandGetoptLong: {
      "send-email": {
        inline: [
          "to-cmd",
          "cc-cmd",
          "header-cmd",
          "sendmail-cmd",
          "smtp-server",
        ],
        exact: ["to", "cc", "h"],
      },
    },
    bangCommands: true,
    extUrls: true,
  }),
  // SQL clients given a statement string. A statement can also reach the
  // host shell (`psql` `\!`, `mysql` `system`, the `sqlite3` `.shell`).
  // The options `psql`'s getopt string gives a value, so `-hlocalhost`,
  // `-Ucustomer` and `-dcustomers` are not `-c` clusters. `-o`/`--output`
  // opens a value starting with `|` with `popen` during option parsing;
  // psql's other file options (`-f`, `-L`/`--log-file`) use plain `fopen`.
  psql: evaluator({
    inline: ["-c", "--command"],
    pipeOptions: ["-o", "--output"],
    abbreviates: true,
    shortValueOptions: [
      "d",
      "f",
      "F",
      "h",
      "L",
      "o",
      "p",
      "P",
      "R",
      "T",
      "U",
      "v",
    ],
  }),
  mysql: MYSQL,
  mariadb: MYSQL,
  // `sqlite3` (`sqlite` once the version suffix is removed) and `duckdb`
  // run any operand after the database as SQL. Their one-dash options are
  // words, not letter clusters, and a two-dash spelling is the same option
  // (`duckdb --c 'SQL'` is `duckdb -c 'SQL'`).
  sqlite: evaluator({
    inline: ["-cmd"],
    valueOptions: SQLITE_VALUE_OPTIONS,
    clusters: false,
    foldsDoubleDash: true,
    codeOperandsAfter: 1,
  }),
  duckdb: evaluator({
    inline: ["-c", "-cmd", "-s"],
    valueOptions: [
      ...SQLITE_VALUE_OPTIONS,
      "-c",
      "-s",
      "-f",
      "-storage-version",
    ],
    clusters: false,
    foldsDoubleDash: true,
    codeOperandsAfter: 1,
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
/**
 * Build-variant suffixes that come after the version: Debian's debug
 * interpreter (`python3.12-dbg`, `python3-dbg`) and the python.org macOS
 * Intel launcher (`python3-intel64`, `python3.13-intel64`).
 */
const VARIANT_SUFFIX = /-(?:dbg|intel64)$/;
/**
 * `python3.12`, `node22` and `node-22` name the same program, and so do
 * CPython's ABI-tagged names: free-threaded `python3.13t` and `python3t`,
 * debug `python3.12d`, and `python3.7m`.
 */
const VERSION_SUFFIX = /-?[0-9][0-9.]*[dmt]{0,2}$/;
const SHORT_OPTION_CLUSTER = /^-[a-z]+$/;
const LETTER_OR_DIGIT = /^[A-Za-z0-9]$/;
/** One `loose-`/`loose_` prefix of a `my_getopt` long option name. */
const MY_GETOPT_LOOSE = /^loose[-_]/i;
/** A `data:` URL argument or option value (`--import=data:…`). */
const DATA_URL = /(?:^|=)data:/i;

/**
 * Program basename, lowercased, without `.exe`, a build-variant suffix or a
 * version suffix.
 */
function programName(arg: string): string {
  const base = arg.split("/").at(-1) ?? arg;
  const name = base
    .toLowerCase()
    .replace(EXE_SUFFIX, "")
    .replace(VARIANT_SUFFIX, "");
  return name.replace(VERSION_SUFFIX, "") || name;
}

/** A dashed Git builtin (`git-clone`) and its subcommand (`clone`). */
const DASHED_GIT = /^git-(.+)$/;
/**
 * A Git plumbing helper subcommand (`bisect--helper`, `submodule--helper`,
 * Git 2.20-2.33's `rebase--interactive`) and the porcelain subcommand it
 * implements (`bisect`, `submodule`, `rebase`).
 */
const GIT_HELPER = /^([a-z0-9][a-z0-9-]*?)--(?:helper|interactive)$/i;

/**
 * A Git argument with a `<sub>--helper` or `<sub>--interactive` subcommand
 * read as its porcelain `<sub>`, so `git bisect--helper --bisect-run cmd`
 * meets the `bisect` rule, `submodule--helper foreach` the `foreach` rule
 * and `rebase--interactive --add-exec-commands` the `rebase` rule. Any other argument is
 * unchanged. A matching argument starts with a letter or digit and holds no
 * `=` or `!`, so no inline flag, word or `!` value is lost by the rewrite.
 * The porcelain is lowercased, like a program name, so a mixed-case helper
 * (`git Rebase--Helper`) still meets the subcommand-scoped flags, which are
 * keyed by lowercase name. Git itself matches case-sensitively, so this
 * only refuses more (fail-closed).
 */
function gitSubcommand(arg: string): string {
  const helper = GIT_HELPER.exec(arg);
  return helper === null ? arg : (helper[1] ?? arg).toLowerCase();
}

/**
 * The evaluator table key for a program name and the arguments it reads:
 * a dashed Git builtin (`git-clone -u cmd url`) is `git` given its
 * subcommand first (`git clone -u cmd url`), so the subcommand-scoped and
 * `!` alias rules apply to it as well. A dashed plumbing helper
 * (`git-bisect--helper`, `/usr/lib/git-core/git-submodule--helper`) is
 * `git` given its porcelain subcommand (`git bisect`, `git submodule`), and
 * so is a `<sub>--helper` argument to `git` itself.
 */
function programArgs(opts: {
  readonly name: string;
  readonly rest: readonly string[];
}): { readonly key: string; readonly rest: readonly string[] } {
  const dashed = DASHED_GIT.exec(opts.name);
  if (dashed === null) {
    return opts.name === "git"
      ? { key: "git", rest: opts.rest.map(gitSubcommand) }
      : { key: opts.name, rest: opts.rest };
  }
  return {
    key: "git",
    rest: [gitSubcommand(dashed[1] ?? ""), ...opts.rest.map(gitSubcommand)],
  };
}

/**
 * An argument that selects one of `flags`: the flag itself, its `=` form,
 * or (for a program with letter clusters) a single-dash cluster that
 * contains a one-letter flag (`-Ic`, `-ec`). Both sides are lowercased, so
 * `-C` also matches `-c` (fail-closed). For a program that abbreviates long
 * options, a prefix of a long flag (`--upl` for `--upload-pack`) matches
 * too. For a program with modeled attached values (`shortValueOptions`), a
 * one-letter flag also matches before a value attached to it (`-cSQL`,
 * `-u/path`, `-qu/path`), but not inside another option's value
 * (`psql -hlocalhost`).
 */
function matchesFlag(opts: {
  readonly arg: string;
  readonly flags: readonly string[];
  readonly spec: Evaluator;
}): boolean {
  const normalized = normalizeOption(opts.arg, opts.spec);
  const arg = normalized.toLowerCase();
  const longName = arg.split("=", 1)[0] ?? arg;
  return opts.flags.some((raw) => {
    const flag = raw.toLowerCase();
    if (arg === flag || arg.startsWith(`${flag}=`)) {
      return true;
    }
    const oneLetter = flag.length === 2 && flag.startsWith("-");
    if (oneLetter) {
      return (
        opts.spec.clusters &&
        clusterSelects({
          arg: normalized,
          letter: flag.slice(1),
          values: opts.spec.shortValueOptions,
        })
      );
    }
    return (
      opts.spec.abbreviates &&
      flag.startsWith("--") &&
      longName.startsWith("--") &&
      longName.length > 2 &&
      flag.startsWith(longName)
    );
  });
}

/**
 * True when a one-dash argument selects the one-letter option `letter`
 * (lowercase), compared case-insensitively. Without modeled attached
 * values (`values` null) only an all-letter cluster counts (`-Ic`). With
 * them, letters and digits are read as options until one of `values` takes
 * the rest of the argument as its value (getopt, Git's parse-options,
 * `my_getopt`): `-1c` and `-cSQL` count, `-hlocalhost` does not.
 */
function clusterSelects(opts: {
  readonly arg: string;
  readonly letter: string;
  readonly values: readonly string[] | null;
}): boolean {
  if (opts.values === null) {
    const arg = opts.arg.toLowerCase();
    return SHORT_OPTION_CLUSTER.test(arg) && arg.includes(opts.letter);
  }
  if (!opts.arg.startsWith("-") || opts.arg.startsWith("--")) {
    return false;
  }
  for (const char of opts.arg.slice(1)) {
    if (!LETTER_OR_DIGIT.test(char)) {
      return false;
    }
    if (char.toLowerCase() === opts.letter) {
      return true;
    }
    if (opts.values.includes(char)) {
      return false;
    }
  }
  return false;
}

/**
 * An argument as the program's option parser reads it: `--x` as `-x` when
 * it strips one leading dash (`foldsDoubleDash`), and a `my_getopt` long
 * option without `loose-` prefixes and with `_` as `-`
 * (`--loose_init_command=SQL` as `--init-command=SQL`). Every other
 * argument, an option's value, and `--` itself are unchanged.
 */
function normalizeOption(arg: string, spec: Evaluator): string {
  if (!arg.startsWith("--") || arg.length <= 2) {
    return arg;
  }
  if (spec.foldsDoubleDash) {
    return arg.slice(1);
  }
  if (!spec.myGetopt) {
    return arg;
  }
  const split = arg.indexOf("=");
  const end = split === -1 ? arg.length : split;
  let name = arg.slice(2, end).replaceAll("_", "-");
  while (MY_GETOPT_LOOSE.test(name)) {
    name = name.slice("loose-".length);
  }
  return `--${name}${arg.slice(end)}`;
}

/** A module named by `-m`, and where the arguments passed to it start. */
type ModuleSelection = {
  readonly module: string;
  /** Index in `rest` of the first argument after the module name. */
  readonly argsFrom: number;
};

/**
 * The module each `-m` selects (`-m code`, `-mcode`, `-Im code`), for a
 * program with Python's option grammar: in a one-dash cluster, the first
 * `m` takes the rest of the cluster or, when nothing follows, the next
 * argument. Every position is checked, and an `m` inside another option's
 * value counts too (fail-closed), so use this only to refuse.
 */
function moduleSelections(rest: readonly string[]): ModuleSelection[] {
  const out: ModuleSelection[] = [];
  for (let index = 0; index < rest.length; index++) {
    const match = PYTHON_MODULE_OPTION.exec(rest[index] ?? "");
    if (match === null) {
      continue;
    }
    const attached = match[1] ?? "";
    if (attached !== "") {
      out.push({ module: attached, argsFrom: index + 1 });
      continue;
    }
    const module = rest[index + 1];
    if (module !== undefined) {
      out.push({ module, argsFrom: index + 2 });
    }
  }
  return out;
}

const PYTHON_MODULE_OPTION = /^-[A-Za-z]*?m(.*)$/;
const LETTER = /^[A-Za-z]$/;

/**
 * True when the options before the first operand certainly select a
 * module, so the program has something to run besides stdin: `-mpytest`,
 * `-um pytest`, `-W ignore -m pytest`. Arguments are read the way Python
 * reads them: an option's value is never an option, whether it is the next
 * argument (`-W -m`, `-X -mpytest`, `--check-hash-based-pycs -m`) or the
 * rest of a cluster (`-Ximporttime` is `-X` given `importtime`), and a
 * cluster ending in a value option takes the next argument (`-bW -m`). A
 * separate module name must not start with `-`. Anything else unexpected,
 * `--` or an operand ends the walk with false, so use this only to accept.
 */
function selectsModule(opts: {
  readonly rest: readonly string[];
  readonly spec: Evaluator;
}): boolean {
  for (let index = 0; index < opts.rest.length; index++) {
    const arg = opts.rest[index] ?? "";
    if (arg === "-" || !arg.startsWith("-") || arg === "--") {
      return false;
    }
    if (opts.spec.valueOptions.includes(normalizeOption(arg, opts.spec))) {
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      continue;
    }
    const end = pythonClusterEnd(arg, opts.spec);
    if (end === "module") {
      return true;
    }
    if (end === "module_next") {
      const module = opts.rest[index + 1];
      return module !== undefined && !module.startsWith("-");
    }
    if (end === "invalid") {
      return false;
    }
    if (end === "value_next") {
      index += 1;
    }
  }
  return false;
}

/**
 * How a one-dash cluster ends when Python reads it: `-m` with its module
 * attached (`module`) or next (`module_next`), a value option whose value
 * is the next argument (`value_next`), only flags or a value option with
 * its value attached (`flags`), or a character that is not an option
 * letter (`invalid`).
 */
function pythonClusterEnd(
  arg: string,
  spec: Evaluator
): "module" | "module_next" | "value_next" | "flags" | "invalid" {
  for (let at = 1; at < arg.length; at++) {
    const char = arg[at] ?? "";
    if (!LETTER.test(char)) {
      return "invalid";
    }
    const last = at + 1 === arg.length;
    if (char === "m") {
      return last ? "module_next" : "module";
    }
    if (spec.shortValueOptions?.includes(char)) {
      return last ? "value_next" : "flags";
    }
  }
  return "flags";
}

/** True when a module's first dotted segment, lowercased, is in `list`. */
function isListedModule(module: string, list: readonly string[]): boolean {
  return list.includes((module.split(".", 1)[0] ?? module).toLowerCase());
}

/**
 * The value one argument gives to one of `flags`: `null` when it selects
 * none, `undefined` when the value is the next argument. A short flag is
 * read in a cluster up to the first option that takes a value, as
 * `clusterSelects` reads it (`-o|cmd`, `-qo|cmd`); a long flag takes an
 * `=` value or the next argument, and for a program that abbreviates, a
 * prefix of its name counts (`--out=|cmd`).
 */
function optionValue(opts: {
  readonly arg: string;
  readonly flags: readonly string[];
  readonly spec: Evaluator;
}): string | undefined | null {
  const arg = normalizeOption(opts.arg, opts.spec);
  const flags = opts.flags.map((flag) => flag.toLowerCase());
  if (arg.startsWith("--")) {
    const split = arg.indexOf("=");
    const name = (split === -1 ? arg : arg.slice(0, split)).toLowerCase();
    const selected =
      name.length > 2 &&
      flags.some(
        (flag) =>
          flag === name ||
          (opts.spec.abbreviates &&
            flag.startsWith("--") &&
            flag.startsWith(name))
      );
    if (!selected) {
      return null;
    }
    return split === -1 ? undefined : arg.slice(split + 1);
  }
  if (!arg.startsWith("-")) {
    return null;
  }
  for (let at = 1; at < arg.length; at++) {
    const char = arg[at] ?? "";
    if (!LETTER_OR_DIGIT.test(char)) {
      return null;
    }
    if (flags.includes(`-${char.toLowerCase()}`)) {
      const attached = arg.slice(at + 1);
      return attached === "" ? undefined : attached;
    }
    if (opts.spec.shortValueOptions?.includes(char)) {
      return null;
    }
  }
  return null;
}

/** A file name that `popen` runs as a command (`|cmd`). */
const PIPE_VALUE = /^\|/;

/** True when any of `spec.pipeOptions` is given a `|cmd` value. */
function pipesToCommand(opts: {
  readonly rest: readonly string[];
  readonly spec: Evaluator;
}): boolean {
  if (opts.spec.pipeOptions.length === 0) {
    return false;
  }
  return opts.rest.some((arg, index) => {
    const value = optionValue({
      arg,
      flags: opts.spec.pipeOptions,
      spec: opts.spec,
    });
    const resolved = value === undefined ? opts.rest[index + 1] : value;
    return typeof resolved === "string" && PIPE_VALUE.test(resolved);
  });
}

/**
 * Every argument after the first of `spec.moduleFlags` (`uv run -m code`),
 * any of which may be the module (fail-closed); none without such a flag.
 */
function afterModuleFlag(opts: {
  readonly rest: readonly string[];
  readonly spec: Evaluator;
}): readonly string[] {
  if (opts.spec.moduleFlags.length === 0) {
    return [];
  }
  const index = opts.rest.findIndex((arg) =>
    matchesFlag({ arg, flags: opts.spec.moduleFlags, spec: opts.spec })
  );
  return index === -1 ? [] : opts.rest.slice(index + 1);
}

/** An operand and its index in the program's arguments. */
type Operand = { readonly word: string; readonly index: number };

/**
 * Every argument that is neither an option nor a known option's value,
 * in order, with its index. Everything after `--` is an operand.
 */
function operands(opts: {
  readonly rest: readonly string[];
  readonly spec: Evaluator;
}): Operand[] {
  const out: Operand[] = [];
  for (let index = 0; index < opts.rest.length; index++) {
    const arg = opts.rest[index] ?? "";
    if (arg === "--") {
      for (let after = index + 1; after < opts.rest.length; after++) {
        out.push({ word: opts.rest[after] ?? "", index: after });
      }
      break;
    }
    if (arg === "-" || !(arg.startsWith("-") || arg.startsWith("+"))) {
      out.push({ word: arg, index });
    } else if (
      opts.spec.valueOptions.includes(normalizeOption(arg, opts.spec))
    ) {
      index += 1;
    }
  }
  return out;
}

/** A value that is a shell command to Git: `!cmd` or `key=!cmd`. */
const BANG_COMMAND = /(?:^|=)\s*!/;
/** An `ext::` remote URL, whole or after `=`, in any letter case. */
const EXT_URL = /(?:^|=)ext::/i;
/** Getopt::Long's default option prefixes (without `POSIXLY_CORRECT`). */
const GETOPT_LONG_PREFIX = /^(?:--|-|\+)/;

/**
 * True when an argument selects one of `options.inline` the way
 * Getopt::Long reads it with its defaults, as `git send-email` does: the
 * name may follow `--`, `-` or `+` (`-to-cmd`, `+to-cmd`), letter case is
 * ignored (`--CC-CMD`), a value may follow `=`, and any prefix of a name
 * is accepted as an abbreviation (`--cc-cm`). A prefix that names more
 * than one option is ambiguous to Getopt::Long, but it is refused here
 * (fail-closed), unless it is the whole name of another option listed in
 * `options.exact` (`--to`, `--cc`).
 */
function getoptLongSelects(opts: {
  readonly arg: string;
  readonly options: GetoptLongOptions;
}): boolean {
  const prefix = GETOPT_LONG_PREFIX.exec(opts.arg)?.[0];
  if (prefix === undefined) {
    return false;
  }
  const body = opts.arg.slice(prefix.length);
  const name = (body.split("=", 1)[0] ?? body).toLowerCase();
  if (name === "" || opts.options.exact.includes(name)) {
    return false;
  }
  return opts.options.inline.some((option) => option.startsWith(name));
}

/**
 * The entries of a subcommand-keyed table in force at argument `at`: one
 * for every operand before it that names a subcommand, compared
 * lowercased (`git clone -u`, `git Send-Email --to-cmd`, not
 * `git push -u origin clone`).
 */
function scopedEntries<T>(opts: {
  readonly table: Readonly<Record<string, T>>;
  readonly positional: readonly Operand[];
  readonly at: number;
}): T[] {
  return opts.positional.flatMap(({ word, index }) => {
    if (index >= opts.at) {
      return [];
    }
    const key = word.toLowerCase();
    const entry = Object.hasOwn(opts.table, key) ? opts.table[key] : undefined;
    return entry === undefined ? [] : [entry];
  });
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
  const { key, rest } = programArgs({ name, rest: argv.slice(index + 1) });
  const spec = Object.hasOwn(EVALUATORS, key) ? EVALUATORS[key] : undefined;
  if (spec === undefined) {
    return false;
  }
  if (spec.evaluatesOperands) {
    return rest.length > 0;
  }
  const positional = operands({ rest, spec });
  const operand = positional[0]?.word ?? null;
  const flags = [...spec.inline, ...spec.stdin];
  if (
    rest.some(
      (arg, at) =>
        matchesFlag({
          arg,
          flags: [
            ...flags,
            ...scopedEntries({
              table: spec.subcommandInline,
              positional,
              at,
            }).flat(),
          ],
          spec,
        }) ||
        scopedEntries({
          table: spec.subcommandGetoptLong,
          positional,
          at,
        }).some((options) => getoptLongSelects({ arg, options })) ||
        spec.words.includes(arg.toLowerCase()) ||
        (spec.dataUrlModules && DATA_URL.test(arg)) ||
        (spec.bangCommands && BANG_COMMAND.test(arg)) ||
        (spec.extUrls && EXT_URL.test(arg))
    ) ||
    pipesToCommand({ rest, spec })
  ) {
    return true;
  }
  const selections = spec.replModules.length > 0 ? moduleSelections(rest) : [];
  const trampolined = selections
    .filter(({ module }) => isListedModule(module, spec.trampolineModules))
    .flatMap(({ argsFrom }) => rest.slice(argsFrom));
  if (
    [
      ...selections.map(({ module }) => module),
      ...afterModuleFlag({ rest, spec }),
      ...trampolined,
    ].some((module) => isListedModule(module, spec.replModules))
  ) {
    return true;
  }
  if (
    spec.codeOperandsAfter !== null &&
    positional.length > spec.codeOperandsAfter
  ) {
    return true;
  }
  if (operand === null) {
    return (
      spec.needsOperand &&
      !(spec.replModules.length > 0 && selectsModule({ rest, spec }))
    );
  }
  return operand === "-" || spec.subcommands.includes(operand.toLowerCase());
}

/**
 * True when argv could evaluate a string as code or depend on a shell
 * parser: a shell or interpreter given an inline-code or stdin flag
 * (anywhere after it, even after an option value or a script path), given
 * `-` or no script operand, or a REPL/eval subcommand or module
 * (`python -m code`, also behind a trampoline: `python -m runpy code`); a
 * SQL client given a statement string (`psql -c`, `sqlite3 db 'SQL'`) or
 * an output pipe (`psql -o '|cmd'`); a package runner, privilege wrapper
 * or tool given its string-to-shell option, word, `!` alias value or
 * `ext::` URL (also as a dashed Git builtin, `git-clone -u cmd`, and in
 * Getopt::Long spellings for `git send-email -to-cmd=cmd`);
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
