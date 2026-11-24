import { createHash, createHmac } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { childEnvironment } from "./child-environment.ts";
import { getString, isRecord } from "./guards.ts";
import { exec } from "./shell.ts";

/** Only platform and Docker transport settings are inputs to inspect/logs/events. */
const DOCKER_HELPER_NAMES: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
  "SSH_AUTH_SOCK",
  "SYSTEMROOT",
  "WINDIR",
  "APPDATA",
  "LOCALAPPDATA",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_TLS",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "DOCKER_API_VERSION",
  "DOCKER_CUSTOM_HEADERS",
  "CONTAINER_HOST",
  "CONTAINER_CONNECTION",
  "CONTAINER_SSHKEY",
  "PODMAN_CONNECTIONS_CONF",
  "CONTAINERS_CONF",
  "CONTAINERS_CONF_OVERRIDE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);

/** Exclude application values, including managed globals and Compose reference values. */
export function dockerHelperEnvironment(
  overrides?: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  const env = childEnvironment(process.env, overrides);
  for (const key of Object.keys(env)) {
    if (!DOCKER_HELPER_NAMES.has(key)) {
      delete env[key];
    }
  }
  return env;
}

const ENGINE_SELECTION_NAMES = [
  "DOCKER_TLS",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "CONTAINER_HOST",
  "CONTAINER_CONNECTION",
  "CONTAINER_SSHKEY",
  "PODMAN_CONNECTIONS_CONF",
  "CONTAINERS_CONF",
  "CONTAINERS_CONF_OVERRIDE",
  "XDG_CONFIG_HOME",
] as const;

/** A launch can retain evidence of Docker selection without storing its values. */
export async function dockerEngineSelectionFingerprint(opts: {
  readonly env: Readonly<Record<string, string>>;
  readonly launchId: string;
  readonly cwd: string;
}): Promise<string> {
  const env = dockerHelperEnvironment(opts.env);
  const configDir = resolve(
    opts.cwd,
    env.DOCKER_CONFIG || join(env.HOME || "", ".docker")
  );
  const context =
    env.DOCKER_CONTEXT ||
    (env.DOCKER_HOST
      ? "default"
      : getString(
          await readDockerSelectionJson(join(configDir, "config.json")),
          "currentContext"
        ) || "default");
  const endpoint =
    context === "default"
      ? env.DOCKER_HOST ||
        (process.platform === "win32"
          ? "npipe:////./pipe/docker_engine"
          : "unix:///var/run/docker.sock")
      : await readDockerContextEndpoint({ configDir, context });
  return createHmac("sha256", opts.launchId)
    .update("hack.docker-engine-selection.v1\0")
    .update(
      JSON.stringify([
        ENGINE_SELECTION_NAMES.map((name) => env[name] || null),
        configDir,
        context,
        endpoint,
      ])
    )
    .digest("hex");
}

async function readDockerContextEndpoint(opts: {
  readonly configDir: string;
  readonly context: string;
}): Promise<readonly [string | null, boolean] | null> {
  const key = createHash("sha256").update(opts.context).digest("hex");
  const record = await readDockerSelectionJson(
    join(opts.configDir, "contexts", "meta", key, "meta.json")
  );
  const docker = isRecord(record.Endpoints)
    ? record.Endpoints.docker
    : undefined;
  return isRecord(docker)
    ? [getString(docker, "Host") ?? null, docker.SkipTLSVerify === true]
    : null;
}

async function readDockerSelectionJson(
  path: string
): Promise<Record<string, unknown>> {
  const maxSize = 1024 * 1024;
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK
  ).catch(() => null);
  if (!file) {
    return {};
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxSize) {
      return {};
    }
    const buffer = Buffer.alloc(info.size + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== info.size) {
      return {};
    }
    const parsed: unknown = JSON.parse(buffer.toString("utf8", 0, bytesRead));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  } finally {
    await file.close();
  }
}

/** Shell runners otherwise merge the caller environment back into the allow-list. */
export function dockerHelperRunEnvironment(
  overrides?: Readonly<Record<string, string>>
) {
  return {
    env: dockerHelperEnvironment(overrides),
    unsetEnvKeys: Object.keys(process.env),
  };
}

const DOCKER_STARTUP_ENV =
  /^(?:LD_|DYLD_|_?RLD_|LDR_|LIBPATH$|SHLIB_PATH$|GCONV_PATH$|LOCPATH$|NLSPATH$|BASH_ENV$|ENV$|ZDOTDIR$|NODE_|BUN_|DENO_|PYTHON|PERL|RUBY|GEM_|LUA_|JAVA_TOOL_OPTIONS$|JDK_JAVA_OPTIONS$|_JAVA_OPTIONS$)/;

/**
 * Resolve Docker from the launcher's absolute PATH entries. Scoped Stop's
 * Docker commands need only transport variables. The synthetic Compose name
 * probe also needs interpolation values, but uses the launcher's client
 * config and drops loader and interpreter controls.
 */
export function createServiceStopDockerExec(): typeof exec {
  const host = dockerHelperEnvironment();
  const path = (host.PATH ?? "")
    .split(delimiter)
    .filter(isAbsolute)
    .join(delimiter);
  const binary = path ? Bun.which("docker", { PATH: path }) : null;
  return async (argv, opts) => {
    if (!binary || argv[0] !== "docker") {
      return { exitCode: 127, stdout: "", stderr: "" };
    }
    const env =
      argv[1] === "compose"
        ? composeNameProbeEnvironment(host, opts?.env)
        : dockerHelperEnvironment({ ...opts?.env, HOME: host.HOME });
    return await exec([binary, ...argv.slice(1)], {
      ...opts,
      env: { ...env, PATH: path },
      unsetEnvKeys: Object.keys(process.env),
    });
  };
}

function composeNameProbeEnvironment(
  host: Readonly<Record<string, string>>,
  overrides?: Readonly<Record<string, string>>
): Record<string, string> {
  const env = childEnvironment(process.env, overrides);
  for (const key of Object.keys(env)) {
    if (
      DOCKER_STARTUP_ENV.test(key) ||
      key.startsWith("DOCKER_") ||
      ["HOME", "XDG_CONFIG_HOME"].includes(key)
    ) {
      delete env[key];
    }
  }
  for (const key of ["HOME", "XDG_CONFIG_HOME", "DOCKER_CONFIG"]) {
    if (host[key] !== undefined) {
      env[key] = host[key];
    }
  }
  return env;
}

const DOCKER_DAEMON_ID = /^[a-zA-Z0-9:-]{4,160}$/;
const UNSUPPORTED_DOCKER_DAEMON_ID = new Set([
  "",
  "null",
  "<no value>",
  "<nil>",
]);

export type DockerDaemonObservation =
  | { readonly kind: "verified"; readonly id: string }
  | { readonly kind: "unsupported" }
  | { readonly kind: "unverified" };

/** A bounded read of the responding daemon's ID, independent of socket or context names. */
export async function readDockerDaemonIdentity(opts: {
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly executeDocker?: typeof exec;
}): Promise<DockerDaemonObservation> {
  const result = await (opts.executeDocker ?? exec)(
    ["docker", "info", "--format", "{{.ID}}"],
    {
      cwd: opts.cwd,
      ...dockerHelperRunEnvironment(opts.env),
      stdin: "ignore",
      timeoutMs: 1500,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
    }
  ).catch(() => null);
  if (result?.exitCode !== 0) {
    return { kind: "unverified" };
  }
  const id = result.stdout.trim();
  if (UNSUPPORTED_DOCKER_DAEMON_ID.has(id)) {
    return { kind: "unsupported" };
  }
  return DOCKER_DAEMON_ID.test(id)
    ? { kind: "verified", id }
    : { kind: "unverified" };
}

export function dockerDaemonIdentityFingerprint(
  id: string,
  launchId: string
): string {
  return createHmac("sha256", launchId)
    .update("hack.docker-daemon-id.v1\0")
    .update(id)
    .digest("hex");
}
