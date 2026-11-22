import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { HACK_VERSION } from "../src/lib/hack-version.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

const root = resolve(import.meta.dir, "..");
const neutralityBase = "3f2f00e1b8b2bb0fe26cadf47369dbc75e693001";
const fixtureEngine = `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import YAML from ${JSON.stringify(resolve(root, "node_modules/yaml/dist/index.js"))};
const argv = Bun.argv.slice(2);
const control = process.env.TEST_CONTROL;
const state = control + "/engine.json";
const files = argv.flatMap((arg, i) => arg === "-f" ? [argv[i+1]] : []);
const generated = files.filter((file) => file.includes("/.internal/") || file.includes("/.branch/"))
  .map((file) => existsSync(file) ? readFileSync(file, "utf8") : null);
appendFileSync(control + "/calls", JSON.stringify({argv, envNames: Object.keys(process.env).sort(), generated}) + "\\n");
const command = ["up", "down", "exec", "run", "logs", "ps", "config"].find((name) => argv.includes(name));
const requiresRemote = files.some((file) => existsSync(file) && readFileSync(file, "utf8").includes("DB_HOST:?required"));
if (requiresRemote && ["up", "down", "config"].includes(command) && !process.env.DB_HOST) {
  console.error("required interpolation unavailable");
  process.exit(1);
}
const row = existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : null;
if (argv.includes("version")) { console.log("2.24.4"); }
else if (argv[0] === "network" && argv.includes("inspect")) { console.log("[]"); }
else if (command === "config") {
  console.log(argv.includes("--services") ? "api" : JSON.stringify({ services: {api: {image: "alpine"}} }));
} else if (command === "up") {
  if (!argv.includes("--no-start")) {
    const override = files.find((file) => file.endsWith("compose.remote.override.yml"));
    const labels = override ? YAML.parse(readFileSync(override, "utf8")).services.api.labels : {};
    writeFileSync(state, JSON.stringify({
      ID: "a".repeat(64), Service: "api", State: "running", ExitCode: 0, Project: "remote-fixture",
      Labels: Object.entries({"com.docker.compose.project":"remote-fixture","com.docker.compose.service":"api","com.docker.compose.project.working_dir":process.cwd(), ...labels}).map(([k,v])=>k+"="+v).join(",")
    }));
  }
} else if (command === "ps") {
  if (row) console.log(JSON.stringify(row));
  if (process.env.TEST_FOREIGN_PEER === "1" && argv.some((arg) => arg.startsWith("label=com.docker.compose.project="))) {
    console.log(JSON.stringify({ ...row, ID: "b".repeat(64), Labels: "com.docker.compose.project=remote-fixture,com.docker.compose.service=foreign" }));
  }
} else if (command === "down") {
  appendFileSync(control + "/down", JSON.stringify({db: process.env.DB_HOST ?? null, files}) + "\\n");
  rmSync(state, {force: true});
}
`;

async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "hack-remote-recovery-"));
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
    extra?: Record<string, string>
  ) => {
    const child = Bun.spawn(
      [process.execPath, join(cliRoot, "index.ts"), ...args],
      {
        cwd: repo,
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
  return { path, project, control, cli, configure };
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
          ["logs", "--compose"],
          ["exec", "api", "true"],
          ["run", "api", "true"],
          ["down"],
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
          traces.push(calls);
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
    for (const mode of ["running", "deleted", "missing"] as const) {
      await configure(false);
      await Bun.write(
        envFile,
        "version: 1\nenvironment: default\nsecretsprovider: project_key\nvalues:\n  global:\n    X_HOST: live.example.test\n"
      );
      const start = await f.cli(["up", "-d", "--use", "db=x"]);
      expect(start.code, start.stdout + start.stderr).toBe(0);
      await rm(join(f.project, ".internal", "runtime-state.json"), {
        force: true,
      });
      await configure(mode === "deleted", true);
      await Bun.write(join(f.project, ".internal", "use.json"), '{"db":"y"}\n');
      if (mode === "missing") {
        await rm(envFile);
      }
      const restart = await f.cli(["restart"], root, {
        TEST_STOP_AFTER_HOOK: "1",
      });
      expect(restart.code, restart.stdout + restart.stderr).toBe(17);
      expect(await Bun.file(join(f.control, "hook")).text()).toBe(
        mode === "running" ? "live.example.test\n" : "absent\n"
      );
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
      const result = await f.cli(["down"]);
      expect(result.code, result.stdout + result.stderr).toBe(0);
      expect(await Bun.file(join(f.control, "hook")).text()).toBe(
        mode === "running" ? "live.example.test\n" : "absent\n"
      );
      const teardown = JSON.parse(
        (await Bun.file(join(f.control, "down")).text()).trim()
      );
      expect(teardown.db).toBe(mode === "running" ? "live.example.test" : null);
      if (mode !== "running") {
        expect(teardown.files).toEqual([
          join(f.project, ".internal", "compose.remote-recovery.json"),
        ]);
      }
      expect(await Bun.file(join(f.control, "engine.json")).exists()).toBe(
        false
      );
    }
  } finally {
    await rm(f.path, { recursive: true });
  }
}, 60_000);
