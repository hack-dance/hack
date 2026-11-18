import { isRecord } from "../lib/guards.ts";
import { readNativeComposeDocument } from "../lib/native-compose-backend-features.ts";
import type { ProjectContext } from "../lib/project.ts";
import {
  resolveProjectEnvConfig,
  selectProjectEnvValuesForExecutionTarget,
} from "../lib/project-env-config.ts";

/** Where native's Compose profile selection came from. */
export type NativeProfileSource = "cli" | "managed-env" | "shell" | "none";

export type NativeProfileSelection = {
  readonly profiles: readonly string[];
  readonly source: NativeProfileSource;
  /**
   * Every profile the Compose file declares. Notices print only these
   * names: COMPOSE_PROFILES can come from decrypted managed env, so a
   * selected name the Compose file does not declare is counted, never shown.
   */
  readonly declaredProfiles?: readonly string[];
  /**
   * COMPOSE_PROFILES names the Compose file does not declare, dropped
   * before use. They select nothing in Compose, and COMPOSE_PROFILES may
   * hold a value copied from decrypted managed env, so such a name never
   * reaches a runtime argument, saved state or output; it is only counted.
   */
  readonly ignoredUndeclared?: number;
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
    return {
      profiles: expand(opts.cliProfiles),
      source: "cli",
      declaredProfiles: opts.declaredProfiles,
    };
  }
  // Environment selectors are reduced to declared names before any use.
  const fromEnv = (
    raw: string[],
    source: "managed-env" | "shell"
  ): NativeProfileSelection => {
    const expanded = expand(raw);
    const declared = new Set(opts.declaredProfiles);
    const profiles = expanded.filter((profile) => declared.has(profile));
    return {
      profiles,
      source,
      declaredProfiles: opts.declaredProfiles,
      ignoredUndeclared: expanded.length - profiles.length,
    };
  };
  if (Object.hasOwn(opts.managedEnv, "COMPOSE_PROFILES")) {
    return fromEnv(
      parseProfiles(opts.managedEnv.COMPOSE_PROFILES),
      "managed-env"
    );
  }
  const shell = parseProfiles(opts.shellEnv.COMPOSE_PROFILES);
  return shell.length > 0
    ? fromEnv(shell, "shell")
    : { profiles: [], source: "none", declaredProfiles: opts.declaredProfiles };
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

/**
 * Splits profile names for a notice: those the Compose file declares are
 * shown; the rest (possibly a value copied into COMPOSE_PROFILES from
 * decrypted managed env) are only counted.
 */
export function nativeDeclaredProfileNames(opts: {
  readonly profiles: readonly string[];
  readonly declared: readonly string[];
}): { readonly shown: string[]; readonly hidden: number } {
  const declared = new Set(opts.declared);
  const shown = opts.profiles.filter((profile) => declared.has(profile));
  return { shown, hidden: opts.profiles.length - shown.length };
}

function profileList(profiles: readonly string[], hidden = 0): string {
  const parts = [...profiles];
  if (hidden > 0) {
    parts.push(
      `${hidden} name${hidden === 1 ? "" : "s"} not declared by the Compose file`
    );
  }
  return parts.length === 0 ? "none" : parts.join(", ");
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
  /** Declared names only; see {@link nativeDeclaredProfileNames}. */
  readonly profiles: readonly string[];
  readonly hiddenProfiles?: number;
  readonly source: NativeProfileNoticeSource;
}): string | null {
  const count = opts.services.length;
  if (count === 0) {
    return null;
  }
  return `Not starting ${count} service${count === 1 ? "" : "s"} whose Compose profiles are not selected: ${opts.services.join(", ")}. Selected profiles: ${profileList(opts.profiles, opts.hiddenProfiles)} (from ${SOURCE_LABEL[opts.source]}). Select others with --profile or COMPOSE_PROFILES.`;
}

/**
 * A retained native run keeps the profiles it started with: `up` and
 * `restart` never replace its data with a different selection. When the
 * environment now selects other profiles, say so instead of refusing.
 */
export function nativeRetainedProfilesNotice(opts: {
  /** Declared names only; see {@link nativeDeclaredProfileNames}. */
  readonly retained: readonly string[];
  readonly hiddenRetained?: number;
  readonly selected: readonly string[];
  readonly hiddenSelected?: number;
  readonly source: "managed-env" | "shell";
}): string {
  return `${SOURCE_LABEL[opts.source]} selects profiles ${profileList(opts.selected, opts.hiddenSelected)}, but this instance's retained run uses ${profileList(opts.retained, opts.hiddenRetained)}; it keeps those. To start it with the new profiles, stop it with hack down --remove-data (this deletes its data volumes) and run hack up again.`;
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
      readonly hiddenProfiles?: number;
      readonly source: NativeProfileNoticeSource;
    }
  | {
      readonly kind: "retained";
      readonly retained: readonly string[];
      readonly hiddenRetained?: number;
      readonly selected: readonly string[];
      readonly hiddenSelected?: number;
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

function count(value: unknown): value is number | undefined {
  return (
    value === undefined ||
    (Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 256)
  );
}

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
    count(value.hiddenProfiles) &&
    typeof value.source === "string" &&
    SOURCES.has(value.source)
  ) {
    return {
      kind: "left-out",
      services: value.services,
      profiles: value.profiles,
      ...(value.hiddenProfiles ? { hiddenProfiles: value.hiddenProfiles } : {}),
      source: value.source as NativeProfileNoticeSource,
    };
  }
  if (
    value.kind === "retained" &&
    names(value.retained) &&
    names(value.selected) &&
    count(value.hiddenRetained) &&
    count(value.hiddenSelected) &&
    (value.source === "managed-env" || value.source === "shell")
  ) {
    return {
      kind: "retained",
      retained: value.retained,
      ...(value.hiddenRetained ? { hiddenRetained: value.hiddenRetained } : {}),
      selected: value.selected,
      ...(value.hiddenSelected ? { hiddenSelected: value.hiddenSelected } : {}),
      source: value.source,
    };
  }
  return null;
}

/**
 * Native's Compose profile selection for a project, from the same sources
 * and in the same order as Compose under Hack: `cliProfile`, else
 * `COMPOSE_PROFILES` in the managed env of `envName`, else in `shellEnv`
 * (see {@link selectNativeProfiles}). `up` and `--native-preflight` share it.
 * A managed env that cannot be resolved here contributes nothing; native
 * input preparation refuses it next.
 */
export async function resolveNativeProfileSelectionForProject(opts: {
  readonly project: Pick<
    ProjectContext,
    "composeFile" | "projectRoot" | "projectDir"
  >;
  readonly envName: string | null | undefined;
  readonly cliProfile: string | undefined;
  readonly shellEnv?: Readonly<Record<string, string | undefined>>;
}): Promise<NativeProfileSelection> {
  const compose = await readNativeComposeDocument(
    opts.project.composeFile
  ).catch(() => null);
  const serviceNames =
    isRecord(compose) && isRecord(compose.services)
      ? Object.keys(compose.services)
      : [];
  const resolved = await resolveProjectEnvConfig({
    projectRoot: opts.project.projectRoot,
    projectDir: opts.project.projectDir,
    envName: opts.envName,
    serviceNames,
  }).catch(() => null);
  return selectNativeProfiles({
    cliProfiles:
      opts.cliProfile === undefined
        ? undefined
        : parseProfiles(opts.cliProfile),
    managedEnv: resolved
      ? selectProjectEnvValuesForExecutionTarget({
          resolved,
          scopeName: "global",
          target: "compose",
        })
      : {},
    shellEnv: opts.shellEnv ?? process.env,
    declaredProfiles: declaredComposeProfiles(compose),
  });
}
