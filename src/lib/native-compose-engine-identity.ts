import { lstatSync, readlinkSync, type Stats } from "node:fs";
import { request } from "node:http";
import { dirname, isAbsolute, join, normalize, parse } from "node:path";
import {
  DOCKER_DEFAULT_UNIX_SOCKET,
  dockerUnixHostPath,
  resolveDockerContextEndpoint,
} from "./docker-context.ts";
import { isRecord } from "./guards.ts";
import { bindNativeComposeEngineConfig } from "./native-compose-engine-config.ts";
import { x01Mark, x01Time } from "./x01-cost-probe.ts";

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
/**
 * Pure filesystem binding only: this neither admits an engine nor performs a
 * probe. Reuses the transport owner's bounded component walk because Bun's
 * async realpath rejects a Unix-socket leaf on macOS. All named ancestor/link
 * and final socket identity facts are rechecked by assertFresh.
 */
export function bindNativeComposeEngineSocketPath(path: string): {
  readonly path: string;
  readonly assertFresh: () => void;
} {
  try {
    requireValue(
      typeof path === "string" &&
        !AMBIGUOUS_PATH.test(path) &&
        normalize(path) === path
    );
    const bound = bindPath(path, "socket");
    return Object.freeze({
      path: bound.canonical,
      assertFresh: () => {
        try {
          requireValue(sameBinding(bound, bindPath(path, "socket")));
        } catch {
          refuse();
        }
      },
    });
  } catch {
    return refuse();
  }
}

function check(signal: AbortSignal | undefined, deadline: number): void {
  requireValue(!signal?.aborted && Date.now() < deadline);
}
/** TLS, certificate, header and API-version selections always keep the CLI. */
function transportSelected(environment: Environment): boolean {
  return Boolean(
    process.platform === "win32" ||
      environment.DOCKER_TLS ||
      environment.DOCKER_TLS_VERIFY ||
      environment.DOCKER_CUSTOM_HEADERS ||
      environment.DOCKER_CERT_PATH ||
      environment.DOCKER_API_VERSION
  );
}
/** An explicit Unix DOCKER_HOST with no context selection, else null. */
function explicitEndpoint(environment: Environment): string | null {
  const host = environment.DOCKER_HOST;
  // Ambiguous URL spelling keeps the existing Docker CLI selection semantics.
  return transportSelected(environment) || environment.DOCKER_CONTEXT || !host
    ? null
    : dockerUnixHostPath(host);
}
type Contexts = { readonly defaultSocketPath: string } | null;
/**
 * Endpoint selection under one config binding. Explicit observers accept only an
 * explicit Unix DOCKER_HOST; admissions resolve the CLI's full context
 * selection. Both return null for every other selection.
 */
function selectEndpoint(opts: {
  readonly environment: Environment;
  readonly currentContext: string | null;
  readonly contexts: Contexts;
}): { readonly socketPath: string; readonly binding: unknown } | null {
  if (opts.contexts === null) {
    const path = explicitEndpoint(opts.environment);
    return path === null ? null : { socketPath: path, binding: ["host"] };
  }
  return transportSelected(opts.environment)
    ? null
    : resolveDockerContextEndpoint({
        environment: opts.environment,
        currentContext: opts.currentContext,
        defaultSocketPath: opts.contexts.defaultSocketPath,
      });
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

type BoundObserver = {
  /** Opaque digest of the exact selection, executable, config and socket binding. */
  readonly key: string;
  readonly read: () => Promise<string>;
  /** TEMPORARY X04 measurement: closed selection kind label. */
  readonly kind: string;
};
function bindObserver(opts: {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly environment?: Environment;
  readonly contexts: Contexts;
}): BoundObserver | null {
  const environment = opts.environment ?? process.env;
  const signal = opts.signal;
  const selected = selection(environment);
  if (
    opts.contexts === null
      ? explicitEndpoint(environment) === null
      : transportSelected(environment)
  ) {
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
    const select = () =>
      selectEndpoint({
        environment,
        currentContext: config.currentContext,
        contexts: opts.contexts,
      });
    const endpoint = select();
    if (endpoint === null) {
      return null;
    }
    const path = endpoint.socketPath;
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
      // An unchanged config can still name another socket through a changed
      // context store entry or a newly created context TLS directory.
      requireValue(JSON.stringify(endpoint) === JSON.stringify(select()));
      requireValue(sameBinding(socket, bindPath(path, "socket")));
      requireValue(sameBinding(executable, bindPath(binary, "executable")));
      check(signal, deadline);
    };
    recheck();
    const key = new Bun.CryptoHasher("sha256")
      .update(
        JSON.stringify([selected, binary, config, endpoint, socket, executable])
      )
      .digest("hex");
    const label = Array.isArray(endpoint.binding)
      ? endpoint.binding[0]
      : undefined;
    return Object.freeze({
      key,
      kind:
        label === "host" || label === "default" || label === "context"
          ? label
          : "other",
      read: async () => {
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
      },
    });
  } catch {
    return refuse();
  }
}

/**
 * Replace only `docker info` transport for an explicit local Unix selection.
 * Every call makes a fresh bounded daemon-ID request; no result is cached. Other
 * selections, including every Docker context selection, return null before
 * admission and retain their existing CLI path: this observer is trusted
 * without a CLI comparison. Admitted errors never fall back. Socket, executable
 * and selection bindings are checked before and after each request under the
 * caller's existing time budget.
 */
export function createNativeComposeEngineIdentityObserver(
  opts: {
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly environment?: Environment;
  } = {}
): (() => Promise<string>) | null {
  return bindObserver({ ...opts, contexts: null })?.read ?? null;
}

/**
 * Command-scoped transport for repeated `docker info --format '{{json .ID}}'`
 * fences. Each fence still makes exactly one fresh engine-ID read; no ID is cached.
 *
 * Eligible selections are those the Docker CLI resolves to a plain Unix socket:
 * an explicit Unix DOCKER_HOST, DOCKER_CONTEXT, the client config's
 * `currentContext`, or the `default` context (`resolveDockerContextEndpoint`).
 * Admission is per exact binding: the selection values, `docker` executable path
 * and identity, client-config path/content, the selected context store entry
 * and absent TLS directory, and socket path identities. The first fence under
 * an eligible binding returns the caller's own Docker CLI read and compares it
 * with one direct `GET /info` on the socket that selection names. Only an equal
 * ID admits that binding; a direct failure or a different ID keeps the CLI for
 * that binding for the rest of the command. Later fences under an admitted
 * binding use one fresh direct request each, and its failures refuse without
 * CLI fallback. A changed binding is a new binding and is admitted through the
 * CLI again. Ineligible selections, and bindings that cannot be established,
 * always use the CLI. The returned text has the CLI's `{{json .ID}}` line shape.
 *
 * `defaultSocketPath` is the `default` context's endpoint; only tests replace
 * the CLI's built-in default.
 */
export function createNativeComposeEngineIdentityAdmissions(
  options: { readonly defaultSocketPath?: string } = {}
): (opts: {
  readonly cli: () => Promise<string>;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly environment: Environment;
}) => Promise<string> {
  const admitted = new Map<string, boolean>();
  const contexts = {
    defaultSocketPath: options.defaultSocketPath ?? DOCKER_DEFAULT_UNIX_SOCKET,
  };
  return async (opts) => {
    let bound: BoundObserver | null;
    try {
      bound = bindObserver({
        signal: opts.signal,
        timeoutMs: opts.timeoutMs,
        environment: opts.environment,
        contexts,
      });
    } catch {
      bound = null;
    }
    if (bound === null) {
      return await opts.cli();
    }
    const state = admitted.get(bound.key);
    const direct = bound.read;
    if (state === true) {
      return `${JSON.stringify(await x01Time("ident", "direct", direct))}\n`;
    }
    const text = await opts.cli();
    if (state === undefined) {
      let equal = false;
      try {
        const value: unknown = JSON.parse(text);
        equal =
          typeof value === "string" &&
          value === (await x01Time("ident", "admission", direct));
      } catch {
        equal = false;
      }
      x01Mark("ident-admit", `${bound.kind}:${equal ? "admitted" : "refused"}`);
      admitted.set(bound.key, equal);
    }
    return text;
  };
}
