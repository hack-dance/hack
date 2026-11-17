import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { assertAutostartCheckoutTrusted } from "./autostart-checkout-trust.ts";
import { assertAutostartDockerConfigTrusted } from "./autostart-docker-trust.ts";
import { assertAutostartFileAclsTrusted } from "./autostart-path-acl.ts";
import { assertAutostartStartPolicy } from "./autostart-start-policy.ts";
import { HackCliError } from "./cli-result.ts";
import {
  readProjectsRegistry,
  resolveProjectsRegistryPath,
} from "./projects-registry.ts";
import { withProjectsRegistryLock } from "./projects-registry-lock.ts";

export interface AutostartProjectScope {
  readonly projectId: string;
  readonly composeProject: string;
  readonly branch: string | null;
}

/**
 * Start and stop share one machine-local project/instance lock. A stop publishes
 * its pause before waiting, then holds the lock through runtime shutdown. Thus
 * an earlier login child cannot outlive a successful stop and start afterwards.
 * The lock owner is the actual CLI child, not its daemon parent.
 */
export async function withAutostartProjectLock<T>(opts: {
  readonly scope: AutostartProjectScope;
  readonly registryPath?: string;
  readonly timeoutMs?: number;
  readonly run: () => Promise<T>;
}): Promise<T> {
  const registryPath = opts.registryPath ?? resolveProjectsRegistryPath();
  const directory = join(dirname(registryPath), "autostart-locks");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o022) !== 0 ||
    (process.getuid && info.uid !== process.getuid())
  ) {
    throw new HackCliError({
      code: "E_PERMISSION",
      message:
        "Project start/stop lock directory is unsafe; no runtime operation ran.",
    });
  }
  try {
    await assertAutostartFileAclsTrusted({
      path: directory,
      uid: process.getuid?.() ?? -1,
    });
  } catch {
    throw new HackCliError({
      code: "E_PERMISSION",
      message:
        "Project start/stop lock directory is unsafe; no runtime operation ran.",
    });
  }
  const key = createHash("sha256")
    .update(
      JSON.stringify({
        composeProject: opts.scope.composeProject,
        branch: opts.scope.branch,
      })
    )
    .digest("hex");
  return await withProjectsRegistryLock({
    lockPath: join(directory, `${key}.lock`),
    timeoutMs: opts.timeoutMs ?? 180_000,
    label: "Project start/stop",
    run: opts.run,
  });
}

/** Must run while the project lock is held, again immediately before containers start. */
export async function assertAutostartProjectCurrent(opts: {
  readonly scope: Pick<AutostartProjectScope, "projectId" | "branch">;
  readonly expectedRoot?: string;
  readonly registryPath?: string;
}): Promise<void> {
  const registry = await readProjectsRegistry({
    registryPath: opts.registryPath,
    requireAutostartTrust: true,
  });
  const projects = registry.projects.filter(
    (project) => project.id === opts.scope.projectId
  );
  const selected = projects.length === 1 ? projects[0] : undefined;
  const marker = selected?.autostart;
  let reason: string | null = null;
  if (registry.autostartGlobal?.paused) {
    reason = "global_paused";
  } else if (!marker || marker.paused || marker.invalid) {
    reason = "paused";
  } else if (
    marker.branch !== opts.scope.branch ||
    (opts.expectedRoot !== undefined &&
      projects[0]?.repoRoot !== opts.expectedRoot)
  ) {
    reason = "target_changed";
  }
  if (reason) {
    throw new HackCliError({
      code: "E_CANCELLED",
      message:
        "Autostart was cancelled by changed machine intent; no further startup effects ran.",
      detail: { reason },
    });
  }
  if (opts.expectedRoot !== undefined && selected) {
    if (process.env.HACK_AUTOSTART_LOGIN === "1") {
      assertAutostartDockerConfigTrusted({ home: homedir() });
    }
    assertAutostartCheckoutTrusted({
      repoRoot: selected.repoRoot,
      projectDir: selected.projectDir,
    });
    if (process.env.HACK_AUTOSTART_LOGIN === "1") {
      await assertAutostartStartPolicy(selected);
    }
  }
}
