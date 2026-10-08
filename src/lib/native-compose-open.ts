import { CliUsageError } from "../cli/command.ts";
import { HackCliError } from "./cli-result.ts";
import { openNativeComposeGenerationStore } from "./native-compose-generation.ts";
import { readNativeComposeRouteMetadata } from "./native-compose-route-owner.ts";
import {
  requireNativeComposeBackend,
  selectNativeComposeProject,
} from "./native-compose-selection.ts";
import type { NativeRoutingResolution } from "./native-routing-plan-protocol.ts";

export type NativeComposeOpenOptions = {
  readonly cwd: string;
  readonly path?: string;
  readonly project?: string;
  readonly instance?: string;
  readonly target?: string;
  readonly prefer?: string;
};

function unsupported(): never {
  throw new HackCliError({
    code: "E_NATIVE_PROJECT_UNSUPPORTED",
    message:
      "Native open requires a saved routed generation and supports only its default or named route. Run hack up to save current routing intent. Values omitted.",
  });
}

function preferredOrigin(opts: {
  readonly origin: string;
  readonly alias?: string;
  readonly automatic: string;
  readonly preference: string;
}): string {
  if (opts.preference === "dev") {
    return opts.origin;
  }
  if (opts.preference === "alias") {
    if (!opts.alias) {
      throw new CliUsageError(
        "OAuth alias origin is unavailable in this saved native generation."
      );
    }
    return opts.alias;
  }
  return opts.automatic;
}

/** Select only admitted saved origins; this does not assert that a stopped app is reachable. */
export function resolveNativeComposeOpenOrigin(opts: {
  readonly resolution: NativeRoutingResolution;
  readonly target?: string;
  readonly prefer?: string;
}): string {
  const preference = opts.prefer ?? "auto";
  if (!["auto", "alias", "dev"].includes(preference)) {
    throw new CliUsageError("--prefer must be 'auto', 'alias', or 'dev'");
  }
  const target = opts.target?.trim() ?? "";
  const route =
    target !== "" && Object.hasOwn(opts.resolution.routes, target)
      ? opts.resolution.routes[target]
      : null;
  const defaults = target === "" || (target === "www" && !route);
  if (!(defaults || route)) {
    return unsupported();
  }
  const origin = route?.origin ?? opts.resolution.project_origin;
  const aliases = route?.aliases ?? opts.resolution.aliases;
  const alias =
    opts.resolution.oauth_alias &&
    Object.hasOwn(aliases, opts.resolution.oauth_alias)
      ? aliases[opts.resolution.oauth_alias]
      : undefined;
  const automaticRouteOrigin =
    alias && opts.resolution.open_preference !== "dev" ? alias : origin;
  const selected = preferredOrigin({
    origin,
    alias,
    automatic: defaults ? opts.resolution.open_origin : automaticRouteOrigin,
    preference,
  });
  const declaredOrigins = Object.values(opts.resolution.routes).flatMap(
    (value) => [value.origin, ...Object.values(value.aliases)]
  );
  if (!declaredOrigins.includes(selected)) {
    return unsupported();
  }
  return selected;
}

/**
 * Select native inputs before legacy context/registration. Read the immutable saved
 * routing report under its generation lease; never compile, decrypt, observe Docker,
 * or invent a host from current authored input merely to answer `open`.
 */
export async function tryNativeComposeOpen(
  opts: NativeComposeOpenOptions
): Promise<string | null> {
  const selected = await selectNativeComposeProject(opts);
  if (!selected) {
    return null;
  }
  requireNativeComposeBackend({ backend: process.env.HACK_RUNTIME_BACKEND });
  try {
    const store = await openNativeComposeGenerationStore({
      projectRoot: selected.projectRoot,
      instance: opts.instance ?? null,
      mode: "saved",
    });
    try {
      const state = await store.loadCurrent();
      if (state.pending || state.beforeHooksPending) {
        throw new HackCliError({
          code: "E_CONFIG_INVALID",
          message:
            "Native open cannot select an origin while saved effects are pending. Recover the instance first. Values omitted.",
        });
      }
      const generation = state.generation;
      if (!generation) {
        return unsupported();
      }
      return await store.withLease({
        generation,
        run: async () => {
          const document = await store.readGenerationDocument(generation);
          const metadata = readNativeComposeRouteMetadata({
            generationId: generation.generationId,
            document,
          });
          if (!metadata?.resolution) {
            return unsupported();
          }
          return resolveNativeComposeOpenOrigin({
            resolution: metadata.resolution,
            target: opts.target,
            prefer: opts.prefer,
          });
        },
      });
    } finally {
      await store.close();
    }
  } catch (error: unknown) {
    if (error instanceof HackCliError || error instanceof CliUsageError) {
      throw error;
    }
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message: "Saved native routing selection is invalid; values omitted.",
    });
  }
}
