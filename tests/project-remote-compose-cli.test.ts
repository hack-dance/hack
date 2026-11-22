import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { HACK_VERSION } from "../src/lib/hack-version.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

const root = resolve(import.meta.dir, "..");
const neutralityBase =
  process.env.HACK_NEUTRALITY_BASE_SHA ??
  "3f2f00e1b8b2bb0fe26cadf47369dbc75e693001";
const fixtureEngine = `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import YAML from ${JSON.stringify(resolve(root, "node_modules/yaml/dist/index.js"))};
const argv = Bun.argv.slice(2);
const control = process.env.TEST_CONTROL;
const state = control + "/engine.json";
const files = argv.flatMap((arg, i) => arg === "-f" ? [argv[i+1]] : []);
const generated = files.filter((file) => file.includes("/.internal/") || file.includes("/.branch/"))
  .map((file) => existsSync(file) ? readFileSync(file, "utf8") : null);
appendFileSync(control + "/calls", JSON.stringify({argv, envNames: Object.keys(process.env).sort(), fixtureEnv: process.env.EXAMPLE ?? null, generated}) + "\\n");
const command = ["up", "down", "exec", "run", "logs", "ps", "config"].find((name) => argv.includes(name));
const requiresRemote = files.some((file) => existsSync(file) && readFileSync(file, "utf8").includes("DB_HOST:?required"));
if (requiresRemote && ["up", "down", "config"].includes(command) && !process.env.DB_HOST) {
  console.error("required interpolation unavailable");
  process.exit(1);
}
const row = existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : null;
if (argv.includes("version")) { console.log("2.24.4"); }
else if (argv[0] === "network" && argv.includes("inspect")) { console.log("[]"); }
else if (argv[0] === "network" && argv.includes("ls") && row) {
  console.log(JSON.stringify({ Name: "remote-fixture_default", Labels: "com.docker.compose.project=remote-fixture,com.docker.compose.network=default" }));
}
else if (command === "config") {
  console.log(argv.includes("--services") ? "api" : JSON.stringify({ services: {api: {image: "alpine"}} }));
} else if (command === "up") {
  if (!argv.includes("--no-start")) {
    const override = files.find((file) => file.includes("/compose.remote.override."));
    const labels = override ? YAML.parse(readFileSync(override, "utf8")).services.api.labels : {};
    writeFileSync(state, JSON.stringify({
      ID: "a".repeat(64), Service: "api", State: "running", ExitCode: 0, Project: "remote-fixture",
      Labels: Object.entries({"com.docker.compose.project":"remote-fixture","com.docker.compose.service":"api","com.docker.compose.project.working_dir":process.cwd(), ...labels}).map(([k,v])=>k+"="+v).join(",")
    }));
  }
} else if (command === "ps") {
  if (process.env.TEST_FAIL_PS === "1") process.exit(19);
  if (row) console.log(JSON.stringify(row));
  if (process.env.TEST_FOREIGN_PEER && argv.some((arg) => arg.startsWith("label=com.docker.compose.project="))) {
    console.log(JSON.stringify({ ...row, ID: "b".repeat(64), Labels: "com.docker.compose.project=remote-fixture,com.docker.compose.service=foreign" + (process.env.TEST_FOREIGN_PEER === "oneoff" ? ",com.docker.compose.oneoff=True" : "") }));
  }
} else if (command === "down") {
  const recovery = files.find((file) => file.includes("/compose.remote-recovery."));
  const networks = recovery ? JSON.parse(readFileSync(recovery, "utf8")).networks : null;
  appendFileSync(control + "/down", JSON.stringify({networks, db: process.env.DB_HOST ?? null, daemon: process.env.DOCKER_HOST, profiles: process.env.COMPOSE_PROFILES, files}) + "\\n");
  rmSync(state, {force: true});
}
`;

async function fixture() {
  const path = await realpath(
    await mkdtemp(join(tmpdir(), "hack-remote-recovery-"))
  );
  const control = join(path, "control");
  const repo = join(path, "repo");
  const project = join(repo, ".hack");
  const bin = join(path, "bin");
  await Promise.all([
    mkdir(control),
    mkdir(project, { recursive: true }),
    mkdir(bin),
  ]);
  const docker = join(bin, "docker");
  await Bun.write(docker, fixtureEngine);
  await chmod(docker, 0o700);
  const env = privateCliEnv({
    root: path,
    env: {
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      TEST_CONTROL: control,
      HACK_RUNTIME_BACKEND: "compose",
      HACK_LOGGER: "console",
      HACK_NO_INTERACTIVE: "1",
    },
  });
  const configure = async (extra: Record<string, unknown> = {}) => {
    await Bun.write(
      join(project, "hack.config.json"),
      JSON.stringify({
        name: "remote-fixture",
        dev_host: "remote-fixture.test",
        internal: { dns: false, tls: false },
        logs: { follow_backend: "compose", snapshot_backend: "compose" },
        ...extra,
      })
    );
    await Bun.write(
      join(project, "docker-compose.yml"),
      "name: remote-fixture\nservices:\n  api:\n    image: alpine\n"
    );
  };
  const cli = async (
    args: readonly string[],
    cliRoot = root,
    extra?: Record<string, string>,
    cwd = repo
  ) => {
    const child = Bun.spawn(
      [process.execPath, join(cliRoot, "index.ts"), ...args],
      {
        cwd,
        env: { ...env, ...extra },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 30_000,
      }
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  };
  return { path, repo, project, control, cli, configure };
}

// ps --json launches its two architecture probes together. Fake child
// startup may reverse their arrival order without changing the CLI calls.
function compareTrace(trace: string, args: readonly string[]): string {
  if (args.join(" ") !== "ps --json") {
    return trace;
  }
  const lines = trace.trimEnd().split("\n");
  const pair = lines.slice(-2);
  if (
    pair.some((line) =>
      line.includes('["version","--format","{{json .Server.Arch}}"]')
    ) &&
    pair.some((line) => line.includes('["inspect","--type","container"'))
  ) {
    lines.splice(-2, 2, ...pair.sort());
  }
  return `${lines.join("\n")}\n`;
}

const base = process.env.HACK_NEUTRALITY_BASE_ROOT;
test.skipIf(!base)(
  "non-remote Compose calls match the pinned base byte for byte",
  async () => {
    if (!base) {
      throw new Error(
        "Set HACK_NEUTRALITY_BASE_ROOT to the pinned base checkout."
      );
    }
    const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: base });
    expect(revision.exitCode).toBe(0);
    expect(revision.stdout.toString().trim()).toBe(neutralityBase);
    const f = await fixture();
    try {
      const capture = async (cliRoot: string) => {
        await rm(f.project, { recursive: true });
        await mkdir(f.project);
        await f.configure();
        await Bun.write(
          join(f.project, "hack.env.default.yaml"),
          "version: 1\nenvironment: default\nsecretsprovider: project_key\nvalues:\n  global:\n    EXAMPLE: sample\n"
        );
        await rm(join(f.control, "engine.json"), { force: true });
        const traces: string[] = [];
        for (const args of [
          ["up"],
          ["up", "-d"],
          ["restart"],
          ["ps"],
          ["ps", "--json"],
          ["logs"],
          ["logs", "--compose"],
          ["exec", "api", "true"],
          ["run", "api", "true"],
          ["down"],
          ["run", "--profile", "test", "api", "true"],
          ["up", "-d", "--branch", "test", "--profile", "test"],
          ["down", "--branch", "test"],
          ["up", "-d"],
          ["down", "--prune-caches", "--yes"],
        ]) {
          await Bun.write(join(f.control, "calls"), "");
          const result = await f.cli(args, cliRoot);
          expect(
            result.code,
            `${args.join(" ")}\n${result.stdout}${result.stderr}`
          ).toBe(0);
          const calls = await Bun.file(join(f.control, "calls")).text();
          const expected = args[0] === "restart" ? "up" : args[0];
          expect(
            calls
              .trim()
              .split("\n")
              .some((line) => {
                const { argv } = JSON.parse(line);
                return argv[0] === "compose" && argv.includes(expected);
              }),
            args.join(" ")
          ).toBe(true);
          traces.push(compareTrace(calls, args));
        }
        await Bun.write(join(f.control, "calls"), "");
        const failed = await f.cli(["ps", "--json"], cliRoot, {
          TEST_FAIL_PS: "1",
        });
        expect(failed.code).toBe(1);
        traces.push(await Bun.file(join(f.control, "calls")).text());
        const git = (...args: string[]) => {
          const result = Bun.spawnSync(
            [
              "git",
              "-c",
              "user.name=Fixture",
              "-c",
              "user.email=fixture@example.test",
              ...args,
            ],
            { cwd: f.repo }
          );
          expect(result.exitCode, result.stderr.toString()).toBe(0);
        };
        const linked = join(f.path, "linked");
        git("init", "-q");
        git(
          "add",
          ".hack/hack.config.json",
          ".hack/docker-compose.yml",
          ".hack/hack.env.default.yaml"
        );
        git("commit", "-qm", "fixture", "--allow-empty");
        git("worktree", "add", "--quiet", "-B", "neutral-linked", linked);
        try {
          await Bun.write(join(f.control, "calls"), "");
          const result = await f.cli(["up", "-d"], cliRoot, undefined, linked);
          expect(result.code, result.stdout + result.stderr).toBe(0);
          const down = await f.cli(["down"], cliRoot, undefined, linked);
          expect(down.code, down.stdout + down.stderr).toBe(0);
          const calls = await Bun.file(join(f.control, "calls")).text();
          expect(calls).toContain("--neutral-linked");
          traces.push(calls);
        } finally {
          git("worktree", "remove", "--force", linked);
        }
        return traces;
      };
      const baseline = await capture(base);
      expect(await capture(root)).toEqual(baseline);
    } finally {
      await rm(f.path, { recursive: true });
    }
  },
  120_000
);

test("teardown after a crash preserves the observed target and tolerates missing interpolation", async () => {
  const f = await fixture();
  try {
    const remote = {
      default: "y",
      env: { DB_HOST: "{host}" },
      targets: {
        x: { hostname: { env_ref: "X_HOST" }, port: 5432 },
        y: { hostname: "other.example.test", port: 5432 },
      },
    };
    const configure = async (deleted: boolean, changed = false) => {
      await f.configure({
        min_cli_version: HACK_VERSION,
        remotes: {
          db: deleted
            ? { ...remote, targets: { y: remote.targets.y } }
            : { ...remote, default: changed ? "y" : "x" },
        },
        lifecycle: {
          down: {
            before: [
              {
                name: "remote",
                command:
                  'printf "%s\\n" "${DB_HOST:-absent}" > "$TEST_CONTROL/hook"; if [ "${TEST_STOP_AFTER_HOOK:-}" = 1 ]; then exit 17; fi',
              },
            ],
          },
        },
      });
      await Bun.write(
        join(f.project, "docker-compose.yml"),
        'name: remote-fixture\nservices:\n  api:\n    image: alpine\n    environment: ["DB_HOST=${DB_HOST:?required}"]\n'
      );
    };
    const envFile = join(f.project, "hack.env.default.yaml");
    for (const mode of ["running", "deleted", "missing", "removed"] as const) {
      await configure(false);
      await Bun.write(
        envFile,
        "version: 1\nenvironment: default\nsecretsprovider: project_key\nvalues:\n  global:\n    X_HOST: live.example.test\n    DOCKER_HOST: tcp://fake-daemon:2375\n    COMPOSE_PROFILES: test\n"
      );
      const start = await f.cli(["up", "-d", "--use", "db=x"]);
      expect(start.code, start.stdout + start.stderr).toBe(0);
      await rm(join(f.project, ".internal", "runtime-state.json"), {
        force: true,
      });
      await configure(mode === "deleted", true);
      await Bun.write(join(f.project, ".internal", "use.json"), '{"db":"y"}\n');
      if (mode === "missing") {
        await Bun.write(
          envFile,
          "version: 1\nenvironment: default\nsecretsprovider: project_key\nvalues:\n  global:\n    DOCKER_HOST: tcp://fake-daemon:2375\n    COMPOSE_PROFILES: test\n"
        );
      }
      if (mode === "removed") {
        await Bun.write(
          join(f.project, "hack.config.json"),
          JSON.stringify({
            name: "remote-fixture",
            lifecycle: {
              down: {
                before: [
                  {
                    name: "remote",
                    command:
                      'printf "%s\\n" "${DB_HOST:-absent}" > "$TEST_CONTROL/hook"',
                  },
                ],
              },
            },
          })
        );
      }
      if (mode === "running" || mode === "deleted") {
        const status = await f.cli(["ps", "--json"]);
        expect(status.code, status.stderr).toBe(0);
        const { remotes } = JSON.parse(status.stdout);
        expect(remotes[0].target).toBe(mode === "running" ? "x" : "unknown");
        expect(status.stdout).not.toContain("live.example.test");
        expect(status.stderr).toBe("");
      }
      if (mode !== "removed") {
        for (const args of [
          ["restart"],
          ["restart", "api"],
          ["up", "-d", "api"],
          ["run", "api", "true"],
        ]) {
          await Bun.write(join(f.control, "calls"), "");
          const refused = await f.cli(args);
          expect(refused.code).not.toBe(0);
          expect(refused.stderr).toContain("E_INVALID_REMOTE");
          expect(refused.stderr).toContain("hack up --detach");
          expect(await Bun.file(join(f.control, "calls")).text()).toBe("");
        }
      }
      if (mode === "missing") {
        const refused = await f.cli(["down"], root, {
          TEST_FOREIGN_PEER: "1",
        });
        expect(refused.code).not.toBe(0);
        expect(await Bun.file(join(f.control, "engine.json")).exists()).toBe(
          true
        );
      }
      await Bun.write(join(f.control, "down"), "");
      const result = await f.cli(["down"], root, {
        TEST_FOREIGN_PEER: "oneoff",
      });
      expect(result.code, result.stdout + result.stderr).toBe(0);
      expect(await Bun.file(join(f.control, "hook")).text()).toBe(
        mode === "running" ? "live.example.test\n" : "absent\n"
      );
      const teardown = JSON.parse(
        (await Bun.file(join(f.control, "down")).text()).trim()
      );
      expect(teardown.daemon).toBe("tcp://fake-daemon:2375");
      expect(teardown.profiles).toBe("test");
      expect(teardown.db).toBe(mode === "running" ? "live.example.test" : null);
      if (mode !== "running") {
        expect(teardown.networks).toEqual({
          default: { name: "remote-fixture_default" },
        });
        expect(teardown.files).toHaveLength(1);
        expect(teardown.files[0]).toMatch(
          /compose\.remote-recovery\.[0-9a-f]{64}\.json$/
        );
      }
      expect(await Bun.file(join(f.control, "engine.json")).exists()).toBe(
        false
      );
      const repeated = await f.cli(["down"]);
      expect(repeated.code, repeated.stderr).toBe(0);
    }
  } finally {
    await rm(f.path, { recursive: true });
  }
}, 120_000);
