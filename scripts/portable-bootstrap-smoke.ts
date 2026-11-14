import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

const COMMAND_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5000;
const OUTPUT_LIMIT = 128 * 1024;
const POLL_MS = 40;
const INPUTS = [
  ".hack/hack.config.json",
  ".hack/docker-compose.yml",
  ".hack/hack.env.default.yaml",
  "app.ts",
  "dev.ts",
  "denied.ts",
] as const;

type BootstrapStep =
  | "setup"
  | "identity"
  | "env"
  | "http"
  | "dev-write"
  | "restart"
  | "cleanup";
type BootstrapReason =
  | "cli_identity"
  | "cli_version_format"
  | "missing_wrong_key_refusal"
  | "secret_free_launch_refusal"
  | "configuration_read"
  | "env_provenance_read"
  | "env_provenance_semantics"
  | "repeat_reads_preserve_inputs"
  | "fresh_application_data"
  | "development_command"
  | "application_reads_development_write"
  | "new_application_process"
  | "restart_retains_application_data"
  | "workflow_preserves_inputs"
  | "workflow_completion"
  | "bounded_command_output"
  | "secret_free_command_output"
  | "application_readiness"
  | "bounded_http_response"
  | "loopback_http_response"
  | "owned_application_response"
  | "owned_application_stop"
  | "application_stop_status"
  | "application_listener_retired"
  | "fixture_contains_no_external_symlinks"
  | "no_materialized_env_key_files"
  | "secret_free_fixture_files"
  | "owned_cleanup_failed"
  | "fixture_cleanup"
  | "invalid_executable"
  | "invalid_json"
  | "connection_refused"
  | "connection_reset"
  | "http_timeout"
  | "io_error"
  | "unexpected_error"
  | "command_deadline"
  | "output_collection_deadline"
  | "owned_process_cleanup_deadline"
  | "forced_owned_process_cleanup_deadline";
type BootstrapContext = { step: BootstrapStep };

type Child = Bun.Subprocess<"ignore", "pipe", "pipe">;
type Capture = { text: string; overflow: boolean };
type OwnedCommand = {
  child: Child;
  stdout: Promise<Capture>;
  stderr: Promise<Capture>;
};
type Ready = { port: number; run: string; boot: string };
type Fixture = {
  root: string;
  project: string;
  env: Record<string, string>;
  key: string;
  secret: string;
  forbidden: string[];
  run: string;
  commands: Set<OwnedCommand>;
};

/**
 * Fresh portable-host acceptance for a caller-selected installed executable.
 * Uses only Bun and node built-ins, so copying this file needs no repo dependencies.
 * It does not install Hack, provision Docker, or qualify a native VM/cloud provider.
 */
export async function runPortableBootstrap(opts: {
  readonly hackBin: string;
}): Promise<{ version: string; checks: readonly string[]; cleanup: true }> {
  const context: BootstrapContext = { step: "setup" };
  try {
    return await runWorkflow(opts, context);
  } catch (error: unknown) {
    throw new BootstrapFailure(
      failureReason(error),
      error instanceof BootstrapFailure
        ? (error.step ?? context.step)
        : context.step
    );
  }
}

async function runWorkflow(
  opts: { readonly hackBin: string },
  context: BootstrapContext
): Promise<{ version: string; checks: readonly string[]; cleanup: true }> {
  if (!isAbsolute(opts.hackBin)) {
    throw new BootstrapFailure("invalid_executable");
  }
  const hackBin = await realpath(opts.hackBin);
  if (!(await lstat(hackBin)).isFile()) {
    throw new BootstrapFailure("invalid_executable");
  }
  await access(hackBin, constants.X_OK);
  const fixture = await createFixture();
  const checks: string[] = [];
  let version = "";
  let completed = false;
  try {
    context.step = "identity";
    const identity = await command({ fixture, hackBin, args: ["--version"] });
    requireThat(
      identity.code === 0 && identity.stdout.trim().length > 0,
      "cli_identity"
    );
    version = identity.stdout.trim();
    requireThat(
      version.length < 160 && !version.includes("\n"),
      "cli_version_format"
    );
    checks.push("selected executable");
    context.step = "env";
    const before = await inputSnapshot(fixture);
    const wrongKey = randomBytes(32).toString("base64url");
    fixture.forbidden.push(wrongKey);
    for (const key of [undefined, wrongKey]) {
      const denied = await command({
        fixture,
        hackBin,
        args: hostArgs(fixture, "denied.ts"),
        key,
      });
      requireThat(denied.code !== 0, "missing_wrong_key_refusal");
      requireThat(
        !(await Bun.file(join(fixture.project, "unexpected-launch")).exists()),
        "secret_free_launch_refusal"
      );
    }
    checks.push("missing and wrong keys refuse child launch");
    for (let round = 0; round < 2; round++) {
      const config = await command({
        fixture,
        hackBin,
        key: fixture.key,
        args: ["config", "get", "name", "--path", fixture.project],
      });
      requireThat(
        config.code === 0 && config.stdout.trim() === `portable-${fixture.run}`,
        "configuration_read"
      );
      const env = await command({
        fixture,
        hackBin,
        key: fixture.key,
        args: [
          "env",
          "explain",
          "BOOTSTRAP_TOKEN",
          "--path",
          fixture.project,
          "--env",
          "default",
          "--json",
        ],
      });
      requireThat(env.code === 0, "env_provenance_read");
      const value: unknown = JSON.parse(env.stdout);
      requireThat(
        isRecord(value) && value.available === true && value.secret === true,
        "env_provenance_semantics"
      );
    }
    requireThat(
      JSON.stringify(await inputSnapshot(fixture)) === JSON.stringify(before),
      "repeat_reads_preserve_inputs"
    );
    checks.push("repeat configuration/env reads preserve inputs");
    context.step = "http";
    const first = await startApplication({ fixture, hackBin });
    const initial = await health({ fixture, ready: first.ready });
    requireThat(initial.marker === null, "fresh_application_data");
    context.step = "dev-write";
    const dev = await command({
      fixture,
      hackBin,
      args: hostArgs(fixture, "dev.ts"),
      key: fixture.key,
    });
    requireThat(
      dev.code === 0 && dev.stdout === "development command passed\n",
      "development_command"
    );
    requireThat(
      (await health({ fixture, ready: first.ready })).marker === fixture.run,
      "application_reads_development_write"
    );
    context.step = "restart";
    await stopApplication({
      fixture,
      command: first.command,
      ready: first.ready,
    });
    const second = await startApplication({ fixture, hackBin });
    requireThat(
      second.ready.boot !== first.ready.boot,
      "new_application_process"
    );
    requireThat(
      (await health({ fixture, ready: second.ready })).marker === fixture.run,
      "restart_retains_application_data"
    );
    context.step = "cleanup";
    await stopApplication({
      fixture,
      command: second.command,
      ready: second.ready,
    });
    checks.push(
      "loopback readiness",
      "development command",
      "restart retains marker"
    );
    requireThat(
      JSON.stringify(await inputSnapshot(fixture)) === JSON.stringify(before),
      "workflow_preserves_inputs"
    );
    await assertNoSecretFiles(fixture);
    checks.push("no key/plaintext files or output");
    completed = true;
  } finally {
    await cleanup(fixture);
  }
  requireThat(completed, "workflow_completion");
  return { version, checks, cleanup: true };
}

/** Only closed labels may cross the runner's stderr boundary; never retain a raw cause. */
class BootstrapFailure extends Error {
  readonly reason: BootstrapReason;
  readonly step?: BootstrapStep;

  constructor(reason: BootstrapReason, step?: BootstrapStep) {
    super(
      `Portable bootstrap failed: step=${step ?? "setup"} reason=${reason}`
    );
    this.reason = reason;
    this.step = step;
  }
}

function failureReason(error: unknown): BootstrapReason {
  if (error instanceof BootstrapFailure) {
    return error.reason;
  }
  if (error instanceof SyntaxError) {
    return "invalid_json";
  }
  if (isRecord(error)) {
    switch (error.code) {
      case "ECONNREFUSED":
        return "connection_refused";
      case "ECONNRESET":
        return "connection_reset";
      case "ABORT_ERR":
      case "ETIMEDOUT":
        return "http_timeout";
      case "ENOENT":
      case "EACCES":
      case "EPERM":
      case "EIO":
      case "ENOSPC":
        return "io_error";
      default:
        break;
    }
  }
  return "unexpected_error";
}

function requireThat(
  condition: boolean,
  reason: BootstrapReason
): asserts condition {
  if (!condition) {
    throw new BootstrapFailure(reason);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Matches project-env-config.ts encryptProjectEnvValue/deriveProjectEnvKey:
 * v1:base64(iv):base64(tag):base64(ciphertext), AES-256-GCM, SHA-256(key text).
 * The synthetic key and plaintext never become fixture files or CLI arguments.
 */
export function encryptSynthetic(opts: {
  key: string;
  secret: string;
}): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    createHash("sha256").update(opts.key).digest(),
    iv
  );
  const encrypted = Buffer.concat([
    cipher.update(opts.secret, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

async function createFixture(): Promise<Fixture> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "hack-portable-bootstrap-"))
  );
  const project = join(root, "project");
  const home = join(root, "home");
  const hackHome = join(root, "hack-home");
  for (const directory of [
    join(project, ".hack"),
    home,
    hackHome,
    join(root, "tmp"),
    join(project, "data"),
  ]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  const key = randomBytes(32).toString("base64url");
  const secret = randomBytes(32).toString("hex");
  const run = randomBytes(8).toString("hex");
  const digest = createHash("sha256").update(secret).digest("hex");
  const fixture: Fixture = {
    root,
    project,
    key,
    secret,
    forbidden: [key, secret],
    run,
    commands: new Set(),
    env: {
      HOME: home,
      HACK_HOME: hackHome,
      TMPDIR: join(root, "tmp"),
      PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
      HACK_EXECUTION_MODE: "codex",
      HACK_NO_INTERACTIVE: "1",
      HACK_DAEMON_DISABLE_DOCKER_EVENTS: "1",
      NO_COLOR: "1",
      TERM: "dumb",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  };
  await Bun.write(
    join(hackHome, "hack.config.json"),
    JSON.stringify({ controlPlane: { daemon: { autoStart: false } } })
  );
  const files: Record<string, string> = {
    ".hack/hack.config.json": JSON.stringify({
      name: `portable-${run}`,
      dev_host: `portable-${run}.hack.local`,
      internal: { dns: false, tls: false },
    }),
    ".hack/docker-compose.yml": "services:\n  app:\n    image: alpine:3.20\n",
    ".hack/hack.env.default.yaml": `version: 1\nenvironment: default\nsecretsprovider: project_key\nvalues:\n  global:\n    BOOTSTRAP_TOKEN:\n      secure: ${encryptSynthetic({ key, secret })}\n`,
    "denied.ts": 'await Bun.write("unexpected-launch", "launched");\n',
    "app.ts": applicationSource({ run, digest }),
    "dev.ts": developmentSource({ run, digest }),
  };
  for (const [path, text] of Object.entries(files)) {
    await Bun.write(join(project, path), text);
  }
  return fixture;
}

function verifyTokenSource(digest: string): string {
  return `import { createHash } from "node:crypto";\nif (createHash("sha256").update(process.env.BOOTSTRAP_TOKEN ?? "").digest("hex") !== ${JSON.stringify(digest)}) process.exit(41);\n`;
}

function applicationSource(opts: { run: string; digest: string }): string {
  return `${verifyTokenSource(opts.digest)}
import { Database } from "bun:sqlite";
import { rename } from "node:fs/promises";
const db = new Database("data/state.sqlite", { create: true });
db.run("CREATE TABLE IF NOT EXISTS fixture (id INTEGER PRIMARY KEY, marker TEXT NOT NULL)");
const boot = crypto.randomUUID();
const run = ${JSON.stringify(opts.run)};
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  if (request.headers.get("x-fixture-run") !== run) return new Response("refused", { status: 403 });
  if (new URL(request.url).pathname === "/stop" && request.method === "POST") {
    setTimeout(() => { server.stop(true); db.close(); process.exit(0); }, 20);
    return new Response("stopping");
  }
  const row = db.query("SELECT marker FROM fixture WHERE id = 1").get();
  return Response.json({ run, boot, marker: row?.marker ?? null });
}});
// Publish only a complete readiness document: existence is the reader's commit signal.
await Bun.write("ready.json.pending", JSON.stringify({ port: server.port, run, boot }));
await rename("ready.json.pending", "ready.json");
setTimeout(() => { server.stop(true); db.close(); process.exit(42); }, 120000);
`;
}

function developmentSource(opts: { run: string; digest: string }): string {
  return `${verifyTokenSource(opts.digest)}
import { Database } from "bun:sqlite";
const db = new Database("data/state.sqlite");
db.run("INSERT OR REPLACE INTO fixture (id, marker) VALUES (1, ?)", [${JSON.stringify(opts.run)}]);
db.close();
process.stdout.write("development command passed\\n");
`;
}

function hostArgs(fixture: Fixture, script: string): string[] {
  return [
    "host",
    "exec",
    "--path",
    fixture.project,
    "--env",
    "default",
    "--timeout",
    "90",
    "--",
    process.execPath,
    script,
  ];
}

function spawn(opts: {
  fixture: Fixture;
  hackBin: string;
  args: string[];
  key?: string;
}): OwnedCommand {
  const child = Bun.spawn([opts.hackBin, ...opts.args], {
    cwd: opts.fixture.project,
    env: {
      ...opts.fixture.env,
      ...(opts.key === undefined ? {} : { HACK_ENV_SECRET_KEY: opts.key }),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const result = {
    child,
    stdout: capture(child.stdout),
    stderr: capture(child.stderr),
  };
  opts.fixture.commands.add(result);
  return result;
}

async function capture(stream: ReadableStream<Uint8Array>): Promise<Capture> {
  const reader = stream.getReader();
  let text = "";
  const decoder = new TextDecoder();
  for (;;) {
    const item = await reader.read();
    if (item.done) {
      return { text: text + decoder.decode(), overflow: false };
    }
    text += decoder.decode(item.value, { stream: true });
    if (text.length > OUTPUT_LIMIT) {
      await reader.cancel();
      return { text: text.slice(0, OUTPUT_LIMIT), overflow: true };
    }
  }
}

async function within<T>(
  promise: Promise<T>,
  milliseconds: number,
  reason: BootstrapReason
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new BootstrapFailure(reason)),
          milliseconds
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function collect(
  fixture: Fixture,
  owned: OwnedCommand
): Promise<{ code: number; stdout: string }> {
  const [code, stdout, stderr] = await within(
    Promise.all([owned.child.exited, owned.stdout, owned.stderr]),
    STOP_TIMEOUT_MS,
    "output_collection_deadline"
  );
  fixture.commands.delete(owned);
  requireThat(!(stdout.overflow || stderr.overflow), "bounded_command_output");
  for (const output of [stdout.text, stderr.text]) {
    requireThat(
      !fixture.forbidden.some((value) => output.includes(value)),
      "secret_free_command_output"
    );
  }
  return { code, stdout: stdout.text };
}

async function command(opts: {
  fixture: Fixture;
  hackBin: string;
  args: string[];
  key?: string;
}): Promise<{ code: number; stdout: string }> {
  const owned = spawn(opts);
  await within(owned.child.exited, COMMAND_TIMEOUT_MS, "command_deadline");
  return collect(opts.fixture, owned);
}

async function startApplication(opts: {
  fixture: Fixture;
  hackBin: string;
}): Promise<{ command: OwnedCommand; ready: Ready }> {
  await rm(join(opts.fixture.project, "ready.json"), { force: true });
  const owned = spawn({
    ...opts,
    args: hostArgs(opts.fixture, "app.ts"),
    key: opts.fixture.key,
  });
  const deadline = Date.now() + COMMAND_TIMEOUT_MS;
  while (Date.now() < deadline && owned.child.exitCode === null) {
    const file = Bun.file(join(opts.fixture.project, "ready.json"));
    if (await file.exists()) {
      const value: unknown = await file.json();
      if (
        isRecord(value) &&
        value.run === opts.fixture.run &&
        typeof value.port === "number" &&
        Number.isInteger(value.port) &&
        value.port > 0 &&
        value.port < 65_536 &&
        typeof value.boot === "string"
      ) {
        const ready = {
          port: value.port,
          run: opts.fixture.run,
          boot: value.boot,
        };
        await health({ fixture: opts.fixture, ready });
        return { command: owned, ready };
      }
    }
    await Bun.sleep(POLL_MS);
  }
  throw new BootstrapFailure("application_readiness");
}

/** Node's direct loopback transport does not consult inherited proxy settings. */
function loopback(opts: {
  fixture: Fixture;
  ready: Ready;
  stop?: boolean;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: opts.ready.port,
        path: opts.stop ? "/stop" : "/",
        method: opts.stop ? "POST" : "GET",
        headers: { "x-fixture-run": opts.fixture.run },
        signal: AbortSignal.timeout(2000),
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > OUTPUT_LIMIT) {
            req.destroy(new BootstrapFailure("bounded_http_response"));
          }
        });
        response.on("error", reject);
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body })
        );
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function health(opts: {
  fixture: Fixture;
  ready: Ready;
}): Promise<Record<string, unknown>> {
  const response = await loopback(opts);
  requireThat(response.status === 200, "loopback_http_response");
  const value: unknown = JSON.parse(response.body);
  requireThat(
    isRecord(value) &&
      value.run === opts.fixture.run &&
      value.boot === opts.ready.boot,
    "owned_application_response"
  );
  return value;
}

async function stopApplication(opts: {
  fixture: Fixture;
  command: OwnedCommand;
  ready: Ready;
}): Promise<void> {
  await health(opts);
  const response = await loopback({ ...opts, stop: true });
  requireThat(response.status === 200, "owned_application_stop");
  const result = await collect(opts.fixture, opts.command);
  requireThat(result.code === 0, "application_stop_status");
  try {
    await loopback(opts);
    requireThat(false, "application_listener_retired");
  } catch (error: unknown) {
    requireThat(
      isRecord(error) && error.code === "ECONNREFUSED",
      "application_listener_retired"
    );
  }
}

function inputSnapshot(fixture: Fixture): Promise<string[]> {
  return Promise.all(
    INPUTS.map(async (path) =>
      createHash("sha256")
        .update(await readFile(join(fixture.project, path)))
        .digest("hex")
    )
  );
}

async function assertNoSecretFiles(
  fixture: Fixture,
  directory = fixture.root
): Promise<void> {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    requireThat(
      !item.isSymbolicLink(),
      "fixture_contains_no_external_symlinks"
    );
    if (item.isDirectory()) {
      await assertNoSecretFiles(fixture, path);
    } else if (item.isFile()) {
      requireThat(
        item.name !== ".hack.secret.key" && item.name !== ".env",
        "no_materialized_env_key_files"
      );
      const bytes = await readFile(path);
      requireThat(
        !fixture.forbidden.some((value) => bytes.includes(Buffer.from(value))),
        "secret_free_fixture_files"
      );
    }
  }
}

async function cleanup(fixture: Fixture): Promise<void> {
  try {
    await cleanupFixture(fixture);
  } catch (error: unknown) {
    throw new BootstrapFailure(failureReason(error), "cleanup");
  }
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  let clean = true;
  for (const owned of fixture.commands) {
    try {
      if (owned.child.exitCode === null) {
        owned.child.kill("SIGTERM");
      }
      await within(
        owned.child.exited,
        STOP_TIMEOUT_MS,
        "owned_process_cleanup_deadline"
      );
      await collect(fixture, owned);
    } catch {
      clean = false;
      if (owned.child.exitCode === null) {
        owned.child.kill("SIGKILL");
      }
      await within(
        owned.child.exited,
        STOP_TIMEOUT_MS,
        "forced_owned_process_cleanup_deadline"
      );
    }
  }
  requireThat(clean, "owned_cleanup_failed");
  await rm(fixture.root, { recursive: true });
  requireThat(
    !(await Bun.file(join(fixture.project, INPUTS[0])).exists()),
    "fixture_cleanup"
  );
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--hack-bin" || !args[1]) {
    process.stderr.write(
      "Usage: bun portable-bootstrap-smoke.ts --hack-bin /absolute/installed/hack\n"
    );
    process.exitCode = 2;
  } else {
    try {
      const result = await runPortableBootstrap({ hackBin: args[1] });
      process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
    } catch (error: unknown) {
      const message =
        error instanceof BootstrapFailure
          ? error.message
          : "Portable bootstrap failed: step=setup reason=unexpected_error";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    }
  }
}
