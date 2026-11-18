import { isRecord } from "../lib/guards.ts";

/** Where native's Compose profile selection came from. */
export type NativeProfileSource = "cli" | "managed-env" | "shell" | "none";

/** A notice's source label also covers profiles kept from the retained run. */
type NoticeSource = NativeProfileSource | "retained";

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

/**
 * One line naming the services the reviewed plan leaves out because their
 * Compose profiles are not selected, as Compose silently does; native says
 * so, with the selected profiles and how to select more. Null when every
 * service is active. Names only.
 */
export function nativeInactiveProfileNotice(opts: {
  readonly plan: unknown;
  readonly selection: {
    readonly profiles: readonly string[];
    readonly source: NoticeSource;
  };
}): string | null {
  const services =
    isRecord(opts.plan) && isRecord(opts.plan.services)
      ? opts.plan.services
      : {};
  const inactive = Object.entries(services)
    .filter(([, service]) => isRecord(service) && service.active === false)
    .map(([name]) => name)
    .sort();
  if (inactive.length === 0) {
    return null;
  }
  const selected =
    opts.selection.profiles.length === 0
      ? "none"
      : opts.selection.profiles.join(", ");
  const from = {
    cli: "--profile",
    "managed-env": "COMPOSE_PROFILES in the managed env",
    shell: "COMPOSE_PROFILES in the shell",
    none: "no --profile or COMPOSE_PROFILES",
    retained: "the retained run",
  }[opts.selection.source];
  return `Not starting ${inactive.length} service${inactive.length === 1 ? "" : "s"} whose Compose profiles are not selected: ${inactive.join(", ")}. Selected profiles: ${selected} (from ${from}). Select others with --profile or COMPOSE_PROFILES.`;
}
