import { homedir } from "node:os";
import { assertAutostartDockerConfigTrusted } from "../lib/autostart-docker-trust.ts";
import { secureAutostartRoutingAssets } from "../lib/autostart-routing-assets.ts";
import { HackCliError } from "../lib/cli-result.ts";
import { resolveDefaultDomain } from "../lib/default-domain.ts";
import { resolveProxyBindAddress } from "../lib/proxy-bind.ts";
import { reconcileRemoteCaddyRoutesStack } from "../lib/remote-caddy-routes.ts";
import { logger } from "../ui/logger.ts";

/** No engine or host effect precedes authentication of automatically executed assets. */
export async function secureGlobalLoginRouting(opts: {
  readonly root: string;
  readonly login: boolean;
}): Promise<void> {
  if (!opts.login) {
    return;
  }
  assertAutostartDockerConfigTrusted({ home: homedir() });
  try {
    await secureAutostartRoutingAssets({
      root: opts.root,
      bindAddress: await resolveProxyBindAddress(),
      defaultDomain: await resolveDefaultDomain(),
    });
  } catch {
    throw new HackCliError({
      code: "E_PERMISSION",
      message:
        "Automatic routing refused untrusted or outdated installed assets. Review and move unexpected schema/dashboard files aside, then reinstall current assets before retrying. Values omitted.",
      detail: { reason: "routing_assets_untrusted" },
    });
  }
}

/** Recreate login containers so file mounts bind the newly published private inodes. */
export function globalRoutingUpArguments(opts: {
  readonly composeFile: string;
  readonly login: boolean;
}): readonly string[] {
  return [
    "docker",
    "compose",
    ...(opts.login ? ["--env-file", "/dev/null"] : []),
    "-f",
    opts.composeFile,
    "up",
    "-d",
    ...(opts.login ? ["--force-recreate"] : []),
    "--remove-orphans",
  ];
}

/** Unsupported remote bridges are never part of automatic local routing startup. */
export async function reconcileGlobalRoutingBridge(opts: {
  readonly enabled: boolean;
}): Promise<void> {
  if (!opts.enabled) {
    return;
  }
  const remoteRoutes = await reconcileRemoteCaddyRoutesStack();
  if (remoteRoutes.status === "failed") {
    logger.warn({
      message: `Remote route bridge sync failed: ${remoteRoutes.error}`,
    });
  } else if (remoteRoutes.status === "applied") {
    logger.step({
      message: `Remote route bridge active (${remoteRoutes.routeCount} host${remoteRoutes.routeCount === 1 ? "" : "s"})`,
    });
  }
}

/** Login restores routing only; logging can expose retained logs through Grafana. */
export function globalLoggingUpArguments(opts: {
  readonly composeFile: string;
  readonly login: boolean;
}): readonly string[] | null {
  return opts.login ? null : globalRoutingUpArguments(opts);
}

/** Login must not invoke the absolute passwordless DNS recovery helper. */
export function globalDnsRecoveryAllowed(opts: {
  readonly login: boolean;
}): boolean {
  return !opts.login;
}

/** A lost engine at login must fail before backend discovery or VM/app startup. */
export function assertGlobalBackendStartAllowed(opts: {
  readonly login: boolean;
}): void {
  if (opts.login) {
    throw new Error(
      "Docker became unavailable during login; start the engine manually and retry."
    );
  }
}
