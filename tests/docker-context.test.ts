import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DOCKER_DEFAULT_UNIX_SOCKET,
  resolveDockerContextEndpoint,
} from "../src/lib/docker-context.ts";
import { bindNativeComposeEngineConfig } from "../src/lib/native-compose-engine-config.ts";
import { createNativeComposeEngineIdentityAdmissions } from "../src/lib/native-compose-engine-identity.ts";

/**
 * Two fake Unix engines answer both the Docker CLI (`HEAD /_ping`, then a
 * versioned `GET /v1.N/info`) and the direct transport (unversioned
 * `GET /info`). Each records which requests it served, so a test can prove
 * which socket each transport dialed.
 */
type Engine = { readonly path: string; readonly served: string[] };
type Environment = Record<string, string | undefined>;
const CANARY = "docker-context-private-canary";
let root: string;
let config: string;
let engines: Record<"a" | "b", Engine>;
let servers: Server[];
let peers: Set<Socket>;

async function engine(name: string): Promise<Engine> {
  const path = join(root, `${name}.sock`);
  const served: string[] = [];
  const server = createServer((req, res) => {
    served.push(`${req.method} ${req.url}`);
    res.setHeader("Api-Version", "1.47");
    res.setHeader("Ostype", "linux");
    if (req.url?.endsWith("/_ping")) {
      res.end("OK");
    } else if (req.url?.endsWith("/info")) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ID: `engine-${name}`, Name: CANARY }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  server.on("connection", (peer) => peers.add(peer));
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  return { path, served };
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "docker-context-")));
  config = join(root, "client");
  await mkdir(config, { mode: 0o700 });
  servers = [];
  peers = new Set();
  engines = { a: await engine("a"), b: await engine("b") };
  // The shape `docker context create --docker host=unix://...` writes.
  await context("ctx-a", {
    Host: `unix://${engines.a.path}`,
    SkipTLSVerify: false,
  });
  await context("ctx-b", {
    Host: `unix://${engines.b.path}`,
    SkipTLSVerify: false,
  });
});
afterEach(async () => {
  for (const peer of peers) {
    peer.destroy();
  }
  for (const server of servers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await rm(root, { recursive: true, force: true });
});

function id(name: string): string {
  return createHash("sha256").update(name).digest("hex");
}
/** Write a context store entry the way `docker context create` lays it out. */
async function context(
  name: string,
  docker: Record<string, unknown> | null,
  raw?: string
) {
  const directory = join(config, "contexts", "meta", id(name));
  await mkdir(directory, { recursive: true, mode: 0o755 });
  await writeFile(
    join(directory, "meta.json"),
    raw ??
      JSON.stringify({
        Name: name,
        Metadata: { Description: "synthetic" },
        Endpoints: { docker },
      }),
    { mode: 0o644 }
  );
}
async function current(name: string | null, raw?: string) {
  await writeFile(
    join(config, "config.json"),
    raw ??
      JSON.stringify({
        auths: { synthetic: { auth: CANARY } },
        ...(name === null ? {} : { currentContext: name }),
      }),
    { mode: 0o600 }
  );
}
function base(extra: Environment = {}): Environment {
  return { HOME: root, DOCKER_CONFIG: config, ...extra };
}
/** The socket this transport would read, or null when the CLI keeps the selection. */
function resolved(environment: Environment): string | null {
  const bound = bindNativeComposeEngineConfig(environment);
  if (bound === null) {
    return null;
  }
  return (
    resolveDockerContextEndpoint({
      environment,
      currentContext: bound.currentContext,
      defaultSocketPath: DOCKER_DEFAULT_UNIX_SOCKET,
    })?.socketPath ?? null
  );
}

// Each row is one selection and the socket the Docker CLI dials for it, as
// docker/cli resolveContextName orders them: DOCKER_HOST, DOCKER_CONTEXT, the
// config's currentContext, then `default`. Empty variables count as unset.
const SELECTIONS: readonly {
  readonly name: string;
  readonly current: string | null;
  readonly env: (engines: Record<"a" | "b", Engine>) => Environment;
  readonly cli: "a" | "b" | "default";
  /** False only where the CLI resolves but this transport keeps the CLI. */
  readonly eligible: boolean;
}[] = [
  {
    name: "no selection",
    current: null,
    env: () => ({}),
    cli: "default",
    eligible: true,
  },
  {
    name: "currentContext",
    current: "ctx-b",
    env: () => ({}),
    cli: "b",
    eligible: true,
  },
  {
    name: "DOCKER_CONTEXT over currentContext",
    current: "ctx-b",
    env: () => ({ DOCKER_CONTEXT: "ctx-a" }),
    cli: "a",
    eligible: true,
  },
  {
    name: "DOCKER_HOST over currentContext",
    current: "ctx-b",
    env: (e) => ({ DOCKER_HOST: `unix://${e.a.path}` }),
    cli: "a",
    eligible: true,
  },
  {
    name: "empty DOCKER_HOST and DOCKER_CONTEXT are unset",
    current: "ctx-b",
    env: () => ({ DOCKER_HOST: "", DOCKER_CONTEXT: "" }),
    cli: "b",
    eligible: true,
  },
  {
    name: "DOCKER_CONTEXT=default over currentContext",
    current: "ctx-b",
    env: () => ({ DOCKER_CONTEXT: "default" }),
    cli: "default",
    eligible: true,
  },
  {
    name: "currentContext=default",
    current: "default",
    env: () => ({}),
    cli: "default",
    eligible: true,
  },
  {
    name: "DOCKER_HOST with DOCKER_CONTEXT",
    current: "ctx-b",
    env: (e) => ({
      DOCKER_HOST: `unix://${e.a.path}`,
      DOCKER_CONTEXT: "ctx-b",
    }),
    cli: "a",
    eligible: false,
  },
];
function socketFor(target: "a" | "b" | "default"): string {
  return target === "default"
    ? DOCKER_DEFAULT_UNIX_SOCKET
    : engines[target].path;
}

test("selection precedence names the same socket the Docker CLI dials", async () => {
  for (const selection of SELECTIONS) {
    await current(selection.current);
    expect({
      name: selection.name,
      socket: resolved(base(selection.env(engines))),
    }).toEqual({
      name: selection.name,
      socket: selection.eligible ? socketFor(selection.cli) : null,
    });
  }
  // A missing config file is the CLI's empty config: the default context.
  await rm(join(config, "config.json"));
  expect(resolved(base())).toBe(DOCKER_DEFAULT_UNIX_SOCKET);
  expect([...engines.a.served, ...engines.b.served]).toEqual([]);
});

test("currentContext is matched without case, like the CLI's config decoder", async () => {
  for (const spelling of [
    "currentContext",
    "CurrentContext",
    "currentcontext",
  ]) {
    await current(null, JSON.stringify({ [spelling]: "ctx-a" }));
    expect(resolved(base())).toBe(engines.a.path);
  }
  for (const raw of [
    '{"currentContext":"ctx-a","CurrentContext":"ctx-b"}',
    '{"currentContext":"ctx-a","currentContext":"ctx-b"}',
    '{"currentContext":7}',
    '{"currentContext":null}',
    '{"currentContexſ":"ctx-a"}',
  ]) {
    await current(null, raw);
    expect(resolved(base())).toBeNull();
  }
});

test("a context store entry is read only as an unambiguous plain Unix endpoint", async () => {
  await current("ctx-x");
  const eligible = (docker: Record<string, unknown> | null, raw?: string) =>
    context("ctx-x", docker, raw).then(() => resolved(base()));
  expect(await eligible({ Host: `unix://${engines.a.path}` })).toBe(
    engines.a.path
  );
  expect(
    await eligible({ host: `unix://${engines.a.path}`, skiptlsverify: false })
  ).toBe(engines.a.path);
  for (const docker of [
    { Host: "tcp://127.0.0.1:2375" },
    { Host: "ssh://synthetic@example.invalid" },
    { Host: "npipe:////./pipe/docker_engine" },
    { Host: "unix://relative.sock" },
    { Host: `unix://${engines.a.path}?x=1` },
    { Host: `unix://${root}/./a.sock` },
    { Host: `unix://${engines.a.path} ` },
    { Host: `unix://${engines.a.path}%00` },
    { Host: "" },
    { Host: null },
    {},
    { Host: `unix://${engines.a.path}`, SkipTLSVerify: true },
    {
      Host: `unix://${engines.a.path}`,
      AdditionalHeaders: { Private: CANARY },
    },
    { Host: `unix://${engines.a.path}`, host: `unix://${engines.b.path}` },
  ]) {
    expect(await eligible(docker)).toBeNull();
  }
  const host = `unix://${engines.a.path}`;
  for (const raw of [
    JSON.stringify({ Name: "ctx-x", Endpoints: { Docker: { Host: host } } }),
    JSON.stringify({ Name: "ctx-x", Endpoints: { docker: null } }),
    JSON.stringify({ Name: "ctx-x", Endpoints: null }),
    JSON.stringify({
      Name: "ctx-x",
      Endpoints: { docker: { Host: host } },
      endpoints: {},
    }),
    JSON.stringify({
      Name: "ctx-x",
      Extra: true,
      Endpoints: { docker: { Host: host } },
    }),
    JSON.stringify({ Name: 1, Endpoints: { docker: { Host: host } } }),
    JSON.stringify({
      Name: "ctx-x",
      Metadata: [],
      Endpoints: { docker: { Host: host } },
    }),
    `{"Endpoints":{"docker":{"Host":"${host}"},"docker":{"Host":"${host}"}}}`,
    "[]",
    CANARY,
  ]) {
    expect(await eligible(null, raw)).toBeNull();
  }
  // Other endpoints in the same context are ignored by the CLI's docker client.
  expect(
    await eligible(
      null,
      JSON.stringify({
        Name: "ctx-x",
        Endpoints: { docker: { Host: host }, kubernetes: { Host: CANARY } },
      })
    )
  ).toBe(engines.a.path);
});

test("missing, unnamed or invalid contexts keep the CLI", async () => {
  for (const name of ["missing", "x", "-leading", "a/b", "a b", "ctx-a\n"]) {
    expect(resolved(base({ DOCKER_CONTEXT: name }))).toBeNull();
  }
  // "Default" is a store name, not the reserved default context.
  expect(resolved(base({ DOCKER_CONTEXT: "Default" }))).toBeNull();
  for (const environment of [
    { HOME: undefined, DOCKER_CONFIG: undefined, DOCKER_CONTEXT: "ctx-a" },
    { HOME: root, DOCKER_CONFIG: "client", DOCKER_CONTEXT: "ctx-a" },
    { HOME: root, DOCKER_CONFIG: `${root}/./client`, DOCKER_CONTEXT: "ctx-a" },
  ]) {
    expect(resolved(environment)).toBeNull();
  }
});

test("context TLS material keeps the CLI without opening or listing it", async () => {
  const tls = join(config, "contexts", "tls", id("ctx-a"));
  await current("ctx-a");
  expect(resolved(base())).toBe(engines.a.path);
  await mkdir(join(tls, "docker"), { recursive: true, mode: 0o700 });
  // A FIFO blocks any reader until a writer opens it: a read would hang here.
  const fifo = Bun.spawnSync(["mkfifo", join(tls, "docker", "key.pem")]);
  expect(fifo.exitCode).toBe(0);
  expect(resolved(base())).toBeNull();
  await rm(tls, { recursive: true });
  // Any entry at the TLS path, even an empty file, keeps the CLI.
  await mkdir(dirname(tls), { recursive: true });
  await writeFile(tls, "");
  expect(resolved(base())).toBeNull();
  await rm(tls);
  expect(resolved(base())).toBe(engines.a.path);
});

test("linked store paths keep the CLI", async () => {
  await current("ctx-a");
  const meta = join(config, "contexts", "meta", id("ctx-a"), "meta.json");
  await rename(meta, join(root, "meta.json"));
  await symlink(join(root, "meta.json"), meta);
  expect(resolved(base())).toBeNull();
  await rm(meta);
  await rename(join(root, "meta.json"), meta);
  expect(resolved(base())).toBe(engines.a.path);
  await rename(join(config, "contexts"), join(root, "contexts"));
  await symlink(join(root, "contexts"), join(config, "contexts"));
  expect(resolved(base())).toBeNull();
});

// Real Docker CLI agreement. Opt-in (HACK_TEST_DOCKER_CLI=1): it runs the
// installed `docker` against the two fake engines only, with an isolated HOME
// and DOCKER_CONFIG, and never contacts a real engine.
const dockerCliTest =
  process.env.HACK_TEST_DOCKER_CLI === "1" ? test : test.skip;
function dockerEnvironment(extra: Environment): Environment {
  const docker = Bun.which("docker");
  if (!docker) {
    throw new Error("HACK_TEST_DOCKER_CLI=1 requires the docker CLI on PATH");
  }
  return base({ PATH: dirname(docker), ...extra });
}
async function docker(environment: Environment, args: readonly string[]) {
  const child = Bun.spawn(["docker", ...args], {
    env: Object.fromEntries(
      Object.entries(environment).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    ),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  if (code !== 0) {
    throw new Error("docker CLI selection failed");
  }
  return stdout;
}

dockerCliTest(
  "the direct read targets the same socket the real Docker CLI picks for each selection",
  async () => {
    for (const selection of SELECTIONS) {
      await current(selection.current);
      const environment = dockerEnvironment(selection.env(engines));
      // Client-only resolution: the CLI prints the endpoint without dialing it.
      expect(
        (
          await docker(environment, [
            "context",
            "inspect",
            "--format",
            "{{.Endpoints.docker.Host}}",
          ])
        ).trim()
      ).toBe(`unix://${socketFor(selection.cli)}`);
      if (selection.cli === "default") {
        continue;
      }
      for (const fake of Object.values(engines)) {
        fake.served.length = 0;
      }
      const admissions = createNativeComposeEngineIdentityAdmissions({
        defaultSocketPath: join(root, "unused-default.sock"),
      });
      const fence = () =>
        admissions({
          cli: () => docker(environment, ["info", "--format", "{{json .ID}}"]),
          timeoutMs: 30_000,
          environment,
        });
      const picked = engines[selection.cli];
      const other = engines[selection.cli === "a" ? "b" : "a"];
      // The first fence is the CLI's own read, on the CLI's own socket.
      expect(await fence()).toBe(`"engine-${selection.cli}"\n`);
      expect(
        picked.served.some((line) => /^GET \/v[\d.]+\/info$/.test(line))
      ).toBe(true);
      expect(await fence()).toBe(`"engine-${selection.cli}"\n`);
      const direct = picked.served.filter((line) => line === "GET /info");
      expect({ name: selection.name, direct: direct.length }).toEqual({
        name: selection.name,
        // Admission read plus one fresh read for the admitted second fence.
        direct: selection.eligible ? 2 : 0,
      });
      // The second fence never ran the CLI when admitted; the other engine was
      // never dialed by either transport.
      expect(
        picked.served.filter((line) => line.endsWith("/_ping")).length
      ).toBe(selection.eligible ? 1 : 2);
      expect(other.served).toEqual([]);
    }
  },
  120_000
);
