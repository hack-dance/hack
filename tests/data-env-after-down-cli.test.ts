import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * The reviewer's sequence, through the real CLI: `hack up --env staging`,
 * `hack down`, then a bare `hack data export`. A successful down removes the
 * instance's recorded env selection, so the export cannot know that staging
 * made the volumes: with overlays it must refuse with E_USAGE before any
 * Docker call instead of exporting the default overlay's volumes. A stub
 * `docker` stands in for the engine and logs every call.
 */
const CLI = resolve(import.meta.dir, "..", "index.ts");

const STUB = [
  "#!/bin/sh",
  'printf "%s\\n" "$*" >> "$STUB_LOG"',
  'if [ "$1" = "compose" ]; then',
  '  marker="$(dirname "$0")/.compose-down"',
  '  case " $* " in',
  '    *" down "*) : > "$marker"; exit 0 ;;',
  '    *" up "*) rm -f "$marker"; exit 0 ;;',
  '    *" ps "*)',
  '      if [ -f "$marker" ]; then exit 0; fi',
  // Compose labels each container with its project directory; `up`
  // refuses containers that do not carry this checkout's.
  '      printf \'{"ID":"fixture-web","Service":"web","State":"running","ExitCode":0,"Labels":"com.docker.compose.project.working_dir=%s"}\\n\' "$STUB_WORKDIR"',
  "      exit 0",
  "      ;;",
  // `hack data export` reads the model next: fail it, so the test sees
  // that export got past the env selection without needing an engine.
  '    *" config "*) echo "stub: no engine" >&2; exit 3 ;;',
  "    *) exit 0 ;;",
  "  esac",
  "fi",
  "exit 0",
  "",
].join("\n");

let root: string;
let projectRoot: string;
let log: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "hack-data-env-down-")));
  projectRoot = join(root, "project");
  log = join(root, "docker.log");
  const hackDir = join(projectRoot, ".hack");
  await mkdir(hackDir, { recursive: true });
  await mkdir(join(root, "bin"));
  await writeFile(join(root, "bin", "docker"), STUB);
  await chmod(join(root, "bin", "docker"), 0o755);
  await writeFile(log, "");
  await writeFile(
    join(hackDir, "hack.config.json"),
    `${JSON.stringify({
      name: "envshop",
      dev_host: "envshop.hack",
      internal: { dns: false, tls: false },
      logs: { follow_backend: "compose", snapshot_backend: "compose" },
    })}\n`
  );
  await writeFile(
    join(hackDir, "docker-compose.yml"),
    [
      "services:",
      "  web:",
      "    image: alpine:3.22",
      "    volumes: [data:/data]",
      "volumes:",
      "  data:",
      "    name: envshop_data-${VOL_SUFFIX}",
      "",
    ].join("\n")
  );
  for (const [env, suffix] of [
    ["default", "base"],
    ["staging", "staging"],
  ] as const) {
    await writeFile(
      join(hackDir, `hack.env.${env}.yaml`),
      [
        "version: 1",
        `environment: ${env}`,
        "secretsprovider: project_key",
        "values:",
        "  global:",
        `    VOL_SUFFIX: "${suffix}"`,
        "",
      ].join("\n")
    );
  }
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function hack(args: readonly string[]) {
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: projectRoot,
    env: privateCliEnv({
      root,
      env: {
        PATH: `${join(root, "bin")}:/usr/bin:/bin`,
        HACK_NO_INTERACTIVE: "1",
        STUB_LOG: log,
        STUB_WORKDIR: join(projectRoot, ".hack"),
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

const configCalls = async (): Promise<string[]> =>
  (await readFile(log, "utf8"))
    .split("\n")
    .filter((line) => / config( |$)/.test(line));

test("hack up --env staging, hack down, then a bare hack data export refuses with E_USAGE before any Docker call", async () => {
  expect((await hack(["up", "--env", "staging", "--json"])).exitCode).toBe(0);

  // While the instance's selection is recorded, export uses it: it gets
  // past the env selection to the Compose model read (which the stub fails).
  const recorded = await hack(["data", "export", "--json"]);
  expect(recorded.exitCode).not.toBe(0);
  expect(recorded.stdout).not.toContain("E_USAGE");
  expect(await configCalls()).toHaveLength(1);

  expect((await hack(["down", "--json"])).exitCode).toBe(0);

  // Down removed the record: the bare export cannot tell staging made the
  // volumes, so it refuses, naming the overlays, and runs no Docker call.
  await writeFile(log, "");
  for (const json of [true, false]) {
    const bare = await hack(["data", "export", ...(json ? ["--json"] : [])]);
    expect(bare.exitCode).not.toBe(0);
    const output = `${bare.stdout}\n${bare.stderr}`;
    expect(output).toContain("E_USAGE");
    expect(output).toContain(
      "This project has environment overlays (staging); the environment `hack up` used is no longer recorded. Pass --env <name> (or --env base for base layers only)."
    );
  }
  expect(await readFile(log, "utf8")).toBe("");

  // An explicit selection still runs.
  const explicit = await hack(["data", "export", "--env", "staging", "--json"]);
  expect(explicit.stdout).not.toContain("E_USAGE");
  expect(await configCalls()).toHaveLength(1);
});

test("a dotenv-overlay-only project: hack up --env staging, hack down, then a bare export refuses", async () => {
  const hackDir = join(projectRoot, ".hack");
  for (const env of ["default", "staging"]) {
    await rm(join(hackDir, `hack.env.${env}.yaml`));
  }
  await writeFile(
    join(hackDir, "hack.env.json"),
    `${JSON.stringify({
      version: 1,
      vars: [{ key: "VOL_SUFFIX", source: "plain_env", required: false }],
    })}\n`
  );
  await writeFile(join(hackDir, ".env"), "VOL_SUFFIX=base\n");
  await writeFile(join(hackDir, ".env.staging"), "VOL_SUFFIX=staging\n");

  const up = await hack(["up", "--env", "staging", "--json"]);
  expect({ exitCode: up.exitCode, stderr: up.stderr }).toMatchObject({
    exitCode: 0,
  });
  // Recorded: export uses staging and gets to the model read.
  const recorded = await hack(["data", "export", "--json"]);
  expect(recorded.stdout).not.toContain("E_USAGE");
  expect(await configCalls()).toHaveLength(1);

  expect((await hack(["down", "--json"])).exitCode).toBe(0);
  await writeFile(log, "");
  const bare = await hack(["data", "export", "--json"]);
  expect(bare.exitCode).not.toBe(0);
  expect(bare.stdout).toContain("E_USAGE");
  expect(bare.stdout).toContain(
    "This project has environment overlays (staging); the environment `hack up` used is no longer recorded."
  );
  expect(await readFile(log, "utf8")).toBe("");
});
