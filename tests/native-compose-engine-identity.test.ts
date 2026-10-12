import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bindNativeComposeEngineSocketPath,
  createNativeComposeEngineIdentityAdmissions,
  createNativeComposeEngineIdentityObserver,
  NativeComposeEngineIdentityError,
} from "../src/lib/native-compose-engine-identity.ts";
import { observeNativeComposeIngress } from "../src/lib/native-compose-ingress.ts";
import { createNativeComposeProbe } from "../src/lib/native-compose-ownership.ts";
import { NativeComposeRoutingError } from "../src/lib/native-compose-routing.ts";
import { nativeComposeStorageIdentityProbe } from "../src/lib/native-compose-storage-witness-docker-identity.ts";
import { restoreEnv } from "./helpers/env.ts";

const ENGINE = "synthetic-engine";
const CANARY = "synthetic-engine-private-canary";
const NETWORK = "a".repeat(64);
const PROXY = "b".repeat(64);
type Environment = Record<string, string | undefined>;
type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let root: string;
let socket: string;
let docker: string;
let environment: Environment;
let handler: Handler;
let requests: { method: string | undefined; url: string | undefined }[];
let connections: Set<Socket>;
let servers: Server[];

async function listen(path: string): Promise<Server> {
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    handler(req, res);
  });
  server.on("connection", (peer) => connections.add(peer));
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  return server;
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "engine-id-")));
  socket = join(root, "engine.sock");
  docker = join(root, "docker");
  await writeFile(docker, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  environment = {
    PATH: root,
    DOCKER_HOST: `unix://${socket}`,
    DOCKER_CONFIG: join(root, "client"),
    HOME: root,
  };
  requests = [];
  connections = new Set();
  servers = [];
  handler = (_req, res) =>
    res.end(JSON.stringify({ ID: ENGINE, private: CANARY }));
  await listen(socket);
});
afterEach(async () => {
  for (const peer of connections) {
    peer.destroy();
  }
  for (const server of [...servers].reverse()) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await rm(root, { recursive: true, force: true });
});

async function observer(
  opts: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {}
) {
  const result = await createNativeComposeEngineIdentityObserver({
    ...opts,
    environment,
  });
  expect(result).not.toBeNull();
  if (result === null) {
    throw new Error("missing test observer");
  }
  return result;
}
async function refusal(observe: () => Promise<string>) {
  try {
    await observe();
    throw new Error("unexpected engine acceptance");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(NativeComposeEngineIdentityError);
    expect(String(error)).not.toContain(CANARY);
    expect(String(error)).not.toContain(root);
    expect(JSON.stringify(error)).not.toContain(CANARY);
  }
}

test("each engine-ID fence uses a fresh real Unix connection and returns only the public ID", async () => {
  const spawn = spyOn(Bun, "spawn");
  try {
    const observe = await observer();
    expect(await observe()).toBe(ENGINE);
    handler = (_req, res) =>
      res.end(JSON.stringify({ ID: "replacement-engine", private: CANARY }));
    expect(await observe()).toBe("replacement-engine");
    expect(requests).toEqual([
      { method: "GET", url: "/info" },
      { method: "GET", url: "/info" },
    ]);
    expect(connections.size).toBe(2);
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    spawn.mockRestore();
  }
});
test("nonlocal, contextual, TLS and explicit API selections retain the existing CLI transport", async () => {
  for (const selection of [
    { DOCKER_HOST: undefined },
    { DOCKER_HOST: "tcp://127.0.0.1:2375" },
    { DOCKER_HOST: "unix:///encoded%2Fsocket" },
    { DOCKER_HOST: `unix://${root}/./engine.sock` },
    { DOCKER_CONTEXT: "selected-context" },
    { DOCKER_TLS: "1" },
    { DOCKER_TLS_VERIFY: "1" },
    { DOCKER_CUSTOM_HEADERS: `Private=${CANARY}` },
    { DOCKER_CERT_PATH: "/selected/certificates" },
    { DOCKER_API_VERSION: "1.44" },
  ]) {
    expect(
      await createNativeComposeEngineIdentityObserver({
        environment: { ...environment, ...selection },
      })
    ).toBeNull();
  }
  expect(requests).toHaveLength(0);
});
async function config(bytes: string | Buffer) {
  const directory = join(root, "client");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "config.json");
  await writeFile(path, bytes, { mode: 0o600 });
  return path;
}
test("strict absent or empty Docker headers retain direct transport without exposing configuration values", async () => {
  for (const headers of [{}, { HttpHeaders: {} }, { httpheaders: {} }]) {
    await config(
      JSON.stringify({ ...headers, auths: { synthetic: { auth: CANARY } } })
    );
    const observe = await observer();
    expect(await observe()).toBe(ENGINE);
    expect(await observe()).not.toContain(CANARY);
  }
  expect(requests).toHaveLength(6);
});
test("configured headers or ambiguous Docker JSON retain CLI before direct admission", async () => {
  for (const bytes of [
    JSON.stringify({ HttpHeaders: { Authorization: CANARY } }),
    JSON.stringify({ httpheaders: { Private: CANARY } }),
    JSON.stringify({ HttpHeaderſ: { Private: CANARY } }),
    '{"HttpHeaders":{},"httpheaders":{}}',
    '{"HttpHeaders":{},"HttpHeaders":{}}',
    String.raw`{"HttpHeaders":{},"Http\u0048eaders":{}}`,
    '{"HttpHeaders":null}',
    '{"HttpHeaders":[]}',
    JSON.stringify([CANARY]),
    CANARY,
    Buffer.from([0xff, 0xfe]),
    "x".repeat(1024 * 1024 + 1),
  ]) {
    await config(bytes);
    expect(
      createNativeComposeEngineIdentityObserver({ environment })
    ).toBeNull();
  }
  expect(requests).toHaveLength(0);
});
test("Docker config file and directory symlinks retain CLI before admission", async () => {
  const path = await config("{}");
  const target = join(root, "target.json");
  await rename(path, target);
  await symlink(target, path);
  expect(createNativeComposeEngineIdentityObserver({ environment })).toBeNull();
  await unlink(path);
  await rename(target, path);
  const alias = join(root, "alias-client");
  await symlink(join(root, "client"), alias);
  environment.DOCKER_CONFIG = alias;
  expect(createNativeComposeEngineIdentityObserver({ environment })).toBeNull();
  environment.DOCKER_CONFIG = "./client";
  expect(createNativeComposeEngineIdentityObserver({ environment })).toBeNull();
  expect(requests).toHaveLength(0);
});
test("an admitted missing config cannot be replaced by a newly published configuration", async () => {
  const observe = await observer();
  await config("{}");
  await refusal(observe);
  expect(requests).toHaveLength(0);
});
test("a byte-identical replacement config still refuses its changed named inode", async () => {
  const path = await config("{}");
  const observe = await observer();
  await rename(path, join(root, "previous-config.json"));
  await writeFile(path, "{}", { mode: 0o600 });
  await refusal(observe);
  expect(requests).toHaveLength(0);
});
test("default HOME client-config selection is bound when DOCKER_CONFIG is absent", async () => {
  const directory = join(root, ".docker");
  await mkdir(directory);
  await writeFile(join(directory, "config.json"), "{}", { mode: 0o600 });
  environment.DOCKER_CONFIG = undefined;
  const observe = await observer();
  expect(await observe()).toBe(ENGINE);
  environment.HOME = join(root, "replacement-home");
  await refusal(observe);
  expect(requests).toHaveLength(1);
});
test("same-size configuration tamper with restored mtime refuses before any request", async () => {
  const path = await config(
    JSON.stringify({ auths: { synthetic: { auth: CANARY } } })
  );
  const before = await Bun.file(path).stat();
  const observe = await observer();
  const bytes = await readFile(path, "utf8");
  await writeFile(path, bytes.replace("canary", "mutate"));
  await utimes(path, before.atime, before.mtime);
  await refusal(observe);
  expect(requests).toHaveLength(0);
});
test("configuration changes during an otherwise successful ID reply refuse without fallback", async () => {
  const path = await config("{}");
  const observe = await observer();
  handler = (_req, res) => {
    void (async () => {
      await writeFile(
        path,
        JSON.stringify({ HttpHeaders: { Private: CANARY } })
      );
      res.end(JSON.stringify({ ID: ENGINE }));
    })();
  };
  await refusal(observe);
  expect(requests).toHaveLength(1);
});
test("changed selection refuses without querying the former endpoint", async () => {
  const observe = await observer();
  environment.DOCKER_CONTEXT = CANARY;
  await refusal(observe);
  expect(requests).toHaveLength(0);
});
test("socket replacement before a read refuses without contacting the replacement", async () => {
  const observe = await observer();
  await rename(socket, join(root, "original.sock"));
  await listen(socket);
  await refusal(observe);
  expect(requests).toHaveLength(0);
});
test("socket replacement while a response is in flight refuses its otherwise valid ID", async () => {
  const observe = await observer();
  handler = (_req, res) => {
    void (async () => {
      await rename(socket, join(root, "original.sock"));
      await listen(socket);
      res.end(JSON.stringify({ ID: ENGINE }));
    })();
  };
  await refusal(observe);
  expect(requests).toHaveLength(1);
});
test("a stable socket symlink is supported but replacement of that link refuses", async () => {
  const alias = join(root, "alias.sock");
  await symlink("engine.sock", alias);
  environment.DOCKER_HOST = `unix://${alias}`;
  const observe = await observer();
  expect(await observe()).toBe(ENGINE);
  await unlink(alias);
  await symlink("engine.sock", alias);
  await refusal(observe);
  expect(requests).toHaveLength(1);
});
test("ancestor symlink rebinding to the same target refuses", async () => {
  const alias = join(root, "alias");
  await symlink(root, alias);
  environment.DOCKER_HOST = `unix://${join(alias, "engine.sock")}`;
  const observe = await observer();
  await unlink(alias);
  await symlink(root, alias);
  await refusal(observe);
  expect(requests).toHaveLength(0);
});
test("unrelated sibling creation preserves the exact named socket and executable bindings", async () => {
  const observe = await observer();
  await writeFile(join(root, "unrelated-sibling"), "synthetic sibling");
  expect(await observe()).toBe(ENGINE);
  expect(requests).toHaveLength(1);
});
test("executable replacement refuses before a request", async () => {
  const observe = await observer();
  await rename(docker, join(root, "original-docker"));
  await writeFile(docker, "#!/bin/sh\nexit 98\n", { mode: 0o700 });
  await refusal(observe);
  expect(requests).toHaveLength(0);
});
test("a new earlier PATH executable refuses without selecting a different engine", async () => {
  const earlier = join(root, "earlier");
  await mkdir(earlier);
  environment.PATH = `${earlier}:${root}`;
  const observe = await observer();
  await writeFile(join(earlier, "docker"), "#!/bin/sh\nexit 98\n", {
    mode: 0o700,
  });
  await refusal(observe);
  expect(requests).toHaveLength(0);
});
test("same-size executable tamper with restored mtime still refuses", async () => {
  const observe = await observer();
  const before = await Bun.file(docker).stat();
  const bytes = await readFile(docker, "utf8");
  await writeFile(docker, bytes.replace("99", "98"));
  await utimes(docker, before.atime, before.mtime);
  await refusal(observe);
  expect(requests).toHaveLength(0);
});
test("unsupported and malformed HTTP responses refuse without CLI fallback", async () => {
  const spawn = spyOn(Bun, "spawn");
  try {
    for (const fixture of [
      {
        status: 301,
        body: JSON.stringify({ ID: ENGINE }),
        location: `http://${CANARY}.invalid`,
      },
      { status: 500, body: CANARY },
      { status: 200, body: CANARY },
      { status: 200, body: JSON.stringify({ ID: "" }) },
      { status: 200, body: JSON.stringify({ private: CANARY }) },
      { status: 200, body: JSON.stringify({ ID: 123, private: CANARY }) },
      { status: 200, body: JSON.stringify({ ID: "x".repeat(129) }) },
    ]) {
      const observe = await observer();
      handler = (_req, res) => {
        res.writeHead(
          fixture.status,
          fixture.location ? { Location: fixture.location } : {}
        );
        res.end(fixture.body);
      };
      await refusal(observe);
    }
    expect(requests).toHaveLength(7);
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    spawn.mockRestore();
  }
});
test("a missing own ID cannot borrow or execute an inherited ID getter", async () => {
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, "ID");
  let reads = 0;
  Object.defineProperty(Object.prototype, "ID", {
    configurable: true,
    get() {
      reads++;
      return ENGINE;
    },
  });
  try {
    const observe = await observer();
    handler = (_req, res) => res.end(JSON.stringify({ private: CANARY }));
    await refusal(observe);
    expect(reads).toBe(0);
    expect(requests).toHaveLength(1);
  } finally {
    if (previous) {
      Object.defineProperty(Object.prototype, "ID", previous);
    } else {
      Reflect.deleteProperty(Object.prototype, "ID");
    }
  }
});
test("encoded, non-UTF8, truncated and oversized bodies refuse with no private diagnostics", async () => {
  for (const mode of ["encoding", "utf8", "truncated", "overflow"]) {
    const observe = await observer({ timeoutMs: 1000 });
    handler = (_req, res) => {
      if (mode === "encoding") {
        res.setHeader("Content-Encoding", "gzip");
        res.end(CANARY);
      } else if (mode === "utf8") {
        res.end(Buffer.from([0xff, 0xfe]));
      } else if (mode === "truncated") {
        res.writeHead(200, { "Content-Length": 100 });
        res.write("{}");
        res.socket?.destroy();
      } else {
        res.end("x".repeat(8 * 1024 * 1024 + 1));
      }
    };
    await refusal(observe);
  }
});
test("repeated reads share the cumulative response budget rather than reset it", async () => {
  const observe = await observer();
  handler = (_req, res) =>
    res.end(
      JSON.stringify({ ID: ENGINE, padding: "x".repeat(5 * 1024 * 1024) })
    );
  expect(await observe()).toBe(ENGINE);
  await refusal(observe);
  expect(requests).toHaveLength(2);
});
test("a concurrent read refuses without opening another request or disarming the active read", async () => {
  const observe = await observer();
  let accepted: (() => void) | undefined;
  let response: ServerResponse | undefined;
  const started = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  handler = (_req, res) => {
    response = res;
    accepted?.();
  };
  const pending = observe();
  await started;
  await refusal(observe);
  expect(requests).toHaveLength(1);
  response?.end(JSON.stringify({ ID: ENGINE }));
  expect(await pending).toBe(ENGINE);
});
test("caller cancellation destroys the owned connection and never accepts a hanging response", async () => {
  const abort = new AbortController();
  const observe = await observer({ signal: abort.signal });
  let accepted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  handler = () => accepted?.();
  const pending = refusal(observe);
  await started;
  abort.abort(CANARY);
  await pending;
  const closed = Date.now() + 1000;
  while (
    [...connections].some((peer) => !peer.destroyed) &&
    Date.now() < closed
  ) {
    await Bun.sleep(5);
  }
  expect([...connections].every((peer) => peer.destroyed)).toBe(true);
});
test("expired deadline refuses a hanging real connection", async () => {
  const observe = await observer({ timeoutMs: 80 });
  handler = () => undefined;
  await refusal(observe);
  expect(requests).toHaveLength(1);
});
test("a successfully received response observed after the deadline is refused", async () => {
  const realNow = Date.now;
  let late = false;
  const clock = spyOn(Date, "now").mockImplementation(
    () => realNow() + (late ? 20_000 : 0)
  );
  try {
    const observe = await observer();
    handler = (_req, res) => {
      late = true;
      res.end(JSON.stringify({ ID: ENGINE }));
    };
    await refusal(observe);
    expect(requests).toHaveLength(1);
  } finally {
    clock.mockRestore();
  }
});
test("Unix transport ignores ambient HTTP proxies and does not send private headers", async () => {
  const keys = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ] as const;
  const before = keys.map((key) => process.env[key]);
  try {
    for (const key of keys) {
      process.env[key] = `http://${CANARY}.invalid:3128`;
    }
    let headers: Record<string, unknown> = {};
    handler = (req, res) => {
      headers = { ...req.headers };
      res.end(JSON.stringify({ ID: ENGINE }));
    };
    expect(await (await observer())()).toBe(ENGINE);
    expect(JSON.stringify(headers)).not.toContain(CANARY);
    expect(headers.authorization).toBeUndefined();
    expect(headers["proxy-authorization"]).toBeUndefined();
  } finally {
    for (const [index, key] of keys.entries()) {
      restoreEnv(key, before[index]);
    }
  }
});
test("ingress still compares fresh daemon IDs and never substitutes CLI info after direct admission", async () => {
  await writeFile(
    docker,
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(root, "commands"))}, JSON.stringify(args) + "\\n");
if (args[0] === "info") process.exit(99);
if (args[0] === "network") console.log(JSON.stringify({id:${JSON.stringify(NETWORK)}, name:"hack-dev"}));
else if (args[1] === "ls") console.log(JSON.stringify(${JSON.stringify(PROXY)}));
else console.log(JSON.stringify({id:${JSON.stringify(PROXY)}, project:"hack-dev-proxy", service:"caddy", running:true, network:${JSON.stringify(NETWORK)}, ip:"172.29.0.2"}));
`
  );
  await chmod(docker, 0o700);
  const keys = [
    "PATH",
    "DOCKER_CONFIG",
    "HOME",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_TLS",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CUSTOM_HEADERS",
    "DOCKER_CERT_PATH",
    "DOCKER_API_VERSION",
  ] as const;
  const before = keys.map((key) => process.env[key]);
  try {
    process.env.PATH = root;
    process.env.DOCKER_CONFIG = environment.DOCKER_CONFIG;
    process.env.HOME = environment.HOME;
    process.env.DOCKER_HOST = environment.DOCKER_HOST;
    for (const key of keys.slice(4)) {
      delete process.env[key];
    }
    const observed = await observeNativeComposeIngress();
    expect(observed.engineId).toBe(ENGINE);
    expect(requests).toHaveLength(2);
    expect(
      (await readFile(join(root, "commands"), "utf8")).trim().split("\n")
    ).toHaveLength(6);
    handler = (_req, res) =>
      res.end(
        JSON.stringify({
          ID: requests.length % 2 ? "replacement-engine" : ENGINE,
        })
      );
    await expect(observeNativeComposeIngress()).rejects.toBeInstanceOf(
      NativeComposeRoutingError
    );
    expect(
      (await readFile(join(root, "commands"), "utf8"))
        .split("\n")
        .some((line) => line.includes('"info"'))
    ).toBe(false);
    const reads = requests.length;
    process.env.DOCKER_API_VERSION = "1.44";
    await expect(observeNativeComposeIngress()).rejects.toBeInstanceOf(
      NativeComposeRoutingError
    );
    expect(requests).toHaveLength(reads);
    expect(
      (await readFile(join(root, "commands"), "utf8")).trim().split("\n").at(-1)
    ).toContain('"info"');
  } finally {
    for (const [index, key] of keys.entries()) {
      restoreEnv(key, before[index]);
    }
  }
});

test("pure socket path binding accepts a real Unix leaf without querying an engine or spawning", () => {
  const spawn = spyOn(Bun, "spawn");
  try {
    const bound = bindNativeComposeEngineSocketPath(socket);
    expect(bound.path).toBe(socket);
    expect(() => bound.assertFresh()).not.toThrow();
    expect(Object.isFrozen(bound)).toBe(true);
    expect(Object.keys(bound)).toEqual(["path", "assertFresh"]);
    expect(requests).toHaveLength(0);
    expect(connections.size).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    spawn.mockRestore();
  }
});
test("pure socket path binding pins alias identity and refuses retargeting before a query", async () => {
  const other = join(root, "other.sock"),
    alias = join(root, "pure-alias.sock");
  await listen(other);
  await symlink("engine.sock", alias);
  const bound = bindNativeComposeEngineSocketPath(alias);
  expect(bound.path).toBe(socket);
  await unlink(alias);
  await symlink("other.sock", alias);
  expect(() => bound.assertFresh()).toThrow(NativeComposeEngineIdentityError);
  expect(requests).toHaveLength(0);
});
test("pure socket path binding refuses ancestor rebinding even to the same target", async () => {
  const alias = join(root, "pure-parent");
  await symlink(root, alias);
  const bound = bindNativeComposeEngineSocketPath(join(alias, "engine.sock"));
  await unlink(alias);
  await symlink(root, alias);
  expect(() => bound.assertFresh()).toThrow(NativeComposeEngineIdentityError);
  expect(requests).toHaveLength(0);
});
test("pure socket path binding refuses physical replacement and unchanged-name wrong type", async () => {
  const bound = bindNativeComposeEngineSocketPath(socket);
  await rename(socket, join(root, "pure-original.sock"));
  await listen(socket);
  expect(() => bound.assertFresh()).toThrow(NativeComposeEngineIdentityError);
  const replacement = bindNativeComposeEngineSocketPath(socket);
  await rename(socket, join(root, "pure-replacement.sock"));
  await writeFile(socket, "not a socket", { mode: 0o600 });
  expect(() => replacement.assertFresh()).toThrow(
    NativeComposeEngineIdentityError
  );
  expect(() => bindNativeComposeEngineSocketPath(socket)).toThrow(
    NativeComposeEngineIdentityError
  );
  expect(requests).toHaveLength(0);
});
test("pure socket path binding pins mode and refuses ambiguous or relative selection", async () => {
  const bound = bindNativeComposeEngineSocketPath(socket);
  await chmod(socket, 0o600);
  const changed = bindNativeComposeEngineSocketPath(socket);
  await chmod(socket, 0o660);
  expect(() => changed.assertFresh()).toThrow(NativeComposeEngineIdentityError);
  for (const path of [
    "engine.sock",
    `${socket}?query`,
    `${socket}\0`,
    join(root, "missing.sock"),
  ]) {
    expect(() => bindNativeComposeEngineSocketPath(path)).toThrow(
      NativeComposeEngineIdentityError
    );
  }
  expect(bound.path).toBe(socket);
  expect(requests).toHaveLength(0);
});

// Command-scoped storage-witness admissions. A CLI stand-in counts each Docker
// CLI fence; the real Unix server counts each direct fence.
function cliStandIn(id: () => string = () => ENGINE) {
  let calls = 0;
  return {
    calls: () => calls,
    read: () => {
      calls++;
      return Promise.resolve(`${JSON.stringify(id())}\n`);
    },
  };
}
function fence(
  admissions: ReturnType<typeof createNativeComposeEngineIdentityAdmissions>,
  cli: ReturnType<typeof cliStandIn>
) {
  return admissions({ cli: cli.read, timeoutMs: 5000, environment });
}
/**
 * No test dials the CLI's built-in default socket: the `default` context's
 * endpoint is a fixture path, absent unless a test listens on it.
 */
function createAdmissions(defaultSocketPath = join(root, "default.sock")) {
  return createNativeComposeEngineIdentityAdmissions({ defaultSocketPath });
}
test("storage fences answer the first one with the CLI and admit only an equal direct ID", async () => {
  const admissions = createAdmissions();
  const cli = cliStandIn();
  expect(await fence(admissions, cli)).toBe(`"${ENGINE}"\n`);
  expect([cli.calls(), requests.length]).toEqual([1, 1]);
  for (let index = 0; index < 3; index++) {
    expect(await fence(admissions, cli)).toBe(`"${ENGINE}"\n`);
  }
  // One fresh direct request per later fence; no further CLI process.
  expect([cli.calls(), requests.length, connections.size]).toEqual([1, 4, 4]);
});
test("a changed daemon ID between two admitted fences is returned, never cached", async () => {
  const admissions = createAdmissions();
  const cli = cliStandIn();
  await fence(admissions, cli);
  expect(await fence(admissions, cli)).toBe(`"${ENGINE}"\n`);
  handler = (_req, res) =>
    res.end(JSON.stringify({ ID: "replacement-engine", private: CANARY }));
  expect(await fence(admissions, cli)).toBe('"replacement-engine"\n');
  handler = (_req, res) => res.end(JSON.stringify({ ID: ENGINE }));
  expect(await fence(admissions, cli)).toBe(`"${ENGINE}"\n`);
  expect([cli.calls(), requests.length]).toEqual([1, 4]);
});
test("a different or failed admission read keeps the CLI for that binding", async () => {
  for (const reply of [
    (_req: IncomingMessage, res: ServerResponse) =>
      res.end(JSON.stringify({ ID: "other-engine" })),
    (_req: IncomingMessage, res: ServerResponse) => {
      res.statusCode = 500;
      res.end();
    },
  ]) {
    handler = reply;
    requests = [];
    const admissions = createAdmissions();
    const cli = cliStandIn();
    for (let index = 0; index < 3; index++) {
      expect(await fence(admissions, cli)).toBe(`"${ENGINE}"\n`);
    }
    expect([cli.calls(), requests.length]).toEqual([3, 1]);
  }
});
test("admitted direct failures refuse without CLI fallback", async () => {
  const admissions = createAdmissions();
  const cli = cliStandIn();
  await fence(admissions, cli);
  handler = (_req, res) => {
    res.statusCode = 500;
    res.end(CANARY);
  };
  await refusal(() => fence(admissions, cli));
  expect([cli.calls(), requests.length]).toEqual([1, 2]);
});
test("a moved config, socket or executable binding is admitted through the CLI again", async () => {
  const path = await config("{}");
  const admissions = createAdmissions();
  const cli = cliStandIn();
  await fence(admissions, cli);
  await fence(admissions, cli);
  expect([cli.calls(), requests.length]).toEqual([1, 2]);
  await rename(path, join(root, "previous-config.json"));
  await writeFile(path, "{}", { mode: 0o600 });
  await fence(admissions, cli);
  await fence(admissions, cli);
  expect([cli.calls(), requests.length]).toEqual([2, 4]);
  await rename(socket, join(root, "original.sock"));
  await listen(socket);
  await fence(admissions, cli);
  await fence(admissions, cli);
  expect([cli.calls(), requests.length]).toEqual([3, 6]);
  await rename(docker, join(root, "original-docker"));
  await writeFile(docker, "#!/bin/sh\nexit 98\n", { mode: 0o700 });
  await fence(admissions, cli);
  await fence(admissions, cli);
  expect([cli.calls(), requests.length]).toEqual([4, 8]);
});
test("ineligible or unbindable selections and CLI admission failures stay on the CLI", async () => {
  for (const selection of [
    // The default context, whose fixture socket is absent.
    { DOCKER_HOST: undefined },
    // DOCKER_HOST with DOCKER_CONTEXT is treated as ambiguous.
    { DOCKER_CONTEXT: "selected-context" },
    { DOCKER_HOST: undefined, DOCKER_CONTEXT: "selected-context" },
    { DOCKER_HOST: `unix://${join(root, "missing.sock")}` },
  ]) {
    const admissions = createAdmissions();
    const cli = cliStandIn();
    for (let index = 0; index < 2; index++) {
      expect(
        await admissions({
          cli: cli.read,
          timeoutMs: 5000,
          environment: { ...environment, ...selection },
        })
      ).toBe(`"${ENGINE}"\n`);
    }
    expect(cli.calls()).toBe(2);
  }
  expect(requests).toHaveLength(0);
  const admissions = createAdmissions();
  const failure = new Error("synthetic CLI fence failure");
  await expect(
    admissions({
      cli: () => Promise.reject(failure),
      timeoutMs: 5000,
      environment,
    })
  ).rejects.toBe(failure);
  // A failed CLI admission records nothing: the next fence admits again.
  const cli = cliStandIn();
  await fence(admissions, cli);
  await fence(admissions, cli);
  expect([cli.calls(), requests.length]).toEqual([1, 2]);
});
/** The storage probe snapshots process.env, like the CLI probe it wraps. */
async function withSelectedProcessEnvironment(body: () => Promise<void>) {
  const keys = [
    "PATH",
    "HOME",
    "DOCKER_HOST",
    "DOCKER_CONFIG",
    "DOCKER_CONTEXT",
    "DOCKER_TLS",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CUSTOM_HEADERS",
    "DOCKER_CERT_PATH",
    "DOCKER_API_VERSION",
  ] as const;
  const before = keys.map((key) => process.env[key]);
  try {
    for (const key of keys) {
      restoreEnv(key, environment[key]);
    }
    await body();
  } finally {
    for (const [index, key] of keys.entries()) {
      restoreEnv(key, before[index]);
    }
  }
}
test("cancelling an admitted direct fence keeps the CLI probe's closed cancellation without a process", async () => {
  await withSelectedProcessEnvironment(async () => {
    const admissions = createAdmissions();
    await fence(admissions, cliStandIn());
    const controller = new AbortController();
    const probe = nativeComposeStorageIdentityProbe({
      probe: createNativeComposeProbe({
        signal: controller.signal,
        timeoutMs: 5000,
      }),
      signal: controller.signal,
      timeoutMs: 5000,
      admissions,
    });
    handler = () => controller.abort();
    const spawn = spyOn(Bun, "spawn");
    try {
      await expect(
        probe(["info", "--format", "{{json .ID}}"])
      ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_PROBE_CANCELLED" });
      expect(spawn).not.toHaveBeenCalled();
      expect(requests).toHaveLength(2);
    } finally {
      spawn.mockRestore();
    }
  });
});
test("storage identity probe routes only the exact engine-ID query", async () => {
  const routed: string[] = [];
  await withSelectedProcessEnvironment(async () => {
    const admissions = createAdmissions();
    const probe = nativeComposeStorageIdentityProbe({
      probe: (args) => {
        routed.push(args.join(" "));
        return Promise.resolve(`${JSON.stringify(ENGINE)}\n`);
      },
      timeoutMs: 5000,
      admissions,
    });
    for (const args of [
      ["info", "--format", "{{json .ID}}"],
      ["info", "--format", "{{json .ID}}"],
      ["info", "--format", '{"id":{{json .ID}}}'],
      ["volume", "ls", "--format", "{{json .Name}}"],
    ]) {
      await probe(args);
    }
    expect(routed).toEqual([
      "info --format {{json .ID}}",
      'info --format {"id":{{json .ID}}}',
      "volume ls --format {{json .Name}}",
    ]);
    expect(requests).toHaveLength(2);
  });
});

// Docker context selections (DOCKER_HOST unset): the default context, the
// client config's currentContext and DOCKER_CONTEXT. Only admissions resolve
// them; the explicit observer, trusted without a CLI comparison, never does.
const CLIENT_CONTEXT = "fixture-context";
function contextId(name: string): string {
  return createHash("sha256").update(name).digest("hex");
}
async function storeContext(name: string, host: string): Promise<string> {
  const directory = join(root, "client", "contexts", "meta", contextId(name));
  await mkdir(directory, { recursive: true });
  const path = join(directory, "meta.json");
  await writeFile(
    path,
    JSON.stringify({
      Name: name,
      Metadata: {},
      Endpoints: { docker: { Host: host, SkipTLSVerify: false } },
    })
  );
  return path;
}
/** Select the fixture engine through the client config's currentContext. */
async function contextSelection(): Promise<{
  readonly config: string;
  readonly meta: string;
}> {
  environment.DOCKER_HOST = undefined;
  const meta = await storeContext(CLIENT_CONTEXT, `unix://${socket}`);
  const path = await config(JSON.stringify({ currentContext: CLIENT_CONTEXT }));
  return { config: path, meta };
}
/** A second engine with its own request count. */
async function otherEngine(id: string) {
  const path = join(root, "other.sock");
  let served = 0;
  const server = createServer((_req, res) => {
    served++;
    res.end(JSON.stringify({ ID: id }));
  });
  server.on("connection", (peer) => connections.add(peer));
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  return { path, served: () => served };
}

test("context selections admit through the CLI, then read that context's socket", async () => {
  await contextSelection();
  for (const selection of [
    {},
    // DOCKER_CONTEXT names the same store entry over an unrelated currentContext.
    { DOCKER_CONTEXT: CLIENT_CONTEXT },
  ]) {
    if ("DOCKER_CONTEXT" in selection) {
      await config(JSON.stringify({ currentContext: "unrelated-context" }));
    }
    requests = [];
    const admissions = createAdmissions();
    const cli = cliStandIn();
    for (let index = 0; index < 4; index++) {
      expect(
        await admissions({
          cli: cli.read,
          timeoutMs: 5000,
          environment: { ...environment, ...selection },
        })
      ).toBe(`"${ENGINE}"\n`);
    }
    expect([cli.calls(), requests.length]).toEqual([1, 4]);
  }
});
test("the default context admits its own endpoint, never a store entry named default", async () => {
  environment.DOCKER_HOST = undefined;
  await config("{}");
  const admissions = createAdmissions(socket);
  const cli = cliStandIn();
  for (let index = 0; index < 3; index++) {
    await fence(admissions, cli);
  }
  expect([cli.calls(), requests.length]).toEqual([1, 3]);
  const other = await otherEngine(ENGINE);
  await storeContext("default", `unix://${other.path}`);
  environment.DOCKER_CONTEXT = "default";
  const named = createAdmissions(socket);
  await fence(named, cli);
  await fence(named, cli);
  expect([cli.calls(), requests.length, other.served()]).toEqual([2, 5, 0]);
});
test("DOCKER_HOST takes precedence: a current context never redirects the direct read", async () => {
  const other = await otherEngine("other-engine");
  await storeContext(CLIENT_CONTEXT, `unix://${other.path}`);
  await config(JSON.stringify({ currentContext: CLIENT_CONTEXT }));
  const admissions = createAdmissions();
  const cli = cliStandIn();
  for (let index = 0; index < 3; index++) {
    expect(await fence(admissions, cli)).toBe(`"${ENGINE}"\n`);
  }
  expect([cli.calls(), requests.length, other.served()]).toEqual([1, 3, 0]);
});
test("a context naming another engine than the CLI's read is never admitted", async () => {
  const { meta } = await contextSelection();
  const other = await otherEngine("other-engine");
  await writeFile(
    meta,
    JSON.stringify({
      Name: CLIENT_CONTEXT,
      Endpoints: { docker: { Host: `unix://${other.path}` } },
    })
  );
  const admissions = createAdmissions();
  const cli = cliStandIn();
  for (let index = 0; index < 3; index++) {
    expect(await fence(admissions, cli)).toBe(`"${ENGINE}"\n`);
  }
  expect([cli.calls(), requests.length, other.served()]).toEqual([3, 0, 1]);
});
test("a changed config, context entry, TLS directory, socket or executable admits through the CLI again", async () => {
  const selected = await contextSelection();
  const admissions = createAdmissions();
  const cli = cliStandIn();
  const twice = async (counts: readonly [number, number]) => {
    await fence(admissions, cli);
    await fence(admissions, cli);
    expect([cli.calls(), requests.length]).toEqual([...counts]);
  };
  await twice([1, 2]);
  // Same bytes under a new inode: the config, then the context store entry.
  for (const [index, path] of [selected.config, selected.meta].entries()) {
    const bytes = await readFile(path);
    await rename(path, join(root, `previous-${index}.json`));
    await writeFile(path, bytes);
    await twice([2 + index, 4 + 2 * index]);
  }
  // Published TLS material keeps the CLI while present; it is never opened.
  const tls = join(
    root,
    "client",
    "contexts",
    "tls",
    contextId(CLIENT_CONTEXT)
  );
  await mkdir(join(tls, "docker"), { recursive: true });
  await writeFile(join(tls, "docker", "key.pem"), CANARY, { mode: 0o000 });
  await twice([5, 6]);
  await rm(tls, { recursive: true });
  await twice([6, 8]);
  await rename(socket, join(root, "original.sock"));
  await listen(socket);
  await twice([7, 10]);
  await rename(docker, join(root, "original-docker"));
  await writeFile(docker, "#!/bin/sh\nexit 98\n", { mode: 0o700 });
  await twice([8, 12]);
});
test("a context store change during an admitted read refuses without fallback", async () => {
  const { meta } = await contextSelection();
  const admissions = createAdmissions();
  const cli = cliStandIn();
  await fence(admissions, cli);
  handler = (_req, res) => {
    void (async () => {
      await writeFile(
        meta,
        JSON.stringify({
          Name: CLIENT_CONTEXT,
          Endpoints: { docker: { Host: `unix://${join(root, "other.sock")}` } },
        })
      );
      res.end(JSON.stringify({ ID: ENGINE }));
    })();
  };
  await refusal(() => fence(admissions, cli));
  expect([cli.calls(), requests.length]).toEqual([1, 2]);
});
test("TLS, header and API-version environment keeps context selections on the CLI", async () => {
  await contextSelection();
  for (const selection of [
    { DOCKER_TLS: "1" },
    { DOCKER_TLS_VERIFY: "1" },
    { DOCKER_CERT_PATH: join(root, "certificates") },
    { DOCKER_CUSTOM_HEADERS: `Private=${CANARY}` },
    { DOCKER_API_VERSION: "1.44" },
  ]) {
    for (const context of [{}, { DOCKER_CONTEXT: "default" }]) {
      const admissions = createAdmissions(socket);
      const cli = cliStandIn();
      for (let index = 0; index < 2; index++) {
        await admissions({
          cli: cli.read,
          timeoutMs: 5000,
          environment: { ...environment, ...selection, ...context },
        });
      }
      expect(cli.calls()).toBe(2);
    }
  }
  expect(requests).toHaveLength(0);
});
test("the explicit observer never resolves a context or the default context", async () => {
  await contextSelection();
  expect(createNativeComposeEngineIdentityObserver({ environment })).toBeNull();
  environment.DOCKER_CONTEXT = CLIENT_CONTEXT;
  expect(createNativeComposeEngineIdentityObserver({ environment })).toBeNull();
  await config("{}");
  environment.DOCKER_CONTEXT = undefined;
  expect(createNativeComposeEngineIdentityObserver({ environment })).toBeNull();
  expect(requests).toHaveLength(0);
});
