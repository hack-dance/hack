import { join } from "node:path";
import { readLinesFromStream } from "../../../src/ui/lines.ts";
import { createMonorepoFixture } from "../fixture.ts";
import {
  buildCliEnv,
  type CliResult,
  expect,
  expectExit,
  extractJsonObject,
  resolveCliSpawnArgs,
  runCommand,
  type Scenario,
  type ScenarioContext,
} from "../harness.ts";

const OWNER = "hack.e2e.background-command-owner";
const PROJECT = "com.docker.compose.project";
const IMAGE = "alpine:3.22";
const TIMEOUT = 180_000;
const WHITESPACE = /\s+/;
const RUNTIME_ENV = {
  HACK_EXECUTION_MODE: "slim",
  HACK_DAEMON_DISABLE_DOCKER_EVENTS: "1",
} as const;
const SERVICE = [
  "trap 'exit 0' TERM",
  "echo ready",
  "while :; do sleep 1; done",
].join("; ");

type EventLine = {
  readonly seq?: number;
  readonly type: string;
  readonly cursor?: string;
  readonly payload?: Record<string, unknown>;
  readonly nextCursor?: string;
  readonly outcome?: string;
  readonly exitCode?: number | null;
  readonly gap?: boolean;
  readonly ended?: boolean;
  readonly state?: string;
};

/**
 * HACK-2085: background `exec` and `run` on a real Compose project.
 *
 * A command prints, sleeps, prints and exits 3. A reader process follows it
 * and is killed after the first line; a new reader resumes from the last
 * cursor and sees the rest with no gap, dense sequence numbers and exit code
 * 3. A background `run` succeeds. `hack down` while a background `exec` is
 * running ends it `failed` with the Compose client's non-zero exit code (the
 * outcome documented in docs/guides/background-commands.md). All Docker
 * resources carry the fixture owner label and are removed by exact ownership.
 */
export const backgroundCommandComposeScenario: Scenario = {
  name: "background-command-compose",
  tier: "docker",
  summary:
    "hack exec/run --detach, cursor resume, exit code and hack down mid-run",
  run: async (ctx) => {
    const stack = await prepareStack(ctx);
    try {
      await stack.cli(["up", "--detach"]);
      const commandId = await checkResume(stack);
      await checkRun(stack);
      await checkRunClientDeath(stack);
      await checkExecCancelStopsGuest(stack);
      await checkExecSelfExitStopsGuest(stack);
      await checkContainerRestart(stack);
      await checkDownMidRun(stack);
      await checkDownMidBackgroundRun(stack);
      await checkScope({ stack, commandId });
    } finally {
      await ctx
        .cli({
          args: ["down"],
          cwd: stack.root,
          timeoutMs: TIMEOUT,
          env: RUNTIME_ENV,
        })
        .catch(() => undefined);
      await stack.clean();
    }
  },
};

type Stack = {
  readonly ctx: ScenarioContext;
  readonly root: string;
  readonly cli: (
    args: readonly string[],
    codes?: readonly number[]
  ) => Promise<CliResult>;
  readonly start: (args: readonly string[]) => Promise<string>;
  readonly clean: () => Promise<void>;
  readonly docker: Docker;
  readonly name: string;
};

async function prepareStack(ctx: ScenarioContext): Promise<Stack> {
  const docker = async (args: readonly string[]) => {
    const result = await runCommand({
      argv: ["docker", ...args],
      cwd: ctx.tempRoot,
      timeoutMs: TIMEOUT,
    });
    return result;
  };
  const info = await docker(["info", "--format", "{{.OSType}}"]);
  if (info.exitCode !== 0 || info.stdout.trim() !== "linux") {
    ctx.skip("a Linux Docker daemon is required");
  }
  const image = await docker([
    "image",
    "inspect",
    IMAGE,
    "--format",
    "{{.Id}}",
  ]);
  if (image.exitCode !== 0) {
    ctx.skip(`${IMAGE} must already be cached (CI pulls it)`);
  }
  const fixture = await createMonorepoFixture({
    parentDir: ctx.tempRoot,
    withHackConfig: true,
    lifecycle: { disableInternal: true },
  });
  const name = fixture.name;
  const labels = { [OWNER]: name };
  await Bun.write(
    join(fixture.hackDir, "hack.config.json"),
    JSON.stringify({ name, internal: { dns: false, tls: false } })
  );
  await Bun.write(
    join(fixture.hackDir, "docker-compose.yml"),
    JSON.stringify({
      name,
      services: {
        api: {
          image: IMAGE,
          pull_policy: "never",
          labels,
          stop_grace_period: "2s",
          command: ["sh", "-c", SERVICE],
        },
      },
      networks: { default: { internal: true, labels } },
    })
  );
  const cli = async (
    args: readonly string[],
    codes: readonly number[] = [0]
  ): Promise<CliResult> => {
    const result = await ctx.cli({
      args,
      cwd: fixture.root,
      timeoutMs: TIMEOUT,
      env: RUNTIME_ENV,
    });
    expectExit({ result, codes, message: `hack ${args.join(" ")}` });
    return result;
  };
  const start = async (args: readonly string[]): Promise<string> => {
    const result = await cli(args);
    const envelope = extractJsonObject<{
      ok: boolean;
      data?: { commandId?: string };
    }>({ text: result.stdout });
    const commandId = envelope?.data?.commandId;
    expect({
      that: envelope?.ok === true && typeof commandId === "string",
      message: "start must return a commandId",
      result,
    });
    return commandId as string;
  };
  const clean = () => removeOwned({ docker, name });

  return { ctx, root: fixture.root, cli, start, clean, docker, name };
}

type Docker = (args: readonly string[]) => Promise<CliResult>;

/** Remove only resources whose owner and Compose project labels are ours. */
async function removeOwned(opts: {
  readonly docker: Docker;
  readonly name: string;
}): Promise<void> {
  for (const kind of ["container", "network", "volume"] as const) {
    const list =
      kind === "container" ? ["ps", "-aq", "--no-trunc"] : [kind, "ls", "-q"];
    const ids = (
      await opts.docker([...list, "--filter", `label=${OWNER}=${opts.name}`])
    ).stdout
      .split(WHITESPACE)
      .filter(Boolean);
    for (const id of ids) {
      await removeIfOwned({ ...opts, kind, id });
    }
  }
}

async function removeIfOwned(opts: {
  readonly docker: Docker;
  readonly name: string;
  readonly kind: "container" | "network" | "volume";
  readonly id: string;
}): Promise<void> {
  const container = opts.kind === "container";
  const expression = container ? "{{json .Config.Labels}}" : "{{json .Labels}}";
  const owned = JSON.parse(
    (await opts.docker([opts.kind, "inspect", opts.id, "--format", expression]))
      .stdout
  ) as Record<string, string>;
  if (owned[OWNER] === opts.name && owned[PROJECT] === opts.name) {
    await opts.docker([
      opts.kind,
      "rm",
      ...(container ? ["--force"] : []),
      opts.id,
    ]);
  }
}

/** 1. Print, sleep, print, exit 3; the first reader dies mid-run. */
async function checkResume(stack: Stack): Promise<string> {
  const { ctx, cli, start } = stack;
  const fixture = { root: stack.root };
  const commandId = await start([
    "exec",
    "--detach",
    "--json",
    "api",
    "--",
    "sh",
    "-c",
    "echo first; sleep 3; echo second; exit 3",
  ]);
  const firstReader = await readUntil({
    ctx,
    cwd: fixture.root,
    args: ["commands", "read", commandId, "--follow", "--json"],
    stopWhen: (line) => line.type === "command.output",
  });
  const firstText = outputText(firstReader);
  expect({
    that: firstText === "first\n",
    message: `first reader should see only the first line, saw ${JSON.stringify(firstText)}`,
  });
  const lastCursor = firstReader.at(-1)?.cursor;
  expect({
    that: typeof lastCursor === "string",
    message: "first reader must have a cursor",
  });
  const rest = parseLines(
    (
      await cli([
        "commands",
        "read",
        commandId,
        "--after",
        lastCursor as string,
        "--follow",
        "--json",
      ])
    ).stdout
  );
  const events = [
    ...firstReader,
    ...rest.filter((line) => line.type !== "read.end"),
  ];
  const seqs = events.map((line) => line.seq);
  expect({
    that: seqs.every((seq, index) => seq === index + 1),
    message: `sequence numbers must be dense across readers: ${JSON.stringify(seqs)}`,
  });
  expect({
    that: !rest.some((line) => line.type === "gap"),
    message: "resume must not report a gap",
  });
  expect({
    that: outputText(events) === "first\nsecond\n",
    message: "both lines, once each",
  });
  const end = rest.find((line) => line.type === "read.end");
  expect({
    that: end?.ended === true && end.outcome === "failed" && end.exitCode === 3,
    message: `exit code 3 must be reported: ${JSON.stringify(end)}`,
  });
  const shown = extractJsonObject<{
    data?: { state?: string; ended?: { exitCode?: number } };
  }>({
    text: (await cli(["commands", "show", commandId, "--json"])).stdout,
  });
  expect({
    that: shown?.data?.state === "ended" && shown.data.ended?.exitCode === 3,
    message: "show reports the end",
  });

  return commandId;
}

/** 2. Background run. */
async function checkRun(stack: Stack): Promise<void> {
  const { cli, start } = stack;
  const runId = await start([
    "run",
    "--detach",
    "--json",
    "api",
    "--",
    "sh",
    "-c",
    "echo from-run",
  ]);
  const runRead = parseLines(
    (await cli(["commands", "read", runId, "--follow", "--json"])).stdout
  );
  expect({
    that:
      outputText(runRead) === "from-run\n" &&
      runRead.at(-1)?.outcome === "succeeded",
    message: `background run must succeed: ${JSON.stringify(runRead.at(-1))}`,
  });
}

/** Start an exec (or run) that prints once and sleeps; return its id after the print. */
async function startSleeper(
  stack: Stack,
  marker: string,
  operation: "exec" | "run" = "exec"
): Promise<string> {
  const id = await stack.start([
    operation,
    "--detach",
    "--json",
    "api",
    "--",
    "sh",
    "-c",
    `echo ${marker}; sleep 120`,
  ]);
  await readUntil({
    ctx: stack.ctx,
    cwd: stack.root,
    args: ["commands", "read", id, "--follow", "--json"],
    stopWhen: (line) => line.type === "command.output",
  });
  return id;
}

async function expectFailedEnd(opts: {
  readonly stack: Stack;
  readonly id: string;
  readonly label: string;
}): Promise<void> {
  const lines = parseLines(
    (
      await opts.stack.cli([
        "commands",
        "read",
        opts.id,
        "--follow",
        "--json",
        "--wait-ms",
        "60000",
      ])
    ).stdout
  );
  const end = lines.at(-1);
  opts.stack.ctx.log(`${opts.label} ended: ${JSON.stringify(end)}`);
  expect({
    that:
      end?.ended === true &&
      end.outcome === "failed" &&
      typeof end.exitCode === "number" &&
      end.exitCode !== 0,
    message: `${opts.label} must end failed with the client's exit code: ${JSON.stringify(end)}`,
  });
}

/** A container restart under a background exec ends it failed. */
async function checkContainerRestart(stack: Stack): Promise<void> {
  const id = await startSleeper(stack, "before-restart");
  const containers = (
    await stack.docker([
      "ps",
      "-q",
      "--no-trunc",
      "--filter",
      `label=${OWNER}=${stack.name}`,
      "--filter",
      `label=${PROJECT}=${stack.name}`,
      "--filter",
      "label=com.docker.compose.service=api",
      "--filter",
      "label=com.docker.compose.oneoff=False",
    ])
  ).stdout
    .split(WHITESPACE)
    .filter(Boolean);
  expect({
    that: containers.length === 1,
    message: `exactly one owned api container expected, saw ${containers.length}`,
  });
  const restart = await stack.docker(["restart", containers[0] as string]);
  expect({
    that: restart.exitCode === 0,
    message: "docker restart must succeed",
    result: restart,
  });
  await expectFailedEnd({ stack, id, label: "container restart mid-run" });
}

/** Cancelling a background `exec` also stops its process in the container. */
async function checkExecCancelStopsGuest(stack: Stack): Promise<void> {
  const id = await startSleeper(stack, "before-exec-cancel");
  const cancel = extractJsonObject<{
    data?: { outcome?: string; confirmed?: { containerProcess?: string } };
  }>({ text: (await stack.cli(["commands", "cancel", id, "--json"])).stdout });
  expect({
    that:
      cancel?.data?.outcome === "cancelled" &&
      cancel.data.confirmed?.containerProcess === "stopped",
    message: `cancel must confirm the process in the container stopped: ${JSON.stringify(cancel?.data)}`,
  });
  const ps = await stack.cli(["exec", "api", "--", "ps", "-o", "args"]);
  expect({
    that: !ps.stdout.includes("sleep 120"),
    message: "the cancelled exec's process must be gone from the container",
    result: ps,
  });
}

/**
 * A background `exec` whose client ends on its own (here: the command exits
 * 3, leaving a marked process in the background, as a client that hits the
 * file-size cap or loses Docker would) must not leave that process running.
 */
async function checkExecSelfExitStopsGuest(stack: Stack): Promise<void> {
  const id = await stack.start([
    "exec",
    "--detach",
    "--json",
    "api",
    "--",
    "sh",
    "-c",
    "sleep 117 >/dev/null 2>&1 & echo left-behind; exit 3",
  ]);
  const end = parseLines(
    (
      await stack.cli([
        "commands",
        "read",
        id,
        "--follow",
        "--json",
        "--wait-ms",
        "60000",
      ])
    ).stdout
  ).at(-1);
  expect({
    that: end?.ended === true && end.outcome === "failed" && end.exitCode === 3,
    message: `an exec that exits 3 ends failed with exit code 3: ${JSON.stringify(end)}`,
  });
  const shown = extractJsonObject<{
    data?: { ended?: { containerProcess?: string } };
  }>({ text: (await stack.cli(["commands", "show", id, "--json"])).stdout });
  expect({
    that: shown?.data?.ended?.containerProcess === "stopped",
    message: `the exec's marked processes must be stopped at its end: ${JSON.stringify(shown?.data?.ended)}`,
  });
  const ps = await stack.cli(["exec", "api", "--", "ps", "-o", "args"]);
  expect({
    that: !ps.stdout.includes("sleep 117"),
    message: "the process the exec left behind must be gone from the container",
    result: ps,
  });
}

/**
 * A background `run` whose Compose client dies on its own (here: killed, as
 * a crash, an OOM kill or the file-size cap would end it) must not leave its
 * one-off container running.
 */
async function checkRunClientDeath(stack: Stack): Promise<void> {
  const id = await startSleeper(stack, "before-client-death", "run");
  const shown = extractJsonObject<{ data?: { child?: { pid?: number } } }>({
    text: (await stack.cli(["commands", "show", id, "--json"])).stdout,
  });
  const clientPid = shown?.data?.child?.pid;
  expect({
    that: typeof clientPid === "number" && clientPid > 1,
    message: `show must report the client pid: ${JSON.stringify(shown?.data?.child)}`,
  });
  // The client was started by this scenario's CLI call; nothing else is killed.
  process.kill(clientPid as number, "SIGKILL");
  const end = parseLines(
    (
      await stack.cli([
        "commands",
        "read",
        id,
        "--follow",
        "--json",
        "--wait-ms",
        "60000",
      ])
    ).stdout
  ).at(-1);
  stack.ctx.log(`run after client death ended: ${JSON.stringify(end)}`);
  expect({
    that: end?.ended === true && end.outcome === "failed",
    message: `a run whose client died ends failed: ${JSON.stringify(end)}`,
  });
  const after = extractJsonObject<{
    data?: { ended?: { containerProcess?: string } };
  }>({ text: (await stack.cli(["commands", "show", id, "--json"])).stdout });
  expect({
    that: after?.data?.ended?.containerProcess === "stopped",
    message: `the one-off container must be removed: ${JSON.stringify(after?.data?.ended)}`,
  });
  const oneOff = await ownedContainers(stack, "True");
  expect({
    that: oneOff.length === 0,
    message: `no one-off container remains after the client died (saw ${oneOff.length})`,
  });
}

/**
 * hack down while a background `run` runs. `docker compose down` does not
 * remove a running one-off container, so the command keeps running (it is
 * not reported as ended); `hack commands cancel` stops it.
 */
async function checkDownMidBackgroundRun(stack: Stack): Promise<void> {
  await stack.cli(["up", "--detach"]);
  const id = await startSleeper(stack, "before-down-run", "run");
  const firstDown = await stack.cli(["down"]);
  stack.ctx.log(
    `hack down with a background run: exit ${firstDown.exitCode}; stderr tail: ${firstDown.stderr.trim().split("\n").slice(-2).join(" | ")}`
  );
  const after = parseLines(
    (await stack.cli(["commands", "read", id, "--json", "--wait-ms", "5000"]))
      .stdout
  );
  const end = after.at(-1);
  stack.ctx.log(`hack down mid background run: ${JSON.stringify(end)}`);
  expect({
    that: end?.ended === false && end.state === "running",
    message: `a background run keeps running through hack down: ${JSON.stringify(end)}`,
  });
  const cancel = extractJsonObject<{ data?: { outcome?: string } }>({
    text: (await stack.cli(["commands", "cancel", id, "--json"])).stdout,
  });
  expect({
    that: cancel?.data?.outcome === "cancelled",
    message: `cancel must stop the background run: ${JSON.stringify(cancel)}`,
  });
  // The supervisor removes the named one-off container after stopping the
  // client, so nothing keeps running or holds the network.
  const result = cancel as {
    data?: { confirmed?: { containerProcess?: string } };
  } | null;
  expect({
    that: result?.data?.confirmed?.containerProcess === "stopped",
    message: `cancel must confirm the one-off container stopped: ${JSON.stringify(cancel)}`,
  });
  const oneOff = await ownedContainers(stack, "True");
  expect({
    that: oneOff.length === 0,
    message: `no one-off container remains after cancel (saw ${oneOff.length})`,
  });
}

async function ownedContainers(
  stack: Stack,
  oneoff: "True" | null
): Promise<string[]> {
  return (
    await stack.docker([
      "ps",
      "-aq",
      "--no-trunc",
      "--filter",
      `label=${OWNER}=${stack.name}`,
      ...(oneoff
        ? ["--filter", `label=com.docker.compose.oneoff=${oneoff}`]
        : []),
    ])
  ).stdout
    .split(WHITESPACE)
    .filter(Boolean);
}

/** 3. hack down while a background exec runs. */
async function checkDownMidRun(stack: Stack): Promise<void> {
  const { ctx, cli, start } = stack;
  const fixture = { root: stack.root };
  const downId = await start([
    "exec",
    "--detach",
    "--json",
    "api",
    "--",
    "sh",
    "-c",
    "echo before-down; sleep 120",
  ]);
  await readUntil({
    ctx,
    cwd: fixture.root,
    args: ["commands", "read", downId, "--follow", "--json"],
    stopWhen: (line) => line.type === "command.output",
  });
  await cli(["down"]);
  const afterDown = parseLines(
    (
      await cli([
        "commands",
        "read",
        downId,
        "--follow",
        "--json",
        "--wait-ms",
        "60000",
      ])
    ).stdout
  );
  const downEnd = afterDown.at(-1);
  ctx.log(`hack down mid-run ended: ${JSON.stringify(downEnd)}`);
  expect({
    that:
      downEnd?.ended === true &&
      downEnd.outcome === "failed" &&
      typeof downEnd.exitCode === "number" &&
      downEnd.exitCode !== 0,
    message: `hack down mid-run must end failed with the client's exit code: ${JSON.stringify(downEnd)}`,
  });
}

/** 4. An id grants nothing outside its project. */
async function checkScope(opts: {
  readonly stack: Stack;
  readonly commandId: string;
}): Promise<void> {
  const { ctx } = opts.stack;
  const commandId = opts.commandId;
  const outside = await ctx.cli({
    args: ["commands", "show", commandId, "--json", "--path", ctx.tempRoot],
    cwd: ctx.tempRoot,
    timeoutMs: TIMEOUT,
    env: RUNTIME_ENV,
  });
  expect({
    that: outside.exitCode !== 0,
    message: "another scope must not read the command",
    result: outside,
  });
}

function parseLines(stdout: string): EventLine[] {
  return stdout
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line) as EventLine);
}

function outputText(lines: readonly EventLine[]): string {
  return (
    lines
      // stdout only: Compose reports container progress on stderr.
      .filter(
        (line) =>
          line.type === "command.output" && line.payload?.stream === "stdout"
      )
      .map((line) => String(line.payload?.text ?? ""))
      .join("")
  );
}

/** Run a reader process and kill it once `stopWhen` matches a line. */
async function readUntil(opts: {
  readonly ctx: ScenarioContext;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly stopWhen: (line: EventLine) => boolean;
}): Promise<EventLine[]> {
  const proc = Bun.spawn(resolveCliSpawnArgs(opts.args), {
    cwd: opts.cwd,
    env: buildCliEnv({ hackHome: opts.ctx.hackHome, extra: RUNTIME_ENV }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const lines: EventLine[] = [];
  const timer = setTimeout(() => proc.kill("SIGKILL"), 60_000);
  try {
    for await (const line of readLinesFromStream(proc.stdout)) {
      if (!line.startsWith("{")) {
        continue;
      }
      const parsed = JSON.parse(line) as EventLine;
      lines.push(parsed);
      if (opts.stopWhen(parsed)) {
        return lines;
      }
    }
  } finally {
    clearTimeout(timer);
    proc.kill("SIGKILL");
    await proc.exited;
  }
  return lines;
}
