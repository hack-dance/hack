import { join } from "node:path";
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
      await checkDownMidRun(stack);
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

  return { ctx, root: fixture.root, cli, start, clean };
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
  return lines
    .filter((line) => line.type === "command.output")
    .map((line) => String(line.payload?.text ?? ""))
    .join("");
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
  const decoder = new TextDecoder();
  let buffer = "";
  const timer = setTimeout(() => proc.kill("SIGKILL"), 60_000);
  try {
    for await (const chunk of proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
        if (!line.startsWith("{")) {
          continue;
        }
        const parsed = JSON.parse(line) as EventLine;
        lines.push(parsed);
        if (opts.stopWhen(parsed)) {
          proc.kill("SIGKILL");
          await proc.exited;
          return lines;
        }
      }
    }
  } finally {
    clearTimeout(timer);
    proc.kill("SIGKILL");
    await proc.exited;
  }
  return lines;
}
