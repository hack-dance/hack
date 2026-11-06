import { constants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { HackCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";

/**
 * Explicit `linux/amd64` emulation for native services (Rosetta 2 in the VM).
 *
 * The native VM is Linux arm64. A service runs a `linux/amd64` image only when the
 * `HACK_NATIVE_ADAPTATION` selection opts it in through `amd64Emulation`, per service
 * or with a project default:
 *
 * ```json
 * { "version": 1,
 *   "amd64Emulation": { "default": "prefer-native", "services": { "worker": "amd64" } } }
 * ```
 *
 * - `native` (the default): Linux arm64 only. A declared `platform: linux/amd64` keeps
 *   the project on the Compose backend (`foreign_platform`).
 * - `prefer-native`: the arm64 variant when the image publishes one, so multi-arch
 *   images stay native; an amd64-only image runs under emulation.
 * - `amd64`: the amd64 variant under emulation, even when arm64 is published.
 *
 * An opted-in service gets the reviewed `x-hack-amd64-emulation` Compose field, whose
 * value is its policy (`prefer-native` or `amd64`), so the two modes are distinct
 * reviewed plans and retained images are bound to the mode they were selected under.
 * The runtime admits an amd64 image only for such a service and only in a pool booted
 * with x86_64 translation, so a missed selection fails closed instead of substituting.
 */
export type NativePlatformMode = "native" | "prefer-native" | "amd64";

/** A mode that may select an emulated platform; `native` services carry no policy. */
export type NativeEmulationPolicy = Exclude<NativePlatformMode, "native">;

/** The reviewed Compose service field the runtime reads as the opt-in. */
export const AMD64_EMULATION_FIELD = "x-hack-amd64-emulation";

/** The host Rosetta 2 Linux runtime SmolVM shares into the guest. */
export const HOST_ROSETTA_RUNTIME =
  "/Library/Apple/usr/libexec/oah/RosettaLinux/rosetta";

const MODES = new Set<string>(["native", "prefer-native", "amd64"]);
const SELECTION_KEYS = new Set(["default", "services"]);
const ARM64 = new Set(["linux/arm64", "linux/arm64/v8"]);

function refused(): Error {
  return new HackCliError({
    code: "E_CONFIG_INVALID",
    message:
      "Native project adaptation is invalid or conflicts with declared configuration; values omitted.",
  });
}

function mode(value: unknown): NativePlatformMode {
  if (typeof value !== "string" || !MODES.has(value)) {
    throw refused();
  }
  return value as NativePlatformMode;
}

/**
 * Per-service modes from one `amd64Emulation` selection value. Every named service
 * must exist; unknown keys and modes refuse with `E_CONFIG_INVALID`. Services without
 * an entry take the explicit project `default`, or `native`.
 */
export function selectNativePlatformModes(opts: {
  readonly selection: unknown;
  readonly services: readonly string[];
}): ReadonlyMap<string, NativePlatformMode> {
  const modes = new Map<string, NativePlatformMode>();
  if (opts.selection === undefined) {
    for (const name of opts.services) {
      modes.set(name, "native");
    }
    return modes;
  }
  const selection = opts.selection;
  if (
    !(
      isRecord(selection) &&
      Object.keys(selection).every((key) => SELECTION_KEYS.has(key))
    )
  ) {
    throw refused();
  }
  const fallback =
    selection.default === undefined ? "native" : mode(selection.default);
  const named = selection.services ?? {};
  if (!isRecord(named) || Object.keys(named).length > 64) {
    throw refused();
  }
  for (const name of Object.keys(named)) {
    if (!opts.services.includes(name)) {
      throw refused();
    }
  }
  for (const name of opts.services) {
    modes.set(name, Object.hasOwn(named, name) ? mode(named[name]) : fallback);
  }
  return modes;
}

/**
 * Applies the selection to normalized Compose services in place and returns the policy
 * of each opted-in service. A service that declares a Linux arm64 platform cannot opt in.
 */
export function applyNativeAmd64Emulation(opts: {
  readonly services: Record<string, unknown>;
  readonly selection: unknown;
}): Readonly<Record<string, NativeEmulationPolicy>> {
  const modes = selectNativePlatformModes({
    selection: opts.selection,
    services: Object.keys(opts.services),
  });
  const policies: Record<string, NativeEmulationPolicy> = {};
  for (const [name, selected] of modes) {
    if (selected === "native") {
      continue;
    }
    const spec = opts.services[name];
    if (!isRecord(spec)) {
      throw refused();
    }
    if (typeof spec.platform === "string" && ARM64.has(spec.platform)) {
      throw refused();
    }
    spec[AMD64_EMULATION_FIELD] = selected;
    policies[name] = selected;
  }
  return policies;
}

/** One service's policy from the adaptation's opted-in policies; `undefined` is native. */
export function nativeEmulationPolicy(
  policies: Readonly<Record<string, NativeEmulationPolicy>> | undefined,
  service: string
): NativeEmulationPolicy | undefined {
  return policies && Object.hasOwn(policies, service)
    ? policies[service]
    : undefined;
}

/**
 * The reviewed policy a graph receipt recorded for one container resource
 * (`amd64_emulation`, absent for a native service), or `null` when the value is not a
 * reviewed policy.
 */
export function receiptEmulationPolicy(
  value: unknown
): NativeEmulationPolicy | undefined | null {
  if (value === undefined) {
    return;
  }
  return value === "prefer-native" || value === "amd64" ? value : null;
}

/** `runtime ensure-image` arguments for one service's policy. */
export function nativeEnsureImageArgs(
  image: string,
  policy: NativeEmulationPolicy | undefined
): string[] {
  return [
    "runtime",
    "ensure-image",
    "--reference",
    image,
    ...(policy ? ["--emulation", policy] : []),
    "--json",
  ];
}

/**
 * `runtime up` arguments: any opted-in service, active or not, needs a translation pool,
 * because every declared service image is pinned before review.
 */
export function nativeAmd64EmulationUpArgs(
  policies: Readonly<Record<string, NativeEmulationPolicy>> | undefined
): string[] {
  return policies && Object.keys(policies).length > 0
    ? ["--amd64-emulation"]
    : [];
}

/**
 * Whether an `ensure-image` reply's `platform` fits the request. A reply without a
 * platform is Linux arm64. `amd64` must return `linux/amd64`, `prefer-native` either
 * platform, and a service without a policy only Linux arm64; anything else is
 * unconfirmed.
 */
export function ensuredPlatformAccepted(
  value: unknown,
  policy: NativeEmulationPolicy | undefined
): boolean {
  const platform = value ?? "linux/arm64";
  switch (policy) {
    case undefined:
      return platform === "linux/arm64";
    case "amd64":
      return platform === "linux/amd64";
    default:
      return platform === "linux/arm64" || platform === "linux/amd64";
  }
}

/**
 * Whether this host can run emulated services: Apple silicon macOS with the system
 * Rosetta 2 Linux runtime installed. Read-only; the runtime repeats a stricter check.
 */
export async function hostRosettaAvailable(opts?: {
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly path?: string;
}): Promise<boolean> {
  const platform = opts?.platform ?? process.platform;
  const arch = opts?.arch ?? process.arch;
  if (platform !== "darwin" || arch !== "arm64") {
    return false;
  }
  const path = opts?.path ?? HOST_ROSETTA_RUNTIME;
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile()) {
      return false;
    }
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
