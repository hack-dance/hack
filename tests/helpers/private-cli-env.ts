import { chmodSync, mkdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isolatedDockerClientEnv } from "./docker-client.ts";

/**
 * The only test-runner variables a spawned source CLI inherits. Everything else
 * in the runner's environment is dropped: the contributor's `HOME`, any
 * `HACK_*` setting, `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_CONFIG`, `XDG_*`,
 * `CI`, credentials and shell state. A harness passes what its test needs
 * through `env` instead.
 */
export const PRIVATE_CLI_INHERITED_ENV = ["PATH", "TMPDIR"] as const;

/** The default private HOME of a fixture root. */
export function privateCliHome(root: string): string {
  return join(root, "user-home");
}

export type PrivateCliEnvOptions = {
  /** Fixture directory that owns the private HOME and Docker client config. */
  readonly root: string;
  /**
   * HOME for the child. It must be the fixture root or a path inside it.
   * Defaults to `<root>/user-home`. It is created when absent, and its mode
   * is set to 0700 either way.
   */
  readonly home?: string;
  /**
   * Values the test needs, applied after the inherited allow-list. An
   * `undefined` value removes an inherited key. `HOME` is not accepted here.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Default true: an isolated Docker client config whose current context does
   * not exist, so no real engine is selected. A `DOCKER_HOST` or
   * `DOCKER_CONFIG` passed in `env` still wins. Pass false only when the test
   * asserts the absence of a Docker client config.
   */
  readonly isolateDockerClient?: boolean;
};

/**
 * Builds the complete environment for a child process that runs the source CLI
 * (`process.execPath index.ts ...`). Use it instead of `{ ...process.env }`.
 *
 * Invariant: the child's HOME is always private to the fixture, and no
 * variable from the test runner reaches the child unless it is on
 * {@link PRIVATE_CLI_INHERITED_ENV} or the test passes it explicitly.
 */
export function privateCliEnv(
  opts: PrivateCliEnvOptions
): Record<string, string> {
  const root = resolve(opts.root);
  const home = resolve(opts.home ?? privateCliHome(root));
  const inside = relative(root, home);
  if (inside.startsWith("..") || isAbsolute(inside)) {
    throw new Error("privateCliEnv: HOME must be inside the fixture root.");
  }
  if (opts.env && Object.hasOwn(opts.env, "HOME")) {
    throw new Error("privateCliEnv: pass HOME through the home option.");
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // mkdir leaves an existing directory's mode alone.
  chmodSync(home, 0o700);
  const env: Record<string, string> = {};
  for (const key of PRIVATE_CLI_INHERITED_ENV) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }
  if (opts.isolateDockerClient !== false) {
    Object.assign(env, isolatedDockerClientEnv(root));
  }
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    if (value === undefined) {
      Reflect.deleteProperty(env, key);
    } else {
      env[key] = value;
    }
  }
  env.HOME = home;
  return env;
}
