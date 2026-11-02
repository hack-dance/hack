import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { requireFixtureRoot } from "./fixture-root.ts";

/** A context name with no store entry: the Docker CLI itself would refuse it. */
export const ISOLATED_DOCKER_CONTEXT = "hack-test-unselected";

/**
 * Docker client selection for commands that run against a synthetic `docker`:
 * an isolated client config whose current context does not exist. The storage
 * engine-ID admission then keeps the synthetic CLI. It never reads the
 * contributor's Docker config or context store, and never dials the default
 * engine socket or a real context's socket. An explicit `DOCKER_HOST` or
 * `DOCKER_CONFIG` passed by a test still takes precedence. `root` must be an
 * absolute fixture path; an empty or relative one is refused, closed.
 */
export function isolatedDockerClientEnv(
  root: string
): Readonly<Record<string, string>> {
  const directory = join(
    requireFixtureRoot(root, "isolatedDockerClientEnv"),
    "docker-client"
  );
  const config = join(directory, "config.json");
  if (!existsSync(config)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(
      config,
      `${JSON.stringify({ currentContext: ISOLATED_DOCKER_CONTEXT })}\n`,
      { mode: 0o600 }
    );
  }
  return { DOCKER_CONFIG: directory };
}
