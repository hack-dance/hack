import { afterAll, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { saveNativeProjectRun } from "../src/backends/native-project-run.ts";
import { nativeSetupShellReply } from "./helpers/native-setup-inspection.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * Golden output for `hack ps` on both backends (HACK-2540).
 *
 * The shared table never wraps or truncates, so a 40-column terminal prints
 * the same bytes as an 80-column one. On a terminal every header cell is
 * faint, addresses are coloured and an absent address is faint; piped output
 * is plain. `ps --json` is a machine contract: the table must never change it,
 * on a terminal or piped.
 */

const CLI = resolve(import.meta.dir, "..", "index.ts");
const WIDTHS = [80, 40] as const;
const roots: string[] = [];

afterAll(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixtureRoot(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

type CliRun = {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly columns: number;
};

/** Piped stdout: not a TTY, so plain text whatever `COLUMNS` says. */
async function piped(opts: CliRun) {
  const child = Bun.spawn([process.execPath, CLI, ...opts.args], {
    cwd: opts.cwd,
    env: { ...opts.env, COLUMNS: String(opts.columns) },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

/**
 * A real PTY of the given width; stdout and stderr share it. The terminal's
 * output processing turns each `\n` into `\r\n`, which is undone so a golden
 * reads as the CLI wrote it.
 */
async function onTerminal(opts: CliRun) {
  let output = "";
  const ended = Promise.withResolvers<void>();
  // Spawn-owned terminal: `exit` fires once the child's side has closed.
  const terminal: Bun.TerminalOptions = {
    cols: opts.columns,
    rows: 40,
    data(_terminal, bytes) {
      output += new TextDecoder().decode(bytes);
    },
    exit() {
      ended.resolve();
    },
  };
  const child = Bun.spawn([process.execPath, CLI, ...opts.args], {
    cwd: opts.cwd,
    env: opts.env,
    terminal,
    timeout: 20_000,
  });
  try {
    const code = await child.exited;
    // Process exit can precede the final PTY data callback.
    const timer = setTimeout(() => {
      ended.reject(new Error("PTY output did not end within 5 seconds"));
    }, 5000);
    try {
      await ended.promise;
    } finally {
      clearTimeout(timer);
    }
    return { code, stdout: output.replaceAll("\r\n", "\n") };
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
}

const faint = (text: string) => `\x1b[2;90m${text}\x1b[0m`;
const identity = (text: string) => `\x1b[36m${text}\x1b[0m`;
const lines = (rows: readonly string[]) => `${rows.join("\n")}\n`;

// ------------------------------------------------------------------ Compose

const COMPOSE_STUB = `#!/bin/sh
if [ "$1" != "compose" ]; then exit 0; fi
case " $* " in
  *" ps "*" --format "*)
    printf '%s\\n' '{"ID":"fixture-web","Service":"web","Name":"sample-web-1","State":"running","Health":"healthy","Status":"Up 2 minutes (healthy)","ExitCode":0,"Ports":"0.0.0.0:3000->3000/tcp","Labels":"com.docker.compose.project=sample"}'
    printf '%s\\n' '{"ID":"fixture-worker","Service":"worker","Name":"sample-worker-1","State":"exited","Status":"Exited (127) 1 minute ago","ExitCode":127,"Labels":"com.docker.compose.project=sample"}'
    printf '%s\\n' '{"ID":"fixture-db","Service":"db","Name":"sample-db-1","State":"running","Health":"","Status":"Up 2 minutes","ExitCode":0,"Ports":"5432/tcp","Labels":"com.docker.compose.project=sample"}'
    ;;
esac
exit 0
`;

async function composeFixture() {
  const root = await fixtureRoot("hack-ps-golden-compose-");
  const project = join(root, "project");
  const hack = join(project, ".hack");
  const bin = join(root, "bin");
  await mkdir(hack, { recursive: true });
  await mkdir(bin);
  await writeFile(join(bin, "docker"), COMPOSE_STUB);
  await chmod(join(bin, "docker"), 0o755);
  await writeFile(
    join(hack, "hack.config.json"),
    JSON.stringify({ name: "sample", internal: { dns: false, tls: false } })
  );
  await writeFile(
    join(hack, "docker-compose.yml"),
    lines([
      "services:",
      "  web:",
      "    image: alpine:3.22",
      "    labels:",
      "      caddy: storefront-preview.sample.hack.local",
      "  worker:",
      "    image: alpine:3.22",
      "  db:",
      "    image: alpine:3.22",
    ])
  );
  return {
    cwd: project,
    args: [] as string[],
    env: privateCliEnv({
      root,
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HACK_RUNTIME_BACKEND: "compose",
        HACK_NO_INTERACTIVE: "1",
      },
    }) as Record<string, string>,
  };
}

const COMPOSE_TEXT = lines([
  "SERVICE  ADDRESS                                       STATE",
  "web      https://storefront-preview.sample.hack.local  healthy",
  "worker   no address                                    exited (127)",
  "db       no address                                    running",
  "",
  "3 services",
]);

const COMPOSE_TERMINAL = lines([
  `${faint("SERVICE")}  ${faint("ADDRESS")}                                       ${faint("STATE")}`,
  `web      ${identity("https://storefront-preview.sample.hack.local")}  healthy`,
  `worker   ${faint("no address")}                                    exited (127)`,
  `db       ${faint("no address")}                                    running`,
  "",
  faint("3 services"),
]);

/**
 * `ps --json` for the Compose fixture. These are the exact bytes printed both
 * before and after the shared table landed (#1067, checked against its parent
 * commit), and they are unchanged on this branch.
 */
const COMPOSE_JSON = `{
  "project": "sample",
  "branch": null,
  "composeProject": "sample",
  "items": [
    {
      "ID": "fixture-web",
      "Service": "web",
      "Name": "sample-web-1",
      "State": "running",
      "Health": "healthy",
      "Status": "Up 2 minutes (healthy)",
      "ExitCode": 0,
      "Ports": "0.0.0.0:3000->3000/tcp",
      "Labels": "com.docker.compose.project=sample"
    },
    {
      "ID": "fixture-worker",
      "Service": "worker",
      "Name": "sample-worker-1",
      "State": "exited",
      "Status": "Exited (127) 1 minute ago",
      "ExitCode": 127,
      "Labels": "com.docker.compose.project=sample"
    },
    {
      "ID": "fixture-db",
      "Service": "db",
      "Name": "sample-db-1",
      "State": "running",
      "Health": "",
      "Status": "Up 2 minutes",
      "ExitCode": 0,
      "Ports": "5432/tcp",
      "Labels": "com.docker.compose.project=sample"
    }
  ],
  "waiting": {}
}
`;

// ------------------------------------------------------------------- Native

const run = {
  run: "a".repeat(32),
  owner: "b".repeat(32),
  namespace: "c".repeat(64),
  planId: "d".repeat(64),
  profiles: [],
  effectiveEnvName: null,
  aws: null,
};

async function nativeFixture(opts: { readonly failedWorker?: boolean } = {}) {
  const root = await fixtureRoot("hack-ps-golden-native-");
  const project = join(root, "project");
  const projectDir = join(project, ".hack");
  const nativeHome = join(root, "native-home");
  await mkdir(projectDir, { recursive: true });
  await mkdir(nativeHome, { mode: 0o700 });
  await writeFile(
    join(projectDir, "docker-compose.yml"),
    JSON.stringify({
      services: {
        web: {
          image: "docker.io/library/busybox:1.37",
          labels: { caddy: "storefront-preview.sample.hack" },
        },
        worker: { image: "docker.io/library/busybox:1.37" },
      },
    })
  );
  await writeFile(
    join(projectDir, "hack.config.json"),
    JSON.stringify({ name: "golden-fixture", dev_host: "sample.hack.local" })
  );
  const graph = {
    receipt: {
      ...run,
      plan_id: run.planId,
      phase: "ready-observed",
      resources: Object.fromEntries(
        ["web", "worker"].map((service) => [
          `container:${service}`,
          {
            kind: "container",
            key: service,
            id: "e".repeat(64),
            phase: "started",
          },
        ])
      ),
    },
    journal_incomplete: false,
    observations: {
      "container:web": { state: "running", health: "healthy" },
      "container:worker": { state: "exited", code: 1 },
    },
    ...(opts.failedWorker
      ? {
          failed_after_started: {
            code: "service_exited",
            service: "worker",
            at: 1_800_000_000,
          },
        }
      : {}),
  };
  const binary = join(root, "native-runtime");
  // Only `graph status` answers. Every other request (the supplemental image
  // tag lookup under --json) is refused, which ps reports as no image tags.
  await writeFile(
    binary,
    `#!/bin/sh
${nativeSetupShellReply()}
case " $* " in
  *" graph status "*) printf '%s' '${JSON.stringify(graph)}' ;;
  *) printf '%s' '${JSON.stringify({ code: "unsupported_request" })}' >&2; exit 1 ;;
esac
`,
    { mode: 0o700 }
  );
  await saveNativeProjectRun({
    projectRoot: project,
    projectDir,
    nativeHome,
    branch: "alpha",
    run,
  });
  return {
    cwd: root,
    // Project selection goes before the command.
    args: ["--path", project, "--branch", "alpha"],
    env: privateCliEnv({
      root,
      env: {
        HACK_RUNTIME_BACKEND: "native",
        HACK_NATIVE_BINARY: binary,
        HACK_NATIVE_HOME: nativeHome,
        HACK_NO_INTERACTIVE: "1",
      },
    }) as Record<string, string>,
  };
}

const NATIVE_TEXT = lines([
  "SERVICE  ADDRESS                                       STATE",
  "web      https://storefront-preview.alpha.sample.hack  healthy",
  "worker   no address                                    exited (1)",
  "",
  "2 services",
]);

const NATIVE_TERMINAL = lines([
  `${faint("SERVICE")}  ${faint("ADDRESS")}                                       ${faint("STATE")}`,
  `web      ${identity("https://storefront-preview.alpha.sample.hack")}  healthy`,
  `worker   ${faint("no address")}                                    exited (1)`,
  "",
  faint("2 services"),
]);

/** A start that failed after `up` returned stays visible by default, with its next command. */
const NATIVE_FAILED_TEXT = lines([
  ...NATIVE_TEXT.trimEnd().split("\n"),
  "",
  "! worker  failed after up returned · service_exited (2027-01-15T08:00:00.000Z)",
  "  see why it did not become ready. run:",
  "  hack logs worker",
]);

const NATIVE_FAILED_TERMINAL = lines([
  ...NATIVE_TERMINAL.trimEnd().split("\n"),
  "",
  "\x1b[33m!\x1b[0m worker  failed after up returned · service_exited (2027-01-15T08:00:00.000Z)",
  "  see why it did not become ready. run:",
  "  hack logs worker",
]);

/**
 * `ps --json` for the native fixture as printed before and after the shared
 * table landed (#1067, checked against its parent commit).
 */
const NATIVE_JSON_AT_TABLE = `{
  "ok": true,
  "data": {
    "backend": "native",
    "status": "observed",
    "run": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "items": [
      {
        "service": "web",
        "container": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        "phase": "started",
        "state": "running",
        "health": "healthy",
        "exitCode": null
      },
      {
        "service": "worker",
        "container": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        "phase": "started",
        "state": "exited",
        "health": null,
        "exitCode": 1
      }
    ],
    "phase": "ready-observed"
  }
}
`;

/**
 * The same bytes today. The only later change is the `readiness` field that
 * #1124 added to the native result on purpose; the table changed nothing.
 */
const NATIVE_JSON = NATIVE_JSON_AT_TABLE.replace(
  '    "phase": "ready-observed"\n',
  '    "phase": "ready-observed",\n    "readiness": "ready"\n'
);

// -------------------------------------------------------------------- Tests

const backends = [
  {
    name: "Compose",
    fixture: composeFixture,
    text: COMPOSE_TEXT,
    terminal: COMPOSE_TERMINAL,
    json: COMPOSE_JSON,
  },
  {
    name: "native",
    fixture: () => nativeFixture(),
    text: NATIVE_TEXT,
    terminal: NATIVE_TERMINAL,
    json: NATIVE_JSON,
  },
] as const;

for (const backend of backends) {
  test(`${backend.name} ps prints the same plain table at 80 and 40 columns when piped`, async () => {
    const f = await backend.fixture();
    for (const columns of WIDTHS) {
      const result = await piped({ ...f, args: [...f.args, "ps"], columns });
      expect(result.code).toBe(0);
      expect(result.stdout).toBe(backend.text);
      expect(result.stderr).toBe("");
    }
  }, 60_000);

  test(`${backend.name} ps on a terminal keeps whole addresses at 80 and 40 columns`, async () => {
    const f = await backend.fixture();
    for (const columns of WIDTHS) {
      const result = await onTerminal({
        ...f,
        args: [...f.args, "ps"],
        columns,
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toBe(backend.terminal);
    }
  }, 60_000);

  test(`${backend.name} ps --json keeps its exact bytes, piped and on a terminal`, async () => {
    const f = await backend.fixture();
    const args = [...f.args, "ps", "--json"];
    const plain = await piped({ ...f, args, columns: 40 });
    expect(plain.code).toBe(0);
    expect(plain.stdout).toBe(backend.json);
    const terminal = await onTerminal({ ...f, args, columns: 40 });
    expect(terminal.code).toBe(0);
    expect(terminal.stdout).toBe(backend.json);
  }, 60_000);
}

test("native ps shows a failure after up returned by default at 40 columns", async () => {
  const f = await nativeFixture({ failedWorker: true });
  const args = [...f.args, "ps"];
  const plain = await piped({ ...f, args, columns: 40 });
  expect(plain.code).toBe(0);
  expect(plain.stdout).toBe(NATIVE_FAILED_TEXT);
  const terminal = await onTerminal({ ...f, args, columns: 40 });
  expect(terminal.code).toBe(0);
  expect(terminal.stdout).toBe(NATIVE_FAILED_TERMINAL);
}, 60_000);
