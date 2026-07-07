import { join } from "node:path";

import type { MonorepoFixture } from "../fixture.ts";
import { runCommand, type ScenarioContext } from "../harness.ts";

const DOWN_TIMEOUT_MS = 180_000;
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Shared helpers for docker-tier scenarios: precondition checks (skip with a
 * clear reason instead of failing on machines without docker or the global
 * hack-dev network) and guaranteed compose cleanup.
 */

export async function requireDockerPreconditions(opts: {
  readonly ctx: ScenarioContext;
}): Promise<void> {
  const info = await runCommand({
    argv: ["docker", "info"],
    cwd: opts.ctx.tempRoot,
    timeoutMs: 30_000,
  });
  if (info.exitCode !== 0) {
    opts.ctx.skip("docker daemon unavailable (docker info failed)");
  }

  const network = await runCommand({
    argv: ["docker", "network", "inspect", "hack-dev"],
    cwd: opts.ctx.tempRoot,
    timeoutMs: 30_000,
  });
  if (network.exitCode !== 0) {
    opts.ctx.skip(
      "global hack-dev network missing (run `hack global install` once on this machine)"
    );
  }
}

/**
 * Always-run cleanup for docker scenarios: `hack down` for the primary (and
 * optional branch) instance, then a raw `docker compose down` sweep so a
 * broken CLI path can never leak containers. Fixture project names are
 * random (e2e-<hex>) so this can never collide with real projects.
 */
export async function downBestEffort(opts: {
  readonly ctx: ScenarioContext;
  readonly fixture: MonorepoFixture;
  readonly branches?: readonly string[];
}): Promise<void> {
  await runQuiet({
    ctx: opts.ctx,
    args: ["down"],
    cwd: opts.fixture.root,
  });
  for (const branch of opts.branches ?? []) {
    await runQuiet({
      ctx: opts.ctx,
      args: ["down", "--branch", branch],
      cwd: opts.fixture.root,
    });
  }

  const composeProjects = [
    opts.fixture.name,
    ...(opts.branches ?? []).map((branch) => `${opts.fixture.name}-${branch}`),
  ];
  for (const composeProject of composeProjects) {
    await runCommand({
      argv: [
        "docker",
        "compose",
        "-p",
        composeProject,
        "-f",
        join(opts.fixture.hackDir, "docker-compose.yml"),
        "down",
        "--volumes",
        "--remove-orphans",
      ],
      cwd: opts.fixture.root,
      timeoutMs: DOWN_TIMEOUT_MS,
    });
  }
}

async function runQuiet(opts: {
  readonly ctx: ScenarioContext;
  readonly args: readonly string[];
  readonly cwd: string;
}): Promise<void> {
  try {
    const result = await opts.ctx.cli({
      args: opts.args,
      cwd: opts.cwd,
      timeoutMs: DOWN_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      opts.ctx.log(
        `cleanup: hack ${opts.args.join(" ")} exited ${result.exitCode} (continuing)`
      );
    }
  } catch (error: unknown) {
    opts.ctx.log(
      `cleanup: hack ${opts.args.join(" ")} threw (${error instanceof Error ? error.message : String(error)})`
    );
  }
}

/**
 * Export the Caddy local CA PEM via `hack global ca --print` so routed
 * dev-host probes can verify TLS properly instead of disabling verification.
 * Returns null when the CA cannot be exported (probe falls back to
 * execServiceProbe instead).
 */
export async function resolveLocalCaPem(opts: {
  readonly ctx: ScenarioContext;
}): Promise<string | null> {
  const result = await opts.ctx.cli({
    args: ["global", "ca", "--print"],
    cwd: opts.ctx.tempRoot,
    timeoutMs: 60_000,
  });
  if (result.exitCode !== 0 || !result.stdout.includes("BEGIN CERTIFICATE")) {
    return null;
  }
  return result.stdout;
}

/**
 * Fetch a routed dev-host URL with TLS verified against the Caddy local CA,
 * tolerating sandboxed DNS: returns the body on success or null when the
 * host does not resolve / connect (callers then use execServiceProbe).
 */
export async function tryFetchRoute(opts: {
  readonly url: string;
  readonly caPem: string;
}): Promise<string | null> {
  try {
    const response = await fetch(opts.url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      tls: { ca: opts.caPem },
    });
    if (!response.ok) {
      return null;
    }
    return await response.text();
  } catch {
    return null;
  }
}

/**
 * In-container fallback probe when the dev_host route is not resolvable from
 * the harness (sandboxed DNS): exec a fetch against localhost inside the
 * service container.
 */
export async function execServiceProbe(opts: {
  readonly fixture: MonorepoFixture;
  readonly composeProject: string;
  readonly service: string;
  readonly port: number;
}): Promise<string | null> {
  const script = `const res = await fetch("http://127.0.0.1:${opts.port}"); process.stdout.write(await res.text())`;
  const result = await runCommand({
    argv: [
      "docker",
      "compose",
      "-p",
      opts.composeProject,
      "-f",
      join(opts.fixture.hackDir, "docker-compose.yml"),
      "exec",
      "-T",
      opts.service,
      "bun",
      "-e",
      script,
    ],
    cwd: opts.fixture.root,
    timeoutMs: 60_000,
  });
  return result.exitCode === 0 ? result.stdout : null;
}
