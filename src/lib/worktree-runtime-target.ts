import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import type { RuntimeProject } from "./runtime-projects.ts";

const RELEVANT_RUNTIME_STATES = new Set([
  "created",
  "paused",
  "restarting",
  "running",
]);

export type SameCheckoutRuntimeTarget = {
  readonly branch: string | null;
  readonly composeProject: string;
  readonly states: readonly string[];
};

export type SameCheckoutRetargetConflict = {
  readonly composeProject: string;
  readonly states: readonly string[];
};

export type ImplicitDownTargetResolution =
  | {
      readonly kind: "inferred";
      readonly branch: string;
      readonly composeProject: string;
    }
  | {
      readonly kind: "retargeted";
      readonly branch: string | null;
      readonly composeProject: string;
      readonly states: readonly string[];
    }
  | {
      readonly kind: "ambiguous";
      readonly targets: readonly SameCheckoutRuntimeTarget[];
    };

/** Find every Compose instance in one project family that belongs to this exact checkout. */
export function findSameCheckoutRuntimeTargets(opts: {
  readonly baseComposeProject: string;
  readonly currentProjectDir: string;
  readonly runtime: readonly RuntimeProject[];
}): readonly SameCheckoutRuntimeTarget[] {
  const currentProjectDir = canonicalPath(opts.currentProjectDir);
  const branchPrefix = `${opts.baseComposeProject}--`;
  const targets: SameCheckoutRuntimeTarget[] = [];

  for (const project of opts.runtime) {
    if (
      project.workingDir === null ||
      canonicalPath(project.workingDir) !== currentProjectDir
    ) {
      continue;
    }

    let branch: string | null | undefined;
    if (project.project === opts.baseComposeProject) {
      branch = null;
    } else if (project.project.startsWith(branchPrefix)) {
      branch = project.project.slice(branchPrefix.length);
    }
    if (branch === undefined || (branch !== null && branch.length === 0)) {
      continue;
    }

    targets.push({
      branch,
      composeProject: project.project,
      states: collectAllStates({ project }),
    });
  }

  return targets.sort((left, right) =>
    left.composeProject.localeCompare(right.composeProject)
  );
}

/**
 * Resolve an implicit linked-worktree down target without silently abandoning
 * an instance after the Git branch is renamed.
 */
export function resolveImplicitDownTarget(opts: {
  readonly baseComposeProject: string;
  readonly currentProjectDir: string;
  readonly inferredBranch: string;
  readonly runtime: readonly RuntimeProject[];
}): ImplicitDownTargetResolution {
  const targets = findSameCheckoutRuntimeTargets({
    baseComposeProject: opts.baseComposeProject,
    currentProjectDir: opts.currentProjectDir,
    runtime: opts.runtime,
  });

  if (targets.length === 0) {
    return {
      kind: "inferred",
      branch: opts.inferredBranch,
      composeProject: `${opts.baseComposeProject}--${opts.inferredBranch}`,
    };
  }

  const onlyTarget = targets[0];
  if (targets.length === 1 && onlyTarget) {
    const inferredComposeProject = `${opts.baseComposeProject}--${opts.inferredBranch}`;
    if (onlyTarget.composeProject === inferredComposeProject) {
      return {
        kind: "inferred",
        branch: opts.inferredBranch,
        composeProject: inferredComposeProject,
      };
    }
    return {
      kind: "retargeted",
      branch: onlyTarget.branch,
      composeProject: onlyTarget.composeProject,
      states: onlyTarget.states,
    };
  }

  return { kind: "ambiguous", targets };
}

/** Find non-terminal instances from the same checkout that differ from an auto-derived target. */
export function findSameCheckoutRetargetConflicts(opts: {
  readonly currentProjectDir: string;
  readonly targetComposeProject: string;
  readonly runtime: readonly RuntimeProject[];
}): readonly SameCheckoutRetargetConflict[] {
  const currentProjectDir = canonicalPath(opts.currentProjectDir);
  const conflicts: SameCheckoutRetargetConflict[] = [];

  for (const project of opts.runtime) {
    if (
      project.project === opts.targetComposeProject ||
      project.workingDir === null ||
      canonicalPath(project.workingDir) !== currentProjectDir
    ) {
      continue;
    }

    const states = collectRelevantStates({ project });
    if (states.length === 0) {
      continue;
    }
    conflicts.push({ composeProject: project.project, states });
  }

  return conflicts.sort((left, right) =>
    left.composeProject.localeCompare(right.composeProject)
  );
}

export function buildWorktreeRetargetWarning(opts: {
  readonly targetComposeProject: string;
  readonly conflicts: readonly SameCheckoutRetargetConflict[];
}): string | null {
  if (opts.conflicts.length === 0) {
    return null;
  }
  const existing = opts.conflicts
    .map(
      (conflict) =>
        `"${conflict.composeProject}" (${conflict.states.join(", ")})`
    )
    .join(", ");
  return `This worktree already owns ${existing}; auto-targeting new instance "${opts.targetComposeProject}". Pass --branch <name> to target an existing instance explicitly.`;
}

function collectRelevantStates(opts: {
  readonly project: RuntimeProject;
}): readonly string[] {
  return collectAllStates({ project: opts.project }).filter((state) =>
    RELEVANT_RUNTIME_STATES.has(state)
  );
}

function collectAllStates(opts: {
  readonly project: RuntimeProject;
}): readonly string[] {
  const states = new Set<string>();
  for (const service of opts.project.services.values()) {
    for (const container of service.containers) {
      const state = container.state.trim().toLowerCase();
      if (state.length > 0) {
        states.add(state);
      }
    }
  }
  return [...states].sort((left, right) => left.localeCompare(right));
}

function canonicalPath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}
