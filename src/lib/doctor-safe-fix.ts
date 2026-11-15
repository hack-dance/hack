import { HackCliError } from "./cli-result.ts";
import { preflightDoctorProject } from "./doctor-adopted-project.ts";
import { inspectHackDirGitignoreForDoctor } from "./doctor-generated-files.ts";
import { findProjectContext } from "./project.ts";
import { ensureHackDirGitignore } from "./project-env-config.ts";

export const DOCTOR_SAFE_FIX_ID = "hack gitignore";

/** Select an ordinary legacy project again at publication; adoption never authorizes this write. */
async function selectedProject(startDir: string) {
  if (await preflightDoctorProject({ startDir })) {
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message: "Selected repair does not change adopted project inputs.",
    });
  }
  const project = await findProjectContext(startDir);
  if (!project) {
    throw new HackCliError({
      code: "E_PROJECT_NOT_FOUND",
      message: "Selected repair requires a project in a Git checkout.",
    });
  }
  return project;
}

/** Exactly one additive repair, followed by readback. Never calls the broad guided remediation. */
export async function runDoctorSafeFix(opts: { readonly startDir: string }) {
  const project = await selectedProject(opts.startDir);
  const inspect = () =>
    inspectHackDirGitignoreForDoctor({ projectDir: project.projectDir });
  const before = await inspect();
  if (before === null) {
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message: "Selected repair requires a Git checkout.",
    });
  }
  let changed = false;
  if (before === "missing" || before === "outdated") {
    const result = await ensureHackDirGitignore({
      projectDir: project.projectDir,
      beforePublish: async () => {
        const current = await selectedProject(opts.startDir);
        if (
          current.projectRoot !== project.projectRoot ||
          current.projectDir !== project.projectDir
        ) {
          throw new HackCliError({
            code: "E_CONFIG_INVALID",
            message: "Selected repair project changed; nothing published.",
          });
        }
      },
    });
    changed = result.changed;
  }
  const after = await inspect();
  const confirmed = after === "current";
  return {
    changed,
    confirmed,
    check: {
      name: DOCTOR_SAFE_FIX_ID,
      status: confirmed ? ("ok" as const) : ("error" as const),
      message: confirmed
        ? "Managed ignore block verified; existing user lines preserved."
        : "Selected repair could not verify the managed ignore block; unsafe, unreadable and read-only files are left unchanged.",
    },
  };
}
