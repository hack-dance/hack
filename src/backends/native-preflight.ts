import { createHash } from "node:crypto";
import { chmod, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { DEFAULT_CADDY_IP } from "../constants.ts";
import { HackCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import {
  type ComposeBackendFeature,
  classifyComposeBackendReading,
  RESERVED_OWNERSHIP_LABEL_PREFIXES,
} from "../lib/native-compose-backend-features.ts";
import { NATIVE_ROOT_DOTENV_IGNORED_NOTICE } from "../lib/native-environment-notices.ts";
import { nativeRuntimeTempDirectory } from "../lib/native-runtime-temp.ts";
import {
  probeProxyLoopback,
  resolveProxyLoopbackAddresses,
} from "../lib/proxy-loopback.ts";
import { NativeEnvFileRefusal } from "./native-env-file-source.ts";
import { nativeEnvironmentUnsetsReviewed } from "./native-environment-unsets.ts";
import {
  adaptNativeGcloudEnvironment,
  hasNativeGcloudCredentialMount,
  type NativeGcloudSelection,
} from "./native-gcloud-environment.ts";
import { admitNativeHttpProbe } from "./native-http-probe-admission.ts";
import { prepareNativeProjectAdaptation } from "./native-project-adaptation.ts";
import { admitNativeProjectBuild } from "./native-project-builds.ts";
import type { NativeProjectInput } from "./native-project-input.ts";
import {
  mergeNativeShellEnvironment,
  nativeProjectInputRefusalMessage,
  prepareNativeProjectInput,
  readNativeComposeBytes,
  requireNativeShellDeliveryFits,
  selectActiveNativeProjectInput,
} from "./native-project-input.ts";
import {
  applyNativeInternalHostAliases,
  type NativeHostAliasSource,
  nativeServiceHostAliases,
} from "./native-project-internal-hosts.ts";
import {
  nativeBridgeSocketCount,
  nativePortPublicationCount,
} from "./native-project-ports.ts";
import {
  nativeBridgeCapacity,
  nativeRouteProbeRefusalDetails,
  reviewedNativeRoutes,
} from "./native-project-routing.ts";
import { requireCapturedNativeSourceWithinLimit } from "./native-project-source-size.ts";
import {
  type NativeServicePreparationProblem,
  nativeServicePreparationProblems,
} from "./native-project-start.ts";
import { nativeManagedRestartNotices } from "./native-restart-policy-notices.ts";
import {
  invokeNativeRuntime,
  isNativeRuntimeStopError,
  NativeRuntimeRequestError,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";
import {
  inspectNativeSetup,
  type NativeSetupState,
  nativeSetupGuidance,
} from "./native-runtime-setup.ts";
import { NATIVE_START_REFUSAL_ENTRIES } from "./native-start-refusal-entries.ts";
import { readNativeStartRefusals } from "./native-start-refusals.ts";

/**
 * Native preflight: everything that would stop a Compose project from starting
 * on the native backend, listed at once.
 *
 * `hack up` under native selection checks a project in two places and stops
 * at the first refusal of each: the CLI's own admission (Compose-backend
 * features, environment files, builds, service preparation, the source-share
 * grant) and the runtime review (`project plan`). This module reads the same
 * project with the same rules and collects every finding instead.
 *
 * Invariants:
 * - Read-only for the project and the runtime. It starts no VM, pulls no
 *   image, runs no lifecycle hook and writes nothing to the project. The only
 *   runtime requests are read-only `runtime setup inspect` and `project plan`
 *   reviews, which need no running runtime; the adapted Compose document lives
 *   in a private temporary directory that is removed afterwards.
 * - It judges what `hack up` judges: the Compose document after the selected
 *   native adaptation and project-wide host aliases are applied, not the raw
 *   file.
 * - Value-free. A finding carries a closed code, a service name, a field path
 *   and fixed sentences. Environment-file findings may name source paths.
 *   Environment values, label keys and values, image names and the runtime's
 *   own message text are never printed.
 * - Not an admission decision. `hack up` still decides with its own checks; a
 *   clean report does not start anything and does not skip any of them.
 */

export const NATIVE_PREFLIGHT_COMMAND = "hack doctor --native-preflight";

export type NativePreflightFinding = {
  readonly severity: "blocker" | "warning" | "consent";
  /** Which check produced it: the CLI's admission or the runtime review. */
  readonly gate: "cli" | "runtime";
  /** Stable, closed name. Runtime findings use the review's own codes. */
  readonly code: string;
  readonly service?: string;
  /** Compose field path, when the finding names one. */
  readonly field?: string;
  /** What is wrong, in one plain sentence. */
  readonly message: string;
  /** What to do about it. */
  readonly fix: string;
};

/** How far the runtime review got. */
export type NativePreflightReviewStatus =
  /** The review ran and its findings are complete. */
  | "completed"
  /** The review stopped at a problem it cannot continue past; fix it and run again. */
  | "stopped"
  /** No usable native runtime is selected, so only the CLI's checks ran. */
  | "skipped"
  /** A native runtime is selected but it did not return a review. */
  | "unavailable";

export type NativePreflightReport = {
  readonly report_version: 2;
  readonly backend: "native";
  /** The Compose file, relative to the project root. */
  readonly compose_file: string;
  /** No blocker or missing consent, and the runtime review completed. */
  readonly ready: boolean;
  readonly runtime_setup: {
    readonly state: NativeSetupState;
    readonly installation_state?: NativeSetupState;
    readonly code: string;
    readonly fix: string;
  };
  readonly runtime_review: {
    readonly status: NativePreflightReviewStatus;
    /**
     * The closed runtime code when the review stopped or failed. For a
     * skipped review: `native_selection_incomplete` when native is selected
     * without a candidate, `native_adaptation_invalid` when the adaptation was
     * refused, `native_setup_incomplete` when setup is not ready and the
     * review could not run before it, and absent when native is not selected.
     */
    readonly code?: string;
  };
  readonly consent_needed: readonly NativePreflightFinding[];
  readonly blockers: readonly NativePreflightFinding[];
  readonly warnings: readonly NativePreflightFinding[];
};

type Explanation = { readonly message: string; readonly fix: string };

const USE_COMPOSE =
  "If the project requires this unsupported configuration, use the Compose backend (HACK_RUNTIME_BACKEND=compose).";

const FEATURE_FINDINGS: Readonly<Record<ComposeBackendFeature, Explanation>> = {
  duplicate_hack_network: {
    message: "Several logical networks refer to the same Hack shared network.",
    fix: "Keep one logical declaration for each of hack-dev and hack-logging and attach its services to that declaration.",
  },
  external_network: {
    message: "The Compose file uses an external network.",
    fix: "Declare the network in this file, or list it under isolatedNetworks in .hack/native/adaptation.json so native replaces it with an isolated one.",
  },
  external_volume: {
    message: "The Compose file uses an external volume.",
    fix: "Declare a named volume in this file instead. Native does not attach volumes it did not create.",
  },
  reserved_label: {
    message:
      "A service, network or volume has a label in a namespace that Docker Compose or Hack owns.",
    fix: `Remove labels in these namespaces: ${RESERVED_OWNERSHIP_LABEL_PREFIXES.map((prefix) => `${prefix}*`).join(", ")}.`,
  },
  unsupported_build: {
    message: "A service build uses a field native builds do not implement.",
    fix: "Keep build to context, dockerfile, target and args, without image beside it; or run this project on the Compose backend.",
  },
  foreign_platform: {
    message: "A service asks for a platform other than linux/arm64.",
    fix: "Remove platform, use an arm64 image, or opt the service in to amd64 emulation in .hack/native/adaptation.json.",
  },
};

const PREPARATION_FINDINGS: Readonly<
  Record<
    NativeServicePreparationProblem,
    Explanation & { readonly field?: string }
  >
> = {
  invalid_service: {
    message: "The service is not a mapping.",
    fix: "Write the service as a Compose mapping of fields.",
  },
  missing_image: {
    field: "image",
    message: "The service names no image and has no admitted build.",
    fix: "Give the service an image, or a build that native builds accept.",
  },
  extra_hosts_without_dependencies: {
    field: "extra_hosts",
    message:
      "The service declares extra_hosts, but no host dependency binding is selected.",
    fix: "Select a dependency file with HACK_NATIVE_DEPENDENCIES or the dependencies setting in the native machine settings, or remove extra_hosts.",
  },
  unsupported_logging: {
    field: "logging",
    message:
      "The service sends logs to a logging driver other than json-file, local or none.",
    fix: "Remove logging. Native keeps its own bounded container logs; read them with hack logs.",
  },
  invalid_restart: {
    field: "restart",
    message: "The service restart policy is not a string.",
    fix: "Use one of no, always, unless-stopped or on-failure.",
  },
  unsupported_label: {
    field: "labels",
    message:
      "The service has a foreign router label or an unsupported semantic Hack label. Generated Hack and Compose metadata is ignored; Caddy routes, dependency caches and one-shot declarations keep their own checks.",
    fix: "Remove those labels, or run this project on the Compose backend if a router or tool needs them.",
  },
};

/**
 * Plain words for the runtime review's most common codes. A code that is not
 * listed is still reported, by its code and field, with a pointer to the guide.
 */
const RUNTIME_FINDINGS: Readonly<Record<string, Explanation>> = {
  missing_service_source: {
    message: "The service has no image or local build context.",
    fix: "Declare an image, or a supported local build with native builds enabled.",
  },
  conflicting_network_owners: {
    message: "The service declares both networks and network_mode.",
    fix: "Keep project network attachments and remove network_mode, or use network_mode: none with no attachments.",
  },
  privileged_service: {
    message: "The service asks for privileged mode.",
    fix: "Remove privileged. Use cap_add for the specific capability if native allows it.",
  },
  capability_refused: {
    message: "The service adds a capability native does not grant.",
    fix: "Remove it from cap_add. The guide lists the capabilities native accepts.",
  },
  unknown_capability: {
    message: "The service names a capability native does not know.",
    fix: "Check the spelling in cap_add or cap_drop.",
  },
  unsupported_field: {
    message: "This Compose field is not supported by native.",
    fix: `Remove the field. ${USE_COMPOSE}`,
  },
  unsupported_mount_type: {
    message: "The service uses a mount type other than bind or volume.",
    fix: "Use a bind mount of a project path or a named volume. tmpfs is not supported.",
  },
  unsupported_mount_option: {
    message: "A mount uses an option native does not accept.",
    fix: "Use source:target with an optional :ro or :rw. The host-only hints cached, delegated, consistent, z and Z are also accepted and ignored.",
  },
  registry_template_invalid: {
    message:
      "The project's npm registry configuration is outside what native accepts for a dependency cache.",
    fix: "Keep only registry URLs and token environment references in the project's npm configuration.",
  },
  registry_template_unsafe: {
    message:
      "The project's npm registry configuration is a link or is too large to read safely.",
    fix: "Make it a regular file under 16 KiB, not a symbolic or hard link.",
  },
  plan_budget: {
    message: "The reviewed plan for this project is over the size limit.",
    fix: "Reduce the Compose file: fewer services, shorter commands or less inline environment.",
  },
  invalid_routing_labels: {
    message: "The service's caddy routing labels are not in the reviewed form.",
    fix: "Use caddy with the hostnames, caddy.reverse_proxy with {{upstreams PORT}}, and optionally caddy.tls: internal.",
  },
  invalid_capability_list: {
    message: "cap_add or cap_drop is not a list of capability names.",
    fix: "Write it as a YAML list.",
  },
  unsafe_source: {
    message:
      "The shared project source contains links or special files native will not share.",
    fix: "Remove them from the project or exclude them.",
  },
  source_budget: {
    message:
      "The project source, or one of its ignore files, is over a size or count limit.",
    fix: "Exclude generated and vendored directories with an ignore file. hack doctor reports the source size.",
  },
  profile_budget: {
    message: "Too many profiles are selected.",
    fix: "Select at most 64 profiles.",
  },
  invalid_mount: {
    message: "A mount is not in a form native accepts.",
    fix: "Write each mount as source:target, or as one absolute container path for an anonymous volume. A bind mount needs a source, and a volume subpath needs a named volume.",
  },
  reserved_volume_name: {
    message:
      "A volume name starts with hack-anonymous-, which native reserves for anonymous volumes.",
    fix: "Rename the volume.",
  },
  reserved_mount_target: {
    message: "A mount replaces a system or runtime directory in the container.",
    fix: "Mount somewhere other than /, /proc, /sys, /dev, /run and /var/run. The Docker socket cannot be mounted.",
  },
  unresolved_mount_source: {
    message: "A mount source uses a variable or the home directory.",
    fix: "Use a path inside the project. The gcloud application-default credentials file and the AWS home directory are delivered by credential adapters instead: set gcloud or aws in the native machine settings.",
  },
  undeclared_volume: {
    message: "The service mounts a named volume the file does not declare.",
    fix: "Add the volume under the top-level volumes key.",
  },
  duplicate_mount_target: {
    message: "Two mounts of one service share a target path.",
    fix: "Give each mount its own target.",
  },
  source_escape: {
    message: "A mount source is outside the project.",
    fix: "Mount only paths inside the project root.",
  },
  source_case_collision: {
    message:
      "Project source paths collide under Unicode normalization and case folding.",
    fix: "Rename the conflicting files or directories so their normalized, case-folded paths are distinct, then correct any env_file references.",
  },
  unresolved_source_path: {
    message: "A mount source cannot be resolved inside the project.",
    fix: "Use a plain path relative to the project.",
  },
  missing_source: {
    message: "A file or directory the Compose file refers to does not exist.",
    fix: "Create it, or correct the path. This includes env_file targets and bind mount sources.",
  },
  external_network: FEATURE_FINDINGS.external_network,
  duplicate_hack_network: FEATURE_FINDINGS.duplicate_hack_network,
  external_volume: FEATURE_FINDINGS.external_volume,
  unsupported_volume_driver: {
    message: "A volume uses a driver other than local.",
    fix: "Remove the driver.",
  },
  unsupported_network_driver: {
    message: "A network uses a driver other than bridge.",
    fix: "Remove the driver.",
  },
  unsupported_network_mode: {
    message:
      "The service uses a network_mode that shares another network stack (host, service or container).",
    fix: "Remove network_mode and attach the service to a project network.",
  },
  undeclared_network: {
    message: "The service attaches to a network the file does not declare.",
    fix: "Add the network under the top-level networks key.",
  },
  invalid_port: {
    message: "A published port is not in a form native accepts.",
    fix: "Publish one port as host:container. Port ranges are not supported.",
  },
  unresolved_port_binding: {
    message: "A published port depends on a variable with no default.",
    fix: "Give the variable a default value in the Compose file, using the :- form.",
  },
  unsupported_host_binding: {
    message: "A port is published on a network address of this machine.",
    fix: "Publish on 127.0.0.1 or leave the address out. Native publishes on loopback only.",
  },
  port_conflict: {
    message: "Two services publish the same host port.",
    fix: "Give each service its own host port.",
  },
  external_route_or_owner_label: {
    message:
      "The service has router or runtime labels native does not adopt, or its caddy routing labels are not in the reviewed form.",
    fix: "Use caddy, caddy.reverse_proxy and caddy.tls for routing; remove unsupported router directives. Generated Hack and Compose metadata needs no adaptation.",
  },
  external_logging_driver: {
    message: "The service sends logs to an external logging driver.",
    fix: "Remove logging. Native keeps its own bounded container logs; read them with hack logs.",
  },
  missing_dependency: {
    message: "depends_on names a service that does not exist.",
    fix: "Correct the service name.",
  },
  inactive_dependency: {
    message: "depends_on names a service that the selected profiles leave out.",
    fix: "Select the profile of the dependency too, or remove the dependency.",
  },
  missing_healthcheck: {
    message:
      "A dependency waits for service_healthy, but that service has no healthcheck.",
    fix: "Add a healthcheck to the dependency.",
  },
  dependency_cycle: {
    message: "depends_on forms a cycle.",
    fix: "Remove one dependency from the cycle.",
  },
  unsupported_dependency_option: {
    message: "depends_on uses restart: true.",
    fix: "Remove restart from the dependency.",
  },
  structural_environment_reference: {
    message: "A structural field, such as image, uses a variable.",
    fix: "Write the value directly.",
  },
  invalid_interpolation: {
    message: "A variable reference uses a form native does not resolve.",
    fix: "Use a plain reference, a :- default or a :+ alternative. The :? form is not supported.",
  },
  unsupported_env_file_mode: {
    message: "env_file uses an option native does not accept.",
    fix: "Use an omitted or empty format for Compose dotenv syntax, or raw.",
  },
  invalid_compose_yaml: {
    message: "The Compose file is not valid YAML.",
    fix: "Fix the syntax error.",
  },
  missing_services: {
    message: "The Compose file has no services.",
    fix: "Add at least one service.",
  },
  empty_active_graph: {
    message: "No service is active with the selected profiles.",
    fix: "Select a profile, or remove profiles from the services to start.",
  },
  unknown_profile: {
    message: "A selected profile is not used by any service.",
    fix: "Check the profile name.",
  },
  unsupported_platform: {
    message: "The service asks for a platform native cannot run.",
    fix: "Use linux/arm64, or linux/amd64 with amd64 emulation enabled in the native adaptation.",
  },
  conflicting_limits: {
    message: "The service sets the same resource limit in two places.",
    fix: "Keep either the top-level limit or deploy.resources.limits.",
  },
  source_symlink: {
    message:
      "The shared project source contains a symbolic link native will not follow.",
    fix: "Replace the link with the file or directory it points to, or exclude it.",
  },
  proposed_loopback_binding: {
    message: "A published port will be bound to 127.0.0.1 only.",
    fix: "Nothing to do. Native does not expose development services to your network.",
  },
  interpolated_port_default: {
    message: "A published port uses a variable; native uses its default value.",
    fix: "Nothing to do, unless you rely on overriding the port from the shell.",
  },
  terminal_not_allocated: {
    message: "tty: true gets no terminal on native.",
    fix: "A program that needs a real terminal must run on the Compose backend.",
  },
  compose_extension_metadata: {
    message: "An x- extension field is present and is ignored.",
    fix: "Nothing to do.",
  },
  obsolete_compose_version: {
    message: "The top-level version key is obsolete and is ignored.",
    fix: "Remove it when convenient.",
  },
  isolated_network_replacement: {
    message:
      "An external network is replaced with an isolated network that native owns.",
    fix: "Nothing to do. Services on it reach each other, not the original network.",
  },
  optional_dependency_inactive: {
    message: "An optional dependency is not active and is skipped.",
    fix: "Nothing to do.",
  },
  route_binding_required: {
    message:
      "The service declares a route, but no native HTTPS frontend is selected, so the service starts and the route is not served.",
    fix: "Set https.caddyBinary, https.caddySha256 and https.port in the native machine settings (or HACK_NATIVE_CADDY_BINARY, HACK_NATIVE_CADDY_SHA256 and HACK_NATIVE_HTTPS_PORT).",
  },
  candidate_project_namespace: {
    message:
      "Native runs the project under its own namespace, so it never adopts or changes the Compose project of the same name.",
    fix: "Nothing to do.",
  },
  hack_network_mapped: {
    message:
      "Hack's shared Compose network becomes a bridge this native project owns, so containers of other projects are not reachable by name; routes are served separately.",
    fix: "Nothing to do, unless a service calls another project's containers by name: use that project's route instead.",
  },
  route_command_healthcheck_replaced: {
    message:
      "The routed service's command healthcheck is not run on native: route readiness is an HTTP probe. Native sends GET / to the route port; a complete HTTP 200-499 response counts as ready, 5xx and timeouts do not.",
    fix: "Nothing to do if GET / answers. To probe a real health path, replace the healthcheck with healthcheck.x-hack-http, for example {port: <route port>, path: /health, interval_ms: 30000, timeout_ms: 1000, retries: 3, start_period_ms: 240000}. Those six fields are required. Until its first success the probe tries every 250 ms (start_interval_ms, optional, at most interval_ms); interval_ms applies after that.",
  },
  inferred_route_probe: {
    message:
      "Native checks TCP and HTTP on the route port because no healthcheck was authored. HTTP 2xx-4xx counts as ready; 5xx does not.",
    fix: "Nothing to do. Declare an explicit x-hack-http healthcheck if this route needs a different path or timing.",
  },
  inert_route_declaration: {
    message:
      "The service declares a hostname with no upstream; no route is served for it.",
    fix: "Add caddy.reverse_proxy if the service should be reachable by that hostname.",
  },
  explicit_dependency_binding_required: {
    message:
      "extra_hosts entries reach the host only through a reviewed host dependency binding.",
    fix: "Nothing to do if a dependency file is selected for this environment; otherwise select one with HACK_NATIVE_DEPENDENCIES.",
  },
  anonymous_volume_named: {
    message:
      "An anonymous volume is stored as a named volume this project owns. Unlike Compose, it is kept across hack down and is not refilled from a rebuilt image.",
    fix: "Nothing to do. Run hack down --remove-data to recreate it from the image on the next start, or declare a named volume to choose its name.",
  },
  mount_host_hint_ignored: {
    message:
      "A mount carries a host-only hint (cached, delegated, consistent, z or Z), which is ignored.",
    fix: "Nothing to do.",
  },
  labels_not_applied: {
    message:
      "Metadata labels on the service are not applied to native containers.",
    fix: "Nothing to do, unless a tool reads them.",
  },
  logging_not_applied: {
    message: "The logging configuration is not applied.",
    fix: "Nothing to do. Read container logs with hack logs.",
  },
};

/**
 * Codes a review request fails with because of the project itself: its
 * Compose file, its mounts or its source tree. Only these become a blocker
 * with a `stopped` review.
 */
export const REVIEW_STOP_CODES: ReadonlySet<string> = new Set([
  "compose_unavailable",
  "conflicting_environment_owner",
  "duplicate_dependency",
  "duplicate_env_file",
  "duplicate_environment_key",
  "duplicate_mount_target",
  "excluded_source",
  "invalid_build",
  "invalid_capability_list",
  "invalid_command",
  "invalid_compose_field",
  "invalid_compose_file",
  "invalid_compose_merge",
  "invalid_compose_path",
  "invalid_compose_yaml",
  "invalid_container_path",
  "invalid_dependency",
  "invalid_dependency_cache",
  "invalid_dependency_condition",
  "invalid_disposable_cache",
  "invalid_duration",
  "invalid_env_file",
  "invalid_environment_key",
  "invalid_environment_unset",
  "invalid_extra_hosts",
  "invalid_healthcheck",
  "invalid_identifier",
  "invalid_ignore_rules",
  "invalid_image",
  "invalid_interpolation",
  "invalid_limit",
  "invalid_mount",
  "invalid_network",
  "invalid_network_replacement",
  "invalid_port",
  "invalid_restart",
  "invalid_routing_labels",
  "invalid_stop_signal",
  "invalid_user",
  "missing_services",
  "missing_source",
  "plan_budget",
  "profile_budget",
  "registry_template_invalid",
  "registry_template_unsafe",
  "reserved_volume_name",
  "service_budget",
  "source_budget",
  "source_case_collision",
  "source_escape",
  "source_generated",
  "source_limit_config",
  "source_mountpoint",
  "source_symlink",
  "unresolved_port_binding",
  "unresolved_source_path",
  "unsafe_source",
  "unsupported_mount_option",
  "unsupported_platform",
  "unsupported_source_name",
]);

/**
 * Codes the runtime's project module can also fail with that are not a
 * verdict on the project: a file that changed under the review, a budget or
 * serialization failure, and the enrollment, execution and graph steps a
 * review never reaches. These, and any code in neither set (a stopped or busy
 * runtime, a transport error, an argument an older runtime does not know),
 * are reported as an `unavailable` review, never as a blocker.
 *
 * `tests/native-preflight-review-codes.test.ts` requires every code the
 * runtime's project sources can fail with to be in exactly one of the two
 * sets, so a new code is classified deliberately.
 */
export const REVIEW_FAILURE_CODES: ReadonlySet<string> = new Set([
  "compose_changed",
  "enrollment_budget",
  "enrollment_busy",
  "enrollment_conflict",
  "enrollment_unavailable",
  "execution_argv",
  "execution_environment",
  "execution_environment_missing",
  "execution_environment_owner",
  "execution_incompatible",
  "execution_input_budget",
  "execution_input_unsupported",
  "execution_interpolation",
  "execution_plan_changed",
  "execution_registry_changed",
  "execution_registry_environment",
  "execution_services",
  "execution_user",
  "foreign_enrollment_state",
  "graph_budget",
  "graph_capabilities",
  "graph_condition",
  "graph_cycle",
  "graph_dependency",
  "graph_incompatible",
  "graph_readiness",
  "graph_service",
  "graph_timeout",
  "graph_timeout_budget",
  "incompatible_compose",
  "incomplete_enrollment",
  "invalid_enrollment",
  "invalid_plan_id",
  "invalid_start_review_context",
  "invalid_source_manifest",
  "live_source_contract",
  "native_graph_compile",
  "native_graph_environment",
  "native_graph_subset",
  "normalized_compose_input",
  "registry_changed",
  "serialization_failed",
  "source_archive",
  "source_changed",
  "source_metadata_unavailable",
  "source_registry",
  "source_revision_mismatch",
  "source_unavailable",
  "source_watch",
  "stale_plan",
]);

/** The same service-name rule as native start (`native-project-input.ts`). */
const SERVICE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
/** A review field path: dotted Compose keys and list indexes, no authored text. */
const FIELD = /^[A-Za-z0-9_.[\]-]{1,256}$/;
const DIGEST = /^[a-f0-9]{64}$/;

function finding(
  base: Omit<NativePreflightFinding, "message" | "fix">,
  text: Explanation
): NativePreflightFinding {
  return { ...base, message: text.message, fix: text.fix };
}

/** Byte-wise order, so the report does not depend on the caller's locale. */
function byCodePoint(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/**
 * The service a `services.<name>…` review field names. Service names may
 * contain dots, so the longest declared name that prefixes the field wins; a
 * field that matches no declared service names none.
 */
function serviceOfField(
  field: string,
  services: readonly string[]
): string | undefined {
  if (!field.startsWith("services.")) {
    return;
  }
  const rest = field.slice("services.".length);
  let best: string | undefined;
  for (const name of services) {
    if (
      (rest === name || rest.startsWith(`${name}.`)) &&
      (best === undefined || name.length > best.length)
    ) {
      best = name;
    }
  }
  return best;
}

/** Build findings for one service, and whether its build is admitted. */
function buildFindings(opts: {
  readonly name: string;
  readonly service: Readonly<Record<string, unknown>>;
  readonly projectRoot: string;
  readonly composeFile: string;
  readonly buildsEnabled: boolean;
  readonly emulated: ReadonlySet<string>;
}): { readonly found: NativePreflightFinding[]; readonly admitted: boolean } {
  const { name } = opts;
  const base = { severity: "blocker", gate: "cli", service: name } as const;
  try {
    admitNativeProjectBuild({
      name,
      service: opts.service,
      projectRoot: opts.projectRoot,
      composeFile: opts.composeFile,
    });
  } catch {
    return {
      admitted: false,
      found: [
        finding(
          { ...base, code: "unsupported_build_form", field: "build" },
          {
            message: "The service build is not in a form native builds accept.",
            fix: "Use a local context inside the project, a relative Dockerfile, and literal args; do not set image beside build.",
          }
        ),
      ],
    };
  }
  if (!opts.buildsEnabled) {
    return {
      admitted: false,
      found: [
        finding(
          { ...base, code: "build_requires_opt_in", field: "build" },
          {
            message:
              "The service is built from a Dockerfile, and native builds are off by default.",
            fix: "Set HACK_NATIVE_BUILDS=1 and prepare the native builder, or give the service a prebuilt image.",
          }
        ),
      ],
    };
  }
  return {
    admitted: true,
    found: opts.emulated.has(name)
      ? [
          finding(
            { ...base, code: "emulated_build", field: "build" },
            {
              message:
                "The service is built natively and also opted in to amd64 emulation. Native builds produce arm64 images.",
              fix: "Remove the service from amd64Emulation in the native adaptation, or give it a prebuilt image.",
            }
          ),
        ]
      : [],
  };
}

function cliServiceFindings(opts: {
  readonly name: string;
  readonly service: unknown;
  readonly projectRoot: string;
  readonly composeFile: string;
  readonly buildsEnabled: boolean;
  readonly hasHostDependencies: boolean;
  /** Services the native adaptation opted in to amd64 emulation. */
  readonly emulated: ReadonlySet<string>;
}): NativePreflightFinding[] {
  const { name, service } = opts;
  const base = { severity: "blocker", gate: "cli", service: name } as const;
  const found: NativePreflightFinding[] = [];
  const builds = new Set<string>();
  const declaresBuild = isRecord(service) && service.build !== undefined;
  if (isRecord(service) && declaresBuild) {
    const build = buildFindings({ ...opts, service });
    found.push(...build.found);
    if (build.admitted) {
      builds.add(name);
    }
  }
  for (const problem of nativeServicePreparationProblems({
    name,
    service,
    hasHostDependencies: opts.hasHostDependencies,
    builds,
  })) {
    // A build that was reported above already explains the missing image.
    if (problem === "missing_image" && declaresBuild) {
      continue;
    }
    const text =
      problem === "extra_hosts_without_dependencies"
        ? serviceHostAliasText(name, service)
        : PREPARATION_FINDINGS[problem];
    found.push(
      finding(
        {
          ...base,
          code: problem,
          ...(text.field ? { field: text.field } : {}),
        },
        text
      )
    );
  }
  if (isRecord(service)) {
    try {
      admitNativeHttpProbe(name, service);
    } catch {
      found.push(
        finding(
          {
            ...base,
            code: "invalid_http_probe",
            field: "healthcheck.x-hack-http",
          },
          {
            message: "The service's native HTTP probe is not valid.",
            fix: "Give healthcheck.x-hack-http a port and path, with interval_ms, timeout_ms, retries and start_period_ms as whole numbers.",
          }
        )
      );
    }
  }
  return found;
}

/**
 * Reads the Compose file with the bounds native start applies
 * (`readCompose` in `native-project-input.ts`): a regular file opened without
 * following a link and without blocking, not empty, at most 256 KiB, and
 * unchanged while it was read. Anything else is `null`, so a FIFO cannot hang
 * the preflight and an oversized file is never loaded.
 */
export async function readNativePreflightCompose(
  path: string
): Promise<Buffer | null> {
  return await readNativeComposeBytes(path).catch(() => null);
}

/** The YAML document, or `undefined` when the bytes are not valid UTF-8 YAML. */
export function parseNativePreflightCompose(bytes: Buffer): unknown {
  try {
    return Bun.YAML.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    );
  } catch {
    return;
  }
}

/** What the CLI's admission would judge: the adapted Compose document. */
type AdaptedProject = {
  readonly findings: NativePreflightFinding[];
  /** Absent when the Compose file cannot be read. */
  readonly document?: {
    readonly originalSha256: string;
    readonly originalCompose: unknown;
    /** The public document native start would review, as JSON. */
    readonly normalizedComposeJson: string;
    readonly services: Readonly<Record<string, unknown>>;
    readonly emulated: ReadonlySet<string>;
    /** False when the adaptation was refused and the document is unadapted. */
    readonly adaptationValid: boolean;
    readonly managedServices: readonly string[];
    /** In-memory check only. Captured private values never enter report JSON. */
    readonly checkDelivery: (plan: unknown) => void;
  };
};

function environmentInputFinding(
  error: unknown,
  delivery = false
): NativePreflightFinding {
  const source = error instanceof NativeEnvFileRefusal ? error : undefined;
  const inputCode =
    source === undefined ? "managed_env_unreadable" : "environment_file_input";
  return finding(
    {
      severity: "blocker",
      gate: "cli",
      code: delivery ? "environment_delivery" : inputCode,
      service: source?.service,
      field: source?.field,
    },
    {
      message:
        source?.message ??
        nativeProjectInputRefusalMessage(error) ??
        "The project's environment declarations or Hack managed env could not be read or decrypted.",
      fix:
        source === undefined
          ? "Check the environment declarations and run hack env list to see the problem."
          : "Check the named source and environment declaration; use owned regular files that are not writable by others.",
    }
  );
}

/** The one alias name preflight prints: a fixed Docker name, never authored data. */
const DOCKER_HOST_ALIAS = "host.docker.internal";
/** Route names that Compose internal DNS sends to the host proxy. */
const HACK_ROUTE_ALIAS = /\.hack(?:\.local)?$/;

/**
 * The fix for host aliases without a binding: what such aliases are usually
 * for, and the dependency entry that admits them. Authored names stay out of
 * the report (only the fixed host.docker.internal is named); ports and
 * targets are never printed.
 */
function hostAliasGuidance(aliases: readonly string[]): string {
  const docker = aliases.includes(DOCKER_HOST_ALIAS);
  const routes = aliases.filter((alias) => HACK_ROUTE_ALIAS.test(alias)).length;
  const others = aliases.length - routes - (docker ? 1 : 0);
  const purposes = [
    docker
      ? `${DOCKER_HOST_ALIAS} usually reaches a process on this machine (a database proxy, a dev server or a tunnel)`
      : null,
    routes
      ? `${routes} name(s) ending in .hack are usually Hack routes sent to the host proxy (Compose internal DNS compatibility)`
      : null,
    others
      ? `${others} other name(s) are usually tunnels or remote names that a process on this machine serves`
      : null,
  ].filter((part) => part !== null);
  const names = JSON.stringify(
    docker && aliases.length === 1 ? [DOCKER_HOST_ALIAS] : ["<alias>"]
  );
  return `${purposes.length ? `${purposes.join("; ")}. ` : ""}Native has no general route from its VM to this machine, so each alias needs a binding to the one host listener it uses: add {"version": 2, "dependencies": [{"binding": "<name>", "aliases": ${names}, "guest_port": <port the container connects to>, "host_port": <listening port on this machine>, "host_executable": "/absolute/path/to/the/listener"}]} to a file selected by HACK_NATIVE_DEPENDENCIES or the dependencies setting (an entry without "services" covers every service that declares the alias; use host_pid instead of host_executable for a listener that does not change). One alias reaches one host listener; hack up names each unbound alias.`;
}

/** The project-wide aliases that target host-gateway. */
function projectHostAliases(
  hosts: Readonly<Record<string, string>> | null
): string[] {
  return Object.entries(hosts ?? {})
    .filter(([, target]) => target === "host-gateway")
    .map(([alias]) => alias);
}

/** The per-service extra_hosts finding, counting that service's aliases. */
function serviceHostAliasText(
  name: string,
  service: unknown
): Explanation & { readonly field?: string } {
  let aliases: string[] = [];
  try {
    aliases = isRecord(service)
      ? (nativeServiceHostAliases({
          services: { [name]: service },
          profiles: Array.isArray(service.profiles)
            ? service.profiles.filter(
                (profile): profile is string => typeof profile === "string"
              )
            : [],
        })[name] ?? [])
      : [];
  } catch {
    // A declaration native refuses (such as one alias declared twice) has
    // authored names in its error; keep the fixed text and let up name it.
  }
  const named = aliases.includes(DOCKER_HOST_ALIAS)
    ? `, including ${DOCKER_HOST_ALIAS}`
    : "";
  return {
    field: "extra_hosts",
    message: aliases.length
      ? `The service declares ${aliases.length} host-gateway alias(es) in extra_hosts${named}, but no host dependency binding is selected.`
      : PREPARATION_FINDINGS.extra_hosts_without_dependencies.message,
    fix: `${hostAliasGuidance(aliases)} To drop one instead, remove it from the service's extra_hosts.`,
  };
}

/**
 * Applies the selected native adaptation and the project-wide host aliases to
 * the Compose document, as native start does before it admits services. Each
 * step that native start would refuse becomes a finding, and the document
 * from before that step is kept so later checks still run.
 */
async function adaptForPreflight(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly composeBytes: Buffer | null;
  readonly composeFile: string;
  readonly adaptationFile: string | undefined;
  readonly internalHosts: Readonly<Record<string, string>> | null;
  readonly internalHostSources: Readonly<Record<string, NativeHostAliasSource>>;
  readonly hasDefaultDependencyFile: boolean;
  readonly effectiveEnvName: string | null;
  readonly profiles: readonly string[];
  readonly gcloud?: NativeGcloudSelection;
}): Promise<AdaptedProject> {
  const blocker = { severity: "blocker", gate: "cli" } as const;
  // One bounded read: the parsed document and the digest come from the same bytes.
  const bytes = opts.composeBytes;
  const compose =
    bytes === null ? undefined : parseNativePreflightCompose(bytes);
  if (bytes === null || !(isRecord(compose) && isRecord(compose.services))) {
    return {
      findings: [
        finding(
          { ...blocker, code: "compose_file_unreadable" },
          {
            message:
              "The Compose file is missing, too large, not valid YAML, or has no services mapping.",
            fix: "Check the project's Compose file. Native reads this one file and does not merge override files.",
          }
        ),
      ],
    };
  }
  const findings: NativePreflightFinding[] = [];
  const normalized = {
    ...structuredClone(compose),
    services: structuredClone(compose.services),
  };
  let input: NativeProjectInput = {
    originalSha256: createHash("sha256").update(bytes).digest("hex"),
    normalizedComposeJson: JSON.stringify(normalized),
    managedEnvironment: {},
    managedSecretValues: [],
    lifecycleHostEnvironment: {},
    effectiveEnvName: opts.effectiveEnvName,
    environmentFiles: [],
    serviceNames: Object.keys(compose.services),
  };
  try {
    const prepared = await prepareNativeProjectInput({
      ...opts,
      envName: opts.effectiveEnvName,
      env: process.env,
    });
    if (prepared.originalSha256 !== input.originalSha256) {
      throw new Error("Compose input changed during preflight");
    }
    input = prepared;
    for (const notice of prepared.environmentNotices ?? []) {
      findings.push(
        finding(
          {
            severity: "warning",
            gate: "cli",
            code:
              prepared.ignoredRootDotenv &&
              notice.service === undefined &&
              notice.line === NATIVE_ROOT_DOTENV_IGNORED_NOTICE
                ? "root_dotenv_ignored"
                : "environment_notice",
            service: notice.service,
            field: notice.service === undefined ? undefined : "environment",
          },
          {
            message: notice.line,
            fix: "Review the named environment input; values are omitted.",
          }
        )
      );
    }
  } catch (error: unknown) {
    findings.push(environmentInputFinding(error));
  }
  const managedServices = [
    ...new Set([
      ...Object.keys(input.managedEnvironment),
      ...Object.keys(input.shellEnvironment ?? {}),
    ]),
  ].sort(byCodePoint);
  let adaptationValid = true;
  try {
    input = await prepareNativeProjectAdaptation({
      input,
      path: opts.adaptationFile,
    });
  } catch {
    adaptationValid = false;
    findings.push(
      finding(
        { ...blocker, code: "native_adaptation_invalid" },
        {
          message:
            "The native adaptation file is not valid or conflicts with the Compose file.",
          fix: "Check .hack/native/adaptation.json, or the file HACK_NATIVE_ADAPTATION names: version 1, known keys only, services that exist, and no httpProbes for a service that already has a healthcheck.",
        }
      )
    );
  }
  if (opts.internalHosts === null) {
    findings.push(
      finding(
        { ...blocker, code: "internal_hosts_unreadable" },
        {
          message: "The project-wide extra hosts could not be read.",
          fix: "Check internal.extra_hosts in the project configuration and the local extra hosts file.",
        }
      )
    );
  } else {
    try {
      input = applyNativeInternalHostAliases({
        input,
        hosts: opts.internalHosts,
        sources: opts.internalHostSources,
        hasDependencySelection: opts.hasDefaultDependencyFile,
      });
    } catch {
      findings.push(
        finding(
          { ...blocker, code: "internal_hosts_without_dependencies" },
          {
            message:
              "The project declares project-wide extra hosts that native cannot apply: no host dependency binding is selected, or an entry is not an exact host-gateway alias.",
            fix: `${hostAliasGuidance(projectHostAliases(opts.internalHosts))} To drop one instead, remove it from internal.extra_hosts or run hack internal extra-hosts unset <alias>.`,
          }
        )
      );
    }
  }
  input = await reviewGcloudCredentialMounts({
    input,
    selected: opts.gcloud !== undefined,
    findings,
  });
  const adapted: unknown = JSON.parse(input.normalizedComposeJson);
  return {
    findings,
    document: {
      originalSha256: input.originalSha256,
      originalCompose: compose,
      managedServices,
      checkDelivery: (plan) =>
        requireNativeShellDeliveryFits(
          selectActiveNativeProjectInput({
            input: mergeNativeShellEnvironment(input),
            reviewedPlan: plan,
          })
        ),
      normalizedComposeJson: input.normalizedComposeJson,
      services:
        isRecord(adapted) && isRecord(adapted.services) ? adapted.services : {},
      emulated: new Set(Object.keys(input.amd64Emulation ?? {})),
      adaptationValid,
    },
  };
}

/** Services whose volumes include the recognized gcloud ADC file mount. */
function gcloudCredentialServices(input: NativeProjectInput): string[] {
  const compose: unknown = JSON.parse(input.normalizedComposeJson);
  if (!(isRecord(compose) && isRecord(compose.services))) {
    return [];
  }
  return Object.entries(compose.services)
    .filter(([, service]) =>
      hasNativeGcloudCredentialMount({
        normalizedComposeJson: JSON.stringify({ services: { service } }),
      })
    )
    .map(([name]) => name)
    .sort();
}

/**
 * A recognized gcloud ADC mount is delivered by the gcloud adapter after
 * lifecycle hooks, not mounted from the host (HACK-2324). Review the input
 * the adapter will produce (the same mount removal; nothing is read) and ask
 * for the one consent the adapter needs when it is not selected.
 */
async function reviewGcloudCredentialMounts(opts: {
  readonly input: NativeProjectInput;
  readonly selected: boolean;
  readonly findings: NativePreflightFinding[];
}): Promise<NativeProjectInput> {
  const services = gcloudCredentialServices(opts.input);
  if (services.length === 0) {
    return opts.input;
  }
  const blocker = { severity: "blocker", gate: "cli" } as const;
  let input = opts.input;
  try {
    // As at startup, env-file and shell values are merged first, so a
    // GOOGLE_APPLICATION_CREDENTIALS selector from env_file is checked as such.
    // Merging again in checkDelivery is a no-op.
    input = (
      await adaptNativeGcloudEnvironment({
        input: mergeNativeShellEnvironment(opts.input),
        mode: "file",
        deliver: false,
      })
    ).input;
  } catch {
    opts.findings.push(
      finding(
        { ...blocker, code: "gcloud_adc_mount_refused" },
        {
          message:
            "A service binds the gcloud application-default credentials file in a form the gcloud adapter does not accept.",
          fix: "Bind ~/.config/gcloud/application_default_credentials.json read-only (:ro) to one absolute container file path per service, outside /proc, /sys, /dev and /run, with no other mount at or around it.",
        }
      )
    );
    return opts.input;
  }
  if (!opts.selected) {
    for (const service of services) {
      opts.findings.push(
        finding(
          {
            ...blocker,
            severity: "consent",
            code: "gcloud_adc_grant_required",
            service,
            field: `services.${service}.volumes`,
          },
          {
            message:
              "The service binds the gcloud application-default credentials file. Native delivers that one file as a read-only snapshot after your consent; nothing else under the gcloud directory is shared.",
            fix: 'Set "gcloud": {"mode": "file"} in the native machine settings for this project, or HACK_NATIVE_GCLOUD_ADC=file. The file must hold authorized_user credentials (gcloud auth application-default login), and the gcloud CLI must be installed.',
          }
        )
      );
    }
  }
  return input;
}

/** Findings from the CLI's own admission. Reads project files only. */
async function collectNativeCliFindings(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly composeFile: string;
  readonly adaptationCandidates: readonly (string | undefined)[];
  readonly buildsEnabled: boolean;
  readonly sharedSource: boolean;
  readonly hasHostDependencies: boolean;
  readonly adapted: NonNullable<AdaptedProject["document"]>;
}): Promise<NativePreflightFinding[]> {
  const found: NativePreflightFinding[] = [];
  const blocker = { severity: "blocker", gate: "cli" } as const;
  try {
    const reading = await classifyComposeBackendReading(
      opts.adapted.originalCompose,
      {
        adaptationCandidates: opts.adaptationCandidates,
        buildsEnabled: opts.buildsEnabled,
      }
    );
    for (const feature of reading.features) {
      if (
        feature === "foreign_platform" &&
        reading.foreignPlatformServices?.length
      ) {
        const services = reading.foreignPlatformServices.filter((name) =>
          SERVICE.test(name)
        );
        for (const service of services) {
          found.push(
            finding(
              { ...blocker, code: feature, service, field: "platform" },
              FEATURE_FINDINGS[feature]
            )
          );
        }
        if (services.length > 0) {
          continue;
        }
      }
      found.push(
        finding({ ...blocker, code: feature }, FEATURE_FINDINGS[feature])
      );
    }
  } catch {
    // An invalid adaptation is reported once, by the adaptation step.
  }
  for (const [name, service] of Object.entries(opts.adapted.services).sort(
    ([a], [b]) => byCodePoint(a, b)
  )) {
    if (!SERVICE.test(name)) {
      found.push(
        finding(
          { ...blocker, code: "invalid_service_name" },
          {
            message: "A service name uses characters native does not accept.",
            fix: "Start with a letter or digit, then use letters, digits, dot, dash and underscore.",
          }
        )
      );
      continue;
    }
    found.push(
      ...cliServiceFindings({
        name,
        service,
        projectRoot: opts.projectRoot,
        composeFile: opts.composeFile,
        buildsEnabled: opts.buildsEnabled,
        hasHostDependencies: opts.hasHostDependencies,
        emulated: opts.adapted.emulated,
      })
    );
  }
  if (!opts.sharedSource) {
    found.push(
      finding(
        {
          ...blocker,
          severity: "consent",
          code: "shared_source_grant_required",
        },
        {
          message:
            "Native shares the whole project directory with its VM, including ignored files, and needs your consent first.",
          fix: 'Set HACK_NATIVE_SHARED_SOURCE=1, or "sharedSource": true in the native machine settings for this project.',
        }
      )
    );
  }
  return found;
}

/** One runtime review diagnostic as a finding, or nothing when it is malformed. */
function runtimeFinding(
  diagnostic: unknown,
  services: readonly string[]
): NativePreflightFinding | null {
  if (
    !(
      isRecord(diagnostic) &&
      typeof diagnostic.code === "string" &&
      CODE.test(diagnostic.code) &&
      (diagnostic.severity === "error" || diagnostic.severity === "warning")
    )
  ) {
    return null;
  }
  let field =
    typeof diagnostic.field === "string" && FIELD.test(diagnostic.field)
      ? diagnostic.field
      : undefined;
  const service = field ? serviceOfField(field, services) : undefined;
  // Older reviewed plans locate these at the service root. Refine the report
  // without changing plan identity or any admission predicate.
  const serviceFields: Readonly<Record<string, string>> = {
    privileged_service: "privileged",
    missing_service_source: "image",
    unsupported_network_mode: "network_mode",
    conflicting_network_owners: "networks",
  };
  if (
    service &&
    field === `services.${service}` &&
    serviceFields[diagnostic.code]
  ) {
    field = `${field}.${serviceFields[diagnostic.code]}`;
  }
  return finding(
    {
      severity: diagnostic.severity === "error" ? "blocker" : "warning",
      gate: "runtime",
      code: diagnostic.code,
      ...(service ? { service } : {}),
      ...(field ? { field } : {}),
    },
    RUNTIME_FINDINGS[diagnostic.code] ?? {
      message: `The native review reported ${diagnostic.code}.`,
      fix: "See the native backend guide for this code.",
    }
  );
}

/** Fixed, value-free diagnostics from the start driver's shared Compose admission. */
function runtimeStartFindings(
  value: unknown,
  services: readonly string[]
): NativePreflightFinding[] | null {
  const refusals = readNativeStartRefusals(value, services);
  if (refusals === null) {
    return null;
  }
  const findings: NativePreflightFinding[] = [];
  for (const refusal of refusals) {
    if (refusal.configuration?.length) {
      for (const detail of refusal.configuration) {
        findings.push(
          finding(
            {
              severity: "blocker",
              gate: "runtime",
              code: refusal.code,
              service: detail.service,
              field: detail.field,
            },
            detail
          )
        );
      }
      continue;
    }
    const service = refusal.service;
    const field = NATIVE_START_REFUSAL_ENTRIES[refusal.code];
    findings.push(
      finding(
        {
          severity: "blocker",
          gate: "runtime",
          code: refusal.code,
          ...(service ? { service } : {}),
          ...(field ? { field } : {}),
        },
        {
          message:
            refusal.message ??
            `Native startup refuses this configuration (${refusal.code}).`,
          fix: USE_COMPOSE,
        }
      )
    );
  }
  return findings;
}
type RuntimeReview = {
  readonly review: NativePreflightReport["runtime_review"];
  readonly findings: NativePreflightFinding[];
  /** The reviewed plan, when the review completed. */
  readonly plan?: Readonly<Record<string, unknown>>;
};

/** How a failed review request is reported: a project verdict, or no review. */
function reviewFailure(
  error: unknown,
  services: readonly string[]
): RuntimeReview {
  const code =
    error instanceof NativeRuntimeRequestError &&
    typeof error.nativeCode === "string" &&
    CODE.test(error.nativeCode)
      ? error.nativeCode
      : undefined;
  if (!(code && REVIEW_STOP_CODES.has(code))) {
    return {
      review: { status: "unavailable", ...(code ? { code } : {}) },
      findings: [],
    };
  }
  if (
    error instanceof NativeRuntimeRequestError &&
    error.nativeConfigurationRefusals?.length
  ) {
    const findings = error.nativeConfigurationRefusals
      .filter(
        (item) => item.service === undefined || services.includes(item.service)
      )
      .map((item) =>
        finding(
          {
            severity: "blocker",
            gate: "runtime",
            code,
            service: item.service,
            field: item.field,
          },
          item
        )
      );
    if (findings.length) {
      return { review: { status: "stopped", code }, findings };
    }
  }
  const text = RUNTIME_FINDINGS[code] ?? {
    message: `The native review stopped with ${code}.`,
    fix: "See the native backend guide for this code.",
  };
  return {
    review: { status: "stopped", code },
    findings: [
      finding(
        { severity: "blocker", gate: "runtime", code },
        {
          message: text.message,
          fix: `${text.fix} The review stops at the first problem of this kind, so run the preflight again after fixing it.`,
        }
      ),
    ],
  };
}

/**
 * The runtime review native start would judge: the original Compose file
 * first, for its namespace, then the adapted document. Two `project plan`
 * requests; no VM is needed and nothing is started.
 */
async function collectNativeRuntimeFindings(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly composeFile: string;
  readonly profiles: readonly string[];
  readonly adapted: NonNullable<AdaptedProject["document"]>;
  readonly invoke?: typeof invokeNativeRuntime;
}): Promise<RuntimeReview> {
  const invoke = opts.invoke ?? invokeNativeRuntime;
  const projectArgs = [
    "--project",
    opts.projectRoot,
    "--file",
    relative(opts.projectRoot, opts.composeFile),
    ...opts.profiles.flatMap((profile) => ["--profile", profile]),
  ];
  let directory: string | undefined;
  let reply: unknown;
  try {
    directory = await nativeRuntimeTempDirectory("hack-native-preflight-");
    const original = await invoke({
      runtime: opts.runtime,
      cwd: opts.projectRoot,
      args: ["project", "plan", ...projectArgs, "--json"],
    });
    const namespace =
      isRecord(original) && isRecord(original.plan)
        ? original.plan.namespace
        : undefined;
    if (typeof namespace !== "string" || !DIGEST.test(namespace)) {
      return { review: { status: "unavailable" }, findings: [] };
    }
    await chmod(directory, 0o700);
    const normalized = join(directory, "compose.json");
    await writeFile(normalized, opts.adapted.normalizedComposeJson, {
      mode: 0o600,
      flag: "wx",
    });
    reply = await invoke({
      runtime: opts.runtime,
      cwd: opts.projectRoot,
      args: [
        "project",
        "plan",
        ...projectArgs,
        "--normalized-file",
        normalized,
        "--expect-original",
        opts.adapted.originalSha256,
        "--expect-namespace",
        namespace,
        ...opts.adapted.managedServices.flatMap((name) => [
          "--start-managed-service",
          name,
        ]),
        "--json",
      ],
    });
  } catch (error: unknown) {
    // A request stopped by Ctrl-C or SIGTERM is an interruption, not a review.
    if (isNativeRuntimeStopError(error)) {
      throw error;
    }
    return reviewFailure(
      error,
      Object.keys(opts.adapted.services).filter((name) => SERVICE.test(name))
    );
  } finally {
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
  }
  if (!(isRecord(reply) && isRecord(reply.plan))) {
    return { review: { status: "unavailable" }, findings: [] };
  }
  if (
    !nativeEnvironmentUnsetsReviewed({
      compose: { services: opts.adapted.services },
      plan: reply.plan,
    })
  ) {
    return {
      review: {
        status: "unavailable",
        code: "native_environment_unset_unavailable",
      },
      findings: [
        finding(
          {
            severity: "blocker",
            gate: "runtime",
            code: "native_environment_unset_unavailable",
          },
          {
            message:
              "The selected native runtime cannot confirm explicit environment removals.",
            fix: "Update the selected native runtime and retry; no VM was started.",
          }
        ),
      ],
    };
  }
  const services = Object.keys(opts.adapted.services).filter((name) =>
    SERVICE.test(name)
  );
  const diagnostics = Array.isArray(reply.plan.diagnostics)
    ? reply.plan.diagnostics
    : [];
  const findings = diagnostics.flatMap((diagnostic) => {
    const found = runtimeFinding(diagnostic, services);
    return found ? [found] : [];
  });
  const startFindings = runtimeStartFindings(reply.start_refusals, services);
  if (startFindings === null) {
    return {
      review: {
        status: "unavailable",
        code: "native_start_review_unavailable",
      },
      findings,
    };
  }
  // Plan diagnostics already name the actual incompatible fields. Do not add
  // an opaque duplicate which tells the user only that diagnostics exist.
  findings.push(
    ...startFindings.filter(
      (item) =>
        item.code !== "graph_incompatible" ||
        !findings.some((detail) => detail.severity === "blocker")
    )
  );
  // Native start refuses on this flag alone; never report ready against it.
  if (
    reply.plan.enrollment_compatible !== true &&
    !findings.some((found) => found.severity === "blocker")
  ) {
    findings.push(
      finding(
        { severity: "blocker", gate: "runtime", code: "review_incompatible" },
        {
          message:
            "The native review does not admit this project, and gave no finding this version can show.",
          fix: "Update Hack, or see the native backend guide.",
        }
      )
    );
  }
  return { review: { status: "completed" }, findings, plan: reply.plan };
}

/** Compose services that are mappings, as native start's `specs`. */
function serviceSpecs(
  services: Readonly<Record<string, unknown>>
): Record<string, Record<string, unknown>> {
  const specs: Record<string, Record<string, unknown>> = {};
  for (const [name, service] of Object.entries(services)) {
    if (isRecord(service)) {
      specs[name] = service;
    }
  }
  return specs;
}

/**
 * The pool's bridge limit, which native start checks before any hook or
 * runtime work: at most 32 routes, and at most 32 routes plus published ports.
 * It needs no review, so it runs even when the review is skipped.
 */
function bridgeFindings(
  services: Readonly<Record<string, unknown>>
): NativePreflightFinding[] {
  const specs = serviceSpecs(services);
  try {
    nativeBridgeSocketCount({
      routes: nativeBridgeCapacity(specs),
      ports: nativePortPublicationCount(specs),
    });
    return [];
  } catch {
    return [
      finding(
        { severity: "blocker", gate: "cli", code: "too_many_bridges" },
        {
          message:
            "The project declares more routed services and published ports than one native pool serves.",
          fix: "Keep routes plus published ports to 32 or fewer, with at most 32 routed services.",
        }
      ),
    ];
  }
}

/**
 * Route admission, which native start runs on the reviewed plan: each active
 * routed service needs an enabled native HTTP probe on its route port and no
 * dependency cache. Checked one service at a time so the report names each.
 */
function routeFindings(opts: {
  readonly plan: Readonly<Record<string, unknown>>;
  readonly services: Readonly<Record<string, unknown>>;
}): NativePreflightFinding[] {
  if (!isRecord(opts.plan.services)) {
    return [];
  }
  const specs = serviceSpecs(opts.services);
  const found: NativePreflightFinding[] = [];
  for (const name of Object.keys(opts.plan.services).sort(byCodePoint)) {
    const reviewed = opts.plan.services[name];
    if (!(SERVICE.test(name) && isRecord(reviewed))) {
      continue;
    }
    try {
      reviewedNativeRoutes({
        plan: { services: { [name]: reviewed } },
        specs,
        capacity: 1,
      });
    } catch (error) {
      found.push(
        finding(
          {
            severity: "blocker",
            gate: "cli",
            code: "route_probe_required",
            service: name,
            field: "healthcheck.x-hack-http",
          },
          nativeRouteProbeRefusalDetails(error)
        )
      );
    }
  }
  return found;
}

/** Inputs the command layer resolves; nothing here is a secret value. */
export type NativePreflightOptions = {
  /** One bounded snapshot shared by project-name lookup, parsing and digest. */
  readonly composeBytes: Buffer | null;
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly composeFile: string;
  /** Findings the command layer already has, such as unreadable settings. */
  readonly settings: readonly NativePreflightFinding[];
  /** The adaptation file for the effective env, as native start selects it. */
  readonly adaptationFile: string | undefined;
  /**
   * False when the adaptation selection itself could not be read (already
   * reported in `settings`). The document is then unadapted, so it is not
   * reviewed, as with an adaptation file that is refused.
   */
  readonly adaptationSelected: boolean;
  /** Every adaptation a start could apply, for the Compose-backend pre-check. */
  readonly adaptationCandidates: readonly (string | undefined)[];
  /** Project-wide extra hosts, or null when they cannot be read. */
  readonly internalHosts: Readonly<Record<string, string>> | null;
  readonly internalHostSources: Readonly<Record<string, NativeHostAliasSource>>;
  readonly buildsEnabled: boolean;
  /** The source-share grant (`HACK_NATIVE_SHARED_SOURCE=1` or `sharedSource`). */
  readonly sharedSource: boolean;
  /** Whether a dependency file is selected for the effective env. */
  readonly hasHostDependencies: boolean;
  /**
   * Whether the default (not per-env) dependency file is set. Native start
   * admits project-wide extra hosts on this alone, so the preflight does too.
   */
  readonly hasDefaultDependencyFile: boolean;
  /** The project's default env, or null. */
  readonly effectiveEnvName: string | null;
  readonly profiles: readonly string[];
  /** The native runtime, `"incomplete"` for a selection without a candidate, or null. */
  readonly runtime: NativeRuntimeSelection | "incomplete" | null;
  /** The gcloud ADC consent (`HACK_NATIVE_GCLOUD_ADC=file` or `gcloud` setting). */
  readonly gcloud?: NativeGcloudSelection;
  /**
   * Whether the native HTTPS frontend is selected (machine `https` setting or
   * the HACK_NATIVE_CADDY_* variables). Routes are then served, so the
   * runtime's per-route `route_binding_required` note is not repeated.
   */
  readonly httpsSelected?: boolean;
  /** The native HTTPS frontend's port, when it is selected and known. */
  readonly httpsPort?: number | null;
  /**
   * The system resolver (hosts file and local overrides included); `[]` means
   * unknown. Tests inject it; the default asks the system resolver.
   */
  readonly resolveHost?: (hostname: string) => Promise<readonly string[]>;
  /**
   * Whether something accepts TCP on 127.0.0.1:443 (for example Hack's
   * Compose proxy). Tests inject it; the default makes one bounded connect.
   */
  readonly defaultHttpsTaken?: () => Promise<boolean>;
  readonly invoke?: typeof invokeNativeRuntime;
};

function hasSelectedRuntime(
  runtime: NativePreflightOptions["runtime"]
): runtime is NativeRuntimeSelection {
  return runtime !== null && runtime !== "incomplete";
}

async function collectSetupFinding(
  opts: NativePreflightOptions
): Promise<NativePreflightReport["runtime_setup"]> {
  let runtimeSetup: NativePreflightReport["runtime_setup"] = {
    state: "unavailable",
    code: "native_selection_unavailable",
    fix: "Select a native candidate to inspect its installation; run this command through hack-next or the candidate bundle.",
  };
  if (hasSelectedRuntime(opts.runtime)) {
    try {
      const inspected = await inspectNativeSetup({
        runtime: opts.runtime,
        cwd: opts.projectRoot,
        invoke: opts.invoke,
      });
      runtimeSetup = {
        state: inspected.state,
        installation_state: inspected.installation_state,
        code: inspected.code,
        fix: nativeSetupGuidance(inspected),
      };
    } catch {
      runtimeSetup = {
        state: "unavailable",
        code: "native_setup_unavailable",
        fix: "Native runtime installation could not be inspected; update the selected candidate and check access to its home.",
      };
    }
  }
  return runtimeSetup;
}

/** HACK-2324: a restart policy native does not apply to privately delivered services. */
function managedRestartFindings(
  document: NonNullable<AdaptedProject["document"]>,
  plan: unknown
): NativePreflightFinding[] {
  return nativeManagedRestartNotices({
    compose: JSON.parse(document.normalizedComposeJson),
    plan,
    delivered: new Set(document.managedServices),
  }).map(({ service, line }) =>
    finding(
      {
        severity: "warning",
        gate: "cli",
        code: "restart_policy_not_applied",
        service,
        field: `services.${service}.restart`,
      },
      {
        message: line,
        fix: "Nothing to do to start. If the service stops, run hack restart (native restarts the whole project; service names are not accepted). Automatic restart with a fresh delivery is planned.",
      }
    )
  );
}

function deliveryFindings(
  document: NonNullable<AdaptedProject["document"]>,
  plan: unknown
): NativePreflightFinding[] {
  try {
    document.checkDelivery(plan);
    return [];
  } catch (error: unknown) {
    return [environmentInputFinding(error, true)];
  }
}

/**
 * Setup states in which the selected binary answered and only the native home is
 * incomplete. The runtime's Compose review is static (it reads the project and
 * starts nothing), so it runs before setup and its findings are listed beside
 * the setup blocker.
 */
const PRE_SETUP_REVIEW_STATES: ReadonlySet<NativeSetupState> = new Set([
  "not_set_up",
  "partial_resumable",
]);

/**
 * The runtime review, or `skipped` with `native_setup_incomplete` when setup is
 * not ready and the review could not run (or must not run, for a home that is
 * invalid or unsafe). The report then names the checks that did not run.
 */
async function reviewWithSetup(opts: {
  readonly setup: NativeSetupState;
  readonly review: () => Promise<RuntimeReview>;
}): Promise<RuntimeReview> {
  const skipped: RuntimeReview = {
    review: { status: "skipped", code: "native_setup_incomplete" },
    findings: [],
  };
  if (opts.setup === "ready") {
    return await opts.review();
  }
  if (!PRE_SETUP_REVIEW_STATES.has(opts.setup)) {
    return skipped;
  }
  const reviewed = await opts.review();
  return reviewed.review.status === "unavailable" ? skipped : reviewed;
}

/** Runtime findings that still apply to this machine's selections. */
function selectedRuntimeFindings(
  findings: readonly NativePreflightFinding[],
  httpsSelected: boolean
): readonly NativePreflightFinding[] {
  return httpsSelected
    ? findings.filter((found) => found.code !== "route_binding_required")
    : findings;
}

/** Routed hostnames checked per preflight, so lookups stay bounded. */
const HOST_RESOLUTION_LIMIT = 32;

const MAPPED_DOTTED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/;
const MAPPED_HEX = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

/**
 * One spelling per address: an IPv4-mapped IPv6 answer, dotted or
 * hexadecimal (`::ffff:7f00:1`), becomes the IPv4 address it reaches.
 */
function canonicalAddress(address: string): string {
  const lower = address.toLowerCase();
  const dotted = MAPPED_DOTTED.exec(lower);
  if (dotted?.[1]) {
    return dotted[1];
  }
  const hex = MAPPED_HEX.exec(lower);
  if (hex?.[1] && hex[2]) {
    const high = Number.parseInt(hex[1], 16);
    const low = Number.parseInt(hex[2], 16);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
  }
  return lower;
}

/** Native's HTTPS listener binds exactly 127.0.0.1. */
function reachesNativeListener(address: string): boolean {
  return canonicalAddress(address) === "127.0.0.1";
}

function loopbackAddress(address: string): boolean {
  const canonical = canonicalAddress(address);
  return canonical === "::1" || canonical.startsWith("127.");
}

/** Each active routed service's hostnames, in service order. */
function routedHostnames(
  plan: Readonly<Record<string, unknown>>
): { service: string; hostname: string }[] {
  const routed: { service: string; hostname: string }[] = [];
  if (!isRecord(plan.services)) {
    return routed;
  }
  for (const name of Object.keys(plan.services).sort(byCodePoint)) {
    const reviewed = plan.services[name];
    if (
      !(
        SERVICE.test(name) &&
        isRecord(reviewed) &&
        reviewed.active !== false &&
        isRecord(reviewed.routing) &&
        Array.isArray(reviewed.routing.hostnames)
      )
    ) {
      continue;
    }
    for (const hostname of reviewed.routing.hostnames) {
      if (typeof hostname === "string" && hostname.length > 0) {
        routed.push({ service: name, hostname });
      }
    }
  }
  return routed;
}

/**
 * Per service: the non-loopback addresses its hostnames resolve to, and
 * whether a hostname resolved only to loopback. Unknown lookups add nothing.
 */
function classifyRouteAnswers(
  answers: readonly {
    readonly service: string;
    readonly addresses: readonly string[];
  }[]
): {
  readonly elsewhere: Map<string, Set<string>>;
  readonly loopbackOnly: Set<string>;
} {
  const elsewhere = new Map<string, Set<string>>();
  const loopbackOnly = new Set<string>();
  for (const answer of answers) {
    // A non-loopback answer can win the connection; a loopback-only answer
    // misses native unless one of its addresses is exactly 127.0.0.1 (::1
    // beside it is the usual localhost pair, which clients fall back from).
    const foreign = answer.addresses.some(reachesNativeListener)
      ? answer.addresses.filter((address) => !loopbackAddress(address))
      : answer.addresses;
    if (foreign.length > 0) {
      const set = elsewhere.get(answer.service) ?? new Set<string>();
      for (const address of foreign) {
        set.add(canonicalAddress(address));
      }
      elsewhere.set(answer.service, set);
    } else if (answer.addresses.length > 0) {
      loopbackOnly.add(answer.service);
    }
  }
  return { elsewhere, loopbackOnly };
}

/**
 * Native's HTTPS frontend listens on loopback (HACK-2338 item 6). A routed
 * hostname that resolves on this machine to another address (an existing
 * Compose proxy, a hosts entry, local DNS) reaches that address instead, so
 * the route looks broken even though native serves it. One warning per
 * service names the answering address and how to reach native. Hostnames are
 * label values and are never printed; an unknown lookup reports nothing.
 */
export async function hostResolutionFindings(opts: {
  readonly plan: Readonly<Record<string, unknown>>;
  readonly httpsPort: number;
  readonly resolveHost: (hostname: string) => Promise<readonly string[]>;
  readonly defaultHttpsTaken: () => Promise<boolean>;
}): Promise<NativePreflightFinding[]> {
  const routed = routedHostnames(opts.plan);
  const answers = await Promise.all(
    routed.slice(0, HOST_RESOLUTION_LIMIT).map(async (route) => ({
      ...route,
      addresses: await opts.resolveHost(route.hostname).catch(() => []),
    }))
  );
  const { elsewhere, loopbackOnly } = classifyRouteAnswers(answers);
  const port = opts.httpsPort;
  // Loopback names reach native only with its port when another listener
  // (such as Hack's Compose proxy on macOS) serves 443 on this machine.
  const portless =
    port !== 443 &&
    [...loopbackOnly].some((service) => !elsewhere.has(service)) &&
    (await opts.defaultHttpsTaken().catch(() => false))
      ? [...loopbackOnly].filter((service) => !elsewhere.has(service))
      : [];
  const portlessFindings: NativePreflightFinding[] = portless.map(
    (service) => ({
      severity: "warning",
      gate: "cli",
      code: "route_default_port_elsewhere",
      service,
      message: `A hostname this service routes resolves to this machine, where another listener (such as Hack's Compose proxy) answers on port 443; native's HTTPS listener is 127.0.0.1:${port}. A URL without a port reaches that other listener, not native.`,
      fix: `Open the route with port ${port} (hack open adds it), or stop the other listener on port 443 (for the Compose proxy, hack global down).`,
    })
  );
  return [
    ...portlessFindings,
    ...[...elsewhere].map(([service, addresses]) => {
      const list = [...addresses].sort();
      const compose = list.includes(DEFAULT_CADDY_IP)
        ? ", the address of Hack's Compose proxy"
        : "";
      return {
        severity: "warning",
        gate: "cli",
        code: "route_host_resolves_elsewhere",
        service,
        message: `A hostname this service routes resolves on this machine to ${list.join(", ")}${compose}, not to native's HTTPS listener on 127.0.0.1:${port}. Clients on this machine reach that address instead of native.`,
        fix: `Make the hostname resolve to 127.0.0.1 here (for the Compose proxy, stop it with hack global down; otherwise remove the hosts file or local DNS entry) and open it with port ${port}; or reach native directly with curl --resolve HOST:${port}:127.0.0.1 https://HOST:${port}/.`,
      } satisfies NativePreflightFinding;
    }),
  ];
}

/** A runtime request error's text is closed; anything else stays generic. */
function sourceMeasurementDetail(error: unknown): string {
  if (error instanceof HackCliError) {
    return `${error.code}: ${error.message}`;
  }
  if (error instanceof NativeRuntimeRequestError) {
    return error.message;
  }
  return "Values omitted.";
}

/**
 * Applies the source content limit enforced by `up` and `restart` before effects.
 * Only selected services that capture source are measured. Both an excessive
 * size and a failed measurement block preflight with the startup refusal.
 */
async function sourceSizeFindings(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly services: Readonly<Record<string, unknown>>;
  readonly profiles: readonly string[];
  readonly invoke?: typeof invokeNativeRuntime;
}): Promise<NativePreflightFinding[]> {
  const services = Object.fromEntries(
    Object.entries(opts.services).filter(
      (entry): entry is [string, Record<string, unknown>] => isRecord(entry[1])
    )
  );
  try {
    await requireCapturedNativeSourceWithinLimit({
      runtime: opts.runtime,
      projectRoot: opts.projectRoot,
      services,
      profiles: opts.profiles,
      invoke: opts.invoke,
    });
    return [];
  } catch (error: unknown) {
    const over =
      error instanceof HackCliError &&
      error.code === "E_NATIVE_PROJECT_UNSUPPORTED";
    const detail = sourceMeasurementDetail(error);
    return [
      {
        severity: "blocker",
        gate: "cli",
        code: over ? "native_source_over_limit" : "native_source_unmeasured",
        message: over
          ? (error as HackCliError).message
          : `Native source size could not be measured, so native up refuses before startup. ${detail}`,
        fix: over
          ? "Reduce the selected project source (the message names its largest parts) or raise native.sourceLimitMiB in .hack/hack.config.json, then run this check again."
          : "Fix what the message names so native can measure the project source, then run this check again.",
      },
    ];
  }
}

/**
 * With a native runtime selected: the runtime review, the source limit `up`
 * enforces, and the findings that need the reviewed plan.
 */
async function reviewSelectedRuntime(input: {
  readonly opts: NativePreflightOptions;
  readonly runtime: NativeRuntimeSelection;
  readonly setup: NativeSetupState;
  readonly document: NonNullable<AdaptedProject["document"]>;
}): Promise<{
  readonly runtime: RuntimeReview;
  readonly findings: NativePreflightFinding[];
}> {
  const { opts, document } = input;
  const findings: NativePreflightFinding[] = [];
  const runtime = await reviewWithSetup({
    setup: input.setup,
    review: () =>
      collectNativeRuntimeFindings({
        runtime: input.runtime,
        projectRoot: opts.projectRoot,
        composeFile: opts.composeFile,
        profiles: opts.profiles,
        adapted: document,
        invoke: opts.invoke,
      }),
  });
  if (input.setup === "ready") {
    findings.push(
      ...(await sourceSizeFindings({
        runtime: input.runtime,
        projectRoot: opts.projectRoot,
        services: document.services,
        profiles: opts.profiles,
        invoke: opts.invoke,
      }))
    );
  }
  if (runtime.plan) {
    findings.push(...deliveryFindings(document, runtime.plan));
    findings.push(...managedRestartFindings(document, runtime.plan));
    findings.push(
      ...routeFindings({ plan: runtime.plan, services: document.services })
    );
    if (opts.httpsSelected === true && opts.httpsPort) {
      findings.push(
        ...(await hostResolutionFindings({
          plan: runtime.plan,
          httpsPort: opts.httpsPort,
          resolveHost:
            opts.resolveHost ??
            ((hostname) => resolveProxyLoopbackAddresses({ hostname })),
          defaultHttpsTaken:
            opts.defaultHttpsTaken ??
            (async () =>
              (await probeProxyLoopback({
                address: "127.0.0.1",
                port: 443,
                caPem: "",
                protocol: "http",
                timeoutMs: 300,
              })) === "ok"),
        }))
      );
    }
  }
  return { runtime, findings };
}

/** Runs installation, CLI and runtime gates over the same selected project. */
export async function collectNativePreflight(
  opts: NativePreflightOptions
): Promise<NativePreflightReport> {
  const runtimeSetup = await collectSetupFinding(opts);
  const adapted = await adaptForPreflight(opts);
  const cli = [...opts.settings, ...adapted.findings];
  if (hasSelectedRuntime(opts.runtime) && runtimeSetup.state !== "ready") {
    cli.push({
      severity: "blocker",
      gate: "cli",
      code: "native_runtime_setup",
      message: `Native runtime setup: ${runtimeSetup.state.replaceAll("_", " ")}.`,
      fix: runtimeSetup.fix,
    });
  }
  let runtime: RuntimeReview = {
    review:
      opts.runtime === "incomplete"
        ? { status: "skipped", code: "native_selection_incomplete" }
        : { status: "skipped" },
    findings: [],
  };
  if (adapted.document) {
    cli.push(
      ...(await collectNativeCliFindings({
        ...opts,
        adapted: adapted.document,
      })),
      ...bridgeFindings(adapted.document.services)
    );
    if (!(adapted.document.adaptationValid && opts.adaptationSelected)) {
      // Reviewing the unadapted document would only add findings the
      // adaptation is there to remove.
      runtime = {
        review: { status: "skipped", code: "native_adaptation_invalid" },
        findings: [],
      };
    } else if (hasSelectedRuntime(opts.runtime)) {
      const selected = await reviewSelectedRuntime({
        opts,
        runtime: opts.runtime,
        setup: runtimeSetup.state,
        document: adapted.document,
      });
      runtime = selected.runtime;
      cli.push(...selected.findings);
    }
  }
  // A runtime finding the CLI already reported for the same service is
  // dropped, and so is an exact repeat (one per published port, for example).
  const reported = new Set(
    cli.map((found) => `${found.code}\0${found.service ?? ""}`)
  );
  const exact = new Set<string>();
  const projectCodes = new Set<string>();
  const all = cli.filter((found) => {
    if (found.service !== undefined) {
      return true;
    }
    if (projectCodes.has(found.code)) {
      return false;
    }
    projectCodes.add(found.code);
    return true;
  });
  for (const found of selectedRuntimeFindings(
    runtime.findings,
    opts.httpsSelected === true
  )) {
    const key = `${found.severity}\0${found.code}\0${found.service ?? ""}\0${found.field ?? ""}\0${found.message}`;
    if (
      reported.has(`${found.code}\0${found.service ?? ""}`) ||
      exact.has(key)
    ) {
      continue;
    }
    exact.add(key);
    all.push(found);
  }
  const blockers = all.filter((found) => found.severity === "blocker");
  return {
    report_version: 2,
    backend: "native",
    compose_file: relative(opts.projectRoot, opts.composeFile),
    ready:
      blockers.length === 0 &&
      !all.some((found) => found.severity === "consent") &&
      runtime.review.status === "completed" &&
      runtimeSetup.state === "ready",
    runtime_setup: runtimeSetup,
    consent_needed: all.filter((found) => found.severity === "consent"),
    runtime_review: runtime.review,
    blockers,
    warnings: all.filter((found) => found.severity === "warning"),
  };
}

function findingLines(found: NativePreflightFinding): string[] {
  const where = [
    found.service ? `service ${found.service}` : null,
    found.field ?? null,
  ]
    .filter((part) => part !== null)
    .join(", ");
  return [
    `- ${found.message}${where ? ` (${where})` : ""} [${found.code}]`,
    `  Fix: ${found.fix}`,
  ];
}

/** What the runtime review adds, so a skipped review says what was not checked. */
const SETUP_SKIPPED_CHECKS =
  "Not checked: the runtime's review of each service (mount sources, healthchecks and route probes, restart policies, platforms, privileges, devices and capabilities), private environment delivery, and route admission.";

function reviewLine(review: NativePreflightReport["runtime_review"]): string {
  if (review.status === "completed") {
    return "Runtime review: completed.";
  }
  if (review.status === "stopped") {
    return "Runtime review: stopped early. More findings may appear after the blocker below is fixed.";
  }
  if (review.status === "unavailable") {
    if (review.code === "native_start_review_unavailable") {
      return "Runtime review: unavailable; update the selected native runtime to include start-admission checks. Only the CLI's own checks ran.";
    }
    return "Runtime review: unavailable; the selected native runtime did not return a review. Only the CLI's own checks ran.";
  }
  if (review.code === "native_setup_incomplete") {
    return `Runtime review: skipped, because native setup is not complete. Only the CLI's own checks ran. ${SETUP_SKIPPED_CHECKS} Finish setup and run the preflight again.`;
  }
  if (review.code === "native_adaptation_invalid") {
    return "Runtime review: skipped, because the native adaptation is not valid. Fix it and run the preflight again.";
  }
  return review.code === "native_selection_incomplete"
    ? "Runtime review: skipped, because native is selected without a candidate (HACK_NATIVE_BINARY and HACK_NATIVE_HOME). Only the CLI's own checks ran. Run this from the hack-next launcher for the full list."
    : "Runtime review: skipped, because no native runtime is selected. Only the CLI's own checks ran. Run this from the hack-next launcher for the full list.";
}

/** The report for a person: plain sentences, one fix per finding, no values. */
export function renderNativePreflightReport(
  report: NativePreflightReport
): string {
  const lines = [
    `Native preflight for ${report.compose_file}`,
    `Runtime setup: ${report.runtime_setup.state.replaceAll("_", " ")}. ${report.runtime_setup.fix}`,
    reviewLine(report.runtime_review),
    "",
  ];
  if (report.blockers.length === 0) {
    lines.push(
      report.ready
        ? "No blockers. Native up should admit this project."
        : "No blockers found by the checks that ran."
    );
  } else {
    lines.push(
      `${report.blockers.length} blocker${report.blockers.length === 1 ? "" : "s"}: native up will refuse this project until these are fixed.`
    );
    for (const found of report.blockers) {
      lines.push(...findingLines(found));
    }
  }
  if (report.consent_needed.length > 0) {
    lines.push("", "Consent needed before native start:");
    for (const found of report.consent_needed) {
      lines.push(...findingLines(found));
    }
  }
  if (report.warnings.length > 0) {
    lines.push(
      "",
      `${report.warnings.length} note${report.warnings.length === 1 ? "" : "s"}: native starts, with these differences from Compose.`
    );
    for (const found of report.warnings) {
      lines.push(...findingLines(found));
    }
  }
  return `${lines.join("\n")}\n`;
}
