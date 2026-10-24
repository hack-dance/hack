import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
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
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * HACK-1410: one bounded non-TTY regression test per `canPrompt()` guard in
 * front of a clack prompt (HACK-1385). A clack prompt opens a terminal
 * readline over stdin; on a piped stdin it never settles and spins at full
 * CPU. Each case runs a real child process with a piped stdin that carries
 * nothing and closes, no `HACK_NO_INTERACTIVE`, and a SIGKILL after
 * {@link KILL_AFTER_MS}. A guard that is removed or made a no-op therefore
 * fails by the kill (signal set, wall time at the bound) or by the wrong exit
 * and output, never by hanging the suite.
 *
 * Isolation: every child gets `privateCliEnv` (private HOME and Docker client
 * config) plus a private HACK_HOME, `HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK=1`
 * and `HACK_SESSIONS_MUX=none` (no tmux or zellij is run). `secrets` children
 * preload a `Bun.secrets` stub, so no case reaches the OS keychain even when a
 * guard is mutated away. `update` children preload a fetch stub, so nothing
 * reaches the network. The `ssh --tailscale` child finds a logging
 * `tailscale` stand-in first on PATH, never the real CLI. No Docker socket,
 * launchd or keychain is touched.
 */

const REPO_ROOT = resolve(import.meta.dir, "..");
const ENTRYPOINT = resolve(REPO_ROOT, "index.ts");
const FIXTURES = resolve(import.meta.dir, "fixtures");
const STDOUT_TTY_PRELOAD = join(FIXTURES, "stdout-tty-preload.ts");
const SECRETS_STUB_PRELOAD = join(FIXTURES, "secrets-store-stub-preload.ts");
const RELEASE_STUB_PRELOAD = join(FIXTURES, "release-fetch-stub-preload.ts");
const ATTACHED_PROMPT_WORKER = join(
  FIXTURES,
  "session-attached-prompt-worker.ts"
);
/**
 * Hard bound for one child. A settled run takes well under a second once the
 * shared Bun cache is warm; the regressed prompt loop never exits.
 */
const KILL_AFTER_MS = 10_000;
/** Overall bound for each test. */
const TEST_TIMEOUT_MS = 30_000;
/**
 * Bound for the one warm-up child in `beforeAll`. Each file run starts with a
 * fresh private HOME, so Bun's runtime transpiler cache (kept under HOME) is
 * cold, and a cold start of the CLI took 6.3 s on a loaded host (HACK-1426).
 * The warm-up pays that cost once, outside every case's {@link KILL_AFTER_MS}.
 */
const WARM_UP_KILL_AFTER_MS = 90_000;
/** `beforeAll` bound: the warm-up child plus margin. */
const WARM_UP_HOOK_TIMEOUT_MS = WARM_UP_KILL_AFTER_MS + 10_000;
/** Clack's active-prompt marker: no case may render a live prompt. */
const ACTIVE_PROMPT_MARKER = "◆";

type RunResult = {
  readonly exitCode: number;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly wallMs: number;
};

let fileRoot: string | null = null;
let caseRoot: string | null = null;

beforeAll(
  async () => {
    // One HOME per file keeps Bun's transpiler cache warm across cases.
    fileRoot = await mkdtemp(join(tmpdir(), "hack-no-tty-prompt-sites-"));
    await warmTranspilerCache(fileRoot);
  },
  { timeout: WARM_UP_HOOK_TIMEOUT_MS }
);

/**
 * Loads the CLI's module graph once under the file's private HOME, so no case
 * pays the cold transpile inside its {@link KILL_AFTER_MS} bound. `--help`
 * needs no project, prompt, network or keychain. Only a kill fails the file:
 * the cases themselves pin every exit code and message.
 */
async function warmTranspilerCache(root: string): Promise<void> {
  const proc = Bun.spawn([process.execPath, ENTRYPOINT, "--help"], {
    cwd: root,
    env: privateCliEnv({
      root,
      env: {
        HACK_HOME: join(root, "warm-up-hack-home"),
        HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK: "1",
        HACK_SESSIONS_MUX: "none",
        HACK_NO_INTERACTIVE: "1",
        NO_COLOR: "1",
      },
    }),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    timeout: WARM_UP_KILL_AFTER_MS,
    killSignal: "SIGKILL",
  });
  await proc.exited;
  if (proc.signalCode !== null) {
    throw new Error(
      `CLI warm-up was killed (${proc.signalCode}) after ${WARM_UP_KILL_AFTER_MS} ms`
    );
  }
}

afterAll(async () => {
  if (fileRoot) {
    await rm(fileRoot, { recursive: true, force: true });
    fileRoot = null;
  }
});

beforeEach(async () => {
  caseRoot = await mkdtemp(join(requireFileRoot(), "case-"));
});

afterEach(() => {
  caseRoot = null;
});

function requireFileRoot(): string {
  if (!fileRoot) {
    throw new Error("Missing file root");
  }
  return fileRoot;
}

function requireCaseRoot(): string {
  if (!caseRoot) {
    throw new Error("Missing case root");
  }
  return caseRoot;
}

/**
 * Spawns `bun [--preload ...] <script> ...args` with a piped stdin that is
 * closed at once and piped stdout/stderr, so neither stream is a TTY (unless
 * the stdout-TTY preload says otherwise).
 */
async function runPiped(input: {
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly script?: string;
  readonly preloads?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}): Promise<RunResult> {
  const root = requireFileRoot();
  const preloadArgs = (input.preloads ?? []).flatMap((path) => [
    "--preload",
    path,
  ]);
  const started = performance.now();
  const proc = Bun.spawn(
    [
      process.execPath,
      ...preloadArgs,
      input.script ?? ENTRYPOINT,
      ...input.args,
    ],
    {
      cwd: input.cwd ?? requireCaseRoot(),
      env: privateCliEnv({
        root,
        env: {
          HACK_HOME: join(requireCaseRoot(), "hack-home"),
          HACK_LOGGER: "console",
          HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK: "1",
          HACK_SESSIONS_MUX: "none",
          HACK_EXPERIMENTAL_ACK: "1",
          NO_COLOR: "1",
          ...input.env,
        },
      }),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      timeout: KILL_AFTER_MS,
      killSignal: "SIGKILL",
    }
  );
  await proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    exitCode,
    signal: proc.signalCode,
    stdout,
    stderr,
    wallMs: performance.now() - started,
  };
}

function expectSettled(result: RunResult): void {
  // A regressed guard is SIGKILLed at the bound with a prompt rendered.
  expect(result.signal).toBeNull();
  expect(result.wallMs).toBeLessThan(KILL_AFTER_MS);
  expect(result.stdout).not.toContain(ACTIVE_PROMPT_MARKER);
  expect(result.stderr).not.toContain(ACTIVE_PROMPT_MARKER);
}

function expectInteractiveRequired(
  result: RunResult,
  wayOut: readonly string[]
): void {
  expectSettled(result);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("E_INTERACTIVE_REQUIRED");
  expect(result.stderr).toContain("no TTY");
  for (const text of wayOut) {
    expect(result.stderr).toContain(text);
  }
}

async function secretsLog(): Promise<string> {
  const path = join(requireCaseRoot(), "secrets.log");
  return await readFile(path, "utf8").catch(() => "");
}

function secretsEnv(): Record<string, string> {
  return { HACK_TEST_SECRETS_LOG: join(requireCaseRoot(), "secrets.log") };
}

test(
  "mcp target selection refuses without a TTY and names the target flags",
  async () => {
    const result = await runPiped({ args: ["mcp", "print"] });
    expectInteractiveRequired(result, ["--all", "--cursor", "--claude"]);
    expect(result.stdout).toBe("");
  },
  { timeout: TEST_TIMEOUT_MS }
);

test(
  "session picker refuses without a TTY and names session list/attach",
  async () => {
    // One registered project, so the picker has an option to offer.
    const repoRoot = join(requireCaseRoot(), "picker-demo");
    await mkdir(join(repoRoot, ".hack"), { recursive: true });
    const hackHome = join(requireCaseRoot(), "hack-home");
    await mkdir(hackHome, { recursive: true });
    await writeFile(
      join(hackHome, "projects.json"),
      `${JSON.stringify({
        version: 1,
        projects: [
          {
            id: "no-tty-picker-demo",
            name: "picker-demo",
            repoRoot,
            projectDirName: ".hack",
            projectDir: join(repoRoot, ".hack"),
            createdAt: "2026-10-23T00:00:00.000Z",
          },
        ],
      })}\n`
    );
    const result = await runPiped({ args: ["session"] });
    expectInteractiveRequired(result, [
      "hack session list",
      "hack session attach <name>",
    ]);
    expect(result.stdout).not.toContain("No workspaces or projects found");
  },
  { timeout: TEST_TIMEOUT_MS }
);

test(
  "attached-workspace choice refuses without a TTY and names --new",
  async () => {
    const result = await runPiped({
      script: ATTACHED_PROMPT_WORKER,
      args: [],
    });
    expectInteractiveRequired(result, ["attached elsewhere", "--new"]);
    expect(result.stdout).toBe("");
  },
  { timeout: TEST_TIMEOUT_MS }
);

test(
  "update install confirmation refuses on a piped stdin even with a TTY stdout",
  async () => {
    // A writable standalone binary named `hack` on PATH is what self-update
    // would replace; it is never touched because the run stops at the
    // confirmation.
    const bin = join(requireCaseRoot(), "bin");
    await mkdir(bin, { recursive: true });
    const binary = join(bin, "hack");
    await writeFile(binary, "standalone hack stand-in\n");
    await chmod(binary, 0o755);
    const result = await runPiped({
      args: ["update", "--json"],
      preloads: [STDOUT_TTY_PRELOAD, RELEASE_STUB_PRELOAD],
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HACK_ASSETS_DIR: join(requireCaseRoot(), "assets"),
      },
    });
    expectSettled(result);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: "Non-interactive shell; re-run with --yes to apply the update.",
    });
    expect(await readFile(binary, "utf8")).toBe("standalone hack stand-in\n");
  },
  { timeout: TEST_TIMEOUT_MS }
);

test(
  "secrets name prompt refuses without a TTY before the keychain",
  async () => {
    const result = await runPiped({
      args: ["secrets", "get"],
      preloads: [SECRETS_STUB_PRELOAD],
      env: secretsEnv(),
    });
    expectInteractiveRequired(result, ["Pass the name as an argument"]);
    expect(result.stdout).toBe("");
    expect(await secretsLog()).toBe("");
  },
  { timeout: TEST_TIMEOUT_MS }
);

test(
  "secrets value prompt refuses without a TTY before the keychain",
  async () => {
    const result = await runPiped({
      args: ["secrets", "set", "no-tty-value"],
      preloads: [SECRETS_STUB_PRELOAD],
      env: secretsEnv(),
    });
    expectInteractiveRequired(result, ["never from an argument"]);
    expect(await secretsLog()).toBe("");
  },
  { timeout: TEST_TIMEOUT_MS }
);

test(
  "secrets delete without --yes refuses closed without a TTY and names --yes",
  async () => {
    const result = await runPiped({
      args: ["secrets", "delete", "no-tty-doomed"],
      preloads: [SECRETS_STUB_PRELOAD],
      env: secretsEnv(),
    });
    expectInteractiveRequired(result, ["--yes"]);
    expect(result.stdout).toBe("");
    expect(await secretsLog()).toBe("");
  },
  { timeout: TEST_TIMEOUT_MS }
);

test(
  "secrets delete --yes deletes without a TTY or a prompt",
  async () => {
    const result = await runPiped({
      args: ["secrets", "delete", "no-tty-doomed", "--yes"],
      preloads: [SECRETS_STUB_PRELOAD],
      env: { ...secretsEnv(), HACK_NO_INTERACTIVE: "1" },
    });
    expectSettled(result);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("E_INTERACTIVE_REQUIRED");
    expect(`${result.stdout}${result.stderr}`).toContain(
      'Deleted secret "no-tty-doomed" (hack-cli)'
    );
    expect(await secretsLog()).toBe("delete hack-cli no-tty-doomed\n");
  },
  { timeout: TEST_TIMEOUT_MS }
);

test(
  "agent init prints the prompt instead of opening the client picker",
  async () => {
    // A package.json bounds the repo inventory to the fixture.
    const repo = join(requireCaseRoot(), "repo");
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, "package.json"), '{"name":"no-tty-agent"}\n');
    const result = await runPiped({
      args: ["agent", "init", "--path", repo],
    });
    expectSettled(result);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hack agent patterns");
    expect(result.stdout).not.toContain("Open hack init prompt in");
  },
  { timeout: TEST_TIMEOUT_MS }
);

test(
  "ssh connection-method choice refuses without a TTY",
  async () => {
    const result = await runPiped({ args: ["ssh"] });
    expectInteractiveRequired(result, ["--tailscale", "--direct", "--host"]);
  },
  { timeout: TEST_TIMEOUT_MS }
);

test(
  "ssh --tailscale does not offer to turn on a stopped Tailscale without a TTY",
  async () => {
    // A `tailscale` stand-in on PATH reports a stopped backend and logs each
    // call, so the test sees whether `tailscale up` would have run.
    const bin = join(requireCaseRoot(), "bin");
    await mkdir(bin, { recursive: true });
    const callLog = join(requireCaseRoot(), "tailscale.log");
    const stub = join(bin, "tailscale");
    await writeFile(
      stub,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$*" >> '${callLog}'`,
        'if [ "$1" = status ]; then',
        `  printf '%s\\n' '{"BackendState":"Stopped"}'`,
        "fi",
        "exit 0",
        "",
      ].join("\n")
    );
    await chmod(stub, 0o755);
    const result = await runPiped({
      args: ["ssh", "--tailscale"],
      env: { PATH: `${bin}:/usr/bin:/bin` },
    });
    expectSettled(result);
    expect(result.exitCode).toBe(1);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain("Tailscale is stopped");
    expect(output).toContain("Run `tailscale up`, then re-run `hack ssh`.");
    expect(output).not.toContain("Turn on Tailscale?");
    const calls = (await readFile(callLog, "utf8")).split("\n");
    expect(calls).toContain("status --json");
    expect(calls).not.toContain("up");
  },
  { timeout: TEST_TIMEOUT_MS }
);

test(
  "ssh --direct host prompt refuses without a TTY and names --host",
  async () => {
    const result = await runPiped({ args: ["ssh", "--direct"] });
    expectInteractiveRequired(result, ["--host"]);
  },
  { timeout: TEST_TIMEOUT_MS }
);

test(
  "ssh --host answers the follow-up choice with Done without a TTY",
  async () => {
    const result = await runPiped({
      args: ["ssh", "--host", "no-tty.example.test"],
    });
    expectSettled(result);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no-tty.example.test");
    expect(result.stdout).toContain("Copy the SSH command above");
    expect(result.stdout).not.toContain("What would you like to do?");
  },
  { timeout: TEST_TIMEOUT_MS }
);

test(
  "node pair walkthrough does not prompt on a piped stdin with a TTY stdout",
  async () => {
    const result = await runPiped({
      args: ["node", "pair", "walkthrough"],
      preloads: [STDOUT_TTY_PRELOAD],
    });
    expectSettled(result);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Missing --source <user@host>");
  },
  { timeout: TEST_TIMEOUT_MS }
);

test(
  "node pair walkthrough leaves the session pending instead of confirming without a TTY",
  async () => {
    // The endpoint preflight only needs a 200 from /v1/node/status.
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) =>
        new URL(request.url).pathname === "/v1/node/status"
          ? Response.json({ ok: true })
          : new Response("not found", { status: 404 }),
    });
    try {
      const result = await runPiped({
        args: [
          "node",
          "pair",
          "walkthrough",
          "--source",
          "no-tty@node.example.test",
          "--endpoint",
          `http://127.0.0.1:${server.port}`,
        ],
      });
      expectSettled(result);
      expect(result.exitCode).toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain(
        "Session left pending"
      );
    } finally {
      await server.stop(true);
    }
  },
  { timeout: TEST_TIMEOUT_MS }
);
