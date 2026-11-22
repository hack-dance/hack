import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HACK_VERSION } from "../src/lib/hack-version.ts";
import { setProjectEnvValue } from "../src/lib/project-env-config.ts";
import { spawnSyncBounded } from "./helpers/bounded-spawn-sync.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

const cli = resolve(import.meta.dir, "../index.ts");

test("the six --use entry points deliver the invocation target without saving it", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hack-use-cli-")));
  try {
    const bin = join(root, "bin");
    await mkdir(bin);
    const log = join(root, "delivery");
    const stack = join(root, "stack");
    const other = join(root, "other");
    for (const dir of [stack, other]) {
      const hack = join(dir, ".hack");
      await mkdir(hack, { recursive: true });
      await Bun.write(
        join(hack, "docker-compose.yml"),
        "services:\n  api:\n    image: alpine\n  postgres:\n    image: postgres\n"
      );
      await Bun.write(
        join(hack, "hack.config.json"),
        JSON.stringify({
          name: dir === stack ? "remote-stack" : "remote-other",
          min_cli_version: HACK_VERSION,
          internal: { dns: false, tls: false },
          sessions: { mux: "tmux" },
          remotes: {
            db: {
              default: "local",
              env: { DB_HOST: "{host}:{port}" },
              targets: {
                local: { service: "postgres", port: 5432 },
                qa: { hostname: "qa.example.test", port: 5432 },
                live: {
                  hostname: { env_ref: "LIVE_HOST" },
                  port: 5432,
                  confirm: true,
                },
              },
            },
          },
        })
      );
      await setProjectEnvValue({
        projectRoot: dir,
        projectDir: hack,
        envName: null,
        scope: "global",
        key: "LIVE_HOST",
        value: "live.example.test",
        secret: false,
      });
    }
    const script = (name: string, body: string) =>
      writeFile(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o700 });
    await script(
      "docker",
      [
        'case " $* " in',
        '  *" down "*) rm -f "$TEST_STACK_STATE" ;;',
        '  *" ps "*) if [ -f "$TEST_STACK_STATE" ]; then cat "$TEST_STACK_STATE"; fi ;;',
        '  *" up "*|*" run "*)',
        '    printf "%s\\n" "$*" >> "$TEST_DELIVERY"',
        '    printf "%s\\n" "${DB_HOST:-}" >> "$TEST_DELIVERY"',
        '    case " $* " in *" up "*)',
        '      for arg in "$@"; do',
        '        case "$arg" in *compose.env.override.yml)',
        '          label="$(awk \'/dev.hack.remote.db:/ {print $2; exit}\' "$arg")"',
        '          printf \'{"ID":"fixture","Service":"api","State":"running","Labels":"dev.hack.remote.db=%s"}\\n\' "$label" > "$TEST_STACK_STATE" ;;',
        "        esac",
        "      done ;;",
        "    esac ;;",
        "esac",
        "exit 0",
      ].join("\n")
    );
    await script("fixture-shell", 'printf "%s\\n" "$DB_HOST"');
    await script(
      "tmux",
      [
        'case " $* " in',
        '  *" list-sessions "*) exit 1 ;;',
        '  *" source-file - "*) cat >> "$TEST_DELIVERY" ;;',
        "esac",
        "exit 0",
      ].join("\n")
    );
    const env = privateCliEnv({
      root,
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        SHELL: join(bin, "fixture-shell"),
        TEST_DELIVERY: log,
        TEST_STACK_STATE: join(root, "stack-state"),
        HACK_NO_INTERACTIVE: "1",
        HACK_RUNTIME_BACKEND: "compose",
      },
    });
    const hack = (args: string[], cwd = stack, extra = {}) => {
      const result = spawnSyncBounded([process.execPath, cli, ...args], {
        cwd,
        env: { ...env, ...extra },
        timeout: 20_000,
      });
      return {
        code: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      };
    };
    const ok = (args: string[], cwd = stack) => {
      const result = hack(args, cwd);
      expect(result.code, result.stdout + result.stderr).toBe(0);
      return result;
    };

    expect(ok(["use", "db=live"]).stdout).toContain("saved for this checkout");
    expect(hack(["up", "--detach"]).stderr).toContain("E_INTERACTIVE_REQUIRED");
    expect(ok(["use", "db=qa"]).stdout).toContain("saved for this checkout");
    expect(ok(["use"], other).stdout).toContain("pending: local (default)");
    expect(
      ok(["host", "exec", "--", "/usr/bin/printenv", "DB_HOST"]).stdout
    ).toBe("qa.example.test:5432\n");
    const choice = ["--use", "db=live"];
    ok(["up", "--detach", "--use", "db=local"]);
    expect(await Bun.file(log).text()).toMatch(/ up .* postgres/);
    expect(
      ok(["host", "exec", ...choice, "--", "/usr/bin/printenv", "DB_HOST"])
        .stdout
    ).toBe("live.example.test:5432\n");
    expect(ok(["host", "shell", ...choice]).stdout).toBe(
      "live.example.test:5432\n"
    );
    for (const args of [
      ["up", "--detach", ...choice],
      ["restart", ...choice],
      ["run", ...choice, "api"],
    ]) {
      await Bun.write(log, "");
      const result = ok(args);
      expect(result.stderr).toContain("$LIVE_HOST:5432");
      expect(result.stdout + result.stderr).not.toContain("live.example.test");
      const delivery = await Bun.file(log).text();
      expect(delivery).toContain("live.example.test:5432\n");
      expect(delivery).not.toMatch(/ up .* postgres/);
    }
    expect(ok(["use"]).stdout).toContain(
      "running: live (--use) · pending: qa (checkout)"
    );
    await Bun.write(log, "");
    ok(["session", "start", ...choice, "--detach", "remote-stack"]);
    expect(await Bun.file(log).text()).toContain(
      "DB_HOST=live.example.test:5432"
    );
    await Bun.write(log, "");
    const withUp = ok([
      "session",
      "start",
      ...choice,
      "--up",
      "--new",
      "--detach",
      "remote-stack",
    ]);
    expect(withUp.stderr.match(/db → live/g)).toHaveLength(1);
    expect(await Bun.file(log).text()).toContain(
      "DB_HOST=live.example.test:5432"
    );
    expect(
      await Bun.file(join(stack, ".hack", ".internal", "use.json")).json()
    ).toEqual({ db: "qa" });
    const native = hack(["up", "--detach", "--json", ...choice], stack, {
      HACK_RUNTIME_BACKEND: "native",
    });
    expect(native.stdout + native.stderr).toContain(
      "E_NATIVE_PROJECT_UNSUPPORTED"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
