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
    expect(failedJson.exitCode).toBe(2);
    expect(failedJson.stdout).toBe("");
    const calls = (await readFile(join(root, "ps-args"), "utf8"))
      .trim()
      .split("\n");
    expect(calls.every((line) => line.includes("--all"))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
