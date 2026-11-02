import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";

import { privateCliEnv, privateCliHome } from "./helpers/private-cli-env.ts";
import {
  createSecretWorktreeFixture,
  runFixtureGit,
  type SecretWorktreeFixture,
} from "./helpers/secret-fixture.ts";

/**
 * Synthetic-sentinel scan of public artifacts (HACK-1127).
 *
 * A primary checkout and a linked worktree get synthetic secrets through the
 * source CLI (`env add --secret --value-stdin`, shared and `--local`), then
 * run materialize, exec, up (Compose generation), env apply, logs, list,
 * explain and doctor. Everything is then committed carelessly
 * (`git add -A`), as a user might before pushing a public repository.
 *
 * Required result: zero occurrences of any sentinel value or of the project
 * key, raw or hex/base64/base64url encoded, in CLI output, captured child
 * argv, tracked files, any Git object of the fixture repository, or any other
 * file on disk (HACK_HOME, the private HOME and its caches, generated Compose
 * and runtime files, host-command records and logs). The only exceptions are
 * the private-by-design plaintext materialization `.hack/.env` and the key
 * files themselves, each of which must be git-ignored, untracked and mode
 * 0600. The generated `.hack/.internal/compose.env.override.yml` holds only
 * `${HACK_ENV_...}` references (HACK-1273): it gets no exception, and it must
 * also be private, ignored and untracked.
 *
 * Positive controls prove the scan is not vacuous: every sentinel reaches the
 * exec'd command and the `docker compose` client environment, the encrypted
 * env file is committed, each allowed plaintext artifact actually contains a
 * sentinel, and the Compose env override exists with references.
 *
 * Isolation: private HOME/HACK_HOME/Docker client config (privateCliEnv), a
 * `docker` shim first on PATH that only records its argv and fails, so no real
 * engine, OrbStack, keychain or client configuration is reached. Sentinels are
 * random per run and are never printed; failures report paths and forms only.
 */

const REPO_ROOT = resolve(import.meta.dir, "..");
const ENTRYPOINT = resolve(REPO_ROOT, "index.ts");
const RECORDER = resolve(import.meta.dir, "fixtures/spawn-argv-recorder.ts");
const PROJECT_KEY_FILENAME = ".hack.secret.key";
const SCAN_TIMEOUT_MS = 240_000;

type CliRun = {
  readonly label: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type SpawnRecord = {
  readonly via: string;
  readonly argv: unknown;
  readonly env: unknown;
};

const runId = randomBytes(6).toString("hex");
/** Synthetic secret values; never printed. */
const SENTINELS = {
  PRIMARY_GLOBAL: `hacksentinel-primary-global-${runId}-v4qz`,
  PRIMARY_API: `hacksentinel-primary-api-${runId}-k9wd`,
  LINKED_GLOBAL: `hacksentinel-linked-global-${runId}-p2mx`,
  LINKED_LOCAL: `hacksentinel-linked-local-${runId}-t7ry`,
} as const;
type SentinelName = keyof typeof SENTINELS;

let root = "";
let fixture: SecretWorktreeFixture | null = null;
const runs: CliRun[] = [];
const execDigests = new Map<string, Record<string, string>>();

function requireFixture(): SecretWorktreeFixture {
  if (!fixture) {
    throw new Error("Missing fixture");
  }
  return fixture;
}

function home(): string {
  return privateCliHome(root);
}

function spawnLogPath(): string {
  return join(root, "logs", "spawn.jsonl");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function cli(opts: {
  readonly label: string;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly stdin?: string;
}): Promise<CliRun> {
  // Only the shim directory (docker shim, git link) and the base system
  // directories: no installed hack, Docker client, brew or OrbStack tools.
  // `hack` re-invocations (for example env apply -> restart) then fall back
  // to this source CLI.
  const env = privateCliEnv({
    root,
    env: {
      PATH: [join(root, "shim"), "/usr/bin", "/bin"].join(":"),
      HACK_HOME: join(root, "hack-home"),
      HACK_NO_INTERACTIVE: "1",
      NO_COLOR: "1",
      HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK: "1",
      HACK_TEST_SPAWN_ARGV_LOG: spawnLogPath(),
    },
  });
  const child = Bun.spawn(
    [process.execPath, "--preload", RECORDER, ENTRYPOINT, ...opts.args],
    {
      cwd: opts.cwd,
      env,
      stdin:
        opts.stdin === undefined
          ? "ignore"
          : new TextEncoder().encode(opts.stdin),
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const run = { label: opts.label, exitCode, stdout, stderr };
  runs.push(run);
  return run;
}

/** Value-free description of a failed run (exit code only). */
function expectExit(run: CliRun, code: number): void {
  expect({ label: run.label, exitCode: run.exitCode }).toEqual({
    label: run.label,
    exitCode: code,
  });
}

/** Hashes (never values) of the named variables as seen by the exec'd child. */
const EXEC_PROBE = [
  "const { createHash } = require('node:crypto');",
  "const out = {};",
  "for (const name of process.argv.slice(1)) {",
  "  const value = process.env[name];",
  "  out[name] = value === undefined ? null : createHash('sha256').update(value, 'utf8').digest('hex');",
  "}",
  "process.stdout.write(JSON.stringify(out));",
].join("\n");

async function addSecret(opts: {
  readonly cwd: string;
  readonly name: SentinelName;
  readonly extra?: readonly string[];
}): Promise<void> {
  const run = await cli({
    label: `env add ${opts.name}`,
    cwd: opts.cwd,
    args: [
      "env",
      "add",
      opts.name,
      "--secret",
      "--value-stdin",
      ...(opts.extra ?? []),
    ],
    stdin: `${SENTINELS[opts.name]}\n`,
  });
  expectExit(run, 0);
}

async function exerciseCheckout(opts: {
  readonly label: string;
  readonly cwd: string;
  readonly expected: readonly SentinelName[];
}): Promise<void> {
  expectExit(
    await cli({
      label: `${opts.label} materialize`,
      cwd: opts.cwd,
      args: ["env", "materialize"],
    }),
    0
  );
  const exec = await cli({
    label: `${opts.label} exec`,
    cwd: opts.cwd,
    args: [
      "env",
      "exec",
      "--",
      process.execPath,
      "-e",
      EXEC_PROBE,
      ...opts.expected,
    ],
  });
  expectExit(exec, 0);
  execDigests.set(
    opts.label,
    JSON.parse(exec.stdout) as Record<string, string>
  );
  // Compose generation runs before the (shimmed) engine call fails.
  for (const [suffix, args] of [
    ["up", ["up", "--detach"]],
    ["env apply", ["env", "apply", "--service", "api"]],
    ["logs", ["logs", "--no-follow", "--compose"]],
    ["env list", ["env", "list", "--json"]],
    ["env explain", ["env", "explain", "PRIMARY_GLOBAL", "--json"]],
    ["doctor", ["doctor", "--json"]],
  ] as const) {
    await cli({ label: `${opts.label} ${suffix}`, cwd: opts.cwd, args });
  }
}

function commitEverything(cwd: string, message: string): void {
  runFixtureGit({ cwd, home: home(), args: ["add", "-A"] });
  runFixtureGit({
    cwd,
    home: home(),
    args: ["commit", "-q", "--allow-empty", "-m", message],
  });
}

beforeAll(async () => {
  // Canonical path, so paths reported by git compare equal to walked paths.
  root = await realpath(await mkdtemp(join(tmpdir(), "hack-sentinel-scan-")));
  await mkdir(join(root, "logs"), { recursive: true });
  await mkdir(join(root, "shim"), { recursive: true });
  const shim = join(root, "shim", "docker");
  await writeFile(
    shim,
    [
      "#!/bin/sh",
      `for arg in "$@"; do printf '%s\\n' "$arg" >> '${join(root, "logs", "docker-argv.log")}'; done`,
      "echo 'docker shim: no engine' >&2",
      "exit 1",
      "",
    ].join("\n")
  );
  await chmod(shim, 0o755);
  await symlink(
    await realpath(Bun.which("git") ?? "/usr/bin/git"),
    join(root, "shim", "git")
  );
  fixture = await createSecretWorktreeFixture({
    parent: join(root, "src"),
    home: home(),
    name: `sentinel-${runId}`,
  });
  const { primaryRoot, linkedRoot } = fixture;

  await addSecret({ cwd: primaryRoot, name: "PRIMARY_GLOBAL" });
  await addSecret({
    cwd: primaryRoot,
    name: "PRIMARY_API",
    extra: ["--service", "api"],
  });
  commitEverything(primaryRoot, "careless: primary secrets");
  runFixtureGit({
    cwd: linkedRoot,
    home: home(),
    args: ["merge", "-q", "--ff-only", "main"],
  });
  await addSecret({ cwd: linkedRoot, name: "LINKED_GLOBAL" });
  await addSecret({
    cwd: linkedRoot,
    name: "LINKED_LOCAL",
    extra: ["--local"],
  });

  await exerciseCheckout({
    label: "primary",
    cwd: primaryRoot,
    expected: ["PRIMARY_GLOBAL"],
  });
  await exerciseCheckout({
    label: "linked",
    cwd: linkedRoot,
    expected: ["PRIMARY_GLOBAL", "LINKED_GLOBAL", "LINKED_LOCAL"],
  });
  commitEverything(primaryRoot, "careless: primary after runtime");
  commitEverything(linkedRoot, "careless: linked after runtime");
}, SCAN_TIMEOUT_MS);

afterAll(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

type Needle = { readonly secret: string; readonly form: string };

/**
 * Raw, hex, and the alignment-independent core of standard and URL-safe
 * base64 for each byte offset modulo 3, so an encoded copy embedded at any
 * position is still found.
 */
function encodedForms(text: string): string[] {
  const bytes = Buffer.from(text, "utf8");
  const forms = new Set<string>([text, bytes.toString("hex")]);
  for (let shift = 0; shift < 3; shift += 1) {
    const encoded = Buffer.concat([Buffer.alloc(shift), bytes]).toString(
      "base64"
    );
    const core = encoded.slice(4, -4);
    forms.add(core);
    forms.add(core.replaceAll("+", "-").replaceAll("/", "_"));
  }
  return [...forms].filter((form) => form.length >= 16);
}

function needlesFor(secrets: Readonly<Record<string, string>>): Needle[] {
  return Object.entries(secrets).flatMap(([secret, value]) =>
    encodedForms(value).map((form) => ({ secret, form }))
  );
}

function findHits(text: string, needles: readonly Needle[]): string[] {
  return [
    ...new Set(
      needles
        .filter((needle) => text.includes(needle.form))
        .map((needle) => needle.secret)
    ),
  ].sort();
}

async function walkFiles(dir: string, skip: (path: string) => boolean) {
  const files: string[] = [];
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop() ?? "";
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (skip(path)) {
        continue;
      }
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  }
  return files.sort();
}

async function projectKeyFiles(): Promise<string[]> {
  const { primaryRoot } = requireFixture();
  const commonDir = runFixtureGit({
    cwd: primaryRoot,
    home: home(),
    args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
  }).trim();
  const candidates = [
    join(primaryRoot, PROJECT_KEY_FILENAME),
    join(requireFixture().linkedRoot, PROJECT_KEY_FILENAME),
    join(commonDir, PROJECT_KEY_FILENAME),
  ];
  const present: string[] = [];
  for (const path of candidates) {
    if ((await lstat(path).catch(() => null))?.isFile()) {
      present.push(path);
    }
  }
  return present;
}

/** Every sentinel plus the project key text, keyed by a printable label. */
async function allSecrets(): Promise<Record<string, string>> {
  const secrets: Record<string, string> = { ...SENTINELS };
  const keys = new Set<string>();
  for (const path of await projectKeyFiles()) {
    keys.add((await readFile(path, "utf8")).trim());
  }
  let index = 0;
  for (const key of keys) {
    secrets[`PROJECT_KEY_${index}`] = key;
    index += 1;
  }
  return secrets;
}

/**
 * Plaintext is allowed only in the documented private materialization
 * `.hack/.env`. The Compose env override is value-free since HACK-1273.
 */
function isPrivatePlaintextArtifact(path: string): boolean {
  const { primaryRoot, linkedRoot } = requireFixture();
  return [primaryRoot, linkedRoot].some(
    (checkout) => path === join(checkout, ".hack", ".env")
  );
}

function readSpawnRecords(text: string): SpawnRecord[] {
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SpawnRecord);
}

// ---------------------------------------------------------------------------
// Positive controls
// ---------------------------------------------------------------------------

test("positive control: the workflow delivered every sentinel to the exec'd command", () => {
  expect(runs.length).toBeGreaterThan(10);
  expect(execDigests.get("primary")).toEqual({
    PRIMARY_GLOBAL: sha256(SENTINELS.PRIMARY_GLOBAL),
  });
  expect(execDigests.get("linked")).toEqual({
    PRIMARY_GLOBAL: sha256(SENTINELS.PRIMARY_GLOBAL),
    LINKED_GLOBAL: sha256(SENTINELS.LINKED_GLOBAL),
    LINKED_LOCAL: sha256(SENTINELS.LINKED_LOCAL),
  });
});

test("positive control: the scanner finds every planted encoding in files and Git objects", async () => {
  const plantDir = join(root, "plant");
  await mkdir(plantDir, { recursive: true });
  const needles = needlesFor({ PLANTED: SENTINELS.PRIMARY_API });
  const encoded = [
    SENTINELS.PRIMARY_API,
    Buffer.from(SENTINELS.PRIMARY_API).toString("hex"),
    Buffer.from(`x${SENTINELS.PRIMARY_API}`).toString("base64"),
    Buffer.from(`xy${SENTINELS.PRIMARY_API}`).toString("base64url"),
  ];
  for (const [index, text] of encoded.entries()) {
    expect(findHits(`prefix ${text} suffix`, needles)).toEqual(["PLANTED"]);
    await writeFile(join(plantDir, `planted-${index}`), text);
  }
  const files = await walkFiles(plantDir, () => false);
  expect(files.length).toBe(encoded.length);
  for (const file of files) {
    expect(findHits(await readFile(file, "latin1"), needles)).toEqual([
      "PLANTED",
    ]);
  }
  // A blob written into a scratch repository is found by the object scan.
  const repo = join(plantDir, "repo");
  await mkdir(repo);
  runFixtureGit({ cwd: repo, home: home(), args: ["init", "-q"] });
  await writeFile(join(repo, "blob"), encoded[0] ?? "");
  runFixtureGit({
    cwd: repo,
    home: home(),
    args: ["hash-object", "-w", "blob"],
  });
  await rm(join(repo, "blob"));
  expect(
    findHits(
      runFixtureGit({
        cwd: repo,
        home: home(),
        args: ["cat-file", "--batch-all-objects", "--batch"],
      }),
      needles
    )
  ).toEqual(["PLANTED"]);
  await rm(plantDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Zero-hit scans
// ---------------------------------------------------------------------------

test("no sentinel or key appears in CLI output or captured child argv", async () => {
  const needles = needlesFor(await allSecrets());
  const outputHits = runs.flatMap((run) =>
    findHits(`${run.stdout}\n${run.stderr}`, needles).map(
      (secret) => `${run.label}: ${secret}`
    )
  );
  expect(outputHits).toEqual([]);

  const records = readSpawnRecords(await readFile(spawnLogPath(), "utf8"));
  expect(records.length).toBeGreaterThan(0);
  const argvHits = records.flatMap((record) =>
    findHits(JSON.stringify(record.argv), needles).map(
      (secret) => `${record.via}: ${secret}`
    )
  );
  expect(argvHits).toEqual([]);
  const dockerArgv = await readFile(
    join(root, "logs", "docker-argv.log"),
    "utf8"
  );
  expect(dockerArgv).toContain("compose");
  expect(findHits(dockerArgv, needles)).toEqual([]);
});

test("no sentinel or key is tracked or stored in any Git object after a careless commit", async () => {
  const { primaryRoot, linkedRoot } = requireFixture();
  const needles = needlesFor(await allSecrets());
  // Every object in the shared object store: reachable or not, both branches.
  const objects = runFixtureGit({
    cwd: primaryRoot,
    home: home(),
    args: ["cat-file", "--batch-all-objects", "--batch"],
  });
  expect(findHits(objects, needles)).toEqual([]);

  for (const checkout of [primaryRoot, linkedRoot]) {
    const tracked = runFixtureGit({
      cwd: checkout,
      home: home(),
      args: ["ls-files", "-z"],
    })
      .split("\0")
      .filter((path) => path.length > 0);
    // Not vacuous: the encrypted env file was committed.
    expect(tracked).toContain(".hack/hack.env.default.yaml");
    for (const privatePath of [
      ".hack/.env",
      ".hack/.internal/compose.env.override.yml",
      ".hack/hack.env.local.yaml",
      PROJECT_KEY_FILENAME,
    ]) {
      expect(tracked).not.toContain(privatePath);
    }
    const trackedHits: string[] = [];
    for (const path of tracked) {
      const text = await readFile(join(checkout, path), "latin1");
      for (const secret of findHits(text, needles)) {
        trackedHits.push(`${path}: ${secret}`);
      }
    }
    expect(trackedHits).toEqual([]);
  }
});

test("plaintext exists on disk only in private, ignored, 0600 materializations", async () => {
  const secrets = await allSecrets();
  const keyFiles = new Set(await projectKeyFiles());
  expect(keyFiles.size).toBeGreaterThan(0);
  const needles = needlesFor(secrets);
  const valueNeedles = needlesFor(SENTINELS);
  const files = await walkFiles(
    root,
    (path) =>
      path.endsWith(`${sep}.git${sep}objects`) || path === spawnLogPath()
  );
  // Not vacuous: HACK_HOME, the private HOME and generated runtime files.
  expect(files.some((path) => path.includes(`${sep}hack-home${sep}`))).toBe(
    true
  );
  expect(
    files.some((path) => path.endsWith("compose.runtime.override.yml"))
  ).toBe(true);

  const unexpected: string[] = [];
  const allowed: string[] = [];
  for (const path of files) {
    const hits = findHits(await readFile(path, "latin1"), needles);
    if (hits.length === 0) {
      continue;
    }
    const keyOnly = hits.every((secret) => secret.startsWith("PROJECT_KEY_"));
    if (keyFiles.has(path) && keyOnly) {
      continue;
    }
    const valueOnly = hits.every((secret) => secret in SENTINELS);
    if (isPrivatePlaintextArtifact(path) && valueOnly) {
      allowed.push(path);
      continue;
    }
    unexpected.push(`${relative(root, path)}: ${hits.join(",")}`);
  }
  expect(unexpected).toEqual([]);

  // Positive control: both checkouts materialized the private artifact.
  const { primaryRoot, linkedRoot } = requireFixture();
  for (const checkout of [primaryRoot, linkedRoot]) {
    const path = join(checkout, ".hack", ".env");
    expect(allowed).toContain(path);
    expect(
      findHits(await readFile(path, "utf8"), valueNeedles).length
    ).toBeGreaterThan(0);
  }
  // Positive control: Compose generation wrote the env override, and it holds
  // references only (any value in it is in `unexpected` above).
  const envOverrides = [primaryRoot, linkedRoot].map((checkout) =>
    join(checkout, ".hack", ".internal", "compose.env.override.yml")
  );
  for (const path of envOverrides) {
    expect(allowed).not.toContain(path);
    expect(await readFile(path, "utf8")).toContain("${HACK_ENV_");
  }

  // Every plaintext artifact, env override and key file is private and ignored.
  for (const path of [...allowed, ...envOverrides, ...keyFiles]) {
    expect({
      path: relative(root, path),
      mode: (await lstat(path)).mode & 0o777,
    }).toEqual({ path: relative(root, path), mode: 0o600 });
  }
  for (const checkout of [primaryRoot, linkedRoot]) {
    const inCheckout = [...allowed, ...envOverrides, ...keyFiles]
      .filter((path) => !relative(checkout, path).startsWith(".."))
      .map((path) => relative(checkout, path));
    const ignored = runFixtureGit({
      cwd: checkout,
      home: home(),
      args: ["check-ignore", "--no-index", ...inCheckout],
    })
      .split("\n")
      .filter((line) => line.length > 0);
    expect(ignored.sort()).toEqual([...inCheckout].sort());
  }
});

test("secret values reach child environments only for runtime delivery", async () => {
  const valueNeedles = needlesFor(SENTINELS);
  const records = readSpawnRecords(await readFile(spawnLogPath(), "utf8"));
  const shimDir = join(root, "shim");
  const unexpected: string[] = [];
  let execDeliveries = 0;
  let composeDeliveries = 0;
  for (const record of records) {
    const argv = Array.isArray(record.argv)
      ? record.argv.map((part) => String(part))
      : [];
    const program = argv[0] ?? "";
    // No keychain access, no installed hack, and Docker only through the
    // recording shim.
    expect(["security", "hack"]).not.toContain(basename(program));
    if (["docker", "orbctl", "orb", "colima"].includes(basename(program))) {
      expect(program === basename(program) || program.startsWith(shimDir)).toBe(
        true
      );
    }
    if (
      findHits(JSON.stringify(record.env ?? null), valueNeedles).length === 0
    ) {
      continue;
    }
    if (program === process.execPath && argv[2] === EXEC_PROBE) {
      execDeliveries += 1;
      continue;
    }
    if (basename(program) === "docker" && argv[1] === "compose") {
      composeDeliveries += 1;
      continue;
    }
    unexpected.push(`${record.via} ${basename(program)} ${argv[1] ?? ""}`);
  }
  expect(unexpected).toEqual([]);
  expect(execDeliveries).toBe(2);
  // The value-free override resolves only through the Compose client env.
  expect(composeDeliveries).toBeGreaterThan(0);
});
