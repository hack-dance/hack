import type { LegacyComposeRoutingIntent } from "./native-config-import-routing.ts";
import type { NativeRoutingResolution } from "./native-routing-plan-protocol.ts";

/** Effective typed-local precedence may qualify only the already served origins. */
export function legacyComposeRoutingResolutionMatches(opts: {
  readonly routing: LegacyComposeRoutingIntent;
  readonly resolution: NativeRoutingResolution | null | undefined;
}): boolean {
  const { routing, resolution } = opts;
  if (
    !resolution ||
    resolution.branch !== undefined ||
    resolution.project_origin !== `https://${routing.devHost}` ||
    resolution.open_origin !== routing.openOrigin
  ) {
    return false;
  }
  const aliases = routing.aliasHost
    ? { oauth: `https://${routing.aliasHost}` }
    : {};
  if (
    JSON.stringify(resolution.aliases) !== JSON.stringify(aliases) ||
    resolution.oauth_alias !== (routing.aliasHost ? "oauth" : null)
  ) {
    return false;
  }
  if (
    Object.keys(resolution.routes).sort().join(",") !==
    routing.routes
      .map((route) => route.service)
      .sort()
      .join(",")
  ) {
    return false;
  }
  return routing.routes.every((route) => {
    const found = resolution.routes[route.service];
    const primary = `https://${route.hostname === "project" ? routing.devHost : `${route.hostname}.${routing.devHost}`}`;
    const alias = routing.aliasHost
      ? `https://${route.hostname === "project" ? routing.aliasHost : `${route.hostname}.${routing.aliasHost}`}`
      : null;
    return (
      found?.service === route.service &&
      found.port === route.port &&
      found.protocol === "http" &&
      found.origin === primary &&
      JSON.stringify(found.aliases) ===
        JSON.stringify(alias ? { oauth: alias } : {})
    );
  });
}
