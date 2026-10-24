import {
  COMPOSE_BACKEND_SELECTION,
  type ComposeBackendFeature,
  describeComposeBackendFeatures,
} from "./native-compose-backend-features.ts";

/** Doctor check id for the Compose-backend feature report. */
export const COMPOSE_BACKEND_CHECK = "compose backend features";

/** Value-free JSON payload: closed feature names only. */
export type ComposeBackendReport = {
  readonly features: readonly ComposeBackendFeature[];
};

/**
 * Doctor result for the current project's Compose-backend features
 * (HACK-1291). Read-only and value-free: it names closed features, never a
 * network, volume, label, path or platform value.
 *
 * On the native backend a blocking feature is a warning, because native `up`
 * refuses the project; on the Compose backend it is informational, because
 * the project already runs where those features are supported.
 */
export function composeBackendCheckResult(opts: {
  readonly backend: "native" | "compose";
  readonly features: readonly ComposeBackendFeature[];
}): {
  readonly name: string;
  readonly status: "ok" | "warn";
  readonly message: string;
  readonly composeBackend: ComposeBackendReport;
} {
  const composeBackend = { features: [...opts.features] };
  if (opts.features.length === 0) {
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
      message: `${uses}, so native up refuses it and the project runs on the Compose backend. ${COMPOSE_BACKEND_SELECTION} to run it there.`,
      composeBackend,
    };
  }
  return {
    name: COMPOSE_BACKEND_CHECK,
    status: "ok",
    message: `${uses}, so it stays on the Compose backend; native up refuses these features.`,
    composeBackend,
  };
}
