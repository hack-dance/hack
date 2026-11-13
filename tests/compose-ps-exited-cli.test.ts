import { expect, test } from "bun:test";
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

const CLI = resolve(import.meta.dir, "..", "index.ts");
const STUB = `#!/bin/sh
if [ "$1" != "compose" ]; then exit 0; fi
case " $* " in
  *" up "*) touch "$STUB_ROOT/started"; exit 1 ;;
  *" ps "*)
    printf '%s\\n' "$*" >> "$STUB_ROOT/ps-args"
    case " $* " in
      *" --format "*)
        if [ "\${STUB_FAIL_JSON:-}" = "1" ]; then exit 2; fi
        case "\${STUB_PS_MODE:-}" in
          permission)
            printf '%s\n' 'permission denied while trying to connect to the docker API at unix:///var/run/docker.sock' 'second line' >&2
            exit 1 ;;
          unreachable)
            printf '%s\n' 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?' >&2
            exit 1 ;;
          garbage) printf '%s\n' 'NAME IMAGE STATUS'; exit 0 ;;
          array)
            printf '%s\n' '[{"Service":"web","Name":"sample-web-1","State":"running","Status":"Up","ExitCode":0}]'
            exit 0 ;;
        esac
        printf '%s\\n' '{"Service":"web","Name":"sample-web-1","State":"running","Status":"Up","ExitCode":0}'
        case " $* " in
          *" --all "*)
            if [ -f "$STUB_ROOT/started" ]; then
              printf '%s\\n' '{"Service":"worker","Name":"sample-worker-1","State":"exited","Status":"Exited (127)","ExitCode":127}' '{"Service":"install","Name":"sample-install-1","State":"exited","Status":"Exited (0)","ExitCode":0}'
            fi ;;
        esac ;;
      *)
        case " $* " in
          *" --all "*) printf '%s\\n' 'worker exited 127' 'install exited 0' ;;
          *) printf '%s\\n' 'web running' ;;
        esac ;;
    esac ;;
  *) exit 0 ;;
esac
`;

test("Compose ps shows failed and completed services after failed up", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-ps-exited-"));
  try {
    const project = join(root, "project");
    const hack = join(project, ".hack");
    const bin = join(root, "bin");
    await mkdir(hack, { recursive: true });
    await mkdir(bin);
    await writeFile(join(bin, "docker"), STUB);
    await chmod(join(bin, "docker"), 0o755);
    await writeFile(
      join(hack, "hack.config.json"),
      JSON.stringify({
        name: "sample",
        internal: { dns: false, tls: false },
      })
    );
    await writeFile(
      join(hack, "docker-compose.yml"),
      "services:\n  web:\n    image: alpine:3.22\n  worker:\n    image: alpine:3.22\n  install:\n    image: alpine:3.22\n"
    );
    async function cli(args: string[], extra: Record<string, string> = {}) {
      const child = Bun.spawn([process.execPath, CLI, ...args], {
        cwd: project,
        env: privateCliEnv({
          root,
          env: {
            PATH: `${bin}:/usr/bin:/bin`,
            STUB_ROOT: root,
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
    expect((await cli(["up", "--detach", "--json"])).exitCode).toBe(1);
    const text = await cli(["ps"]);
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("STATE");
    expect(text.stdout).toContain("EXIT CODE");
    expect(text.stdout).toMatch(/worker\s+sample-worker-1\s+exited\s+127/);
    expect(text.stdout).toMatch(/install\s+sample-install-1\s+exited\s+0/);
    const json = await cli(["ps", "--json"]);
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.stdout).items).toEqual([
      expect.objectContaining({ Service: "web", State: "running" }),
      expect.objectContaining({
        Service: "worker",
        State: "exited",
        ExitCode: 127,
      }),
      expect.objectContaining({
        Service: "install",
        State: "exited",
        ExitCode: 0,
      }),
    ]);
    const fallback = await cli(["ps"], { STUB_FAIL_JSON: "1" });
    expect(fallback.exitCode).toBe(0);
    expect(fallback.stdout).toContain("worker exited 127");
    expect(fallback.stdout).toContain("install exited 0");
    const failedJson = await cli(["ps", "--json"], { STUB_FAIL_JSON: "1" });
    expect(failedJson.exitCode).toBe(1);
    expect(JSON.parse(failedJson.stdout)).toEqual({
      ok: false,
      error: {
        code: "E_COMPOSE_FAILED",
        message:
          "docker compose ps failed (exit 2). Its output is omitted because Compose can expand project values into it; run `docker compose ps` in the project (or `hack ps` without --json) to see it.",
      },
    });
    const calls = (await readFile(join(root, "ps-args"), "utf8"))
      .trim()
      .split("\n");
    expect(calls.every((line) => line.includes("--all"))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

/** No frame of a JavaScript stack trace (`    at fn (file:line)`). */
const STACK_FRAME = /^\s+at\s/m;

test("Compose ps reports the engine's cause with a stable code (HACK-2068)", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-ps-engine-"));
  try {
    const project = join(root, "project");
    const hack = join(project, ".hack");
    const bin = join(root, "bin");
    await mkdir(hack, { recursive: true });
    await mkdir(bin);
    await writeFile(join(bin, "docker"), STUB);
    await chmod(join(bin, "docker"), 0o755);
    await writeFile(
      join(hack, "hack.config.json"),
      JSON.stringify({ name: "sample", internal: { dns: false, tls: false } })
    );
    await writeFile(
      join(hack, "docker-compose.yml"),
      "services:\n  web:\n    image: alpine:3.22\n"
    );
    async function cli(args: string[], mode: string) {
      const child = Bun.spawn([process.execPath, CLI, ...args], {
        cwd: project,
        env: privateCliEnv({
          root,
          env: {
            PATH: `${bin}:/usr/bin:/bin`,
            STUB_ROOT: root,
            STUB_PS_MODE: mode,
            HACK_RUNTIME_BACKEND: "compose",
            HACK_NO_INTERACTIVE: "1",
            NO_COLOR: "1",
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
    const engineLine: Record<string, string> = {
      permission:
        "permission denied while trying to connect to the docker API at unix:///var/run/docker.sock",
      unreachable:
        "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
    };
    const cases = [
      { mode: "permission", code: "E_PERMISSION" },
      { mode: "unreachable", code: "E_DOCKER_UNAVAILABLE" },
    ] as const;
    for (const { mode, code } of cases) {
      const json = await cli(["ps", "--json"], mode);
      expect(json.exitCode).toBe(1);
      const envelope = JSON.parse(json.stdout);
      expect(envelope.ok).toBe(false);
      expect(envelope.error.code).toBe(code);
      expect(envelope.error.message).toContain(
        `Engine said: ${engineLine[mode]}`
      );
      // Only the first engine line is kept.
      expect(envelope.error.message).not.toContain("second line");

      // Text mode (the CLI logger prints to stdout): one coded line with the cause, no stack, no plain-ps retry
      // (it would fail the same way).
      await rm(join(root, "ps-args"), { force: true });
      const text = await cli(["ps"], mode);
      expect(text.exitCode).toBe(1);
      expect(`${text.stdout}${text.stderr}`).toContain(`${code}:`);
      expect(`${text.stdout}${text.stderr}`).toContain(engineLine[mode] ?? "");
      expect(`${text.stdout}${text.stderr}`).not.toMatch(STACK_FRAME);
      const calls = (await readFile(join(root, "ps-args"), "utf8"))
        .trim()
        .split("\n");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain("--format");

      // `hack exec` reads the same listing before running and keeps the cause.
      const exec = await cli(["exec", "web", "--", "true"], mode);
      expect(exec.exitCode).toBe(1);
      expect(`${exec.stdout}${exec.stderr}`).toContain(`${code}:`);
      expect(`${exec.stdout}${exec.stderr}`).toContain(engineLine[mode] ?? "");
      expect(`${exec.stdout}${exec.stderr}`).not.toMatch(STACK_FRAME);
    }

    // Exit 0 with output that is not JSON: a distinct code, output not echoed.
    const garbage = await cli(["ps", "--json"], "garbage");
    expect(garbage.exitCode).toBe(1);
    const garbageEnvelope = JSON.parse(garbage.stdout);
    expect(garbageEnvelope.error.code).toBe("E_COMPOSE_OUTPUT_INVALID");
    expect(garbageEnvelope.error.message).not.toContain("NAME IMAGE STATUS");

    // Older Compose v2 prints one JSON array; it is still read.
    const array = await cli(["ps", "--json"], "array");
    expect(array.exitCode).toBe(0);
    expect(JSON.parse(array.stdout).items).toEqual([
      expect.objectContaining({ Service: "web", State: "running" }),
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
