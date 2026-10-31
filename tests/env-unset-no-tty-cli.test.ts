import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * HACK-1385: `hack env unset KEY` with a piped (non-TTY) stdin and without
 * `HACK_NO_INTERACTIVE` used to enter the clack confirm prompt, which cannot
 * settle on a non-TTY stdin and spins at full CPU forever.
 *
 * Each case runs the real CLI in a fresh subprocess with piped stdin, no
 * `HACK_NO_INTERACTIVE`, and a hard 5 s kill. The run must settle through
 * the documented non-interactive policy: `env unset` applies its default
 * (the key is removed), and a `fail`-policy prompt refuses with
 * `E_INTERACTIVE_REQUIRED`. Wall time and CPU time are both bounded, so a
 * regressed prompt path fails by timeout rather than hanging the suite.
 *
 * Isolation: private HOME/HACK_HOME/DOCKER_CONFIG, a temp project with its env
 * layer file written first, the project-key YAML store, and the keychain
 * fallback disabled. No keychain, Docker socket, or launchd is reached.
 */

const REPO_ROOT = resolve(import.meta.dir, "..");
const ENTRYPOINT = resolve(REPO_ROOT, "index.ts");
/** Hard bound for the whole subprocess; the old prompt loop never exits. */
const KILL_AFTER_MS = 5000;
/** Bun startup plus the command measured ~0.3 s CPU; the spin burns ~1 s/s. */
const MAX_CPU_MS = 3000;
/** Never printed by the command: proves the value stays out of both streams. */
const VALUE_CANARY = "unset-canary-value-7f3a9c";

type RunResult = {
  readonly exitCode: number;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly wallMs: number;
  readonly cpuMs: number | null;
};

let root: string | null = null;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-env-unset-no-tty-"));
  await mkdir(join(root, "home"), { recursive: true });
});

afterEach(async () => {
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

/**
 * Spawns the CLI with a piped stdin that carries one newline and then closes,
 * the shape an agent harness or `echo | hack ...` produces. The environment
 * deliberately omits `HACK_NO_INTERACTIVE` and `--no-interactive`.
 */
async function runHackPipedStdin(input: {
  readonly args: readonly string[];
  readonly cwd: string;
}): Promise<RunResult> {
  const home = join(requireRoot(), "home");
  const started = performance.now();
  const proc = Bun.spawn([process.execPath, ENTRYPOINT, ...input.args], {
    cwd: input.cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      TMPDIR: home,
      HACK_HOME: join(home, ".hack"),
      DOCKER_CONFIG: join(home, "docker"),
      HACK_GLOBAL_CONFIG_PATH: join(home, "hack-config.json"),
      HACK_LOGGER: "console",
      HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK: "1",
      HACK_SECRETS_FILE_KEY: "env-unset-no-tty-test-key",
      NO_COLOR: "1",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    timeout: KILL_AFTER_MS,
    killSignal: "SIGKILL",
  });
  proc.stdin.write("\n");
  await proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const wallMs = performance.now() - started;
  const usage = proc.resourceUsage();
  const cpuMs = usage
    ? Number(usage.cpuTime.user + usage.cpuTime.system) / 1000
    : null;
  return {
    exitCode,
    signal: proc.signalCode,
    stdout,
    stderr,
    wallMs,
    cpuMs,
  };
}

function expectSettledWithinBounds(result: RunResult): void {
  // A regressed prompt path is killed by the spawn timeout: non-zero exit via
  // SIGKILL, wall time at the bound, and CPU time close to wall time.
  expect(result.signal).toBeNull();
  expect(result.wallMs).toBeLessThan(KILL_AFTER_MS);
  if (result.cpuMs !== null) {
    expect(result.cpuMs).toBeLessThan(MAX_CPU_MS);
  }
  // The clack confirm never rendered its "● Yes / ○ No" toggle.
  expect(result.stdout).not.toContain("Yes / ");
}

async function createModernProject(): Promise<{
  readonly projectRoot: string;
  readonly layerFile: string;
}> {
  const projectRoot = join(requireRoot(), "modern");
  const projectDir = join(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, "docker-compose.yml"),
    "services:\n  api:\n    image: alpine:3.20\n"
  );
  await writeFile(
    join(projectDir, "hack.config.json"),
    `${JSON.stringify({ name: "unset-no-tty-modern", dev_host: "unset-no-tty-modern.hack" }, null, 2)}\n`
  );
  // The env layer file is written before any command runs.
  const layerFile = join(projectDir, "hack.env.default.yaml");
  await writeFile(
    layerFile,
    `version: 1\nenvironment: default\nsecretsprovider: project_key\nvalues:\n  global:\n    KEEP_FLAG: "1"\n    DOOMED_KEY: "${VALUE_CANARY}"\n`
  );
  return { projectRoot, layerFile };
}

test(
  "env unset with piped stdin applies the documented default and exits promptly",
  async () => {
    const { projectRoot, layerFile } = await createModernProject();
    const result = await runHackPipedStdin({
      args: ["env", "unset", "DOOMED_KEY", "--path", projectRoot],
      cwd: projectRoot,
    });

    expectSettledWithinBounds(result);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(`Updated ${layerFile}`);

    const after = await readFile(layerFile, "utf8");
    expect(after).not.toContain("DOOMED_KEY");
    expect(after).toContain("KEEP_FLAG");
    for (const stream of [result.stdout, result.stderr]) {
      expect(stream).not.toContain(VALUE_CANARY);
      expect(stream).not.toContain("E_INTERACTIVE_REQUIRED");
    }
  },
  { timeout: 30_000 }
);

test(
  "a fail-policy confirmation with piped stdin refuses closed instead of prompting",
  async () => {
    // `hack secrets delete` confirms with the `fail` policy; the refusal must
    // land before the keychain is touched and must name the way out.
    const result = await runHackPipedStdin({
      args: ["secrets", "delete", "unset-no-tty-never-stored"],
      cwd: requireRoot(),
    });

    expectSettledWithinBounds(result);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("E_INTERACTIVE_REQUIRED");
    expect(result.stderr).toContain("no TTY");
    expect(result.stderr).toContain("in a terminal");
    expect(result.stdout).toBe("");
  },
  { timeout: 30_000 }
);
