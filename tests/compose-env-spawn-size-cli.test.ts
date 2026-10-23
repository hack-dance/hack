import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PROJECT_ENV_KEY_FILENAME } from "../src/constants.ts";
import { setProjectEnvValue } from "../src/lib/project-env-config.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * HACK-1317: with one 64 KiB global secret and 20 services, `hack up` failed
 * with `E_UNEXPECTED: E2BIG ... posix_spawn docker` because every service got
 * its own `HACK_ENV_*` copy of the value. A stub `docker` stands in for the
 * engine and records only counts about the environment Compose would read:
 * how many variables hold the value and the total size. Values are synthetic
 * and assembled at runtime; the test never prints them.
 */
const CANARY = "g45-synthetic-canary";
const SERVICES = Array.from(
  { length: 20 },
  (_, index) => `svc${String(index + 1).padStart(2, "0")}`
);
const CLI = resolve(import.meta.dir, "..", "index.ts");

let root: string;
let projectRoot: string;
let hackDir: string;
let capture: string;
let overridePath: string;

const STUB = [
  "#!/bin/sh",
  'printf "%s\\n" "$*" >> "$STUB_CAPTURE/docker-args.log"',
  'if [ "$1" = "compose" ]; then',
  '  case " $* " in',
  '    *" up "*)',
  // Counts only: never the values themselves.
  // A value line is NAME=<canary>-...; the STUB_CANARY line itself is not.
  '      env | grep -c "=$STUB_CANARY-" > "$STUB_CAPTURE/canary-vars.txt"',
  '      env | wc -c > "$STUB_CAPTURE/env-bytes.txt"',
  '      env | grep "=$STUB_CANARY-" | cut -d= -f1 | sort > "$STUB_CAPTURE/canary-names.txt"',
  "      exit 0",
  "      ;;",
  '    *" ps "*)',
  `      for s in ${SERVICES.join(" ")}; do printf '{"Service":"%s","State":"running","ExitCode":0}\\n' "$s"; done`,
  "      exit 0",
  "      ;;",
  "    *) exit 0 ;;",
  "  esac",
  "fi",
  "exit 0",
  "",
].join("\n");

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "hack-env-e2big-")));
  projectRoot = join(root, "project");
  capture = join(root, "capture");
  hackDir = join(projectRoot, ".hack");
  overridePath = join(hackDir, ".internal", "compose.env.override.yml");
  await mkdir(hackDir, { recursive: true });
  await mkdir(capture);
  await mkdir(join(root, "bin"));
  await writeFile(join(root, "bin", "docker"), STUB);
  await chmod(join(root, "bin", "docker"), 0o755);
  await writeFile(
    join(hackDir, "hack.config.json"),
    `${JSON.stringify({
      name: "envsize",
      dev_host: "envsize.hack",
      internal: { dns: false, tls: false },
      logs: { follow_backend: "compose", snapshot_backend: "compose" },
    })}\n`
  );
  await writeFile(
    join(hackDir, "docker-compose.yml"),
    [
      "services:",
      ...SERVICES.flatMap((service) => [
        `  ${service}:`,
        "    image: alpine:3.22",
      ]),
      "",
    ].join("\n")
  );
  await writeFile(join(projectRoot, PROJECT_ENV_KEY_FILENAME), "synthetic-key");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A synthetic value of `bytes` bytes that starts with the canary. */
function syntheticValue(tag: string, bytes: number): string {
  const head = `${CANARY}-${tag}-`;
  return `${head}${"x".repeat(bytes - head.length)}`;
}

async function setGlobal(key: string, value: string): Promise<void> {
  await setProjectEnvValue({
    projectRoot,
    projectDir: hackDir,
    envName: null,
    scope: "global",
    key,
    value,
    secret: true,
  });
}

async function runUp(): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const child = Bun.spawn([process.execPath, CLI, "up", "--detach", "--json"], {
    cwd: projectRoot,
    env: privateCliEnv({
      root,
      env: {
        // Stub docker plus base system tools only.
        PATH: `${join(root, "bin")}:/usr/bin:/bin`,
        STUB_CAPTURE: capture,
        STUB_CANARY: CANARY,
        HACK_NO_INTERACTIVE: "1",
      },
    }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  // Never print a value: a failing assertion reports only these flags.
  expect(stdout.includes(CANARY)).toBe(false);
  expect(stderr.includes(CANARY)).toBe(false);
  return { exitCode, stdout, stderr };
}

test("twenty services and one 64 KiB global secret start with one shared reference", async () => {
  await setGlobal("BIG_TOKEN", syntheticValue("big", 64 * 1024));

  const up = await runUp();
  expect(up.exitCode).toBe(0);
  expect((JSON.parse(up.stdout) as { ok: boolean }).ok).toBe(true);

  // Compose got the value once under its shared reference and once under its
  // own name for interpolation, not once per service (21 copies before).
  const names = (await readFile(join(capture, "canary-names.txt"), "utf8"))
    .trim()
    .split("\n");
  expect(names).toHaveLength(2);
  expect(names).toContain("BIG_TOKEN");
  const shared = names.find((name) => name !== "BIG_TOKEN") ?? "";
  expect(shared).toMatch(/^HACK_ENV_[0-9A-F]{12}_BIG_TOKEN$/);
  expect(
    Number(await readFile(join(capture, "env-bytes.txt"), "utf8"))
  ).toBeLessThan(256 * 1024);

  // Every service references the same name; the file holds no value.
  const text = await readFile(overridePath, "utf8");
  expect(text.includes(CANARY)).toBe(false);
  expect(text.split(`BIG_TOKEN: "\${${shared}}"`)).toHaveLength(
    SERVICES.length + 1
  );
  const args = await readFile(join(capture, "docker-args.log"), "utf8");
  expect(args.includes(CANARY)).toBe(false);
}, 120_000);

test("an environment over the platform limit fails with E_ENV_TOO_LARGE before Compose starts", async () => {
  // Three 200 KiB global values: each string is over Linux's 128 KiB
  // MAX_ARG_STRLEN, and two copies of each are over the macOS 1 MiB ARG_MAX.
  for (const key of ["HUGE_A", "HUGE_B", "HUGE_C"]) {
    await setGlobal(key, syntheticValue(key, 200 * 1024));
  }

  const up = await runUp();
  expect(up.exitCode).toBe(1);
  const envelope = JSON.parse(up.stdout) as {
    readonly ok: boolean;
    readonly error: {
      readonly code: string;
      readonly message: string;
      readonly detail: {
        readonly limit: string;
        readonly bytes: number;
        readonly limitBytes: number;
      };
    };
  };
  expect(envelope.ok).toBe(false);
  expect(envelope.error.code).toBe("E_ENV_TOO_LARGE");
  const expectedLimit =
    process.platform === "linux" ? "MAX_ARG_STRLEN" : "ARG_MAX";
  expect(envelope.error.detail.limit).toBe(expectedLimit);
  expect(envelope.error.message).toContain(expectedLimit);
  expect(envelope.error.message).toContain("did not start docker compose");
  expect(envelope.error.detail.bytes).toBeGreaterThan(
    envelope.error.detail.limitBytes
  );
  expect(envelope.error.message.includes("HUGE_")).toBe(false);

  // Nothing ran Compose and nothing was written for it.
  const args = await readFile(join(capture, "docker-args.log"), "utf8").catch(
    () => ""
  );
  expect(args).not.toContain("compose");
  expect(await lstat(join(capture, "canary-vars.txt")).catch(() => null)).toBe(
    null
  );
  expect(await lstat(overridePath).catch(() => null)).toBeNull();
}, 120_000);
