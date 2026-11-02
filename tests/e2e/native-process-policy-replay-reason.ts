import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { fileURLToPath } from "node:url";

const SOURCE_SHA256 =
  "8913d0e1f1390b443e04bfb8264f16565f3c2a482c64c6235bb74b645c81c56a";
const SOURCE_PATH = fileURLToPath(
  new URL("../../src/lib/native-compose-ownership.ts", import.meta.url)
);
const SOURCE_BUDGET = 128 * 1024;
const HEADER =
  "NativeComposeOwnershipError: Native Compose resource ownership is missing, conflicting or changed; values omitted.";
const CALLSITES = [
  ["collectInspections", 602, "resource-owner-labels"],
  ["collectInspections", 660, "network-policy"],
  ["endpointAliases", 745, "endpoint-alias-shape"],
  ["validateEndpointIdentity", 785, "endpoint-network-id"],
  ["validateEndpointIdentity", 787, "endpoint-aliases"],
  ["requireLiveMember", 862, "live-network-membership"],
] as const;
export type ProcessPolicyReplayReason =
  | (typeof CALLSITES)[number][2]
  | "unavailable";
type SourcePin = {
  readonly path: string;
  readonly sha256: string;
  readonly identity: string;
};

/** Diagnostic evidence only: no probe, admission or cleanup authority. */
export function captureProcessPolicyOwnershipSource(): SourcePin | null {
  let fd: number | undefined;
  try {
    if (realpathSync(SOURCE_PATH) !== SOURCE_PATH) {
      return null;
    }
    fd = openSync(
      SOURCE_PATH,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    const before = fstatSync(fd);
    if (!(before.isFile() && before.size > 0 && before.size <= SOURCE_BUDGET)) {
      return null;
    }
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length);
      if (count === 0) {
        break;
      }
      length += count;
    }
    const after = fstatSync(fd);
    const identity = (value: typeof before): string =>
      JSON.stringify([
        value.dev,
        value.ino,
        value.size,
        value.mtimeMs,
        value.ctimeMs,
      ]);
    if (
      length !== before.size ||
      identity(before) !== identity(after) ||
      realpathSync(SOURCE_PATH) !== SOURCE_PATH
    ) {
      return null;
    }
    // The descriptor must still name the current source, not a replaced path.
    const current = lstatSync(SOURCE_PATH);
    if (!current.isFile() || identity(current) !== identity(after)) {
      return null;
    }
    const sha256 = createHash("sha256")
      .update(bytes.subarray(0, length))
      .digest("hex");
    return sha256 === SOURCE_SHA256
      ? { path: SOURCE_PATH, sha256, identity: identity(after) }
      : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Diagnostic unavailability must not replace the replay's ownership result.
      }
    }
  }
}

export function sameProcessPolicyOwnershipSource(
  before: SourcePin | null,
  after: SourcePin | null
): boolean {
  return (
    before !== null &&
    after !== null &&
    before.path === after.path &&
    before.sha256 === after.sha256 &&
    before.identity === after.identity
  );
}

export function isProcessPolicyReplayReason(
  value: unknown
): value is ProcessPolicyReplayReason {
  return (
    value === "unavailable" || CALLSITES.some((entry) => entry[2] === value)
  );
}

/** The first owning caller must match; never search later frames for a plausible reason. */
export function processPolicyReplayReason(opts: {
  readonly stack: unknown;
  readonly sourcePath: string;
  readonly sourceSha256: unknown;
}): ProcessPolicyReplayReason {
  if (
    opts.sourceSha256 !== SOURCE_SHA256 ||
    opts.sourcePath !== SOURCE_PATH ||
    typeof opts.stack !== "string" ||
    opts.stack.length > 16 * 1024
  ) {
    return "unavailable";
  }
  const frames = opts.stack.split("\n");
  const matches = (
    frame: string | undefined,
    name: string,
    line: number
  ): boolean => {
    const prefix = `    at ${name} (${SOURCE_PATH}:${line}:`;
    if (!(frame?.startsWith(prefix) && frame.endsWith(")"))) {
      return false;
    }
    return /^[1-9][0-9]{0,5}$/.test(frame.slice(prefix.length, -1));
  };
  if (
    frames[0] !== HEADER ||
    !matches(frames[1], "refuse", 200) ||
    !matches(frames[2], "requireValue", 204)
  ) {
    return "unavailable";
  }
  return (
    CALLSITES.find(([name, line]) => matches(frames[3], name, line))?.[2] ??
    "unavailable"
  );
}
