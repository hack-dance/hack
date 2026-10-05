import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  AmbiguousProjectNameError,
  normalizeProjectName,
} from "./project-name.ts";
import {
  type RegisteredProject,
  selectRegisteredProjectByName,
} from "./projects-registry.ts";
import type { RuntimeProject } from "./runtime-projects.ts";

/** A name alias never proves that containers belong to a registered checkout. */
export async function assertPruneRuntimeOwnership(opts: {
  readonly projects: readonly RegisteredProject[];
  readonly runtime: readonly RuntimeProject[];
}): Promise<void> {
  for (const runtime of opts.runtime) {
    // Without an aggregate directory, orphan detection does not select this group.
    if (!runtime.workingDir) {
      continue;
    }
    const name =
      normalizeProjectName(runtime.project.split("--")[0] ?? "") ??
      runtime.project;
    const aggregate = await canonicalPath(runtime.workingDir);
    await assertSingleRuntimeDirectory({ runtime, name, aggregate });
    const registration = selectRegisteredProjectByName({
      projects: opts.projects,
      name,
    });
    if (!registration) {
      continue;
    }
    const roots = [
      registration.repoRoot,
      ...(registration.worktrees ?? []).map((entry) => entry.path),
    ];
    const allowed = new Set(
      await Promise.all(
        [
          registration.projectDir,
          ...roots.flatMap((root) => [
            root,
            resolve(root, registration.projectDirName),
          ]),
        ].map(canonicalPath)
      )
    );
    if (!allowed.has(aggregate)) {
      throw new AmbiguousProjectNameError(name);
    }
  }
}

async function assertSingleRuntimeDirectory(opts: {
  readonly runtime: RuntimeProject;
  readonly name: string;
  readonly aggregate: string;
}): Promise<void> {
  for (const service of opts.runtime.services.values()) {
    for (const container of service.containers) {
      // Match the IDs orphan cleanup would delete, excluding lifecycle placeholders.
      if (
        !container.id ||
        container.labels?.["hack.lifecycle.process"] === "true"
      ) {
        continue;
      }
      // A group's aggregate directory decides whether every ID is deleted. A
      // missing/foreign member cannot inherit that decision, even without a registry.
      if (
        !container.workingDir ||
        (await canonicalPath(container.workingDir)) !== opts.aggregate
      ) {
        throw new AmbiguousProjectNameError(opts.name);
      }
    }
  }
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    // Missing checkouts are the normal prune case; compare their recorded paths.
    return resolve(path);
  }
}
