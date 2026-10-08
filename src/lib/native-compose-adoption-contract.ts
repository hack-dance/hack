import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "./guards.ts";
import { hasCode } from "./native-compose-private-state.ts";

const MANAGED = /^hack\.env(?:\.|$)/;
function check(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new Error("Legacy adoption cancelled; values omitted.");
  }
}
/** First execution slice has no alternate local/env authority and no profile-dependent retained selection. */
export function legacyComposeAdoptionCandidateSupported(
  candidate: unknown
): boolean {
  return (
    isRecord(candidate) &&
    isRecord(candidate.services) &&
    Object.values(candidate.services).every(
      (service) => isRecord(service) && !Object.hasOwn(service, "profiles")
    )
  );
}
/** Inspect names/types only, with a bounded directory walk; never read managed values or keys. */
export async function legacyComposeAdoptionLayoutSupported(opts: {
  readonly projectRoot: string;
  readonly signal?: AbortSignal;
}): Promise<boolean> {
  check(opts.signal);
  for (const relative of [
    ".env",
    ".hack/.env",
    ".hack/hack.local.json",
    ".hack/hack.config.toml",
    ".dev/hack.config.json",
    ".dev/hack.config.toml",
    ".dev/docker-compose.yml",
  ]) {
    try {
      await lstat(join(opts.projectRoot, relative));
      return false;
    } catch (error: unknown) {
      if (!hasCode(error, "ENOENT")) {
        throw new Error(
          "Legacy adoption input inspection refused; values omitted."
        );
      }
    }
    check(opts.signal);
  }
  const directory = await opendir(join(opts.projectRoot, ".hack"));
  let count = 0;
  for await (const entry of directory) {
    check(opts.signal);
    count++;
    if (count > 4096 || MANAGED.test(entry.name)) {
      return false;
    }
  }
  check(opts.signal);
  return true;
}
