import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { hasDevMutationAcl } from "./dev-acl.ts";
import { walkReplaceableChain } from "./path-trust.ts";
import { exec } from "./shell.ts";

interface AclInspection {
  readonly exitCode: number;
  readonly stdout: string;
}
export interface AutostartAclDependencies {
  readonly platform?: NodeJS.Platform;
  readonly inspect?: (
    paths: readonly string[],
    timeoutMs: number
  ) => Promise<AclInspection>;
  readonly inspectSync?: (
    paths: readonly string[],
    timeoutMs: number
  ) => AclInspection;
}

async function inspect(paths: readonly string[], timeoutMs: number) {
  return await exec(["/bin/ls", "-blde", "--", ...paths], {
    stdin: "ignore",
    env: { LC_ALL: "C", CLICOLOR: "", CLICOLOR_FORCE: "" },
    timeoutMs,
    maxStdoutBytes: 1024 * 1024,
    maxStderrBytes: 4096,
    forwardSignals: true,
  });
}

/** Inspect Darwin ACLs in bounded batches; unknown grants and probe failures refuse. */
export async function assertAutostartPathAclsTrusted(
  paths: ReadonlySet<string>,
  deps?: AutostartAclDependencies
): Promise<void> {
  for (const { entries, remaining } of inspectionBatches(
    paths,
    deps?.platform
  )) {
    const result = await (deps?.inspect ?? inspect)(
      entries,
      Math.min(3000, remaining)
    );
    if (result.exitCode !== 0 || hasDevMutationAcl(result.stdout)) {
      throw new Error("Executable ACL trust could not be established");
    }
  }
}

function* inspectionBatches(
  paths: ReadonlySet<string>,
  platform = process.platform
) {
  if (platform !== "darwin") {
    return;
  }
  if (paths.size === 0 || paths.size > 16_384) {
    throw new Error("ACL inspection exceeds bound");
  }
  const pathsArray = [...paths];
  const deadline = Date.now() + 15_000;
  for (let offset = 0; offset < pathsArray.length; offset += 128) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error("ACL inspection exceeded deadline");
    }
    yield { entries: pathsArray.slice(offset, offset + 128), remaining };
  }
}

function inspectSync(
  paths: readonly string[],
  timeoutMs: number
): AclInspection {
  const result = spawnSync("/bin/ls", ["-blde", "--", ...paths], {
    env: { LC_ALL: "C", CLICOLOR: "", CLICOLOR_FORCE: "" },
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    exitCode: result.error ? 1 : (result.status ?? 1),
    stdout: result.stdout?.toString("utf8") ?? "",
  };
}

/** Synchronous metadata readers use the same bounded ACL policy before consuming inputs. */
export function assertAutostartPathAclsTrustedSync(
  paths: ReadonlySet<string>,
  deps?: AutostartAclDependencies
): void {
  for (const { entries, remaining } of inspectionBatches(
    paths,
    deps?.platform
  )) {
    const result = (deps?.inspectSync ?? inspectSync)(
      entries,
      Math.min(3000, remaining)
    );
    if (result.exitCode !== 0 || hasDevMutationAcl(result.stdout)) {
      throw new Error("Path ACL trust could not be established");
    }
  }
}

/** For no-follow descriptor readers, inspect the parent chain and the opened entry. */
export async function assertAutostartFileAclsTrusted(
  opts: { readonly path: string; readonly uid: number },
  deps?: AutostartAclDependencies
): Promise<void> {
  if ((deps?.platform ?? process.platform) !== "darwin") {
    return;
  }
  const checked = new Set<string>();
  const parent = walkReplaceableChain({
    path: dirname(opts.path),
    uid: opts.uid,
    hackHome: null,
    checked,
  });
  if ("error" in parent) {
    throw new Error("Unsafe ACL parent");
  }
  checked.add(opts.path);
  await assertAutostartPathAclsTrusted(checked, deps);
}
