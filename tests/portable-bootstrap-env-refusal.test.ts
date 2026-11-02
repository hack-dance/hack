import { afterEach, describe, expect, test } from "bun:test";
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
import { encryptSynthetic } from "../scripts/portable-bootstrap-smoke.ts";
import {
  PORTABLE_BOOTSTRAP_INSTALL_SCRIPT,
  PORTABLE_BOOTSTRAP_VERIFY_SCRIPT,
  renderBootstrapCompose,
  renderBootstrapEnvFile,
  renderBootstrapLock,
  sha256Hex,
} from "./e2e/portable-bootstrap-controls.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

const cli = resolve(import.meta.dir, "../index.ts");
// Synthetic, process-local values; never real credentials.
const KEY = "portable-refusal-key-0123456789abcdef";
const WRONG_KEY = "portable-refusal-wrong-key-0123456789";
const DRIFT_KEY = "portable-refusal-drift-key-0123456789";
const SECRET = "portable-refusal-secret-value";
const DRIFT_SECRET = "portable-refusal-drift-value";
const FORBIDDEN = [KEY, WRONG_KEY, DRIFT_KEY, SECRET, DRIFT_SECRET];
const MUTATIONS = new Set(["create", "run", "start", "up"]);

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * The hosted `portable-bootstrap-negatives` fixture against a recording Docker
 * stub: env refusals must happen before Hack asks Compose to create, run or
 * start anything. The stub refuses every Compose mutation, so the positive
 * control shows the same command reaches the dependency bootstrap with a
 * valid key.
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hack-portable-refusal-"));
  roots.push(root);
  const project = join(root, "project");
  const bin = join(root, "bin");
  const home = join(root, "home");
  for (const path of [
    join(project, ".hack"),
    join(project, "deps"),
    bin,
    home,
  ]) {
    await mkdir(path, { recursive: true });
  }
  const manifest = '{\n  "name": "portable-refusal",\n  "private": true\n}\n';
  const files: Record<string, string> = {
    ".gitignore": ".hack/.internal/\n.hack.secret.key\n",
    "package.json": manifest,
    "bun.lock": renderBootstrapLock({ manifest, revision: 1 }),
    "deps/install.sh": PORTABLE_BOOTSTRAP_INSTALL_SCRIPT,
    "deps/verify.sh": PORTABLE_BOOTSTRAP_VERIFY_SCRIPT,
    ".hack/hack.config.json": `${JSON.stringify({
      name: "portable-refusal",
      internal: { dns: false, tls: false },
    })}\n`,
    ".hack/docker-compose.yml": renderBootstrapCompose({
      name: "portable-refusal",
      ref: `sha256:${"a".repeat(64)}`,
      platform: "linux/arm64",
      generation: "0",
      tokenDigest: sha256Hex(SECRET),
    }),
    ".hack/hack.env.default.yaml": renderBootstrapEnvFile({
      environment: "default",
      sealed: encryptSynthetic({ key: KEY, secret: SECRET }),
    }),
    ".hack/hack.env.drift.yaml": renderBootstrapEnvFile({
      environment: "drift",
      sealed: encryptSynthetic({ key: DRIFT_KEY, secret: DRIFT_SECRET }),
    }),
  };
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(project, path), content);
  }
  const git = (args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", project, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
  };
  git(["init", "-q", "-b", "main"]);
  git(["add", "."]);
  git([
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ]);
  const log = join(root, "docker.jsonl");
  await writeFile(log, "");
  const docker = join(bin, "docker");
  await writeFile(
    docker,
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const mutations = ${JSON.stringify([...MUTATIONS])};
if (args[0] === "compose" && args.some((arg) => mutations.includes(arg))) process.exit(97);
`
  );
  await chmod(docker, 0o755);
  const up = async (opts: {
    readonly key: string | null;
    readonly overlay?: string;
  }) => {
    const child = Bun.spawn(
      [
        process.execPath,
        cli,
        "up",
        "--detach",
        ...(opts.overlay ? ["--env", opts.overlay] : []),
        "app",
      ],
      {
        cwd: project,
        timeout: 20_000,
        env: privateCliEnv({
          root,
          home,
          env: {
            HACK_HOME: join(home, ".hack"),
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            HACK_NO_INTERACTIVE: "1",
            HACK_EXECUTION_MODE: "slim",
            HACK_DAEMON_DISABLE_DOCKER_EVENTS: "1",
            NO_COLOR: "1",
            ...(opts.key === null ? {} : { HACK_ENV_SECRET_KEY: opts.key }),
          },
        }),
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const calls = (await readFile(log, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    await writeFile(log, "");
    return { exitCode, stdout, stderr, calls };
  };
  return { up };
}

function composeMutations(calls: readonly (readonly string[])[]) {
  return calls.filter(
    (args) => args[0] === "compose" && args.some((arg) => MUTATIONS.has(arg))
  );
}

describe("portable bootstrap env refusals", () => {
  test.each([
    { name: "missing key", key: null, reason: ".hack.secret.key" },
    { name: "wrong key", key: WRONG_KEY, reason: "Invalid secure env value." },
    {
      name: "overlay sealed under another key",
      key: KEY,
      overlay: "drift",
      reason: "Invalid secure env value.",
    },
  ])("$name refuses before any Compose mutation", async (entry) => {
    const { up } = await fixture();
    const result = await up(entry);
    expect(result.exitCode).not.toBe(0);
    expect(composeMutations(result.calls)).toEqual([]);
    expect(`${result.stdout}${result.stderr}`).toContain(entry.reason);
    for (const value of FORBIDDEN) {
      expect(`${result.stdout}${result.stderr}`).not.toContain(value);
    }
  }, 60_000);

  test("the valid key reaches the dependency bootstrap first", async () => {
    const { up } = await fixture();
    const result = await up({ key: KEY });
    expect(result.exitCode).not.toBe(0);
    const mutations = composeMutations(result.calls);
    expect(mutations.length).toBe(1);
    expect(mutations[0]).toContain("run");
    expect(mutations[0]?.at(-1)).toBe("deps");
    for (const value of FORBIDDEN) {
      expect(`${result.stdout}${result.stderr}`).not.toContain(value);
    }
  }, 60_000);
});
