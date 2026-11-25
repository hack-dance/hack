import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

const CLI = resolve(import.meta.dir, "..", "index.ts");

/**
 * Stub `docker` that logs each call. `inspect` reports the global proxy
 * containers at STUB_CADDY_IP (default 172.30.0.2) and 172.30.0.53;
 * `compose ps` reports `api` running unless STUB_API_STOPPED=1; `compose
 * exec` into a stopped service exits 1 as Compose does; `compose run` fails
 * with 7 when STUB_RUN_FAIL=1; STUB_GLOBAL_GONE=1 removes both containers.
 */
const STUB = `#!/bin/sh
dir="$(dirname "$0")"
printf '%s\\n' "$*" >> "$dir/calls.log"
case " $* " in
  *" inspect "*)
    if [ "\${STUB_GLOBAL_GONE:-}" = "1" ]; then
      echo 'Error response from daemon: No such container: hack-dev-proxy-coredns-1' >&2
      exit 1
    fi
    printf 'hack-dev-proxy\\tcoredns\\ttrue\\tid-dns\\t2026-11-20T00:00:00Z\\t{"hack-dev":{"IPAddress":"172.30.0.53"}}\\n'
    printf 'hack-dev-proxy\\tcaddy\\ttrue\\tid-caddy\\t2026-11-20T00:00:00Z\\t{"hack-dev":{"IPAddress":"%s"}}\\n' "\${STUB_CADDY_IP:-172.30.0.2}"
    exit 1 ;;
  *" ps "*)
    if [ "\${STUB_API_STOPPED:-}" = "1" ]; then exit 0; fi
    printf '{"ID":"c1","Service":"api","Name":"shop-api-1","State":"running","Status":"Up","ExitCode":0,"Labels":"com.docker.compose.project.working_dir=%s"}\\n' "$PWD"
    exit 0 ;;
  *" exec "*)
    if [ "\${STUB_API_STOPPED:-}" = "1" ]; then
      echo 'service "api" is not running' >&2
      exit 1
    fi
    exit 0 ;;
  *" run "*)
    if [ "\${STUB_RUN_FAIL:-}" = "1" ]; then exit 7; fi
    exit 0 ;;
  *) exit 0 ;;
esac
`;

let root = "";
let project = "";
let bin = "";
let hackHome = "";

beforeEach(async () => {
  // Resolved once: on macOS the temp directory is behind a symlink
  // (/var -> /private/var), and the CLI passes real paths.
  root = await realpath(await mkdtemp(join(tmpdir(), "hack-exec-run-probes-")));
  project = join(root, "project");
  bin = join(root, "bin");
  hackHome = join(root, "hack-home");
  const hack = join(project, ".hack");
  await mkdir(hack, { recursive: true });
  await mkdir(bin);
  await mkdir(join(hackHome, "caddy"), { recursive: true });
  await writeFile(
    join(hackHome, "caddy", "docker-compose.yml"),
    "services: {}\n"
  );
  await writeFile(join(bin, "docker"), STUB);
  await chmod(join(bin, "docker"), 0o755);
  await writeFile(
    join(hack, "hack.config.json"),
    JSON.stringify({ name: "shop", dev_host: "shop.hack" })
  );
  await writeFile(
    join(hack, "docker-compose.yml"),
    [
      "name: shop",
      "services:",
      "  api:",
      "    image: alpine:3.22",
      "    labels:",
      "      caddy: api.shop.hack",
      "    networks: [hack-dev, default]",
      "networks:",
      "  hack-dev:",
      "    external: true",
      "",
    ].join("\n")
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

type CliResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** `inspect --type`, `compose <verb>`, … in call order. */
  readonly calls: string[];
  /** Full argv lines as logged. */
  readonly raw: string[];
};

async function cli(
  args: readonly string[],
  extra: Record<string, string> = {}
): Promise<CliResult> {
  await rm(join(bin, "calls.log"), { force: true });
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: project,
    env: privateCliEnv({
      root,
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HACK_HOME: hackHome,
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
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  const log = await readFile(join(bin, "calls.log"), "utf8").catch(() => "");
  const raw = log.split("\n").filter((entry) => entry.length > 0);
  const calls = raw.map((entry) =>
    entry.startsWith("compose ")
      ? composeVerb(entry)
      : entry.split(" ").slice(0, 2).join(" ")
  );
  return { exitCode, stdout, stderr, calls, raw };
}

const COMPOSE_OPTIONS_WITH_VALUE = new Set([
  "-f",
  "-p",
  "--profile",
  "--project-directory",
]);

/** `compose -p x --project-directory d -f a … <verb> …` → `compose <verb>`. */
function composeVerb(entry: string): string {
  const words = entry.split(" ");
  let i = 1;
  while (COMPOSE_OPTIONS_WITH_VALUE.has(words[i] ?? "")) {
    i += 2;
  }
  return `compose ${words[i] ?? ""}`;
}

/** Every file under the project with its size and modification time. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of await readdir(dir, { recursive: true })) {
    const info = await stat(join(dir, name));
    if (info.isFile()) {
      out[name] = `${info.size}:${info.mtimeMs}`;
    }
  }
  return out;
}

const RECORD = () => join(hackHome, "caddy", "ingress-addresses.json");
const LEGACY = () =>
  join(project, ".hack", ".internal", "compose.override.yml");

async function storedOverrides(): Promise<string[]> {
  const base = join(hackHome, "compose-overrides");
  const dirs = await readdir(base).catch(() => [] as string[]);
  const out: string[] = [];
  for (const dir of dirs) {
    for (const name of await readdir(join(base, dir))) {
      out.push(join(base, dir, name));
    }
  }
  return out;
}

test("run reads Docker once with no record, then never; the override lives in Hack's home", async () => {
  const first = await cli(["run", "api", "--", "true"]);
  expect(first.exitCode).toBe(0);
  // One inspect replaces the two `compose ps -q` + `inspect` pairs.
  expect(first.calls).toEqual(["inspect --type", "compose ps", "compose run"]);
  const record = JSON.parse(await readFile(RECORD(), "utf8"));
  expect(record).toMatchObject({
    coreDns: "172.30.0.53",
    caddy: "172.30.0.2",
    containers: { caddy: { id: "id-caddy" } },
  });
  const stored = await storedOverrides();
  expect(stored).toHaveLength(1);
  expect(stored[0]).toEndWith("@base.yml");
  for (const path of [
    stored[0] ?? "",
    dirname(stored[0] ?? ""),
    join(hackHome, "compose-overrides"),
  ]) {
    expect((await stat(path)).mode & 0o077).toBe(0);
  }
  expect(await readFile(stored[0] ?? "", "utf8")).toContain("172.30.0.53");
  expect(await Bun.file(LEGACY()).exists()).toBe(false);
  // Compose gets the stored file by absolute path and an explicit project directory.
  const runArgv = first.raw.find((entry) => entry.includes(" run "));
  expect(runArgv).toContain(`-f ${stored[0]}`);
  expect(runArgv).toContain(`--project-directory ${join(project, ".hack")}`);

  const second = await cli(["run", "api", "--", "true"]);
  expect(second.exitCode).toBe(0);
  expect(second.calls).toEqual(["compose ps", "compose run"]);
});

test("a run against another Docker engine reads that engine instead of the record", async () => {
  expect((await cli(["run", "api", "--", "true"])).exitCode).toBe(0);
  const other = await cli(["run", "api", "--", "true"], {
    DOCKER_HOST: "tcp://127.0.0.1:2399",
    STUB_CADDY_IP: "172.30.0.9",
  });
  expect(other.exitCode).toBe(0);
  expect(other.calls).toEqual(["inspect --type", "compose ps", "compose run"]);
  const record = JSON.parse(await readFile(RECORD(), "utf8"));
  expect(record).toMatchObject({
    engine: "host:tcp://127.0.0.1:2399",
    caddy: "172.30.0.9",
  });
  // Back on the first engine: its addresses are read again, not reused.
  const back = await cli(["run", "api", "--", "true"]);
  expect(back.calls).toEqual(["inspect --type", "compose ps", "compose run"]);
});

test("after up, exec and run write nothing inside the project", async () => {
  const up = await cli(["up", "-d"]);
  expect(up.exitCode).toBe(0);
  const before = await snapshot(project);

  const exec = await cli(["exec", "api", "--", "true"]);
  expect(exec.exitCode).toBe(0);
  expect(exec.calls).toEqual(["compose exec"]);
  const run = await cli(["run", "api", "--", "true"]);
  expect(run.exitCode).toBe(0);
  expect(run.calls).toEqual(["compose ps", "compose run"]);

  // Every file, including any new one.
  expect(await snapshot(project)).toEqual(before);
});

test("branch exec passes the branch's generated files and generates none", async () => {
  const up = await cli(["up", "-d", "--branch", "feat"]);
  expect(up.exitCode).toBe(0);
  const before = await snapshot(project);
  const exec = await cli(["exec", "--branch", "feat", "api", "--", "true"]);
  expect(exec.exitCode).toBe(0);
  expect(exec.calls).toEqual(["compose exec"]);
  const argv = exec.raw[0] ?? "";
  expect(argv).toContain("-p shop--feat");
  expect(argv).toContain(".branch/compose.feat.override.yml");
  expect(argv).toContain("feat.yml");
  const after = await snapshot(project);
  // Only the branch usage record may change (it marks the branch in use).
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!name.endsWith("branch-usage.json")) {
      expect([name, after[name]]).toEqual([name, before[name]]);
    }
  }
});

test("exec regenerates the overrides when they name a service the Compose file dropped", async () => {
  const composeFile = join(project, ".hack", "docker-compose.yml");
  const original = await readFile(composeFile, "utf8");
  await writeFile(
    composeFile,
    original.replace(
      "networks:\n  hack-dev:",
      "  worker:\n    image: alpine:3.22\n    networks: [hack-dev, default]\nnetworks:\n  hack-dev:"
    )
  );
  // A global managed value: `up` then also writes an env override for every
  // service, which exec reuses.
  await writeFile(
    join(project, ".hack", "hack.env.default.yaml"),
    'version: 1\nenvironment: default\nsecretsprovider: project_key\nvalues:\n  global:\n    FLAG: "on"\n'
  );
  const envOverride = join(
    project,
    ".hack",
    ".internal",
    "compose.env.override.yml"
  );
  const up = await cli(["up", "-d"]);
  expect(up.exitCode).toBe(0);
  const stored = await storedOverrides();
  expect(stored.length).toBeGreaterThan(0);
  expect(await readFile(stored[0] ?? "", "utf8")).toContain("worker:");
  expect(await readFile(envOverride, "utf8")).toContain("worker:");

  // worker is removed after up: a stored file still declaring it would make
  // Compose reject the model (no image or build) for every service.
  await writeFile(composeFile, original);
  const exec = await cli(["exec", "api", "--", "true"]);
  expect(exec.exitCode).toBe(0);
  expect(exec.calls).toEqual(["compose exec"]);
  const files = [...(exec.raw[0] ?? "").matchAll(/-f (\S+)/g)].map(
    (m) => m[1] ?? ""
  );
  expect(files.length).toBeGreaterThan(1);
  for (const file of files) {
    expect([file, await readFile(file, "utf8")]).not.toEqual([
      file,
      expect.stringContaining("worker:"),
    ]);
  }
  expect(files).not.toContain(envOverride);

  // Once `up` rendered them against the current file, exec reuses them all.
  expect((await cli(["up", "-d"])).exitCode).toBe(0);
  const again = await cli(["exec", "api", "--", "true"]);
  expect(again.exitCode).toBe(0);
  expect(again.raw[0] ?? "").toContain(envOverride);
});

test("one project reached through a symlink and through its real path keeps one override", async () => {
  const link = join(root, "link-to-project");
  await symlink(project, link);

  // Started through the symlinked path, used from the real path.
  expect((await cli(["up", "-d", "--path", link])).exitCode).toBe(0);
  const afterUp = await storedOverrides();
  expect(afterUp).toHaveLength(1);
  const exec = await cli(["exec", "api", "--", "true"]);
  expect(exec.exitCode).toBe(0);
  expect(exec.raw[0] ?? "").toContain(afterUp[0] ?? "<none>");

  // And the other way round: a run from the real path, an exec through the link.
  expect((await cli(["run", "api", "--", "true"])).exitCode).toBe(0);
  const viaLink = await cli(["exec", "--path", link, "api", "--", "true"]);
  expect(viaLink.exitCode).toBe(0);
  expect(await storedOverrides()).toEqual(afterUp);
  expect(viaLink.raw[0] ?? "").toContain(afterUp[0] ?? "<none>");
});

test("exec with nothing generated yet reads and writes no override", async () => {
  const result = await cli(["exec", "api", "--", "true"]);
  expect(result.exitCode).toBe(0);
  expect(result.calls).toEqual(["compose exec"]);
  expect(await storedOverrides()).toEqual([]);
  expect(await Bun.file(RECORD()).exists()).toBe(false);
  expect(await Bun.file(LEGACY()).exists()).toBe(false);
});

test("exec still passes the in-project override an older Hack wrote", async () => {
  await mkdir(join(project, ".hack", ".internal"), { recursive: true });
  await writeFile(LEGACY(), "services:\n  api:\n    dns: [172.30.0.53]\n");
  const result = await cli(["exec", "api", "--", "true"]);
  expect(result.exitCode).toBe(0);
  expect(result.calls).toEqual(["compose exec"]);
  expect(result.raw[0]).toContain(`-f ${LEGACY()}`);
});

test("exec into a stopped service still names hack up -d and hack run", async () => {
  const result = await cli(["exec", "api", "--", "true"], {
    STUB_API_STOPPED: "1",
  });
  expect(result.exitCode).toBe(1);
  expect(result.calls).toEqual(["compose exec", "compose ps"]);
  expect(result.stderr).toContain('Service "api" is not running.');
  expect(result.stderr).toContain("hack up -d");
});

test("a failed run with a stale record refreshes the override and does not run again", async () => {
  await cli(["run", "api", "--", "true"]);
  // The proxy came back with a new address outside Hack.
  const result = await cli(["run", "api", "--", "false"], {
    STUB_CADDY_IP: "172.30.0.9",
    STUB_RUN_FAIL: "1",
  });
  expect(result.exitCode).toBe(7);
  expect(result.calls).toEqual(["compose ps", "compose run", "inspect --type"]);
  expect(result.stderr).toContain("address changed");
  const [stored] = await storedOverrides();
  expect(await readFile(stored ?? "", "utf8")).toContain("172.30.0.9");
  expect(JSON.parse(await readFile(RECORD(), "utf8")).caddy).toBe("172.30.0.9");

  // The next run uses the refreshed addresses with no Docker read.
  const next = await cli(["run", "api", "--", "true"], {
    STUB_CADDY_IP: "172.30.0.9",
  });
  expect(next.calls).toEqual(["compose ps", "compose run"]);
});

test("a failed run with unchanged addresses only returns its exit code", async () => {
  await cli(["run", "api", "--", "true"]);
  const result = await cli(["run", "api", "--", "false"], {
    STUB_RUN_FAIL: "1",
  });
  expect(result.exitCode).toBe(7);
  expect(result.calls).toEqual(["compose ps", "compose run", "inspect --type"]);
  expect(result.stderr).not.toContain("address changed");
});

test("a failed run after the global stack went away drops the stored override and the record", async () => {
  // No CA and no extra hosts: with no addresses the instance needs no override.
  await cli(["run", "api", "--", "true"]);
  expect(await storedOverrides()).toHaveLength(1);
  const result = await cli(["run", "api", "--", "false"], {
    STUB_GLOBAL_GONE: "1",
    STUB_RUN_FAIL: "1",
  });
  expect(result.exitCode).toBe(7);
  expect(await storedOverrides()).toEqual([]);
  expect(await Bun.file(RECORD()).exists()).toBe(false);
  expect(result.stderr).toContain("address changed");
});

test("HACK_COREDNS_IP and HACK_CADDY_IP still skip every Docker read", async () => {
  const result = await cli(["run", "api", "--", "true"], {
    HACK_COREDNS_IP: "10.9.0.53",
    HACK_CADDY_IP: "10.9.0.2",
  });
  expect(result.exitCode).toBe(0);
  expect(result.calls).toEqual(["compose ps", "compose run"]);
  const [stored] = await storedOverrides();
  expect(await readFile(stored ?? "", "utf8")).toContain("10.9.0.53");
});

test("after hack global down the record is no longer trusted", async () => {
  await cli(["run", "api", "--", "true"]);
  const trusted = await cli(["run", "api", "--", "true"]);
  expect(trusted.calls).toEqual(["compose ps", "compose run"]);
  const tokenFile = join(hackHome, "caddy", "ingress-generation.json");
  const down = await cli(["global", "down"]);
  expect(down.exitCode).toBe(0);
  expect(JSON.parse(await readFile(tokenFile, "utf8"))).toMatchObject({
    settled: true,
  });
  // The token changed: the next run reads Docker once and records again.
  const next = await cli(["run", "api", "--", "true"]);
  expect(next.calls).toEqual(["inspect --type", "compose ps", "compose run"]);
});

test("exec does not rewrite the env override when env config changed after up", async () => {
  const envFile = join(project, ".hack", "hack.env.default.yaml");
  await writeFile(
    envFile,
    "version: 1\nsecretsprovider: project_key\nvalues:\n  global:\n    GREETING: hello\n"
  );
  const up = await cli(["up", "-d"]);
  expect(up.exitCode).toBe(0);
  const envOverride = join(
    project,
    ".hack",
    ".internal",
    "compose.env.override.yml"
  );
  const written = await readFile(envOverride, "utf8");
  expect(written).toContain("GREETING");

  await writeFile(
    envFile,
    "version: 1\nsecretsprovider: project_key\nvalues:\n  global:\n    GREETING: hello\n    FAREWELL: bye\n"
  );
  const before = await snapshot(project);
  const exec = await cli(["exec", "api", "--", "true"]);
  expect(exec.exitCode).toBe(0);
  expect(exec.raw[0]).toContain(`-f ${envOverride}`);
  expect(await snapshot(project)).toEqual(before);
  expect(await readFile(envOverride, "utf8")).toBe(written);
});

test("the in-project override of an older Hack stops being used once this version renders", async () => {
  await mkdir(join(project, ".hack", ".internal"), { recursive: true });
  await writeFile(LEGACY(), "services:\n  api:\n    dns: [172.30.0.53]\n");
  // Internal DNS and TLS off: this version renders no internal override.
  await writeFile(
    join(project, ".hack", "hack.config.json"),
    JSON.stringify({
      name: "shop",
      dev_host: "shop.hack",
      internal: { dns: false, tls: false },
    })
  );
  const up = await cli(["up", "-d"]);
  expect(up.exitCode).toBe(0);
  expect(await Bun.file(LEGACY()).exists()).toBe(false);
  const exec = await cli(["exec", "api", "--", "true"]);
  expect(exec.raw[0]).not.toContain("compose.override.yml");
});

test("a failed refresh after a failed run keeps the run's exit code", async () => {
  await cli(["run", "api", "--", "true"]);
  // The record can no longer be replaced: its folder refuses writes.
  await chmod(join(hackHome, "caddy"), 0o500);
  try {
    const result = await cli(["run", "api", "--", "false"], {
      STUB_CADDY_IP: "172.30.0.9",
      STUB_RUN_FAIL: "1",
    });
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain(
      "could not check the recorded proxy and DNS addresses"
    );
    expect(result.stdout).not.toContain("could not check");
  } finally {
    await chmod(join(hackHome, "caddy"), 0o700);
  }
});
