import { isRecord } from "../lib/guards.ts";

/** Where native's Compose profile selection came from. */
export type NativeProfileSource = "cli" | "managed-env" | "shell" | "none";

export type NativeProfileSelection = {
  readonly profiles: readonly string[];
  readonly source: NativeProfileSource;
};

function parseProfiles(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((profile) => profile.trim())
    .filter((profile) => profile.length > 0);
}

/**
 * Selects Compose profiles for a native start from the same sources, in the
 * same order, as Compose under Hack (see `effectiveComposeProfiles`): the
 * command's `--profile` values; else `COMPOSE_PROFILES` from the managed env
 * Hack delivers to Compose (the selected `hack.env.*.yaml` layers), which
 * overrides the shell; else `COMPOSE_PROFILES` from the shell. Native never
 * reads the project's root `.env` (it is ignored, with a notice), so that
 * file is not a source here either.
 *
 * Compose's `*` enables every profile; it expands to every profile the Compose
 * file declares, so the runtime receives names only. Values are profile
 * names, never secrets; nothing else is read from the environments.
 */
export function selectNativeProfiles(opts: {
  readonly cliProfiles: readonly string[] | undefined;
  readonly managedEnv: Readonly<Record<string, string | undefined>>;
  readonly shellEnv: Readonly<Record<string, string | undefined>>;
  readonly declaredProfiles: readonly string[];
}): NativeProfileSelection {
  const expand = (profiles: readonly string[]): string[] =>
    profiles.includes("*")
      ? [...new Set(opts.declaredProfiles)].sort()
      : [...profiles];
  if (opts.cliProfiles !== undefined && opts.cliProfiles.length > 0) {
    return { profiles: expand(opts.cliProfiles), source: "cli" };
  }
  if (Object.hasOwn(opts.managedEnv, "COMPOSE_PROFILES")) {
    const profiles = parseProfiles(opts.managedEnv.COMPOSE_PROFILES);
    return { profiles: expand(profiles), source: "managed-env" };
  }
  const shell = parseProfiles(opts.shellEnv.COMPOSE_PROFILES);
  return shell.length > 0
    ? { profiles: expand(shell), source: "shell" }
    : { profiles: [], source: "none" };
}

/** Every profile name a Compose document's services declare, sorted. */
export function declaredComposeProfiles(compose: unknown): string[] {
  if (!(isRecord(compose) && isRecord(compose.services))) {
    return [];
  }
  const names = new Set<string>();
  for (const service of Object.values(compose.services)) {
    if (isRecord(service) && Array.isArray(service.profiles)) {
      for (const profile of service.profiles) {
        if (typeof profile === "string" && profile.length > 0) {
          names.add(profile);
        }
      }
    }
  }
  return [...names].sort();
}

/** Where a notice's profile set came from, including a retained run's. */
export type NativeProfileNoticeSource = NativeProfileSource | "retained";

const SOURCE_LABEL: Readonly<Record<NativeProfileNoticeSource, string>> = {
  cli: "--profile",
  "managed-env": "COMPOSE_PROFILES in the managed env",
  shell: "COMPOSE_PROFILES in the shell",
  none: "no --profile or COMPOSE_PROFILES",
  retained: "the retained run",
};

function profileList(profiles: readonly string[]): string {
  return profiles.length === 0 ? "none" : profiles.join(", ");
}

/** The services a reviewed plan marks inactive, sorted. Names only. */
export function nativeInactiveServices(plan: unknown): string[] {
  const services =
    isRecord(plan) && isRecord(plan.services) ? plan.services : {};
  return Object.entries(services)
    .filter(([, service]) => isRecord(service) && service.active === false)
    .map(([name]) => name)
    .sort();
}

/**
 * One line naming the services left out because their Compose profiles are
 * not selected, as Compose silently does; native says so, with the selected
 * profiles, where they came from and how to select more. Null when none.
 */
export function nativeLeftOutNotice(opts: {
  readonly services: readonly string[];
  readonly profiles: readonly string[];
  readonly source: NativeProfileNoticeSource;
}): string | null {
  const count = opts.services.length;
  if (count === 0) {
    return null;
  }
  return `Not starting ${count} service${count === 1 ? "" : "s"} whose Compose profiles are not selected: ${opts.services.join(", ")}. Selected profiles: ${profileList(opts.profiles)} (from ${SOURCE_LABEL[opts.source]}). Select others with --profile or COMPOSE_PROFILES.`;
}

/**
 * A retained native run keeps the profiles it started with: `up` and
 * `restart` never replace its data with a different selection. When the
 * environment now selects other profiles, say so instead of refusing.
 */
export function nativeRetainedProfilesNotice(opts: {
  readonly retained: readonly string[];
  readonly selected: readonly string[];
  readonly source: "managed-env" | "shell";
}): string {
  return `${SOURCE_LABEL[opts.source]} selects profiles ${profileList(opts.selected)}, but this instance's retained run uses ${profileList(opts.retained)}; it keeps those. To start it with the new profiles, stop it with hack down --remove-data (this deletes its data volumes) and run hack up again.`;
}

/**
 * A profile notice as data, so a detached owner (whose stderr is not shown)
 * can hand it to its launcher. Names only: services, profiles and a source.
 */
export type NativeProfileNotice =
  | {
      readonly kind: "left-out";
      readonly services: readonly string[];
      readonly profiles: readonly string[];
      readonly source: NativeProfileNoticeSource;
    }
  | {
      readonly kind: "retained";
      readonly retained: readonly string[];
      readonly selected: readonly string[];
      readonly source: "managed-env" | "shell";
    };

export function renderNativeProfileNotice(
  notice: NativeProfileNotice
): string | null {
  return notice.kind === "left-out"
    ? nativeLeftOutNotice(notice)
    : nativeRetainedProfilesNotice(notice);
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SOURCES = new Set<string>(Object.keys(SOURCE_LABEL));

function names(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 256 &&
    value.every((name) => typeof name === "string" && NAME.test(name))
  );
}

/** Validates a notice received over IPC; anything else is dropped. */
export function parseNativeProfileNotice(
  value: unknown
): NativeProfileNotice | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    value.kind === "left-out" &&
    names(value.services) &&
    names(value.profiles) &&
    typeof value.source === "string" &&
    SOURCES.has(value.source)
  ) {
    return {
      kind: "left-out",
      services: value.services,
      profiles: value.profiles,
      source: value.source as NativeProfileNoticeSource,
    };
  }
  if (
    value.kind === "retained" &&
    names(value.retained) &&
    names(value.selected) &&
    (value.source === "managed-env" || value.source === "shell")
  ) {
    return {
      kind: "retained",
      retained: value.retained,
      selected: value.selected,
      source: value.source,
    };
  }
  return null;
}
