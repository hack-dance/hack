import { afterEach, beforeEach, expect, test } from "bun:test";
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

/**
 * Stub `docker` that logs each call. `inspect` answers for the global proxy
 * containers; `compose ps` reports `api` running unless STUB_API_STOPPED=1;
 * `compose exec` into a stopped service exits 1 as Compose does.
 */
const STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$(dirname "$0")/calls.log"
case " $* " in
  *" inspect "*)
    printf 'hack-dev-proxy\\tcoredns\\ttrue\\t{"hack-dev":{"IPAddress":"172.30.0.53"}}\\n'
    printf 'hack-dev-proxy\\tcaddy\\ttrue\\t{"hack-dev":{"IPAddress":"172.30.0.2"}}\\n'
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

async function cli(
  args: readonly string[],
  extra: Record<string, string> = {}
): Promise<{ exitCode: number; stderr: string; calls: string[] }> {
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
  const calls = log
    .split("\n")
    .filter((entry) => entry.length > 0)
    .map((entry) => (entry.startsWith("compose ") ? composeVerb(entry) : entry))
    .map((entry) => entry.split(" ").slice(0, 2).join(" "));
  return { exitCode, stderr, calls };
}

/** `compose -f a -f b … <verb> …` → `compose <verb>`. */
function composeVerb(entry: string): string {
  const words = entry.split(" ");
  let i = 1;
  while (words[i] === "-f" || words[i] === "-p" || words[i] === "--profile") {
    i += 2;
  }
  return `compose ${words[i] ?? ""}`;
}

test("exec reuses the override up wrote: Compose exec is its only Docker call", async () => {
  // `run` writes the internal override, as `up` does.
  const first = await cli(["run", "api", "--", "true"]);
  expect(first.exitCode).toBe(0);
  // One inspect replaces the two `compose ps -q` + `inspect` pairs.
  expect(first.calls).toEqual(["inspect --type", "compose ps", "compose run"]);

  const result = await cli(["exec", "api", "--", "true"]);
  expect(result.exitCode).toBe(0);
  expect(result.calls).toEqual(["compose exec"]);
});

test("exec with no override yet reads the addresses once", async () => {
  const result = await cli(["exec", "api", "--", "true"]);
  expect(result.exitCode).toBe(0);
  expect(result.calls).toEqual(["inspect --type", "compose exec"]);
});

test("exec into a stopped service still names hack up -d and hack run", async () => {
  await cli(["exec", "api", "--", "true"]);
  const result = await cli(["exec", "api", "--", "true"], {
    STUB_API_STOPPED: "1",
  });
  expect(result.exitCode).toBe(1);
  expect(result.calls).toEqual(["compose exec", "compose ps"]);
  expect(result.stderr).toContain('Service "api" is not running.');
  expect(result.stderr).toContain("hack up -d");
});
