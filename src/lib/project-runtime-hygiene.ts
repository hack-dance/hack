import { resolve } from "node:path";
import { PROJECT_COMPOSE_FILENAME } from "../constants.ts";
import { pathExists } from "./fs.ts";
import type { RegisteredProject } from "./projects-registry.ts";
import type { RuntimeProject } from "./runtime-projects.ts";

export type MissingRegistryEntry = {
  readonly project: RegisteredProject;
  readonly reason: string;
};

export type OrphanedRuntimeProject = {
  readonly project: string;
  readonly workingDir: string | null;
  readonly reason: string;
  readonly containerIds: readonly string[];
};

export type IncompleteRuntimeProject = {
  readonly project: string;
  readonly workingDir: string | null;
  readonly createdServices: readonly string[];
  readonly containerIds: readonly string[];
};

export function scopeRuntimeHygieneToProject(input: {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly projects: readonly RegisteredProject[];
  readonly runtime: readonly RuntimeProject[];
}): {
  readonly projects: readonly RegisteredProject[];
  readonly runtime: readonly RuntimeProject[];
} {
  const projects = input.projects.filter((project) => {
    return (
      project.repoRoot === input.projectRoot ||
      project.projectDir === input.projectDir
    );
  });
  const projectNames = new Set(projects.map((project) => project.name));
  const runtime = input.runtime.filter((project) => {
    if (projectNames.has(project.project)) {
      return true;
    }
    for (const projectName of projectNames) {
      if (project.project.startsWith(`${projectName}--`)) {
        return true;
      }
    }
    return (
      project.workingDir === input.projectRoot ||
      project.workingDir === input.projectDir
    );
  });
  return { projects, runtime };
}

export async function findMissingRegistryEntries(input: {
  readonly projects: readonly RegisteredProject[];
}): Promise<MissingRegistryEntry[]> {
  const out: MissingRegistryEntry[] = [];
  for (const project of input.projects) {
    if (!(await pathExists(project.projectDir))) {
      out.push({ project, reason: "missing project dir" });
      continue;
    }
    const composeFile = resolve(project.projectDir, PROJECT_COMPOSE_FILENAME);
    if (!(await pathExists(composeFile))) {
      out.push({ project, reason: "missing compose file" });
    }
  }
  return out;
}

export async function findOrphanRuntimeProjects(input: {
  readonly runtime: readonly RuntimeProject[];
}): Promise<OrphanedRuntimeProject[]> {
  const out: OrphanedRuntimeProject[] = [];
  for (const project of input.runtime) {
    const workingDir = project.workingDir;
    if (!workingDir) {
      continue;
    }
    if (!(await pathExists(workingDir))) {
      out.push({
        project: project.project,
        workingDir,
        reason: "missing working dir",
        containerIds: collectContainerIds(project),
      });
      continue;
    }
    const composeFile = resolve(workingDir, PROJECT_COMPOSE_FILENAME);
    if (!(await pathExists(composeFile))) {
      out.push({
        project: project.project,
        workingDir,
        reason: "missing compose file",
        containerIds: collectContainerIds(project),
      });
    }
  }
  return out;
}

/** Find Compose projects with regular service containers left in the pre-start Created state. */
export function findIncompleteRuntimeProjects(input: {
  readonly runtime: readonly RuntimeProject[];
}): IncompleteRuntimeProject[] {
  const incomplete: IncompleteRuntimeProject[] = [];
  for (const project of input.runtime) {
    const createdServices = [...project.services.values()]
      .filter((service) =>
        service.containers.some(
          (container) =>
            container.state.trim().toLowerCase() === "created" &&
            container.labels?.["hack.lifecycle.process"] !== "true"
        )
      )
      .map((service) => service.service)
      .sort((left, right) => left.localeCompare(right));
    const containerIds = [...project.services.values()]
      .flatMap((service) =>
        service.containers
          .filter(
            (container) =>
              container.state.trim().toLowerCase() === "created" &&
              container.labels?.["hack.lifecycle.process"] !== "true"
          )
          .map((container) => container.id)
      )
      .filter((id) => id.length > 0)
      .sort((left, right) => left.localeCompare(right));
    if (createdServices.length === 0) {
      continue;
    }
    incomplete.push({
      project: project.project,
      workingDir: project.workingDir,
      createdServices,
      containerIds,
    });
  }
  return incomplete.sort((left, right) =>
    left.project.localeCompare(right.project)
  );
}

function collectContainerIds(project: RuntimeProject): readonly string[] {
  const out: string[] = [];
  for (const service of project.services.values()) {
    for (const container of service.containers) {
      if (container.id.length > 0) {
        out.push(container.id);
      }
    }
  }
  return out;
}
