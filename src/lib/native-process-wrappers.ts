import { resolveNativeComposeText } from "../backends/native-compose-interpolation.ts";
import { HackCliError } from "./cli-result.ts";
import { isRecord } from "./guards.ts";

/**
 * Native wraps some services' processes: private environment delivery runs
 * the selected process through a launcher, and host-dependency services run it
 * behind a release barrier. Both run exactly what Docker would (image or
 * Compose `entrypoint` + `command`, bare executable names resolved through the
 * container's PATH, shell-form health checks through `/bin/sh -c`), but a few
 * settings still cannot be wrapped. Native up checks every wrapped service
 * before any runtime state is reserved and names each refused service and
 * field; this module predicts the Compose-declared cases before `up` starts
 * anything, and parses and describes the runtime's named refusals.
 *
 * Settings inherited from an image (its ENTRYPOINT, CMD or USER) are not read
 * here; native up checks those against the pinned image and reports every
 * refused service at once.
 */
export const NATIVE_PROCESS_FIELDS = [
  "entrypoint",
  "healthcheck",
  "user",
  "stop_signal",
  "mounts",
] as const;

export type NativeProcessField = (typeof NATIVE_PROCESS_FIELDS)[number];

/** One refused (service, field) pair; value-free. */
export type NativeProcessRefusal = {
  readonly service: string;
  readonly field: NativeProcessField;
};

const SERVICE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_REFUSALS = 32;

/**
 * Accept only the runtime's versioned, bounded `process_refusals` contract;
 * anything else is dropped whole.
 */
export function readNativeProcessRefusals(
  value: unknown
): readonly NativeProcessRefusal[] | undefined {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    value.version !== 1 ||
    !Array.isArray(value.refusals) ||
    value.refusals.length < 1 ||
    value.refusals.length > MAX_REFUSALS
  ) {
    return;
  }
  const result: NativeProcessRefusal[] = [];
  for (const entry of value.refusals) {
    if (
      !isRecord(entry) ||
      Object.keys(entry).length !== 2 ||
      typeof entry.service !== "string" ||
      !SERVICE.test(entry.service) ||
      !NATIVE_PROCESS_FIELDS.includes(entry.field as NativeProcessField)
    ) {
      return;
    }
    result.push({
      service: entry.service,
      field: entry.field as NativeProcessField,
    });
  }
  return result;
}

const FIELD_LABELS: Readonly<Record<NativeProcessField, string>> = {
  entrypoint: "entrypoint or command",
  healthcheck: "healthcheck test",
  user: "user",
  stop_signal: "stop_signal",
  mounts: "volume target",
};

const FIELD_ADVICE: Readonly<Record<NativeProcessField, string>> = {
  entrypoint: "the process must name an executable",
  healthcheck: "use an exec-form CMD test that names an executable",
  user: "use a numeric UID or UID:GID",
  stop_signal: "use SIGTERM, SIGINT, SIGQUIT or SIGKILL",
  mounts: "a volume target overlaps a path the wrapper reserves",
};

/** `service web (user: use a numeric UID or UID:GID); ...`, fields in a fixed order. */
export function describeNativeProcessRefusals(
  refusals: readonly NativeProcessRefusal[]
): string {
  return refusals
    .map(
      (refusal) =>
        `service ${refusal.service} ${FIELD_LABELS[refusal.field]} (${FIELD_ADVICE[refusal.field]})`
    )
    .join("; ");
}

const SIGNALS = new Set(["SIGTERM", "SIGINT", "SIGQUIT", "SIGKILL"]);
const NUMERIC_USER = /^(\d{1,10})(?::(\d{1,10}))?$/;
const MAX_ID = 2_147_483_647;
const ENVIRONMENT_RESERVED = ["/run/hack-environment"];
const DEPENDENCY_RESERVED = [
  "/run/hack-relay-guest",
  "/run/hack-startup",
  "/run/hack-dependencies",
];

/** A Compose string as native execution resolves it; null when not knowable. */
function compiled(value: string): string | null {
  return resolveNativeComposeText({ text: value });
}

function numericUser(value: unknown): boolean | undefined {
  if (value === undefined || value === null) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 && value <= MAX_ID;
  }
  if (typeof value !== "string") {
    return false;
  }
  const user = compiled(value);
  if (user === null) {
    return;
  }
  if (user === "") {
    return true;
  }
  const match = NUMERIC_USER.exec(user);
  return (
    match !== null &&
    Number(match[1]) <= MAX_ID &&
    (match[2] === undefined || Number(match[2]) <= MAX_ID)
  );
}

function emptyArgv(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return typeof value === "string" && value.trim() === "";
}

/** True when the declared entrypoint and command select no executable. */
function emptyProcess(service: Readonly<Record<string, unknown>>): boolean {
  const entrypoint = service.entrypoint;
  if (Array.isArray(entrypoint) && entrypoint.length > 0) {
    const first = entrypoint[0];
    return typeof first === "string" && (first === "" || first === "/");
  }
  if (!emptyArgv(entrypoint)) {
    return false;
  }
  // An explicit empty entrypoint suppresses the image's CMD as well.
  const command = service.command;
  if (Array.isArray(command) && command.length > 0) {
    const first = command[0];
    return typeof first === "string" && (first === "" || first === "/");
  }
  return command === undefined || command === null || emptyArgv(command);
}

function unwrappableHealth(health: unknown): boolean {
  // A native HTTP probe replaces the container health check entirely.
  if (
    !isRecord(health) ||
    health.disable === true ||
    Object.hasOwn(health, "x-hack-http")
  ) {
    return false;
  }
  const test = health.test;
  if (test === undefined || test === null) {
    return false;
  }
  if (typeof test === "string") {
    return test.trim() === "";
  }
  if (!Array.isArray(test) || test.length === 0) {
    return true;
  }
  const [kind, ...rest] = test;
  if (kind === "NONE") {
    return false;
  }
  if (kind === "CMD") {
    return !(
      typeof rest[0] === "string" &&
      rest[0] !== "" &&
      rest.every((part) => typeof part === "string")
    );
  }
  if (kind === "CMD-SHELL") {
    return !(
      rest.length === 1 &&
      typeof rest[0] === "string" &&
      rest[0] !== ""
    );
  }
  return true;
}

function volumeTargets(volumes: unknown): string[] {
  if (!Array.isArray(volumes)) {
    return [];
  }
  const targets: string[] = [];
  for (const volume of volumes) {
    if (typeof volume === "string") {
      const parts = volume.split(":");
      const target = parts.length >= 2 ? parts[1] : parts[0];
      if (target) {
        targets.push(target);
      }
    } else if (isRecord(volume) && typeof volume.target === "string") {
      targets.push(volume.target);
    }
  }
  return targets;
}

/** The same reserved targets the environment launcher and release barrier refuse. */
function reservedTarget(target: string, dependency: boolean): boolean {
  const normalized =
    target.length > 1 && target.endsWith("/") ? target.slice(0, -1) : target;
  return (
    normalized === "/" ||
    normalized === "/run" ||
    ENVIRONMENT_RESERVED.some((prefix) => normalized.startsWith(prefix)) ||
    (dependency &&
      DEPENDENCY_RESERVED.some(
        (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`)
      ))
  );
}

/**
 * Compose-declared settings native cannot wrap, for every wrapped service:
 * `wrapped` services have their process wrapped, `fileOwners` receive private
 * files only (their user must be numeric). `dependencies` are the wrapped
 * services that also run behind the host-dependency release barrier.
 * Interpolated values are compiled like native execution; unknown ones are
 * left to the runtime check.
 */
export function predictNativeProcessRefusals(opts: {
  readonly services: Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
  readonly wrapped: ReadonlySet<string>;
  readonly dependencies?: ReadonlySet<string>;
  readonly fileOwners?: ReadonlySet<string>;
}): NativeProcessRefusal[] {
  const refusals: NativeProcessRefusal[] = [];
  for (const name of Object.keys(opts.services).sort()) {
    const service = opts.services[name];
    const wrapped = opts.wrapped.has(name);
    if (
      !(
        service &&
        SERVICE.test(name) &&
        (wrapped || opts.fileOwners?.has(name))
      )
    ) {
      continue;
    }
    const add = (field: NativeProcessField) => {
      if (refusals.length < MAX_REFUSALS) {
        refusals.push({ service: name, field });
      }
    };
    if (wrapped && emptyProcess(service)) {
      add("entrypoint");
    }
    if (wrapped && unwrappableHealth(service.healthcheck)) {
      add("healthcheck");
    }
    if (numericUser(service.user) === false) {
      add("user");
    }
    if (
      wrapped &&
      typeof service.stop_signal === "string" &&
      !SIGNALS.has(service.stop_signal)
    ) {
      add("stop_signal");
    }
    const dependency = opts.dependencies?.has(name) === true;
    if (
      wrapped &&
      volumeTargets(service.volumes).some((target) =>
        reservedTarget(target, dependency)
      )
    ) {
      add("mounts");
    }
  }
  return refusals;
}

/**
 * Compose profile activation: a service without `profiles` (or with an empty
 * list) always runs; otherwise it runs only when one of its profiles is
 * selected. Inactive services are never scheduled, so nothing wraps them.
 */
export function activeNativeService(
  service: Readonly<Record<string, unknown>>,
  profiles: readonly string[]
): boolean {
  const declared = service.profiles;
  if (declared === undefined || declared === null) {
    return true;
  }
  return (
    Array.isArray(declared) &&
    (declared.length === 0 ||
      declared.some(
        (profile) => typeof profile === "string" && profiles.includes(profile)
      ))
  );
}

function activeServices(
  services: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  profiles: readonly string[]
): Record<string, Readonly<Record<string, unknown>>> {
  const result: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const [name, service] of Object.entries(services)) {
    if (activeNativeService(service, profiles)) {
      Object.defineProperty(result, name, {
        value: service,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return result;
}

/** Leading text of the refusal for Compose settings no process wrapper can run. */
export const NATIVE_PROCESS_WRAPPER_REFUSAL =
  "Native up cannot wrap these services' processes; nothing was started.";

/**
 * Refuse, before the VM starts, the Compose-declared settings the runtime's
 * process wrappers refuse. Services with private environment values or host
 * dependency bindings have their process wrapped, and services with private
 * files only need a numeric user. Settings inherited from images are checked
 * by the runtime against the pinned image before any state is reserved.
 */
export function requireWrappableNativeProcesses(opts: {
  readonly services: Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
  /** Selected profiles: services outside them never run and are not checked. */
  readonly profiles: readonly string[];
  readonly managedEnvironment: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
  readonly managedFiles?: Readonly<Record<string, readonly unknown[]>>;
  readonly dependencyServices: readonly string[];
}): void {
  const dependencies = new Set(opts.dependencyServices);
  const wrapped = new Set(dependencies);
  for (const [service, values] of Object.entries(opts.managedEnvironment)) {
    if (Object.keys(values).length > 0) {
      wrapped.add(service);
    }
  }
  const fileOwners = new Set(
    Object.entries(opts.managedFiles ?? {})
      .filter(([service, files]) => files.length > 0 && !wrapped.has(service))
      .map(([service]) => service)
  );
  const refusals = predictNativeProcessRefusals({
    services: activeServices(opts.services, opts.profiles),
    wrapped,
    dependencies,
    fileOwners,
  });
  if (refusals.length > 0) {
    throw new HackCliError({
      code: "E_NATIVE_PROJECT_UNSUPPORTED",
      message: `${NATIVE_PROCESS_WRAPPER_REFUSAL} Refused: ${describeNativeProcessRefusals(refusals)}.`,
    });
  }
}

/** Doctor check id for the process-wrapper prediction. */
export const NATIVE_PROCESS_CHECK = "native process wrappers";

/** Value-free JSON payload: service names and closed fields only. */
export type NativeProcessReport = {
  readonly refusals: readonly NativeProcessRefusal[];
  /** Services behind a profile: refused only when that profile is selected. */
  readonly profiled?: readonly NativeProcessRefusal[];
};

function declaresHostGateway(extraHosts: unknown): boolean {
  if (isRecord(extraHosts)) {
    return Object.values(extraHosts).some(
      (target) => target === "host-gateway"
    );
  }
  return (
    Array.isArray(extraHosts) &&
    extraHosts.some(
      (entry) => typeof entry === "string" && entry.endsWith("host-gateway")
    )
  );
}

/** Bare or null environment keys are where Hack delivers managed values. */
function declaresManagedKeys(environment: unknown): boolean {
  if (isRecord(environment)) {
    return Object.values(environment).some((value) => value === null);
  }
  return (
    Array.isArray(environment) &&
    environment.some(
      (entry) => typeof entry === "string" && !entry.includes("=")
    )
  );
}

/**
 * The services native up may wrap, from the Compose file alone: every service
 * when project-wide host aliases exist (each then needs a host dependency
 * binding), services that declare a host-gateway extra host, and services
 * that declare bare environment keys Hack can deliver privately.
 */
export function nativeWrappedServiceCandidates(opts: {
  readonly compose: unknown;
  readonly projectWideAliases: boolean;
}): {
  readonly services: Record<string, Readonly<Record<string, unknown>>>;
  readonly wrapped: ReadonlySet<string>;
  readonly dependencies: ReadonlySet<string>;
} {
  const services: Record<string, Readonly<Record<string, unknown>>> = {};
  const wrapped = new Set<string>();
  const dependencies = new Set<string>();
  if (!(isRecord(opts.compose) && isRecord(opts.compose.services))) {
    return { services, wrapped, dependencies };
  }
  for (const [name, service] of Object.entries(opts.compose.services)) {
    if (!(isRecord(service) && SERVICE.test(name))) {
      continue;
    }
    Object.defineProperty(services, name, {
      value: service,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    if (opts.projectWideAliases || declaresHostGateway(service.extra_hosts)) {
      dependencies.add(name);
      wrapped.add(name);
    }
    if (declaresManagedKeys(service.environment)) {
      wrapped.add(name);
    }
  }
  return { services, wrapped, dependencies };
}

/**
 * Doctor result for the process-wrapper prediction. Warning when a
 * Compose-declared setting would be refused, otherwise ok. Read-only and
 * value-free apart from service names.
 */
export function nativeProcessCheckResult(
  refusals: readonly NativeProcessRefusal[],
  /** Refusals of services that run only when one of their profiles is selected. */
  profiled: readonly NativeProcessRefusal[] = []
): {
  readonly name: string;
  readonly status: "ok" | "warn";
  readonly message: string;
  readonly nativeProcess: NativeProcessReport;
} {
  const nativeProcess = {
    refusals: refusals.map((entry) => ({ ...entry })),
    ...(profiled.length > 0
      ? { profiled: profiled.map((entry) => ({ ...entry })) }
      : {}),
  };
  const note =
    profiled.length > 0
      ? ` Only when their profile is selected: ${describeNativeProcessRefusals(profiled)}.`
      : "";
  if (refusals.length === 0) {
    return {
      name: NATIVE_PROCESS_CHECK,
      status: "ok",
      message: `No Compose setting blocks native process wrapping for the services that always run; native up checks image entrypoints, commands and users before it reserves anything and names every refused service at once.${note}`,
      nativeProcess,
    };
  }
  return {
    name: NATIVE_PROCESS_CHECK,
    status: "warn",
    message: `Native up would refuse to wrap these services' processes: ${describeNativeProcessRefusals(refusals)}.${note}`,
    nativeProcess,
  };
}

/**
 * Doctor's prediction, split by profile activation: services that always run
 * can block `up` (warning); services behind a profile block it only when that
 * profile is selected, so they are reported as information only.
 */
export function nativeProcessCheckFromCompose(opts: {
  readonly compose: unknown;
  readonly projectWideAliases: boolean;
}): ReturnType<typeof nativeProcessCheckResult> {
  const candidates = nativeWrappedServiceCandidates(opts);
  const refusals = predictNativeProcessRefusals(candidates);
  const always = refusals.filter((refusal) => {
    const service = candidates.services[refusal.service];
    return service !== undefined && activeNativeService(service, []);
  });
  return nativeProcessCheckResult(
    always,
    refusals.filter((refusal) => !always.includes(refusal))
  );
}
