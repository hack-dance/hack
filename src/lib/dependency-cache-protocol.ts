import { isRecord } from "./guards.ts";

const PROTOCOL = "hack.dependencies.cache-protocol";
const VERIFY = "hack.dependencies.cache-verify";
const SAFE_PATH = /^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/;
const FINGERPRINT = /^[a-f0-9]{16,64}$/;

export type DependencyCacheProtocol = {
  readonly entrypoint: readonly string[];
  readonly script: string;
  readonly target: string;
  readonly verify: readonly string[];
};

function labels(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  const result: Record<string, unknown> = {};
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== "string") {
        throw invalid();
      }
      const index = item.indexOf("=");
      const key = item.slice(0, index);
      if (index < 1 || Object.hasOwn(result, key)) {
        throw invalid();
      }
      result[key] = item.slice(index + 1);
    }
  }
  return result;
}

function argv(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 128 &&
    value.every(
      (entry) =>
        typeof entry === "string" &&
        entry.length <= 8192 &&
        !entry.includes("\0")
    ) &&
    value[0].length > 0
  );
}

function safePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 1024 &&
    SAFE_PATH.test(value) &&
    !value.split("/").some((part) => part === "." || part === "..")
  );
}

function selectedMountTarget(mount: unknown, volume: string): string | null {
  if (typeof mount === "string") {
    const [source, target, mode, ...extra] = mount.split(":");
    if (source !== volume) {
      return null;
    }
    if (
      extra.length ||
      (mode !== undefined && mode !== "rw") ||
      !safePath(target)
    ) {
      throw invalid();
    }
    return target;
  }
  if (!isRecord(mount) || mount.source !== volume) {
    return null;
  }
  if (
    mount.type !== "volume" ||
    (mount.read_only !== undefined && mount.read_only !== false) ||
    !safePath(mount.target) ||
    (isRecord(mount.volume) && mount.volume.subpath !== undefined)
  ) {
    throw invalid();
  }
  return mount.target;
}

function cacheTarget(mounts: unknown, volume: string): string {
  if (!Array.isArray(mounts)) {
    throw invalid();
  }
  const targets = mounts
    .map((mount) => selectedMountTarget(mount, volume))
    .filter((target) => target !== null);
  if (targets.length !== 1 || targets[0] === undefined) {
    throw invalid();
  }
  return targets[0];
}

function overlaps(left: string, right: string): boolean {
  return (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}

function mountTarget(mount: unknown): unknown {
  if (typeof mount === "string") {
    return mount.split(":")[1];
  }
  return isRecord(mount) ? mount.target : undefined;
}

function validateIsolation(
  service: Record<string, unknown>,
  target: string,
  scriptPath: string
): void {
  const environment = service.environment;
  if (
    service.env_file !== undefined ||
    (environment !== undefined &&
      (!(isRecord(environment) || Array.isArray(environment)) ||
        Object.keys(environment).length > 0))
  ) {
    throw invalid();
  }
  if (overlaps(target, "/etc/hack/ca") || overlaps(target, scriptPath)) {
    throw invalid();
  }
  if (!Array.isArray(service.volumes)) {
    throw invalid();
  }
  for (const mount of service.volumes) {
    const mountedTarget = mountTarget(mount);
    if (!safePath(mountedTarget)) {
      throw invalid();
    }
    if (
      overlaps(mountedTarget, scriptPath) ||
      (mountedTarget !== target && mountedTarget.startsWith(`${target}/`))
    ) {
      throw invalid();
    }
  }
  const sameTarget = service.volumes.filter(
    (mount) => mountTarget(mount) === target
  );
  if (sameTarget.length !== 1) {
    throw invalid();
  }
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function invalid(): Error {
  return new Error(
    "Invalid locked-v1 dependency cache declaration: require empty entrypoint, exec argv, verification argv and one writable cache volume mount"
  );
}

/** Opt-in shell protocol; callers must separately gate consumers and mount this script read-only. */
export function createDependencyCacheProtocol(opts: {
  readonly service: unknown;
  readonly volume: string;
  readonly fingerprint: string;
  readonly scriptPath: string;
}): DependencyCacheProtocol | null {
  if (!isRecord(opts.service)) {
    return null;
  }
  const declared = labels(opts.service.labels);
  if (declared[PROTOCOL] === undefined) {
    return null;
  }
  if (
    declared[PROTOCOL] !== "locked-v1" ||
    !Array.isArray(opts.service.entrypoint) ||
    opts.service.entrypoint.length !== 0 ||
    !argv(opts.service.command) ||
    !FINGERPRINT.test(opts.fingerprint) ||
    !safePath(opts.scriptPath)
  ) {
    throw invalid();
  }
  let verify: unknown;
  try {
    verify = JSON.parse(
      typeof declared[VERIFY] === "string" ? declared[VERIFY] : ""
    );
  } catch {
    throw invalid();
  }
  if (!argv(verify)) {
    throw invalid();
  }
  const target = cacheTarget(opts.service.volumes, opts.volume);
  validateIsolation(opts.service, target, opts.scriptPath);
  const commandChecks = opts.service.command
    .map(
      (argument, index) =>
        `[ "\${${index + 1}}" = ${quote(argument)} ] || reject_command`
    )
    .join("\n  ");
  const script = `#!/bin/sh
set -eu
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
reject_command() { printf '%s\\n' 'Dependency cache command override refused; use the declared initializer command.' >&2; exit 64; }
validate_command() {
  [ "$#" -eq ${opts.service.command.length} ] || reject_command
  ${commandChecks}
}
validate_command "$@"
umask 077
phase() { printf '%s\\n' "HACK_DEPENDENCY_PHASE_V1 $1"; }
fail() { phase failed; printf '%s\\n' 'Dependency cache incomplete or invalid; bump hack.dependencies.cache-generation to use a new volume.' >&2; exit 74; }
command -v flock >/dev/null 2>&1 || fail
command -v cmp >/dev/null 2>&1 || fail
command -v env >/dev/null 2>&1 || fail
cache=${quote(target)}
meta="$cache/.hack-dependency-cache-v1"
[ -d "$cache" ] && [ ! -L "$cache" ] || fail
if ! mkdir "$meta" 2>/dev/null; then
  [ -d "$meta" ] && [ ! -L "$meta" ] || fail
fi
[ ! -L "$meta/lock" ] || fail
if [ ! -e "$meta/lock" ]; then
  (set -C; : > "$meta/lock") 2>/dev/null || [ -f "$meta/lock" ] || fail
fi
[ -f "$meta/lock" ] && [ ! -L "$meta/lock" ] || fail
exec 9>>"$meta/lock"
phase waiting
waited=0
until flock -n 9; do
  [ "$waited" -lt 60 ] || fail
  sleep 1 || fail
  waited=$((waited + 1))
done
for marker in attempt ready ready.pending; do
  [ ! -L "$meta/$marker" ] || fail
  if [ -e "$meta/$marker" ]; then [ -f "$meta/$marker" ] || fail; fi
done
expected() { printf '%s\\n' 'locked-v1' ${quote(opts.fingerprint)}; }
if [ -e "$meta/ready" ] || [ -L "$meta/ready" ]; then
  [ -f "$meta/ready" ] && [ ! -L "$meta/ready" ] || fail
  expected | cmp -s - "$meta/ready" || fail
  phase ready
  printf '%s\\n' 'Dependency cache ready (locked-v1).'
  exit 0
fi
[ ! -e "$meta/attempt" ] && [ ! -L "$meta/attempt" ] || fail
[ ! -e "$meta/ready.pending" ] && [ ! -L "$meta/ready.pending" ] || fail
(set -C; : > "$meta/attempt") || fail
phase installing
env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/tmp "$@" || fail
phase verifying
env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/tmp ${verify.map(quote).join(" ")} || fail
(set -C; expected > "$meta/ready.pending") || fail
mv "$meta/ready.pending" "$meta/ready" || fail
phase ready
printf '%s\\n' 'Dependency cache initialized (locked-v1).'
`;
  return { entrypoint: ["/bin/sh", opts.scriptPath], script, target, verify };
}
