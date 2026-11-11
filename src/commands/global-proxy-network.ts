/**
 * `hack global up|status` wiring for proxy containers that are running but
 * not usable on the ingress network (HACK-2056). Decisions live in
 * `lib/global-proxy-network.ts`.
 */
import { dirname } from "node:path";
import { readTextFile } from "../lib/fs.ts";
import {
  describeProxyNetworkIssue,
  findProxyNetworkIssues,
  type ProxyContainerState,
  type ProxyNetworkIssue,
  readProxyContainers,
  reservedProxyIps,
} from "../lib/global-proxy-network.ts";
import { run } from "../lib/shell.ts";
import { logger } from "../ui/logger.ts";

/** Issues for the proxy stack in `composeFile`; `null` when Docker is unreadable. */
export async function inspectProxyNetwork(opts: {
  readonly composeFile: string;
  readonly readContainers?: () => Promise<
    readonly ProxyContainerState[] | null
  >;
}): Promise<readonly ProxyNetworkIssue[] | null> {
  const containers = await (
    opts.readContainers ??
    (() =>
      readProxyContainers({
        composeFile: opts.composeFile,
        cwd: dirname(opts.composeFile),
      }))
  )();
  if (containers === null) {
    return null;
  }
  return findProxyNetworkIssues({
    containers,
    reservedIps: reservedProxyIps((await readTextFile(opts.composeFile)) ?? ""),
  });
}

/**
 * Before `docker compose up`: take a detached or misaddressed proxy stack
 * down so Compose recreates it on the ingress network with its reserved
 * addresses. Plain `up -d` would keep the running container as it is.
 * Returns the exit code of the down step (0 when nothing was needed).
 */
export async function repairProxyNetworkBeforeUp(opts: {
  readonly composeFile: string;
}): Promise<number> {
  const issues = await inspectProxyNetwork({ composeFile: opts.composeFile });
  if (!issues || issues.length === 0) {
    return 0;
  }
  logger.warn({
    message: [
      "Global proxy containers are running without their ingress network:",
      ...issues.map((issue) => `- ${describeProxyNetworkIssue(issue)}`),
      "Recreating the proxy stack…",
    ].join("\n"),
  });
  return await run(["docker", "compose", "-f", opts.composeFile, "down"], {
    cwd: dirname(opts.composeFile),
  });
}

/** JSON shape for `hack global status --json`. */
export function proxyNetworkStatusPayload(
  issues: readonly ProxyNetworkIssue[] | null
) {
  return {
    /** `null` when Docker could not be read (unknown, not a failure). */
    ok: issues === null ? null : issues.length === 0,
    readable: issues !== null,
    issues: (issues ?? []).map((issue) => ({
      service: issue.service,
      name: issue.name,
      problem: issue.problem,
      expected_ip: issue.expectedIp,
      actual_ip: issue.actualIp,
      message: describeProxyNetworkIssue(issue),
    })),
  } as const;
}
