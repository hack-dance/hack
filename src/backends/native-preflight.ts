import { access } from "node:fs/promises";
import { join, relative } from "node:path";
import { isRecord } from "../lib/guards.ts";
import {
  type ComposeBackendFeature,
  readComposeBackendReading,
  readNativeComposeDocument,
} from "../lib/native-compose-backend-features.ts";
import { projectEnvConfigExists } from "../lib/project-env-config.ts";
import { admitNativeHttpProbe } from "./native-http-probe-admission.ts";
import { admitNativeProjectBuild } from "./native-project-builds.ts";
import {
  type NativeServicePreparationProblem,
  nativeServicePreparationProblems,
} from "./native-project-start.ts";
import {
  invokeNativeRuntime,
  NativeRuntimeRequestError,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

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
 * - Read-only. It starts no VM, pulls no image, runs no lifecycle hook and
 *   writes nothing. The only runtime request is `project plan`, which reads
 *   the project and needs no running runtime.
 * - Value-free. A finding carries a closed code, a service name, a field path
 *   and fixed sentences. Authored values (environment values, label keys and
 *   values, paths, image names) are never printed, and neither is the
 *   runtime's own message text.
 * - Not an admission decision. `hack up` still decides with its own checks; a
 *   clean report does not start anything and does not skip any of them.
 */

export const NATIVE_PREFLIGHT_COMMAND = "hack doctor --native-preflight";

export type NativePreflightFinding = {
  readonly severity: "blocker" | "warning";
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
  /** No native runtime is selected, so only the CLI's checks ran. */
  | "skipped"
  /** A native runtime is selected but the review request failed. */
  | "unavailable";

export type NativePreflightReport = {
  readonly report_version: 1;
  readonly backend: "native";
  /** The Compose file, relative to the project root. */
  readonly compose_file: string;
  /** No blocker was found and the runtime review completed. */
  readonly ready: boolean;
  readonly runtime_review: {
    readonly status: NativePreflightReviewStatus;
    /** The closed runtime code when the review stopped or failed. */
    readonly code?: string;
  };
  readonly blockers: readonly NativePreflightFinding[];
  readonly warnings: readonly NativePreflightFinding[];
};

type Explanation = { readonly message: string; readonly fix: string };

const USE_COMPOSE =
  "Run this project on the Compose backend (HACK_RUNTIME_BACKEND=compose), or remove it.";

const FEATURE_FINDINGS: Readonly<Record<ComposeBackendFeature, Explanation>> = {
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
    fix: "Remove labels that start with com.docker.compose. or io.hack.",
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
    message: "The service sets a logging configuration native does not accept.",
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
      "The service has a label native does not accept. Only the reviewed caddy routing labels, dependency cache labels and the one-shot marker are admitted.",
    fix: "Remove the other labels, or run this project on the Compose backend if a router or tool needs them.",
  },
};

/**
 * Plain words for the runtime review's most common codes. A code that is not
 * listed is still reported, by its code and field, with a pointer to the guide.
 */
const RUNTIME_FINDINGS: Readonly<Record<string, Explanation>> = {
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
    fix: "Use source:target with an optional :ro or :rw.",
  },
  invalid_mount: {
    message:
      "A mount is not in a form native accepts. Anonymous volumes, such as a bare /app/node_modules, are not supported.",
    fix: "Write each mount as source:target, and replace an anonymous volume with a named volume declared under volumes.",
  },
  reserved_mount_target: {
    message: "A mount replaces a system or runtime directory in the container.",
    fix: "Mount somewhere other than /, /proc, /sys, /dev, /run and /var/run. The Docker socket cannot be mounted.",
  },
  unresolved_mount_source: {
    message: "A mount source uses a variable or the home directory.",
    fix: "Use a path relative to the project.",
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
  unresolved_source_path: {
    message: "A mount source cannot be resolved inside the project.",
    fix: "Use a plain path relative to the project.",
  },
  missing_source: {
    message: "A file or directory the Compose file refers to does not exist.",
    fix: "Create it, or correct the path. This includes env_file targets and bind mount sources.",
  },
  external_network: FEATURE_FINDINGS.external_network,
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
    message: "The service uses network_mode host or service.",
    fix: "Remove network_mode and attach the service to a project network.",
  },
  undeclared_network: {
    message: "The service attaches to a network the file does not declare.",
    fix: "Add the network under the top-level networks key.",
  },
  invalid_port: {
    message: "A published port is not in a form native accepts.",
    fix: "Publish one TCP port as host:container. Port ranges are not supported.",
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
    fix: "Keep only caddy, caddy.reverse_proxy and caddy.tls for routing, and remove traefik, hack and com.docker.compose labels.",
  },
  external_logging_driver: {
    message: "The service sends logs to an external logging driver.",
    fix: "Remove logging, or use the json-file, local or none driver.",
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
    fix: "Move the variables into Hack managed env with hack env set --service.",
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
  optional_dependency_inactive: {
    message: "An optional dependency is not active and is skipped.",
    fix: "Nothing to do.",
  },
  route_binding_required: {
    message:
      "The service declares a route, which needs native HTTPS to be set up.",
    fix: "Set up native HTTPS (see the guide) and give the service a healthcheck with x-hack-http.",
  },
  inert_route_declaration: {
    message:
      "The service declares a hostname with no upstream; no route is served for it.",
    fix: "Add caddy.reverse_proxy if the service should be reachable by that hostname.",
  },
  explicit_dependency_binding_required: {
    message: "extra_hosts needs a host dependency binding.",
    fix: "Select a dependency file with HACK_NATIVE_DEPENDENCIES.",
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
  restart_policy_not_applied: {
    message:
      "The restart policy is not applied to a service with published ports or routes.",
    fix: "Nothing to do. The service starts without automatic restarts.",
  },
};

/**
 * Failures of the runtime itself, not verdicts on the project. The review
 * needs no running runtime, so these mean the selected binary could not
 * answer; they are reported as an unavailable review, never as a blocker.
 */
const RUNTIME_STATE_CODES = new Set([
  "runtime_not_running",
  "runtime_busy",
  "checkout_mismatch",
  "invalid_candidate_root",
]);

const SERVICE = /^[A-Za-z0-9_.-]{1,128}$/;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
/** A review field path: dotted Compose keys and list indexes, no authored text. */
const FIELD = /^[A-Za-z0-9_.[\]-]{1,256}$/;

function finding(
  base: Omit<NativePreflightFinding, "message" | "fix">,
  text: Explanation
): NativePreflightFinding {
  return { ...base, message: text.message, fix: text.fix };
}

/** The service a `services.<name>…` review field names, when it is well formed. */
function serviceOfField(field: string): string | undefined {
  if (!field.startsWith("services.")) {
    return;
  }
  const name = field.slice("services.".length).split(".", 1)[0] ?? "";
  return SERVICE.test(name) ? name : undefined;
}

function cliServiceFindings(opts: {
  readonly name: string;
  readonly service: unknown;
  readonly projectRoot: string;
  readonly composeFile: string;
  readonly buildsEnabled: boolean;
  readonly hasHostDependencies: boolean;
}): NativePreflightFinding[] {
  const { name, service } = opts;
  const base = { severity: "blocker", gate: "cli", service: name } as const;
  const found: NativePreflightFinding[] = [];
  const builds = new Set<string>();
  if (isRecord(service) && service.build !== undefined) {
    if (opts.buildsEnabled) {
      try {
        admitNativeProjectBuild({
          name,
          service,
          projectRoot: opts.projectRoot,
          composeFile: opts.composeFile,
        });
        builds.add(name);
      } catch {
        found.push(
          finding(
            { ...base, code: "unsupported_build_form", field: "build" },
            {
              message:
                "The service build is not in a form native builds accept.",
              fix: "Use a local context inside the project, a relative Dockerfile, and literal args; do not set image beside build.",
            }
          )
        );
      }
    } else {
      found.push(
        finding(
          { ...base, code: "build_requires_opt_in", field: "build" },
          {
            message:
              "The service is built from a Dockerfile, and native builds are off by default.",
            fix: "Set HACK_NATIVE_BUILDS=1 and prepare the native builder, or give the service a prebuilt image.",
          }
        )
      );
    }
  }
  if (isRecord(service) && Object.hasOwn(service, "env_file")) {
    found.push(
      finding(
        { ...base, code: "env_file", field: "env_file" },
        {
          message: "The service uses env_file, which native does not read.",
          fix: "Move its variables into Hack managed env with hack env set --service, or run hack doctor --migrate-env-config.",
        }
      )
    );
  }
  const declaresBuild = isRecord(service) && service.build !== undefined;
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
    const text = PREPARATION_FINDINGS[problem];
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

async function exists(path: string): Promise<boolean> {
  return await access(path).then(
    () => true,
    () => false
  );
}

/** Findings from the CLI's own admission. Reads project files only. */
export async function collectNativeCliFindings(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly composeFile: string;
  readonly adaptationCandidates?: readonly (string | undefined)[];
  readonly buildsEnabled: boolean;
  /** The source-share grant (`HACK_NATIVE_SHARED_SOURCE=1` or `sharedSource`). */
  readonly sharedSource: boolean;
  readonly hasHostDependencies: boolean;
}): Promise<NativePreflightFinding[]> {
  const found: NativePreflightFinding[] = [];
  const blocker = { severity: "blocker", gate: "cli" } as const;
  const compose = await readNativeComposeDocument(opts.composeFile);
  if (!(isRecord(compose) && isRecord(compose.services))) {
    return [
      finding(
        { ...blocker, code: "compose_file_unreadable" },
        {
          message:
            "The Compose file is missing, too large, not valid YAML, or has no services mapping.",
          fix: "Check .hack/docker-compose.yml. Native reads this one file and does not merge override files.",
        }
      ),
    ];
  }
  try {
    const reading = await readComposeBackendReading(opts.composeFile, {
      adaptationCandidates: opts.adaptationCandidates,
      buildsEnabled: opts.buildsEnabled,
    });
    for (const feature of reading.features) {
      found.push(
        finding({ ...blocker, code: feature }, FEATURE_FINDINGS[feature])
      );
    }
  } catch {
    found.push(
      finding(
        { ...blocker, code: "native_adaptation_invalid" },
        {
          message:
            "The native adaptation file is not valid or conflicts with the Compose file.",
          fix: "Check .hack/native/adaptation.json, or the file HACK_NATIVE_ADAPTATION names.",
        }
      )
    );
  }
  for (const [name, service] of Object.entries(compose.services).sort(
    ([a], [b]) => a.localeCompare(b)
  )) {
    if (!SERVICE.test(name)) {
      found.push(
        finding(
          { ...blocker, code: "invalid_service_name" },
          {
            message: "A service name uses characters native does not accept.",
            fix: "Use letters, digits, dot, dash and underscore.",
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
      })
    );
  }
  const managedEnv = await projectEnvConfigExists({
    projectDir: opts.projectDir,
  }).catch(() => true);
  if (
    !managedEnv &&
    ((await exists(join(opts.projectDir, ".env"))) ||
      (await exists(join(opts.projectRoot, ".env"))))
  ) {
    found.push(
      finding(
        { ...blocker, code: "dotenv_without_managed_env" },
        {
          message:
            "The project has a .env file and no Hack managed env. Native does not read .env files.",
          fix: "Migrate it with hack doctor --migrate-env-config, or remove the file.",
        }
      )
    );
  }
  if (!opts.sharedSource) {
    found.push(
      finding(
        { ...blocker, code: "shared_source_grant_required" },
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
function runtimeFinding(diagnostic: unknown): NativePreflightFinding | null {
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
  const field =
    typeof diagnostic.field === "string" && FIELD.test(diagnostic.field)
      ? diagnostic.field
      : undefined;
  const service = field ? serviceOfField(field) : undefined;
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

/**
 * Findings from the runtime review of the original Compose file. One
 * `project plan` request; no VM is needed and nothing is started.
 */
export async function collectNativeRuntimeFindings(opts: {
  readonly runtime: NativeRuntimeSelection | null;
  readonly projectRoot: string;
  readonly composeFile: string;
  readonly profiles?: readonly string[];
  readonly invoke?: typeof invokeNativeRuntime;
}): Promise<{
  readonly review: NativePreflightReport["runtime_review"];
  readonly findings: NativePreflightFinding[];
}> {
  if (!opts.runtime) {
    return { review: { status: "skipped" }, findings: [] };
  }
  const file = relative(opts.projectRoot, opts.composeFile);
  let reply: unknown;
  try {
    reply = await (opts.invoke ?? invokeNativeRuntime)({
      runtime: opts.runtime,
      cwd: opts.projectRoot,
      args: [
        "project",
        "plan",
        "--project",
        opts.projectRoot,
        "--file",
        file,
        ...(opts.profiles ?? []).flatMap((profile) => ["--profile", profile]),
        "--json",
      ],
    });
  } catch (error: unknown) {
    const code =
      error instanceof NativeRuntimeRequestError &&
      typeof error.nativeCode === "string" &&
      CODE.test(error.nativeCode)
        ? error.nativeCode
        : undefined;
    if (!code || RUNTIME_STATE_CODES.has(code)) {
      return {
        review: { status: "unavailable", ...(code ? { code } : {}) },
        findings: [],
      };
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
  if (!(isRecord(reply) && isRecord(reply.plan))) {
    return { review: { status: "unavailable" }, findings: [] };
  }
  const diagnostics = Array.isArray(reply.plan.diagnostics)
    ? reply.plan.diagnostics
    : [];
  return {
    review: { status: "completed" },
    findings: diagnostics.flatMap((diagnostic) => {
      const found = runtimeFinding(diagnostic);
      return found ? [found] : [];
    }),
  };
}

/** Both gates, merged: a runtime finding the CLI already reported is dropped. */
export function buildNativePreflightReport(opts: {
  readonly projectRoot: string;
  readonly composeFile: string;
  readonly cli: readonly NativePreflightFinding[];
  readonly runtime: Awaited<ReturnType<typeof collectNativeRuntimeFindings>>;
}): NativePreflightReport {
  const seen = new Set(
    opts.cli.map((found) => `${found.code}\0${found.service ?? ""}`)
  );
  const all = [
    ...opts.cli,
    ...opts.runtime.findings.filter(
      (found) => !seen.has(`${found.code}\0${found.service ?? ""}`)
    ),
  ];
  const blockers = all.filter((found) => found.severity === "blocker");
  return {
    report_version: 1,
    backend: "native",
    compose_file: relative(opts.projectRoot, opts.composeFile),
    ready: blockers.length === 0 && opts.runtime.review.status === "completed",
    runtime_review: opts.runtime.review,
    blockers,
    warnings: all.filter((found) => found.severity === "warning"),
  };
}

function findingLines(found: NativePreflightFinding): string[] {
  const where = [
    found.service ? `service ${found.service}` : null,
    found.field && !found.field.startsWith("services.") ? found.field : null,
    found.field?.startsWith("services.") ? found.field : null,
  ]
    .filter((part) => part !== null)
    .join(", ");
  return [
    `- ${found.message}${where ? ` (${where})` : ""} [${found.code}]`,
    `  Fix: ${found.fix}`,
  ];
}

const REVIEW_LINES: Readonly<Record<NativePreflightReviewStatus, string>> = {
  completed: "Runtime review: completed.",
  stopped:
    "Runtime review: stopped early. More findings may appear after the blocker below is fixed.",
  skipped:
    "Runtime review: skipped, because no native runtime is selected. Only the CLI's own checks ran. Run this from the hack-next launcher for the full list.",
  unavailable:
    "Runtime review: unavailable; the selected native runtime did not answer. Only the CLI's own checks ran.",
};

/** The report for a person: plain sentences, one fix per finding, no values. */
export function renderNativePreflightReport(
  report: NativePreflightReport
): string {
  const lines = [
    `Native preflight for ${report.compose_file}`,
    REVIEW_LINES[report.runtime_review.status],
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
