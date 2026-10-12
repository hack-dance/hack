import { isAbsolute, join, normalize } from "node:path";
import { isRecord } from "./guards.ts";
import {
  bindNativeComposeEngineAbsence,
  bindNativeComposeEngineDocument,
  foldNativeComposeEngineFields,
  nativeComposeDockerConfigDirectory,
} from "./native-compose-engine-config.ts";

type Environment = Readonly<Record<string, string | undefined>>;

/** The Docker CLI's built-in default endpoint on Unix (`client.DefaultDockerHost`). */
export const DOCKER_DEFAULT_UNIX_SOCKET = "/var/run/docker.sock";
/** The reserved name the CLI resolves from its flags and environment, never the store. */
const DEFAULT_CONTEXT = "default";
/** docker/cli `ValidateContextName`; other spellings keep the CLI. */
const CONTEXT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.+-]+$/;
const AMBIGUOUS_PATH = /[%?#\0\r\n]/;

/**
 * The Unix socket the Docker CLI would dial for one selection, and the
 * value-free facts that pin how it was selected. The facts are compared and
 * digested only; they are never displayed.
 */
export type DockerContextEndpoint = {
  readonly socketPath: string;
  readonly binding: unknown;
};

/**
 * Path of an unambiguous `unix:///absolute/path` host, else null. The CLI uses
 * the text after `unix://` verbatim; spellings it would trim, decode or
 * normalize are refused so that no other spelling can name a different socket.
 */
export function dockerUnixHostPath(host: string): string | null {
  if (!host.startsWith("unix:///")) {
    return null;
  }
  const path = host.slice("unix://".length);
  return AMBIGUOUS_PATH.test(path) ||
    path.trim() !== path ||
    !isAbsolute(path) ||
    normalize(path) !== path
    ? null
    : path;
}

/** sha256 of the context name: the store's directory name for that context. */
function contextId(name: string): string {
  return new Bun.CryptoHasher("sha256").update(name).digest("hex");
}

/**
 * The docker endpoint of a context's `meta.json`, matched the way the CLI's Go
 * decoder matches it: top-level and endpoint fields without case, endpoint map
 * keys exactly. Unknown fields, duplicate spellings, TLS options and any host
 * other than an unambiguous Unix socket keep the CLI.
 */
function inspectMeta(value: Record<string, unknown>): string | null {
  const fields = foldNativeComposeEngineFields(value, [
    "name",
    "metadata",
    "endpoints",
  ]);
  const name = fields?.get("name");
  const metadata = fields?.get("metadata");
  const endpoints = fields?.get("endpoints");
  if (
    fields === null ||
    (name !== undefined && typeof name !== "string") ||
    !(metadata === undefined || metadata === null || isRecord(metadata)) ||
    !isRecord(endpoints) ||
    !Object.hasOwn(endpoints, "docker")
  ) {
    return null;
  }
  const docker = endpoints.docker;
  const endpoint = isRecord(docker)
    ? foldNativeComposeEngineFields(docker, ["host", "skiptlsverify"])
    : null;
  const host = endpoint?.get("host");
  const skip = endpoint?.get("skiptlsverify");
  return typeof host === "string" && (skip === undefined || skip === false)
    ? dockerUnixHostPath(host)
    : null;
}

/**
 * Resolve the endpoint exactly as the Docker CLI does for a flagless command,
 * then return it only when it is a plain Unix socket this transport can read:
 *
 * 1. a non-empty DOCKER_HOST selects the default context with that host (with a
 *    non-empty DOCKER_CONTEXT too, the selection is treated as ambiguous);
 * 2. else a non-empty DOCKER_CONTEXT names the context;
 * 3. else the client config's `currentContext` names it;
 * 4. else the `default` context, whose endpoint is `defaultSocketPath`.
 *
 * A named context is read from `<config dir>/contexts/meta/<sha256>/meta.json`
 * through a no-follow binding. Its TLS directory must be absent: it is proven
 * absent by name and never opened, so no key material is read. A missing,
 * malformed, TLS, TCP, SSH or otherwise ineligible context returns null, and
 * the caller keeps the Docker CLI. The caller must have already refused TLS,
 * certificate, header and API-version environment selections, and must
 * re-resolve and compare the binding around every read.
 */
export function resolveDockerContextEndpoint(opts: {
  readonly environment: Environment;
  readonly currentContext: string | null;
  readonly defaultSocketPath: string;
}): DockerContextEndpoint | null {
  const { environment } = opts;
  if (environment.DOCKER_HOST) {
    const path = environment.DOCKER_CONTEXT
      ? null
      : dockerUnixHostPath(environment.DOCKER_HOST);
    return path === null ? null : { socketPath: path, binding: ["host"] };
  }
  const name =
    environment.DOCKER_CONTEXT || opts.currentContext || DEFAULT_CONTEXT;
  if (name === DEFAULT_CONTEXT) {
    return { socketPath: opts.defaultSocketPath, binding: [DEFAULT_CONTEXT] };
  }
  const directory = nativeComposeDockerConfigDirectory(environment);
  if (directory === null || !CONTEXT_NAME.test(name)) {
    return null;
  }
  const id = contextId(name);
  const meta = bindNativeComposeEngineDocument({
    path: join(directory, "contexts", "meta", id, "meta.json"),
    inspect: inspectMeta,
  });
  if (meta === null || !meta.found) {
    return null;
  }
  const tls = bindNativeComposeEngineAbsence(
    join(directory, "contexts", "tls", id)
  );
  return tls === null
    ? null
    : {
        socketPath: meta.value,
        binding: ["context", name, meta.binding, tls],
      };
}
