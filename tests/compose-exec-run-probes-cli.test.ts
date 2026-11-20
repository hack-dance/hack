import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

const CLI = resolve(import.meta.dir, "..", "index.ts");

/**
 * Stub `docker` that logs each call. `inspect` reports the global proxy
 * containers at STUB_CADDY_IP (default 172.30.0.2) and 172.30.0.53;
 * `compose ps` reports `api` running unless STUB_API_STOPPED=1; `compose
 * exec` into a stopped service exits 1 as Compose does; `compose run` fails
 * with 7 once when STUB_RUN_FAIL_ONCE=1, always when STUB_RUN_FAIL=1.
 */
const STUB = `#!/bin/sh
dir="$(dirname "$0")"
printf '%s\\n' "$*" >> "$dir/calls.log"
case " $* " in
  *" inspect "*)
    printf 'hack-dev-proxy\\tcoredns\\ttrue\\tid-dns\\t2026-11-20T00:00:00Z\\t{"hack-dev":{"IPAddress":"172.30.0.53"}}\\n'
    printf 'hack-dev-proxy\\tcaddy\\ttrue\\tid-caddy\\t2026-11-20T00:00:00Z\\t{"hack-dev":{"IPAddress":"%s"}}\\n' "\${STUB_CADDY_IP:-172.30.0.2}"
    exit 1 ;;
  *" ps "*)
    if [ "\${STUB_API_STOPPED:-}" = "1" ]; then exit 0; fi
    printf '%s\\n' '{"ID":"c1","Service":"api","Name":"shop-api-1","State":"running","Status":"Up","ExitCode":0}'
    exit 0 ;;
  *" exec "*)
    if [ "\${STUB_API_STOPPED:-}" = "1" ]; then
      echo 'service "api" is not running' >&2
      exit 1
    fi
    exit 0 ;;
  *" run "*)
    if [ "\${STUB_RUN_FAIL:-}" = "1" ]; then exit 7; fi
    if [ "\${STUB_RUN_FAIL_ONCE:-}" = "1" ] && [ ! -f "$dir/.ran" ]; then
      : > "$dir/.ran"
      exit 7
    fi
    exit 0 ;;
  *) exit 0 ;;
esac
`;

let root = "";
let project = "";
let bin = "";
let hackHome = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-exec-run-probes-"));
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
  const [exitCode, stderr] = await Promise.all([
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
  return { exitCode, stderr, calls, raw };
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

  expect(await snapshot(project)).toEqual(before);
});

test("exec makes no Docker read and no write even with no override yet", async () => {
  const before = await snapshot(project);
  const result = await cli(["exec", "api", "--", "true"]);
  expect(result.exitCode).toBe(0);
  expect(result.calls).toEqual(["compose exec"]);
  expect(await storedOverrides()).toEqual([]);
  expect(await Bun.file(RECORD()).exists()).toBe(false);
  // Only files other generated overrides may add; never the internal one.
  expect(await Bun.file(LEGACY()).exists()).toBe(false);
  for (const name of Object.keys(before)) {
    expect((await snapshot(project))[name]).toBe(before[name]);
  }
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

test("run rebuilds a stale override once with one inspect and runs again", async () => {
  await cli(["run", "api", "--", "true"]);
  // The proxy came back with a new address outside Hack.
  const result = await cli(["run", "api", "--", "true"], {
    STUB_CADDY_IP: "172.30.0.9",
    STUB_RUN_FAIL_ONCE: "1",
  });
  expect(result.exitCode).toBe(0);
  expect(result.calls).toEqual([
    "compose ps",
    "compose run",
    "inspect --type",
    "compose run",
  ]);
  expect(result.stderr).toContain("running the command once more");
  const [stored] = await storedOverrides();
  expect(await readFile(stored ?? "", "utf8")).toContain("172.30.0.9");
  expect(JSON.parse(await readFile(RECORD(), "utf8")).caddy).toBe("172.30.0.9");
});

test("run with unchanged addresses returns the command's failure without a retry", async () => {
  await cli(["run", "api", "--", "true"]);
  const result = await cli(["run", "api", "--", "false"], {
    STUB_RUN_FAIL: "1",
  });
  expect(result.exitCode).toBe(7);
  expect(result.calls).toEqual(["compose ps", "compose run", "inspect --type"]);
  expect(result.stderr).not.toContain("once more");
});

test("a run that fails again after a rebuild is not retried a second time", async () => {
  await cli(["run", "api", "--", "true"]);
  const result = await cli(["run", "api", "--", "false"], {
    STUB_CADDY_IP: "172.30.0.9",
    STUB_RUN_FAIL: "1",
  });
  expect(result.exitCode).toBe(7);
  expect(result.calls).toEqual([
    "compose ps",
    "compose run",
    "inspect --type",
    "compose run",
  ]);
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

test("hack global down removes the record", async () => {
  await cli(["run", "api", "--", "true"]);
  expect(await Bun.file(RECORD()).exists()).toBe(true);
  await writeFile(
    join(hackHome, "logging", "docker-compose.yml"),
    "services: {}\n"
  ).catch(() => undefined);
  const down = await cli(["global", "down"]);
  expect(down.exitCode).toBe(0);
  expect(await Bun.file(RECORD()).exists()).toBe(false);
});
