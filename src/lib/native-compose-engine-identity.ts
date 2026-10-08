import { lstatSync, readlinkSync, type Stats } from "node:fs";
import { request } from "node:http";
import { dirname, isAbsolute, join, normalize, parse } from "node:path";
import { isRecord } from "./guards.ts";
import { bindNativeComposeEngineConfig } from "./native-compose-engine-config.ts";

const ENGINE_ID = /^[A-Za-z0-9:-]{1,128}$/;
const AMBIGUOUS_PATH = /[%?#\0\r\n]/;
const RESPONSE_LIMIT = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const SELECTION = [
  "PATH",
  "HOME",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_TLS",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CUSTOM_HEADERS",
  "DOCKER_CERT_PATH",
  "DOCKER_API_VERSION",
] as const;
type Environment = Readonly<Record<string, string | undefined>>;
type PathEntry = {
  readonly path: string;
  readonly identity: readonly number[];
  readonly target: string | null;
};
type Binding = {
  readonly canonical: string;
  readonly entries: readonly PathEntry[];
};

/** Never retain the endpoint, system-info fields, transport error or abort reason. */
export class NativeComposeEngineIdentityError extends Error {
  readonly code = "E_NATIVE_COMPOSE_ENGINE_ID";
  constructor() {
    super(
      "Native Compose engine identity could not be inspected; values omitted."
    );
    this.name = "NativeComposeEngineIdentityError";
  }
}
function refuse(): never {
  throw new NativeComposeEngineIdentityError();
}
function requireValue(value: unknown): asserts value {
  if (!value) {
    refuse();
  }
}
function selection(environment: Environment): readonly (string | undefined)[] {
  return SELECTION.map((key) => environment[key]);
}
function identity(info: Stats): readonly number[] {
  return [
    info.dev,
    info.ino,
    info.mode,
    info.uid,
    info.gid,
    // Directory metadata changes when unrelated siblings are created (including
    // nlink on APFS). Pin the named directory itself, not its whole contents.
    ...(info.isDirectory()
      ? []
      : [info.nlink, info.size, info.mtimeMs, info.ctimeMs]),
  ];
}
function bindPath(path: string, kind: "socket" | "executable"): Binding {
  requireValue(isAbsolute(path));
  let current = parse(path).root;
  const pending = path.slice(current.length).split("/");
  const entries: PathEntry[] = [];
  let links = 0;
  while (pending.length > 0) {
    const component = pending.shift();
    if (!component || component === ".") {
      continue;
    }
    if (component === "..") {
      current = dirname(current);
      continue;
    }
    const named = join(current, component);
    // Bun 1.4.2's async lstat and realpath reject Unix sockets. This synchronous
    // component walk also records every intermediate named symlink identity.
    const before = lstatSync(named);
    const target = before.isSymbolicLink() ? readlinkSync(named) : null;
    requireValue(
      JSON.stringify(identity(before)) ===
        JSON.stringify(identity(lstatSync(named)))
    );
    entries.push({ path: named, identity: identity(before), target });
    if (target !== null) {
      // Match the OS symlink-loop bound, not a workload resource limit.
      requireValue(++links <= 40);
      if (isAbsolute(target)) {
        current = parse(target).root;
      }
      pending.unshift(...target.split("/"));
    } else {
      requireValue(pending.length === 0 || before.isDirectory());
      current = named;
    }
  }
  const info = lstatSync(current);
  requireValue(
    (info.uid === 0 || info.uid === process.getuid?.()) &&
      (kind === "socket"
        ? info.isSocket()
        : info.isFile() && Boolean(info.mode & 0o111))
  );
  return { canonical: current, entries };
}
function sameBinding(left: Binding, right: Binding): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function check(signal: AbortSignal | undefined, deadline: number): void {
  requireValue(!signal?.aborted && Date.now() < deadline);
}
function localEndpoint(environment: Environment): string | null {
  if (
    process.platform === "win32" ||
    environment.DOCKER_CONTEXT ||
    environment.DOCKER_TLS ||
    environment.DOCKER_TLS_VERIFY ||
    environment.DOCKER_CUSTOM_HEADERS ||
    environment.DOCKER_CERT_PATH ||
    environment.DOCKER_API_VERSION
  ) {
    return null;
  }
  const host = environment.DOCKER_HOST;
  if (!host?.startsWith("unix:///")) {
    return null;
  }
  const path = host.slice("unix://".length);
  // Ambiguous URL spelling keeps the existing Docker CLI selection semantics.
  return AMBIGUOUS_PATH.test(path) ||
    !isAbsolute(path) ||
    normalize(path) !== path
    ? null
    : path;
}

function readId(opts: {
  readonly socketPath: string;
  readonly signal?: AbortSignal;
  readonly deadline: number;
  readonly limit: number;
}): Promise<{ readonly id: string; readonly bytes: number }> {
  check(opts.signal, opts.deadline);
  return new Promise((resolve, reject) => {
    let settled = false;
    let size = 0;
    const chunks: Uint8Array[] = [];
    const client = request({
      socketPath: opts.socketPath,
      method: "GET",
      path: "/info",
      agent: false,
      headers: {
        Host: "docker",
        Connection: "close",
        Accept: "application/json",
      },
    });
    const fail = () => finish();
    const timer = setTimeout(fail, Math.max(1, opts.deadline - Date.now()));
    function finish(id?: string): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", fail);
      client.destroy();
      if (id === undefined) {
        reject(new NativeComposeEngineIdentityError());
      } else {
        resolve({ id, bytes: size });
      }
    }
    opts.signal?.addEventListener("abort", fail, { once: true });
    client.on("error", fail);
    client.on("response", (response) => {
      if (
        response.statusCode !== 200 ||
        (response.headers["content-encoding"] !== undefined &&
          response.headers["content-encoding"] !== "identity")
      ) {
        response.destroy();
        fail();
        return;
      }
      response.on("error", fail);
      response.on("aborted", fail);
      response.on("data", (chunk: unknown) => {
        if (settled) {
          return;
        }
        if (!(chunk instanceof Uint8Array)) {
          response.destroy();
          fail();
          return;
        }
        size += chunk.byteLength;
        if (size > opts.limit) {
          response.destroy();
          fail();
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          check(opts.signal, opts.deadline);
          requireValue(response.complete);
          const value: unknown = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              Buffer.concat(chunks, size)
            )
          );
          requireValue(
            isRecord(value) &&
              Object.hasOwn(value, "ID") &&
              typeof value.ID === "string" &&
              ENGINE_ID.test(value.ID)
          );
          finish(value.ID);
        } catch {
          fail();
        }
      });
    });
    if (opts.signal?.aborted) {
      fail();
    } else {
      client.end();
    }
  });
}

/**
 * Replace only `docker info` transport for an explicit local Unix selection.
 * Every call makes a fresh bounded daemon-ID request; no result is cached. Other
 * selections return null before admission and retain their existing CLI path.
 * Admitted errors never fall back. Socket, executable and selection bindings are
 * checked before and after each request under the caller's existing time budget.
 */
export function createNativeComposeEngineIdentityObserver(
  opts: {
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly environment?: Environment;
  } = {}
): (() => Promise<string>) | null {
  const environment = opts.environment ?? process.env;
  const signal = opts.signal;
  const selected = selection(environment);
  const path = localEndpoint(environment);
  if (path === null) {
    return null;
  }
  try {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    requireValue(
      Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 60_000
    );
    const deadline = Date.now() + timeoutMs;
    check(signal, deadline);
    const config = bindNativeComposeEngineConfig(environment);
    if (config === null) {
      return null;
    }
    const binary = Bun.which("docker", { PATH: environment.PATH ?? "" });
    requireValue(binary);
    const socket = bindPath(path, "socket");
    const executable = bindPath(binary, "executable");
    let remaining = RESPONSE_LIMIT;
    let reading = false;
    const recheck = () => {
      check(signal, deadline);
      requireValue(
        JSON.stringify(selected) === JSON.stringify(selection(environment))
      );
      requireValue(
        Bun.which("docker", { PATH: environment.PATH ?? "" }) === binary
      );
      requireValue(
        JSON.stringify(config) ===
          JSON.stringify(bindNativeComposeEngineConfig(environment))
      );
      requireValue(sameBinding(socket, bindPath(path, "socket")));
      requireValue(sameBinding(executable, bindPath(binary, "executable")));
      check(signal, deadline);
    };
    recheck();
    return async () => {
      if (reading) {
        return refuse();
      }
      reading = true;
      try {
        recheck();
        const result = await readId({
          socketPath: socket.canonical,
          signal,
          deadline,
          limit: remaining,
        });
        remaining -= result.bytes;
        recheck();
        return result.id;
      } catch {
        return refuse();
      } finally {
        reading = false;
      }
    };
  } catch {
    return refuse();
  }
}
