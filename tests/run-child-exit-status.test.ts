import { afterEach, expect, test } from "bun:test";
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
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

// ---------------------------------------------------------------------------
// HACK-1155 (P11): `hack run <service> -- <cmd...>` reports the child's own
// exit status, from the CLI and from the MCP `hack.project.run` envelope, and
// passes the child argv after `--` through unchanged. A pipe filter can hide
// that status only from the pipeline, never from hack's own exit code.
//
// The source CLI runs with a private HOME and HACK_HOME against a recording
// `docker` stub on PATH. The stub plays `docker compose run`: it runs the argv
// after the service name on the host and exits with its status. No Docker
// engine, client config or real home directory is touched.
// ---------------------------------------------------------------------------

const cli = resolve(import.meta.dir, "../index.ts");
/** Each test runs the source CLI several times; the default 5 s is too short. */
const TEST_TIMEOUT_MS = 90_000;
const roots: string[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close();
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

type RunResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hack-run-exit-"));
  roots.push(root);
  const project = join(root, "project");
  const bin = join(root, "bin");
  const home = join(root, "home");
  for (const path of [join(project, ".hack"), bin, home]) {
    await mkdir(path, { recursive: true });
  }
  await writeFile(
    join(project, ".hack", "docker-compose.yml"),
    "name: run-exit\nservices:\n  app:\n    image: alpine:3.20\n"
  );
  // Internal DNS/TLS off: no CoreDNS/Caddy probes, whose warnings would
  // otherwise depend on the host's global Hack state.
  await writeFile(
    join(project, ".hack", "hack.config.json"),
    '{"name":"run-exit","dev_host":"run-exit.hack","internal":{"dns":false,"tls":false}}\n'
  );
  const log = join(root, "docker-log.jsonl");
  await writeFile(log, "");
  const docker = join(bin, "docker");
  await writeFile(
    docker,
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { YAML } from "bun";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const run = args.indexOf("run");
if (args[0] === "compose" && run >= 0) {
  const service = args.indexOf("app", run + 1);
  const child = Bun.spawnSync(args.slice(service + 1), {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(child.exitCode ?? 1);
}
if (args.includes("config")) {
  const merged = { services: {} };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-f") {
      const doc = YAML.parse(await Bun.file(args[++i]).text());
      Object.assign(merged.services, doc.services ?? {});
    }
  }
  console.log(JSON.stringify(merged));
}
`
  );
  await chmod(docker, 0o755);
  const env = privateCliEnv({
    root,
    home,
    env: {
      HACK_HOME: join(home, ".hack"),
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HACK_NO_INTERACTIVE: "1",
    },
  });
  const collect = async (child: ReturnType<typeof Bun.spawn>) => {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout as ReadableStream).text(),
      new Response(child.stderr as ReadableStream).text(),
      child.exited,
    ]);
    return { exitCode, stdout, stderr } satisfies RunResult;
  };
  /** `hack run --path <project> app -- <cmd...>` from the source CLI. */
  const run = async (cmd: readonly string[]) =>
    await collect(
      Bun.spawn(
        [process.execPath, cli, "run", "--path", project, "app", "--", ...cmd],
        {
          cwd: project,
          env,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          timeout: 20_000,
        }
      )
    );
  /** The same command piped through `cat`, with and without pipefail. */
  const piped = async (opts: {
    readonly cmd: readonly string[];
    readonly pipefail: boolean;
  }) =>
    await collect(
      Bun.spawn(
        [
          "/bin/bash",
          "-c",
          `set ${opts.pipefail ? "-o" : "+o"} pipefail; "$@" | cat; echo "pipeline=$? hack=\${PIPESTATUS[0]}"`,
          "hack-pipe",
          process.execPath,
          cli,
          "run",
          "--path",
          project,
          "app",
          "--",
          ...opts.cmd,
        ],
        {
          cwd: project,
          env,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          timeout: 20_000,
        }
      )
    );
  /** The argv each `docker compose run` received after the service name. */
  const runArgv = async () =>
    (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[])
      .filter((args) => args[0] === "compose" && args.includes("run"))
      .map((args) => args.slice(args.indexOf("app", args.indexOf("run")) + 1));
  /** An in-process MCP session whose tools run this source CLI. */
  const mcp = async () => {
    const wrapper = join(root, "hack-under-test");
    await writeFile(
      wrapper,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} "$@"\n`
    );
    await chmod(wrapper, 0o755);
    const server = createMcpServer({
      cwd: project,
      env: { ...env, HACK_MCP_COMMAND: wrapper },
    });
    const client = new Client({ name: "hack-run-exit", version: "1" });
    clients.push(client);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
  };
  return { run, piped, runArgv, mcp };
}

function envelope(result: unknown): {
  readonly isError: boolean;
  readonly ok: unknown;
  readonly exitCode: unknown;
  readonly stdout: unknown;
} {
  const record = result as {
    readonly isError?: boolean;
    readonly structuredContent?: Record<string, unknown>;
  };
  return {
    isError: record.isError === true,
    ok: record.structuredContent?.ok,
    exitCode: record.structuredContent?.exitCode,
    stdout: record.structuredContent?.stdout,
  };
}

test(
  "hack run exits with the child's status and keeps its argv after --",
  async () => {
    const f = await fixture();
    const failed = await f.run(["false"]);
    expect({ exitCode: failed.exitCode, stdout: failed.stdout }).toEqual({
      exitCode: 1,
      stdout: "",
    });
    const seven = await f.run(["sh", "-c", "printf partial; exit 7"]);
    expect({ exitCode: seven.exitCode, stdout: seven.stdout }).toEqual({
      exitCode: 7,
      stdout: "partial",
    });
    // Positive control: a successful child is a successful run.
    const passed = await f.run(["true"]);
    expect(passed.exitCode).toBe(0);
    // Hack-looking words after `--` reach the child, not hack's parser.
    const flags = await f.run(["sh", "-c", 'exit "$1"', "sh", "--json"]);
    expect(flags.exitCode).not.toBe(0);
    expect(await f.runArgv()).toEqual([
      ["false"],
      ["sh", "-c", "printf partial; exit 7"],
      ["true"],
      ["sh", "-c", 'exit "$1"', "sh", "--json"],
    ]);
  },
  TEST_TIMEOUT_MS
);

test(
  "a pipe filter hides a failed child only from the pipeline, never from hack",
  async () => {
    const f = await fixture();
    // Negative control: without pipefail the filtered pipeline reports success.
    const filtered = await f.piped({ cmd: ["false"], pipefail: false });
    expect(filtered.stdout.trim()).toBe("pipeline=0 hack=1");
    const failed = await f.piped({ cmd: ["false"], pipefail: true });
    expect(failed.stdout.trim()).toBe("pipeline=1 hack=1");
    const seven = await f.piped({
      cmd: ["sh", "-c", "printf partial; exit 7"],
      pipefail: false,
    });
    expect(seven.stdout.trim()).toBe("partialpipeline=0 hack=7");
  },
  TEST_TIMEOUT_MS
);

test(
  "the MCP hack.project.run envelope reports the child's exit status",
  async () => {
    const f = await fixture();
    const client = await f.mcp();
    const call = async (cmd: readonly string[]) =>
      envelope(
        await client.callTool({
          name: "hack.project.run",
          arguments: { service: "app", cmd: [...cmd] },
        })
      );
    expect(await call(["false"])).toEqual({
      isError: true,
      ok: false,
      exitCode: 1,
      stdout: "",
    });
    expect(await call(["sh", "-c", "printf partial; exit 7"])).toEqual({
      isError: true,
      ok: false,
      exitCode: 7,
      stdout: "partial",
    });
    // Positive control: a successful child is an ok envelope.
    expect(await call(["true"])).toEqual({
      isError: false,
      ok: true,
      exitCode: 0,
      stdout: "",
    });
    expect((await f.runArgv()).slice(-3)).toEqual([
      ["false"],
      ["sh", "-c", "printf partial; exit 7"],
      ["true"],
    ]);
  },
  TEST_TIMEOUT_MS
);
