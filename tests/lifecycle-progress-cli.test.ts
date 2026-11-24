import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LIFECYCLE_PROGRESS_SCHEMA } from "../src/lib/lifecycle-progress.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

const CLI = resolve(import.meta.dir, "..", "index.ts");

/**
 * Stub `docker`: Compose `up` succeeds unless STUB_UP_FAIL=1, `ps --format`
 * reports `api` running and `migrate` completed, everything else succeeds.
 */
const STUB = `#!/bin/sh
if [ "$1" != "compose" ]; then exit 0; fi
# After down, ps lists nothing (HACK-2340: down checks what is left).
marker="$(dirname "$0")/.compose-down"
case " $* " in
  *" down "*)
    : > "$marker"
    exit 0 ;;
  *" up "*)
    rm -f "$marker"
    if [ "\${STUB_UP_FAIL:-}" = "1" ]; then exit 3; fi
    if [ "\${STUB_UP_SLEEP:-}" = "1" ]; then sleep 8; fi
    exit 0 ;;
  *" ps "*)
    if [ -f "$marker" ]; then exit 0; fi
    case " $* " in
      *" --format "*)
        printf '{"ID":"c1","Service":"api","Name":"shop-api-1","State":"running","Status":"Up","ExitCode":0,"Labels":"com.docker.compose.project.working_dir=%s"}\\n' "$PWD"
        printf '{"ID":"c2","Service":"migrate","Name":"shop-migrate-1","State":"exited","Status":"Exited (0)","ExitCode":0,"Labels":"com.docker.compose.project.working_dir=%s"}\\n' "$PWD" ;;
    esac
    exit 0 ;;
  *) exit 0 ;;
esac
`;

let root = "";
let project = "";
let bin = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-lifecycle-progress-"));
  project = join(root, "project");
  bin = join(root, "bin");
  const hack = join(project, ".hack");
  await mkdir(hack, { recursive: true });
  await mkdir(bin);
  await writeFile(join(bin, "docker"), STUB);
  await chmod(join(bin, "docker"), 0o755);
  await writeFile(
    join(hack, "hack.config.json"),
    JSON.stringify({ name: "shop", internal: { dns: false, tls: false } })
  );
  await writeFile(
    join(hack, "docker-compose.yml"),
    "name: shop\nservices:\n  api:\n    image: alpine:3.22\n  migrate:\n    image: alpine:3.22\n    restart: 'no'\n"
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function cli(
  args: readonly string[],
  extra: Record<string, string> = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: project,
    env: privateCliEnv({
      root,
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HACK_RUNTIME_BACKEND: "compose",
        HACK_NO_INTERACTIVE: "1",
        NO_COLOR: "1",
        ...extra,
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
  return { exitCode, stdout, stderr };
}

/** Every stdout line must be one JSON object; returns them parsed. */
function ndjson(stdout: string): Record<string, unknown>[] {
  expect(stdout.endsWith("\n")).toBe(true);
  return stdout
    .slice(0, -1)
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function expectStreamShape(
  lines: readonly Record<string, unknown>[],
  action: string
): void {
  expect(lines[0]).toMatchObject({
    schema: LIFECYCLE_PROGRESS_SCHEMA,
    type: "start",
    action,
    project: "shop",
  });
  expect(typeof lines[0]?.ts).toBe("string");
  for (const line of lines.slice(1, -1)) {
    expect(line.type).toBe("progress");
    expect(line).not.toHaveProperty("schema");
    expect(typeof line.ts).toBe("string");
  }
  expect(lines.at(-1)).toHaveProperty("ok");
}

test("up --json --progress streams start, progress lines and one compact envelope", async () => {
  const result = await cli(["up", "--json", "--progress"]);
  expect(result.exitCode).toBe(0);
  const lines = ndjson(result.stdout);
  expectStreamShape(lines, "up");
  const progress = lines.slice(1, -1).map((line) => [line.service, line.phase]);
  expect(progress).toEqual([
    [null, "images"],
    [null, "starting"],
    ["api", "running"],
    ["migrate", "completed"],
  ]);
  const envelope = lines.at(-1);
  expect(envelope).toMatchObject({
    ok: true,
    data: { action: "up", services: { started: ["api"] } },
  });
  // The envelope is one compact line and nothing follows it.
  const rawLines = result.stdout.trimEnd().split("\n");
  expect(rawLines.at(-1)?.startsWith('{"ok":true,')).toBe(true);
}, 60_000);

test("a failing Compose up ends the stream with one compact error envelope", async () => {
  const result = await cli(["up", "--json", "--progress"], {
    STUB_UP_FAIL: "1",
  });
  expect(result.exitCode).not.toBe(0);
  const lines = ndjson(result.stdout);
  expectStreamShape(lines, "up");
  expect(lines.slice(1, -1).map((line) => line.phase)).toEqual(["images"]);
  expect(lines.at(-1)).toMatchObject({
    ok: false,
    error: { code: "E_COMPOSE_FAILED" },
  });
  expect(
    result.stdout.trimEnd().split("\n").at(-1)?.startsWith('{"ok":false,')
  ).toBe(true);
}, 60_000);

test("down --json --progress reports stopping and stopped", async () => {
  const result = await cli(["down", "--json", "--progress"]);
  expect(result.exitCode).toBe(0);
  const lines = ndjson(result.stdout);
  expectStreamShape(lines, "down");
  expect(lines.slice(1, -1).map((line) => [line.service, line.phase])).toEqual([
    [null, "stopping"],
    [null, "stopped"],
    ["api", "stopped"],
  ]);
  expect(lines.at(-1)).toMatchObject({ ok: true, data: { action: "down" } });
}, 60_000);

test("restart --json --progress reports its stop and start phases", async () => {
  const result = await cli(["restart", "--json", "--progress"]);
  expect(result.exitCode).toBe(0);
  const lines = ndjson(result.stdout);
  expectStreamShape(lines, "restart");
  expect(lines.slice(1, -1).map((line) => [line.service, line.phase])).toEqual([
    [null, "stopping"],
    [null, "stopped"],
    [null, "images"],
    [null, "starting"],
    ["api", "running"],
    ["migrate", "completed"],
  ]);
  expect(lines.at(-1)).toMatchObject({
    ok: true,
    data: { action: "restart" },
  });
}, 60_000);

test("--progress without --json is a usage error", async () => {
  for (const action of ["up", "down", "restart"]) {
    const result = await cli([action, "--progress"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "--progress requires --json."
    );
  }
}, 60_000);

test("the native backend refuses --progress with a single usage envelope", async () => {
  for (const action of ["up", "down", "restart"]) {
    const result = await cli([action, "--json", "--progress"], {
      HACK_RUNTIME_BACKEND: "native",
    });
    expect(result.exitCode).toBe(1);
    // A refusal before the stream starts is the ordinary envelope.
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      error?: { code: string; message: string };
    };
    expect(parsed).toEqual({
      ok: false,
      error: {
        code: "E_USAGE",
        message: "Native lifecycle commands do not support --progress yet.",
      },
    });
  }
}, 60_000);

test("SIGTERM after start closes the stream with one E_CANCELLED line", async () => {
  const child = Bun.spawn(
    [process.execPath, CLI, "up", "--json", "--progress"],
    {
      cwd: project,
      env: privateCliEnv({
        root,
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          HACK_RUNTIME_BACKEND: "compose",
          HACK_NO_INTERACTIVE: "1",
          NO_COLOR: "1",
          STUB_UP_SLEEP: "1",
        },
      }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let stdout = "";
  while (!stdout.includes('"type":"start"')) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    stdout += decoder.decode(chunk.value, { stream: true });
  }
  child.kill("SIGTERM");
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    stdout += decoder.decode(chunk.value, { stream: true });
  }
  await child.exited;

  const lines = ndjson(stdout);
  expect(lines[0]).toMatchObject({ type: "start", action: "up" });
  expect(lines.at(-1)).toMatchObject({
    ok: false,
    error: { code: "E_CANCELLED" },
  });
  expect(lines.filter((line) => "ok" in line)).toHaveLength(1);
  expect(child.exitCode === 0).toBe(false);
}, 60_000);
