import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/*
 * HACK-2311: with Hack's own `--json`, stdout carries exactly one JSON value
 * (or, with `--progress`, only ndjson lines ending in the envelope), even
 * when lifecycle hooks and the Compose client print. Their stdout and stderr
 * go to stderr.
 */

const CLI = resolve(import.meta.dir, "..", "index.ts");
const HOOK_OUT = "hook-stdout-marker";
const HOOK_ERR = "hook-stderr-marker";
const COMPOSE_OUT = "compose-stdout-marker";

/**
 * Stub `docker`: every Compose call prints a line to stdout (as the real
 * client does for up/down/run), `ps --format` reports `api` running, and
 * everything succeeds.
 */
const STUB = `#!/bin/sh
if [ "$1" != "compose" ]; then exit 0; fi
# After down, ps lists nothing (HACK-2340: down checks what is left).
marker="$(dirname "$0")/.compose-down"
case " $* " in
  *" down "*)
    : > "$marker"
    printf '%s\\n' '${COMPOSE_OUT}'; exit 0 ;;
  *" up "*)
    rm -f "$marker"
    printf '%s\\n' '${COMPOSE_OUT}'; exit 0 ;;
  *" ps "*)
    if [ -f "$marker" ]; then exit 0; fi
    case " $* " in
      *" --format "*)
        printf '{"ID":"c1","Service":"api","Name":"shop-api-1","State":"running","Status":"Up","ExitCode":0,"Labels":"com.docker.compose.project.working_dir=%s"}\\n' "$PWD" ;;
    esac
    exit 0 ;;
  *) printf '%s\\n' '${COMPOSE_OUT}'; exit 0 ;;
esac
`;

/** A hook command that prints to both streams, tagged by phase. */
function hook(phase: string): string {
  return `printf '[hack-lifecycle] ${HOOK_OUT} ${phase}\\n'; printf '${HOOK_ERR} ${phase}\\n' >&2`;
}

let root = "";
let project = "";
let bin = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-json-hooks-"));
  project = join(root, "project");
  bin = join(root, "bin");
  const hack = join(project, ".hack");
  await mkdir(hack, { recursive: true });
  await mkdir(bin);
  await writeFile(join(bin, "docker"), STUB);
  await chmod(join(bin, "docker"), 0o755);
  await writeFile(
    join(hack, "hack.config.json"),
    JSON.stringify({
      name: "shop",
      internal: { dns: false, tls: false },
      lifecycle: {
        up: { before: [hook("up-before")], after: [hook("up-after")] },
        down: { before: [hook("down-before")], after: [hook("down-after")] },
      },
    })
  );
  await writeFile(
    join(hack, "docker-compose.yml"),
    "services:\n  api:\n    image: alpine:3.22\n"
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function cli(
  args: readonly string[],
  extra: Readonly<Record<string, string>> = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: project,
    env: privateCliEnv({
      root,
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
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

/**
 * No hook or Compose output on stdout; the hooks' output on stderr, and the
 * Compose client's too when it is passed through (`run --detach` captures
 * it for its result instead).
 */
function expectOutputOnStderr(
  result: { readonly stdout: string; readonly stderr: string },
  phases: readonly string[],
  composePassedThrough = true
): void {
  expect(result.stdout).not.toContain(HOOK_OUT);
  expect(result.stdout).not.toContain(HOOK_ERR);
  expect(result.stdout).not.toContain(COMPOSE_OUT);
  if (composePassedThrough) {
    // The Compose client's output is kept, on stderr.
    expect(result.stderr).toContain(COMPOSE_OUT);
  }
  for (const phase of phases) {
    // A hook that ran printed both of its lines, and both reached stderr.
    expect(result.stderr).toContain(`${HOOK_OUT} ${phase}`);
    expect(result.stderr).toContain(`${HOOK_ERR} ${phase}`);
  }
}

const SINGLE_ENVELOPE_CASES: ReadonlyArray<{
  readonly name: string;
  readonly args: readonly string[];
  readonly phases: readonly string[];
}> = [
  {
    name: "up --detach --json",
    args: ["up", "--detach", "--json"],
    phases: ["up-before", "up-after"],
  },
  {
    name: "restart --json",
    args: ["restart", "--json"],
    phases: ["down-before", "down-after", "up-before", "up-after"],
  },
  {
    name: "down --json",
    args: ["down", "--json"],
    phases: ["down-before", "down-after"],
  },
  {
    name: "run --detach --json",
    args: ["run", "--detach", "--json", "api", "true"],
    phases: [],
  },
];

for (const { name, args, phases } of SINGLE_ENVELOPE_CASES) {
  test(`${name}: stdout is exactly one JSON value while hooks print`, async () => {
    const result = await cli(args);
    expect({ exitCode: result.exitCode, stderr: result.stderr }).toMatchObject({
      exitCode: 0,
    });
    // JSON.parse of the whole of stdout succeeds only for a single value.
    const envelope = JSON.parse(result.stdout) as { ok: boolean };
    expect(envelope.ok).toBe(true);
    expectOutputOnStderr(result, phases, args[0] !== "run");
  }, 60_000);
}

for (const command of ["up", "restart", "down"] as const) {
  test(`${command} --json --progress: stdout is only ndjson while hooks print`, async () => {
    const args =
      command === "up"
        ? ["up", "--detach", "--json", "--progress"]
        : [command, "--json", "--progress"];
    const result = await cli(args);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.endsWith("\n")).toBe(true);
    const lines = result.stdout
      .slice(0, -1)
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.at(-1)).toMatchObject({ ok: true });
    expectOutputOnStderr(
      result,
      command === "down"
        ? ["down-before", "down-after"]
        : command === "up"
          ? ["up-before", "up-after"]
          : ["down-before", "down-after", "up-before", "up-after"]
    );
  }, 60_000);
}

test("up --detach --json --target remote: dispatch output goes to stderr", async () => {
  // The dispatch child is `hack dispatch run ... -- hack up ...`; a stand-in
  // for that `hack` prints to stdout and succeeds.
  const dispatch = join(bin, "fake-hack");
  await writeFile(
    dispatch,
    "#!/bin/sh\nprintf '%s\\n' 'dispatch-stdout-marker'\nexit 0\n"
  );
  await chmod(dispatch, 0o755);
  // Remote execution needs a node; nothing is contacted.
  await writeFile(
    join(project, ".hack", "hack.config.json"),
    JSON.stringify({
      name: "shop",
      internal: { dns: false, tls: false },
      controlPlane: { execution: { nodeId: "node-1" } },
    })
  );
  const result = await cli(["up", "--detach", "--json", "--target", "remote"], {
    HACK_MCP_COMMAND: dispatch,
  });
  expect(result.exitCode).toBe(0);
  const envelope = JSON.parse(result.stdout) as { ok: boolean };
  expect(envelope.ok).toBe(true);
  expect(result.stdout).not.toContain("dispatch-stdout-marker");
  expect(result.stderr).toContain("dispatch-stdout-marker");
}, 60_000);
