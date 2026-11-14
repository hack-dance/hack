import { isRecord } from "../lib/guards.ts";
import { nativeServiceActive } from "./native-project-builds.ts";

/**
 * Whether native startup captures the project's selected source (HACK-1965).
 *
 * The runtime reads source content only for a graph that bind-mounts project source
 * (`--shared-source`) or declares a dependency cache (a published `--source-revision`).
 * An image-only graph passes neither and starts without reading any content
 * (`requested_mode` and `prepare` in `packages/runtime-core/src/provider/graph/source.rs`),
 * so the native source limit does not apply to it. The startup flags and the source
 * limit check both decide through the predicates below, so they cannot disagree.
 *
 * The facts come from the reviewed plan ({@link nativePlanServiceSourceUse}) once it
 * exists, and from the selected Compose service ({@link nativeComposeServiceSourceUse})
 * before review, where the limit check runs. The Compose reading is conservative: a
 * declaration it cannot classify counts as capturing, so the limit still applies.
 */
export interface NativeServiceSourceUse {
  /** The service runs for the selected profiles. */
  readonly active: boolean;
  /** At least one mount binds project source into the service. */
  readonly bindsSource: boolean;
  /** The service declares a dependency cache initialized from the source. */
  readonly cachesDependencies: boolean;
}

/** An active service with a bind mount: the graph starts in shared-source mode. */
export function nativeServiceSharesSource(
  use: NativeServiceSourceUse
): boolean {
  return use.active && use.bindsSource;
}

/** An active dependency-cache service: startup publishes a source revision for it. */
export function nativeServiceInitializesCache(
  use: NativeServiceSourceUse
): boolean {
  return use.active && use.cachesDependencies;
}

/** Whether a graph of these services captures source content at startup. */
export function nativeSourceCaptured(
  uses: Iterable<NativeServiceSourceUse>
): boolean {
  for (const use of uses) {
    if (nativeServiceSharesSource(use) || nativeServiceInitializesCache(use)) {
      return true;
    }
  }
  return false;
}

/** Source facts of one reviewed plan service. */
export function nativePlanServiceSourceUse(
  service: Readonly<Record<string, unknown>>
): NativeServiceSourceUse {
  return {
    active: service.active === true,
    bindsSource:
      Array.isArray(service.mounts) &&
      service.mounts.some((mount) => isRecord(mount) && mount.kind === "bind"),
    cachesDependencies: isRecord(service.dependency_cache),
  };
}

const NAMED_VOLUME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const CACHE_LABEL_PREFIX = "hack.dependencies.";
const CACHE_BOOTSTRAP_LABEL = "hack.dependencies.bootstrap";

/** A Compose mount the runtime plans as a project bind; unclear forms count as binds. */
function composeMountBindsSource(mount: unknown): boolean {
  if (typeof mount === "string") {
    // Short syntax: a named volume is a bare identifier; a path (`.`/`/`) is a
    // bind, unless it is an absolute path with no second path after it. That
    // is an anonymous volume (`/data`, `/data:ro`), which shares no source.
    const [source = "", second, ...rest] = mount.split(":");
    if (
      source.startsWith("/") &&
      rest.length === 0 &&
      !second?.startsWith("/")
    ) {
      return false;
    }
    return !(mount.includes(":") && NAMED_VOLUME.test(source));
  }
  if (isRecord(mount)) {
    // Long syntax: the runtime's default type is `volume`.
    return !(mount.type === undefined || mount.type === "volume");
  }
  return true;
}

function composeLabelKeys(labels: unknown): readonly string[] | undefined {
  if (labels === undefined || labels === null) {
    return [];
  }
  if (isRecord(labels)) {
    return Object.keys(labels);
  }
  if (Array.isArray(labels)) {
    return labels.map((label) =>
      typeof label === "string" ? (label.split("=", 1)[0] ?? "") : ""
    );
  }
  return undefined;
}

/**
 * Source facts of one selected Compose service before review. A dependency cache
 * is any `hack.dependencies.*` label other than a lone bootstrap flag, as the
 * runtime's cache declaration reads it.
 */
export function nativeComposeServiceSourceUse(
  service: Readonly<Record<string, unknown>>,
  profiles: readonly string[]
): NativeServiceSourceUse {
  const volumes = service.volumes;
  const keys = composeLabelKeys(service.labels);
  const cacheKeys = keys?.filter((key) => key.startsWith(CACHE_LABEL_PREFIX));
  return {
    active: nativeServiceActive(service, profiles),
    bindsSource:
      volumes === undefined || volumes === null
        ? false
        : !Array.isArray(volumes) || volumes.some(composeMountBindsSource),
    cachesDependencies:
      cacheKeys === undefined ||
      cacheKeys.some((key) => key !== CACHE_BOOTSTRAP_LABEL),
  };
}

/** Whether the selected Compose services will capture source at startup. */
export function nativeComposeSourceCaptured(opts: {
  readonly services: Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
  readonly profiles: readonly string[] | undefined;
}): boolean {
  return nativeSourceCaptured(
    Object.values(opts.services).map((service) =>
      nativeComposeServiceSourceUse(service, opts.profiles ?? [])
    )
  );
}
