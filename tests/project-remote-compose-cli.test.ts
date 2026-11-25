import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { HACK_VERSION } from "../src/lib/hack-version.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

const root = resolve(import.meta.dir, "..");
const requiredInterpolation = /\$\{([A-Za-z_][A-Za-z0-9_]*):?\?[^}]*\}/g;
const fixtureEngine = `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import YAML from ${JSON.stringify(resolve(root, "node_modules/yaml/dist/index.js"))};
const argv = Bun.argv.slice(2);
const control = join(dirname(dirname(Bun.argv[1])), "control");
const state = control + "/engine.json";
const files = argv.flatMap((arg, i) => arg === "-f" ? [argv[i+1]] : []);
appendFileSync(control + "/calls", JSON.stringify(argv) + "\\n");
const command = ["up", "down", "exec", "run", "logs", "ps", "config"].find((name) => argv.includes(name));
const dotenv = files[0] && join(dirname(files[0]), ".env");
const fileEnv = dotenv && existsSync(dotenv)
  ? Object.fromEntries(readFileSync(dotenv, "utf8").trim().split("\\n").map((line) => line.split("=")))
  : {};
const required = files.flatMap((file) => existsSync(file)
  ? [...readFileSync(file, "utf8").matchAll(${requiredInterpolation})]
  : []).find((match) => !(process.env[match[1]] ?? fileEnv[match[1]]));
if (required) {
  console.error("required variable " + required[1] + " is missing a value: required");
  process.exit(1);
}
const row = existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : null;
if (argv.includes("version")) { console.log("2.24.4"); }
else if (argv[0] === "network" && argv.includes("inspect")) { console.log("[]"); }
else if (command === "config") {
  console.log(argv.includes("--services") ? "api" : JSON.stringify({ services: {api: {image: "alpine"}} }));
} else if (command === "up") {
  if (!argv.includes("--no-start")) {
    const override = files.find((file) => file.includes("/compose.remote.override."));
    const service = override ? YAML.parse(readFileSync(override, "utf8")).services.api : {};
    const containerEnv = Object.fromEntries(Object.entries(service.environment ?? {})
      .map(([name, ref]) => [name, process.env[ref.slice(2, -1)]]));
    writeFileSync(join(control, "delivery"), JSON.stringify({
      host: [process.env.DOCKER_HOST ?? null, process.env.COMPOSE_PROJECT_NAME ?? null, process.env.PATH],
      container: containerEnv,
    }));
    const labels = service.labels ?? {};
    writeFileSync(state, JSON.stringify({
      ID: "a".repeat(64), Service: "api", State: "running", ExitCode: 0, Project: "remote-fixture",
      Labels: Object.entries({"com.docker.compose.project":"remote-fixture","com.docker.compose.service":"api","com.docker.compose.project.working_dir":process.cwd(), ...labels}).map(([k,v])=>k+"="+v).join(",")
    }));
  }
} else if (command === "ps") {
  if (process.env.TEST_FAIL_PS === "1") process.exit(19);
  if (row) console.log(JSON.stringify(row));
} else if (command === "down") {
  if (process.env.TEST_FAIL_DOWN === "1") process.exit(19);
  appendFileSync(control + "/down", JSON.stringify({db: process.env.DB_HOST ?? null, daemon: process.env.DOCKER_HOST, files}) + "\\n");
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

test("up requires optional remote interpolation and down binds hooks from the started target", async () => {
  const f = await fixture();
  try {
    const composeFile = join(f.project, "docker-compose.yml");
    const compose = (operator: string, key = "DB_HOST") =>
      Bun.write(
        composeFile,
        `name: remote-fixture\nservices:\n  api:\n    image: alpine\n    environment: ["DB_HOST=\${${key}${operator}}"]\n`
      );
    const configure = (target: string, hostname = "live.example.test") =>
      f.configure({
        min_cli_version: HACK_VERSION,
        remotes: {
          db: {
            default: target,
            env: { DB_HOST: "{host}" },
            targets: {
              x: { hostname, port: 5432 },
              y: { hostname: "other.example.test", port: 5432 },
            },
          },
        },
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
      });
    await configure("x");
    for (const operator of [":?required", "?required"]) {
      await compose(operator);
      await Bun.write(join(f.control, "calls"), "");
      const refused = await f.cli(["up", "-d"]);
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain(
        "Compose requires remote binding DB_HOST"
      );
      expect(refused.stderr).toContain("${DB_HOST:-}");
      expect(await Bun.file(join(f.control, "engine.json")).exists()).toBe(
        false
      );
    }
    await compose(":-");
    const start = await f.cli(["up", "-d", "--use", "db=x"]);
    expect(start.code, start.stdout + start.stderr).toBe(0);
    await rm(join(f.project, ".internal", "runtime-state.json"), {
      force: true,
    });
    await configure("y");
    await compose(":-");
    await Bun.write(join(f.project, ".internal", "use.json"), '{"db":"y"}\n');
    const status = await f.cli(["ps", "--json"]);
    expect(status.code, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout).remotes[0].target).toBe("x");
    for (const args of [
      ["restart"],
      ["restart", "api"],
      ["up", "-d", "api"],
      ["run", "api", "true"],
    ]) {
      await Bun.write(join(f.control, "calls"), "");
      const refused = await f.cli(args);
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain("E_REMOTE_START_UNSUPPORTED");
      expect(await Bun.file(join(f.control, "calls")).text()).toBe("");
    }
    for (const args of [["logs"], ["exec", "api", "true"]]) {
      const result = await f.cli(args);
      expect(result.code, result.stderr).toBe(0);
    }
    await compose(":?required");
    const laterEdit = await f.cli(["down"]);
    expect(laterEdit.code).not.toBe(0);
    expect(await Bun.file(join(f.control, "engine.json")).exists()).toBe(true);
    await compose(":-");
    const down = await f.cli(["down"]);
    expect(down.code, down.stdout + down.stderr).toBe(0);
    expect(await Bun.file(join(f.control, "hook")).text()).toBe(
      "live.example.test\n"
    );
    expect(
      JSON.parse((await Bun.file(join(f.control, "down")).text()).trim())
    ).toMatchObject({
      db: null,
      files: [composeFile],
    });
    for (const mode of ["record", "changedLabel", "changedRecord"]) {
      await configure("x");
      // A real .env value removes the requirement for a remote-only interpolation.
      await Bun.write(
        join(f.project, ".env"),
        "DB_HOST=from-file.example.test\n"
      );
      await compose(":?required");
      const started = await f.cli(["up", "-d", "--use", "db=x"]);
      expect(started.code, started.stdout + started.stderr).toBe(0);
      if (mode !== "changedLabel") {
        const engine = Bun.file(join(f.control, "engine.json"));
        const row = await engine.json();
        const labels = row.Labels.split(",").filter(
          (label: string) => !label.startsWith("dev.hack.remote.")
        );
        await Bun.write(
          engine,
          JSON.stringify({ ...row, Labels: labels.join(",") })
        );
      }
      if (mode !== "record") {
        await configure("x", "changed.example.test");
        await compose(":?required");
      }
      const ended = await f.cli(["down"]);
      expect(ended.code, ended.stdout + ended.stderr).toBe(0);
      expect(await Bun.file(join(f.control, "hook")).text()).toBe(
        mode === "record" ? "live.example.test\n" : "absent\n"
      );
    }
    const stopped = await f.cli(["ps", "--json"]);
    expect(stopped.code, stopped.stderr).toBe(0);
    expect(JSON.parse(stopped.stdout).remotes[0].target).toBe("unknown");
  } finally {
    await rm(f.path, { recursive: true });
  }
}, 120_000);

test("remote control names reach containers without changing the Compose client", async () => {
  const f = await fixture();
  try {
    await f.configure({
      min_cli_version: HACK_VERSION,
      remotes: {
        db: {
          default: "qa",
          env: {
            DOCKER_HOST: "tcp://{host}:{port}",
            COMPOSE_PROJECT_NAME: "{host}",
            PATH: "/{host}",
          },
          targets: { qa: { hostname: "fixture-db", port: 5432 } },
        },
      },
    });
    const started = await f.cli(["up", "-d"]);
    expect(started.code, started.stdout + started.stderr).toBe(0);
    const delivery = await Bun.file(join(f.control, "delivery")).json();
    expect(delivery.host).toEqual([
      null,
      null,
      expect.stringContaining("/bin:"),
    ]);
    expect(delivery.container).toMatchObject({
      DOCKER_HOST: "tcp://fixture-db:5432",
      COMPOSE_PROJECT_NAME: "fixture-db",
      PATH: "/fixture-db",
    });
    const ended = await f.cli(["down"]);
    expect(ended.code, ended.stdout + ended.stderr).toBe(0);
  } finally {
    await rm(f.path, { recursive: true });
  }
}, 60_000);
