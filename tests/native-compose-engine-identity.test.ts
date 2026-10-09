import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
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
  createNativeComposeEngineIdentityObserver,
  NativeComposeEngineIdentityError,
} from "../src/lib/native-compose-engine-identity.ts";
import { observeNativeComposeIngress } from "../src/lib/native-compose-ingress.ts";
import { NativeComposeRoutingError } from "../src/lib/native-compose-routing.ts";
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
