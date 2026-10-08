import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "./guards.ts";
import { hasCode } from "./native-compose-private-state.ts";
import {
  resolveVerifiedPrimaryWorktreeRoot,
  shouldInheritPrimaryLocalInputs,
} from "./worktree-local-config.ts";

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
async function rootLayoutSupported(
  projectRoot: string,
  signal?: AbortSignal
): Promise<boolean> {
  check(signal);
  for (const relative of [
    ".env",
    ".hack/.env",
    ".hack/hack.local.json",
    ".hack/.internal/extra-hosts.json",
    ".hack/hack.config.toml",
    ".dev/hack.config.json",
    ".dev/hack.config.toml",
    ".dev/docker-compose.yml",
  ]) {
    try {
      await lstat(join(projectRoot, relative));
      return false;
    } catch (error: unknown) {
      if (!hasCode(error, "ENOENT")) {
        throw new Error(
          "Legacy adoption input inspection refused; values omitted."
        );
      }
    }
    check(signal);
  }
  const directory = await opendir(join(projectRoot, ".hack")).catch(
    (error: unknown) => {
      if (hasCode(error, "ENOENT")) {
        return null;
      }
      throw new Error(
        "Legacy adoption input inspection refused; values omitted."
      );
    }
  );
  if (!directory) {
    return true;
  }
  let count = 0;
  for await (const entry of directory) {
    check(signal);
    count++;
    if (count > 4096 || MANAGED.test(entry.name)) {
      return false;
    }
  }
  check(signal);
  return true;
}

/** Names-only refusal includes the verified inherited primary scope, without reading values or keys. Validated candidate policy supplies the existing opt-out. */
export async function legacyComposeAdoptionLayoutSupported(opts: {
  readonly projectRoot: string;
  readonly candidate: unknown;
  readonly signal?: AbortSignal;
}): Promise<boolean> {
  if (!(await rootLayoutSupported(opts.projectRoot, opts.signal))) {
    return false;
  }
  const inheritLocal = !(
    isRecord(opts.candidate) &&
    isRecord(opts.candidate.worktree) &&
    opts.candidate.worktree.inherit_local === false
  );
  if (!shouldInheritPrimaryLocalInputs({ inheritLocal })) {
    return true;
  }
  const marker = await lstat(join(opts.projectRoot, ".git")).catch(
    (error: unknown) => {
      if (hasCode(error, "ENOENT")) {
        return null;
      }
      throw new Error(
        "Legacy adoption input inspection refused; values omitted."
      );
    }
  );
  if (!marker?.isFile()) {
    return true;
  }
  const primary = await resolveVerifiedPrimaryWorktreeRoot(opts);
  check(opts.signal);
  return primary === null || (await rootLayoutSupported(primary, opts.signal));
}
