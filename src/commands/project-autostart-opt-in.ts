import { CliUsageError } from "../cli/command.ts";
import { isLinkedGitWorktree } from "../lib/git-worktree.ts";
import { findProjectContext, type ProjectContext } from "../lib/project.ts";
import { normalizeProjectName } from "../lib/project-name.ts";
import {
  type ProjectsRegistry,
  setProjectAutostart,
  upsertProjectRegistration,
} from "../lib/projects-registry.ts";

/** Validate legacy paths before an ordinary registration write can make them private. */
export async function enableAutostartForUp(opts: {
  readonly project: ProjectContext;
  readonly startDir: string;
  readonly selectorName?: string;
  readonly branch: string | null;
  readonly registry: ProjectsRegistry;
}): Promise<void> {
  const { project, branch, registry } = opts;
  if (await isLinkedGitWorktree({ repoRoot: project.projectRoot })) {
    throw new CliUsageError(
      "Autostart currently requires the primary checkout. Run hack up --always there with --branch <name>."
    );
  }
  const observed = await findProjectContext(opts.startDir).catch(() => null);
  const observedProject = observed
    ? { repoRoot: observed.projectRoot, projectDir: observed.projectDir }
    : undefined;
  const existing = registry.projects.find((entry) =>
    opts.selectorName
      ? normalizeProjectName(entry.name) === opts.selectorName
      : entry.repoRoot === project.projectRoot &&
        entry.projectDir === project.projectDir
  );
  const onPermissionsRepaired = () =>
    process.stderr.write(
      "Repaired this machine's unmarked projects registry permissions to 0600 before enabling autostart.\n"
    );
  // Validate legacy identity before an upsert could republish its unsafe paths.
  if (existing) {
    await setProjectAutostart({
      id: existing.id,
      branch,
      observedProject,
      onPermissionsRepaired,
    });
  }
  const registered = await upsertProjectRegistration({ project });
  if (registered.status === "conflict") {
    throw new CliUsageError(
      "Project registration conflicts; inspect hack projects before enabling autostart."
    );
  }
  if (!existing) {
    await setProjectAutostart({
      id: registered.project.id,
      branch,
      observedProject,
      onPermissionsRepaired,
    });
  }
}
