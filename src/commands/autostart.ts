import { relative, resolve } from "node:path";
import {
  type CliContext,
  CliUsageError,
  type CommandHandlerFor,
  defineCommand,
  withHandler,
} from "../cli/command.ts";
import { optBranch, optJson } from "../cli/options.ts";
import {
  parseProjectSelectorOption,
  unknownProjectMessage,
} from "../cli/project-selector.ts";
import { isLinkedGitWorktree } from "../lib/git-worktree.ts";
import { sanitizeBranchSlug } from "../lib/project.ts";
import { PROJECT_SELECTOR_PATTERN } from "../lib/project-name.ts";
import { serializeProjectAutostart } from "../lib/project-views.ts";
import {
  type RegisteredProject,
  readProjectsRegistry,
  removeProjectAutostart,
  selectRegisteredProjectByName,
  setProjectAutostart,
  setProjectAutostartPaused,
} from "../lib/projects-registry.ts";
import { display } from "../ui/display.ts";

const projectPositionals = [{ name: "project", required: false }] as const;
const addSpec = defineCommand({
  name: "add",
  summary: "Start this registered project at login on this machine",
  group: "Project",
  options: [optBranch],
  positionals: projectPositionals,
  subcommands: [],
} as const);
const removeSpec = defineCommand({
  name: "remove",
  summary: "Remove this project's machine autostart marker",
  group: "Project",
  options: [],
  positionals: projectPositionals,
  subcommands: [],
} as const);
const pauseSpec = defineCommand({
  name: "pause",
  summary: "Pause one marked project, or all marked projects",
  group: "Project",
  options: [],
  positionals: projectPositionals,
  subcommands: [],
} as const);
const resumeSpec = defineCommand({
  name: "resume",
  summary: "Resume one marked project, or all marked projects",
  group: "Project",
  options: [],
  positionals: projectPositionals,
  subcommands: [],
} as const);
const listSpec = defineCommand({
  name: "list",
  summary: "List this machine's always-on projects",
  group: "Project",
  options: [optJson],
  positionals: [],
  subcommands: [],
} as const);

/** Registry selection changes only the machine marker, without reading project configuration. */
async function selectProject(opts: {
  readonly ctx: CliContext;
  readonly name?: string;
}): Promise<RegisteredProject> {
  const selector =
    opts.name === undefined
      ? null
      : parseProjectSelectorOption({ projectOpt: opts.name });
  const registry = await readProjectsRegistry();
  if (selector) {
    const project = selectRegisteredProjectByName({
      projects: registry.projects,
      name: selector.name,
    });
    if (!project) {
      throw new CliUsageError(unknownProjectMessage(selector));
    }
    return project;
  }
  const cwd = resolve(opts.ctx.cwd);
  const matches = registry.projects
    .filter((project) => {
      const roots = [
        project.repoRoot,
        ...(project.worktrees ?? []).map((worktree) => worktree.path),
      ];
      return roots.some((root) => {
        const path = relative(root, cwd);
        return (
          path === "" ||
          !(
            path === ".." ||
            path.startsWith("../") ||
            resolve(root, path) !== cwd
          )
        );
      });
    })
    .sort((a, b) => b.repoRoot.length - a.repoRoot.length);
  const project = matches[0];
  if (!project || (matches[1] && matches[1].repoRoot === project.repoRoot)) {
    throw new CliUsageError(
      "Select a registered project by name; run 'hack projects' to list projects."
    );
  }
  return project;
}

const add: CommandHandlerFor<typeof addSpec> = async ({ ctx, args }) => {
  const project = await selectProject({ ctx, name: args.positionals.project });
  const [cwdLinked, registeredLinked] = await Promise.all([
    isLinkedGitWorktree({ repoRoot: ctx.cwd }),
    isLinkedGitWorktree({ repoRoot: project.repoRoot }),
  ]);
  if (cwdLinked === true || registeredLinked === true) {
    throw new CliUsageError(
      "Autostart currently requires the primary checkout; run 'hack autostart add --branch <name>' there."
    );
  }
  const branch =
    args.options.branch === undefined
      ? undefined
      : sanitizeBranchSlug(args.options.branch);
  if (
    args.options.branch !== undefined &&
    !(PROJECT_SELECTOR_PATTERN.test(args.options.branch.trim()) && branch)
  ) {
    throw new CliUsageError(
      "Invalid --branch value; use a branch alias containing letters or digits."
    );
  }
  await setProjectAutostart({ id: project.id, branch });
  process.stdout.write(
    "Autostart enabled on this machine. Install the login service with: hack daemon install\n"
  );
  return 0;
};
const remove: CommandHandlerFor<typeof removeSpec> = async ({ ctx, args }) => {
  const project = await selectProject({ ctx, name: args.positionals.project });
  await removeProjectAutostart({ id: project.id });
  process.stdout.write("Autostart removed on this machine.\n");
  return 0;
};
const pause: CommandHandlerFor<typeof pauseSpec> = async ({ ctx, args }) => {
  const project =
    args.positionals.project === undefined
      ? null
      : await selectProject({ ctx, name: args.positionals.project });
  await setProjectAutostartPaused({ id: project?.id, paused: true });
  process.stdout.write("Autostart paused; running projects are unchanged.\n");
  return 0;
};
const resume: CommandHandlerFor<typeof resumeSpec> = async ({ ctx, args }) => {
  const project =
    args.positionals.project === undefined
      ? null
      : await selectProject({ ctx, name: args.positionals.project });
  await setProjectAutostartPaused({ id: project?.id, paused: false });
  process.stdout.write(
    "Autostart resumed; use 'hack up -d' to start a project now.\n"
  );
  return 0;
};
const list: CommandHandlerFor<typeof listSpec> = async ({ args }) => {
  const registry = await readProjectsRegistry();
  const projects = registry.projects
    .filter((project) => project.autostart)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  if (args.options.json) {
    process.stdout.write(
      `${JSON.stringify({ projects: projects.map((project) => ({ project_id: project.id, name: project.name, autostart: serializeProjectAutostart(project.autostart) })) })}\n`
    );
    return 0;
  }
  await display.table({
    columns: ["Project", "Branch", "Autostart", "Last result", "Reason"],
    rows: projects.map((project) => [
      project.name,
      project.autostart?.branch ?? "base",
      project.autostart?.paused ? "paused" : "always-on",
      project.autostart?.lastResult?.status ?? "not attempted",
      project.autostart?.lastResult?.reason ?? "",
    ]),
  });
  return 0;
};

export const autostartCommand = defineCommand({
  name: "autostart",
  summary: "Manage always-on projects on this machine",
  group: "Project",
  options: [],
  positionals: [],
  subcommands: [
    withHandler(addSpec, add),
    withHandler(removeSpec, remove),
    withHandler(listSpec, list),
    withHandler(pauseSpec, pause),
    withHandler(resumeSpec, resume),
  ],
} as const);
