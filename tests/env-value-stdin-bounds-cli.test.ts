import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * HACK-1354: `hack env set KEY --secret --value-stdin` must never wait without
 * a bound. Each stdin shape runs in a fresh CLI subprocess with a short overall
 * kill timeout, under `HACK_NO_INTERACTIVE=1`.
 *
 * Isolation mirrors the reported fixture: a minimal environment (no inherited
 * variables), a private HOME and HACK_HOME, a stub `docker` first on PATH, and
 * DOCKER_HOST pointing at a socket that does not exist. The D-Bus session bus
 * points at a socket this test owns, so no real keychain, 1Password, or secret
 * store is reached. Secret values are assembled at runtime.
 */

const REPO_ROOT = resolve(import.meta.dir, "..");
const ENTRYPOINT = resolve(REPO_ROOT, "index.ts");
/** Short deadlines so a regression fails fast instead of hanging CI. */
const STDIN_DEADLINE_MS = 1500;
const KEYCHAIN_DEADLINE_MS = 1500;
/** Hard kill for each CLI subprocess; well above the deadlines plus startup. */
const RUN_KILL_MS = 20_000;
/** A bounded refusal must arrive well before the kill timeout. */
const BOUNDED_EXIT_MS = 12_000;

type RunResult = {
  readonly exitCode: number;
  readonly signalCode: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly elapsedMs: number;
};

/** How the child's stdin is wired. */
type StdinShape =
  | { readonly kind: "piped"; readonly data: string }
  | { readonly kind: "closed" }
  | { readonly kind: "dev-null" }
  /** Pipe stays open for the child's whole life; `data` may be empty. */
  | { readonly kind: "held-open"; readonly data: string };

let root: string | null = null;
let busServer: { stop: () => void } | null = null;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-value-stdin-bounds-"));
  await mkdir(join(root, "home"), { recursive: true });
  await mkdir(join(root, "hack-home"), { recursive: true });
  await mkdir(join(root, "bin"), { recursive: true });
  const docker = join(root, "bin", "docker");
  await writeFile(docker, "#!/bin/sh\nexit 1\n");
  await chmod(docker, 0o755);
});

afterEach(async () => {
  busServer?.stop();
  busServer = null;
  if (root) {
    await rm(root, { recursive: true, force: true });
    root = null;
  }
});

function requireRoot(): string {
  if (!root) {
    throw new Error("Missing temp root");
  }
  return root;
}

function newSecret(): string {
  return ["bounds", crypto.randomUUID(), crypto.randomUUID()].join("-");
}

/** Session bus that accepts connections and never answers. */
function startSilentSessionBus(): string {
  const path = join(requireRoot(), "silent-bus.sock");
  const listener = Bun.listen({
    unix: path,
    socket: { data() {}, open() {} },
  });
  busServer = { stop: () => listener.stop(true) };
  return path;
}

function isolatedEnv(
  extra: Record<string, string> = {}
): Record<string, string> {
  const base = requireRoot();
  return {
    PATH: `${join(base, "bin")}:/usr/bin:/bin`,
    HOME: join(base, "home"),
    TMPDIR: join(base, "home"),
    HACK_HOME: join(base, "hack-home"),
    HACK_GLOBAL_CONFIG_PATH: join(base, "home", "hack-config.json"),
    HACK_NO_INTERACTIVE: "1",
    HACK_LOGGER: "console",
    DOCKER_HOST: `unix://${join(base, "missing-docker.sock")}`,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(base, "missing-bus.sock")}`,
    HACK_ENV_VALUE_STDIN_TIMEOUT_MS: String(STDIN_DEADLINE_MS),
    HACK_KEYCHAIN_TIMEOUT_MS: String(KEYCHAIN_DEADLINE_MS),
    ...extra,
  };
}

async function runHack(input: {
  readonly args: readonly string[];
  readonly stdin: StdinShape;
  readonly cwd: string;
  readonly env?: Record<string, string>;
}): Promise<RunResult> {
  const hackArgv = [process.execPath, ENTRYPOINT, ...input.args];
  // A closed fd 0 needs the shell: Bun.spawn always provides one.
  const argv =
    input.stdin.kind === "closed"
      ? ["/bin/sh", "-c", 'exec "$@" <&-', "sh", ...hackArgv]
      : hackArgv;
  const started = performance.now();
  const proc = Bun.spawn(argv, {
    cwd: input.cwd,
    env: isolatedEnv(input.env),
    stdin:
      input.stdin.kind === "piped" || input.stdin.kind === "held-open"
        ? "pipe"
        : input.stdin.kind === "dev-null"
          ? Bun.file("/dev/null")
          : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: RUN_KILL_MS,
    killSignal: "SIGKILL",
  });
  const sink = typeof proc.stdin === "object" ? proc.stdin : null;
  if (input.stdin.kind === "piped" && sink) {
    sink.write(input.stdin.data);
    await sink.end();
  } else if (
    input.stdin.kind === "held-open" &&
    sink &&
    input.stdin.data.length > 0
  ) {
    sink.write(input.stdin.data);
    await sink.flush();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const elapsedMs = performance.now() - started;
  if (input.stdin.kind === "held-open" && sink) {
    await Promise.resolve(sink.end()).catch(() => undefined);
  }
  return {
    exitCode,
    signalCode: proc.signalCode ?? null,
    stdout,
    stderr,
    elapsedMs,
  };
}

function expectBoundedExit(result: RunResult): void {
  // A SIGKILL from the hard timeout means the CLI hung.
  expect(result.signalCode).toBeNull();
  expect(result.elapsedMs).toBeLessThan(BOUNDED_EXIT_MS);
}

function expectValueFree(result: RunResult, secret: string): void {
  for (const fragment of [secret, secret.slice(-12)]) {
    expect(result.stdout).not.toContain(fragment);
    expect(result.stderr).not.toContain(fragment);
  }
}

/** Modern project: `env set --secret` stores through the project key. */
async function createModernProject(): Promise<string> {
  const projectRoot = join(requireRoot(), "modern");
  const projectDir = join(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, "docker-compose.yml"),
    "services:\n  api:\n    image: alpine:3.20\n"
  );
  await writeFile(
    join(projectDir, "hack.config.json"),
    `${JSON.stringify({ name: "value-stdin-bounds", dev_host: "value-stdin-bounds.hack" }, null, 2)}\n`
  );
  await writeFile(
    join(projectDir, "hack.env.default.yaml"),
    "version: 1\nenvironment: default\nsecretsprovider: project_key\nvalues: {}\n"
  );
  return projectRoot;
}

/** Project with no env contract: `env set --secret` uses the OS keychain. */
async function createKeychainProject(): Promise<string> {
  const projectRoot = join(requireRoot(), "keychain");
  const projectDir = join(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, "docker-compose.yml"),
    "services:\n  api:\n    image: alpine:3.20\n"
  );
  await writeFile(
    join(projectDir, "hack.config.json"),
    `${JSON.stringify({ name: "value-stdin-keychain" }, null, 2)}\n`
  );
  return projectRoot;
}

async function readProjectFiles(projectRoot: string): Promise<string> {
  const files = ["hack.env.default.yaml", "hack.env.local.yaml", ".env"];
  const contents = await Promise.all(
    files.map((file) =>
      readFile(join(projectRoot, ".hack", file), "utf8").catch(() => "")
    )
  );
  return contents.join("\n");
}

const SET_ARGS = ["env", "set", "API_TOKEN", "--secret", "--value-stdin"];

test(
  "a piped and closed value is stored without hanging or echoing it",
  async () => {
    const projectRoot = await createModernProject();
    const secret = newSecret();
    const result = await runHack({
      args: SET_ARGS,
      stdin: { kind: "piped", data: `${secret}\n` },
      cwd: projectRoot,
    });
    expectBoundedExit(result);
    expect(result.exitCode).toBe(0);
    expectValueFree(result, secret);
    expect(await readProjectFiles(projectRoot)).not.toContain(secret);
  },
  { timeout: 30_000 }
);

test(
  "a closed stdin is refused as empty without hanging",
  async () => {
    const projectRoot = await createModernProject();
    const result = await runHack({
      args: SET_ARGS,
      stdin: { kind: "closed" },
      cwd: projectRoot,
    });
    expectBoundedExit(result);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Nothing was stored.");
  },
  { timeout: 30_000 }
);

test(
  "an empty stdin at end of input is refused without hanging",
  async () => {
    const projectRoot = await createModernProject();
    const result = await runHack({
      args: SET_ARGS,
      stdin: { kind: "dev-null" },
      cwd: projectRoot,
    });
    expectBoundedExit(result);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--value-stdin received an empty value");
  },
  { timeout: 30_000 }
);

test(
  "an open stdin pipe with no input fails at the read deadline",
  async () => {
    const projectRoot = await createModernProject();
    const result = await runHack({
      args: SET_ARGS,
      stdin: { kind: "held-open", data: "" },
      cwd: projectRoot,
    });
    expectBoundedExit(result);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("did not reach end of input");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(STDIN_DEADLINE_MS);
  },
  { timeout: 30_000 }
);

test(
  "a value whose pipe is never closed fails at the deadline and stores nothing",
  async () => {
    const projectRoot = await createModernProject();
    const before = await readProjectFiles(projectRoot);
    const secret = newSecret();
    const result = await runHack({
      args: SET_ARGS,
      stdin: { kind: "held-open", data: `${secret}\n` },
      cwd: projectRoot,
    });
    expectBoundedExit(result);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("did not reach end of input");
    expectValueFree(result, secret);
    expect(await readProjectFiles(projectRoot)).toBe(before);
  },
  { timeout: 30_000 }
);

/** Run the CLI under a pseudo-terminal with `script(1)`, where available. */
function scriptArgv(command: readonly string[]): string[] | null {
  const quoted = command.map((part) => `'${part.replaceAll("'", "'\\''")}'`);
  if (process.platform === "linux" && Bun.which("script")) {
    return ["script", "-qec", quoted.join(" "), "/dev/null"];
  }
  if (process.platform === "darwin" && Bun.which("script")) {
    return ["script", "-q", "/dev/null", ...command];
  }
  return null;
}

test(
  "a TTY stdin is refused before any read",
  async () => {
    const argv = scriptArgv([process.execPath, ENTRYPOINT, ...SET_ARGS]);
    if (!argv) {
      return;
    }
    const projectRoot = await createModernProject();
    const started = performance.now();
    const proc = Bun.spawn(argv, {
      cwd: projectRoot,
      env: isolatedEnv(),
      stdin: Bun.file("/dev/null"),
      stdout: "pipe",
      stderr: "pipe",
      timeout: RUN_KILL_MS,
      killSignal: "SIGKILL",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expectBoundedExit({
      exitCode,
      signalCode: proc.signalCode ?? null,
      stdout,
      stderr,
      elapsedMs: performance.now() - started,
    });
    expect(exitCode).toBe(1);
    expect(`${stdout}${stderr}`).toContain("stdin is an interactive terminal");
  },
  { timeout: 30_000 }
);

// The keychain path is exercised only on Linux, where the session bus can be
// replaced with a silent socket. On macOS it would reach the real keychain.
test.skipIf(process.platform !== "linux")(
  "an unresponsive keychain fails at its deadline instead of hanging",
  async () => {
    const projectRoot = await createKeychainProject();
    const bus = startSilentSessionBus();
    const secret = newSecret();
    const result = await runHack({
      args: SET_ARGS,
      stdin: { kind: "piped", data: `${secret}\n` },
      cwd: projectRoot,
      env: { DBUS_SESSION_BUS_ADDRESS: `unix:path=${bus}` },
    });
    expectBoundedExit(result);
    expect(result.exitCode).toBe(1);
    expectValueFree(result, secret);
    // Hosts without libsecret fail fast before reaching the bus; with it, the
    // call blocks on the silent bus and must end in the closed refusal.
    if (result.elapsedMs >= KEYCHAIN_DEADLINE_MS) {
      expect(result.stderr).toContain("The OS keychain did not answer");
    }
  },
  { timeout: 30_000 }
);
