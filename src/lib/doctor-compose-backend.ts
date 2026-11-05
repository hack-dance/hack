import {
  BASIC_BUILD_NEXT_STEP,
  COMPOSE_BACKEND_SELECTION,
  type ComposeBackendFeature,
  describeComposeBackendFeatures,
  ISOLATED_NETWORKS_SELECTION,
} from "./native-compose-backend-features.ts";

/** Doctor check id for the Compose-backend feature report. */
export const COMPOSE_BACKEND_CHECK = "compose backend features";

/** Closed reasons native image-project `up` refuses a project that stays native-eligible. */
export type NativeUpRefusal = "basic_build";

/**
 * Value-free JSON payload: closed feature names only. `nativeUpRefusals` is
 * present only when native image-project `up` refuses a project for a reason
 * outside {@link ComposeBackendFeature}, such as a basic build.
 */
export type ComposeBackendReport = {
  readonly features: readonly ComposeBackendFeature[];
  readonly nativeUpRefusals?: readonly NativeUpRefusal[];
};

/**
 * Doctor result for the current project's Compose-backend features
 * (HACK-1291). Read-only and value-free: it names closed features, never a
 * network, volume, label, path or platform value.
 *
 * On the native backend a blocking feature is a warning, because native `up`
 * refuses the project; on the Compose backend it is informational, because
 * the project already runs where those features are supported. A basic build
 * is not a Compose-backend feature, but native image-project `up` still
 * refuses it (HACK-1907), so on the native backend it is a warning too.
 * Each warning names the next step: the Compose backend selection, the
 * documented `isolatedNetworks` adaptation for an external network, or the
 * authored native format for a build.
 */
export function composeBackendCheckResult(opts: {
  readonly backend: "native" | "compose";
  readonly features: readonly ComposeBackendFeature[];
  readonly basicBuild?: boolean;
}): {
  readonly name: string;
  readonly status: "ok" | "warn";
  readonly message: string;
  readonly composeBackend: ComposeBackendReport;
} {
  const basicBuild = opts.basicBuild === true;
  const composeBackend: ComposeBackendReport = {
    features: [...opts.features],
    ...(basicBuild ? { nativeUpRefusals: ["basic_build"] as const } : {}),
  };
  const network = opts.features.includes("external_network")
    ? ` ${ISOLATED_NETWORKS_SELECTION}.`
    : "";
  const build = basicBuild
    ? ` Its basic Compose build is also refused by native image-project up. ${BASIC_BUILD_NEXT_STEP}.`
    : "";
  if (opts.features.length === 0) {
    if (basicBuild && opts.backend === "native") {
      return {
        name: COMPOSE_BACKEND_CHECK,
        status: "warn",
        message: `No Compose-only features found, but native image-project up refuses this project's basic Compose build with its general configuration refusal. ${BASIC_BUILD_NEXT_STEP}, or ${COMPOSE_BACKEND_SELECTION} to run it on the Compose backend.`,
        composeBackend,
      };
    }
    if (basicBuild) {
      return {
        name: COMPOSE_BACKEND_CHECK,
        status: "ok",
        message: `No Compose-only features found; the basic Compose build runs on the Compose backend. Native image-project up refuses it: ${BASIC_BUILD_NEXT_STEP}.`,
        composeBackend,
      };
    }
    return {
      name: COMPOSE_BACKEND_CHECK,
      status: "ok",
      message:
        "No Compose-only features found; native up still reviews the rest of the configuration when it starts.",
      composeBackend,
    };
  }
  const uses = `This project uses ${describeComposeBackendFeatures(opts.features)}`;
  if (opts.backend === "native") {
    return {
      name: COMPOSE_BACKEND_CHECK,
      status: "warn",
      message: `${uses}, so native up refuses it and the project runs on the Compose backend. ${COMPOSE_BACKEND_SELECTION} to run it there.${network}${build}`,
      composeBackend,
    };
  }
  return {
    name: COMPOSE_BACKEND_CHECK,
    status: "ok",
    message: `${uses}, so it stays on the Compose backend; native up refuses these features.${network}${build}`,
    composeBackend,
  };
}
