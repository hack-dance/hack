import { resolve } from "node:path";
import {
  GLOBAL_HACK_DIR_NAME,
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
  PROJECT_ENV_FILENAME,
} from "../constants.ts";
import { pathExists } from "./fs.ts";
import { getString, isRecord } from "./guards.ts";
import { parseJsonLines } from "./json-lines.ts";
import { upsertProjectRegistration } from "./projects-registry.ts";
import { exec } from "./shell.ts";

export type RuntimeContainer = {
  readonly id: string;
  readonly project: string;
  readonly service: string;
  readonly state: string;
  readonly status: string;
  readonly name: string;
  readonly ports: string;
  readonly workingDir: string | null;
  readonly image: string | null;
  readonly labels: Readonly<Record<string, string>> | null;
  readonly mounts: readonly RuntimeContainerMount[];
  readonly networks: readonly RuntimeContainerNetwork[];
};

export type RuntimeContainerMount = {
  readonly type: string;
  readonly source: string;
  readonly destination: string;
  readonly mode: string;
  readonly rw: boolean | null;
};

export type RuntimeContainerNetwork = {
  readonly name: string;
  readonly ipAddress: string | null;
  readonly gateway: string | null;
  readonly aliases: readonly string[];
};

export type RuntimeService = {
  readonly service: string;
  readonly containers: readonly RuntimeContainer[];
};

export type RuntimeProject = {
  readonly project: string;
  readonly workingDir: string | null;
  readonly services: ReadonlyMap<string, RuntimeService>;
  readonly isGlobal: boolean;
};

export type RuntimeProjectsResult = {
  readonly ok: boolean;
  readonly runtime: readonly RuntimeProject[];
  readonly error: string | null;
  readonly checkedAtMs: number;
};

type ContainerInspectData = {
  readonly labels: Record<string, string>;
  readonly image: string | null;
  readonly mounts: readonly RuntimeContainerMount[];
  readonly networks: readonly RuntimeContainerNetwork[];
};

export function countRunningServices(runtime: RuntimeProject | null): number {
  if (!runtime) {
    return 0;
  }
  let count = 0;
  for (const svc of runtime.services.values()) {
    const running = svc.containers.some((c) => c.state === "running");
    if (running) {
      count += 1;
    }
  }
  return count;
}

export function filterRuntimeProjects(opts: {
  readonly runtime: readonly RuntimeProject[];
  readonly includeGlobal: boolean;
}): readonly RuntimeProject[] {
  if (opts.includeGlobal) {
    return opts.runtime;
  }
  return opts.runtime.filter((project) => !project.isGlobal);
}

export async function readRuntimeProjects(opts: {
  readonly includeGlobal: boolean;
}): Promise<RuntimeProjectsResult> {
  const checkedAtMs = Date.now();
  const res = await exec(
    [
      "docker",
      "ps",
      "-a",
      "--filter",
      "label=com.docker.compose.project",
      "--format",
      "json",
    ],
    { stdin: "ignore" }
  );
  if (res.exitCode !== 0) {
    return {
      ok: false,
      runtime: [],
      error: formatDockerError({
        exitCode: res.exitCode,
        stdout: res.stdout,
        stderr: res.stderr,
      }),
      checkedAtMs,
    };
  }

  const baseRows = parseJsonLines(res.stdout);
  const ids = baseRows
    .map((row) => getString(row, "ID") ?? getString(row, "Id") ?? "")
    .filter((id) => id.length > 0);
  const inspectById = await readContainerInspectData({ ids });

  const home = process.env.HOME ?? "";
  const globalRoot = home ? resolve(home, GLOBAL_HACK_DIR_NAME) : "";

  const containers: RuntimeContainer[] = [];
  for (const row of baseRows) {
    const id = getString(row, "ID") ?? getString(row, "Id") ?? "";
    const state = getString(row, "State") ?? "";
    const status = getString(row, "Status") ?? "";
    const name = getString(row, "Names") ?? "";
    const ports = getString(row, "Ports") ?? "";
    const inspect = id.length > 0 ? inspectById.get(id) : undefined;
    const labelsRaw = getString(row, "Labels");
    const labels =
      inspect?.labels ??
      (labelsRaw ? parseLabelString({ raw: labelsRaw }) : {});
    const project = labels["com.docker.compose.project"] ?? null;
    const service = labels["com.docker.compose.service"] ?? null;
    const oneoff =
      (labels["com.docker.compose.oneoff"] ?? "").toLowerCase() === "true";
    if (!(project && service) || oneoff) {
      continue;
    }

    const workingDir = labels["com.docker.compose.project.working_dir"] ?? null;
    const isGlobal =
      globalRoot.length > 0 && workingDir
        ? workingDir.startsWith(globalRoot)
        : false;
    if (isGlobal && !opts.includeGlobal) {
      continue;
    }

    containers.push({
      id,
      project,
      service,
      state,
      status,
      name,
      ports,
      workingDir,
      image: inspect?.image ?? null,
      labels: Object.keys(labels).length > 0 ? labels : null,
      mounts: inspect?.mounts ?? [],
      networks: inspect?.networks ?? [],
    });
  }

  const byProject = new Map<
    string,
    {
      workingDir: string | null;
      byService: Map<string, RuntimeContainer[]>;
      isGlobal: boolean;
    }
  >();
  for (const c of containers) {
    const workingDir = c.workingDir;
    const isGlobal =
      globalRoot.length > 0 && workingDir
        ? workingDir.startsWith(globalRoot)
        : false;
    const p = byProject.get(c.project) ?? {
      workingDir,
      byService: new Map(),
      isGlobal,
    };
    const arr = p.byService.get(c.service) ?? [];
    p.byService.set(c.service, [...arr, c]);
    byProject.set(c.project, p);
  }

  const out: RuntimeProject[] = [];
  for (const [project, value] of byProject.entries()) {
    const services = new Map<string, RuntimeService>();
    for (const [service, containersByService] of value.byService.entries()) {
      services.set(service, { service, containers: containersByService });
    }
    out.push({
      project,
      workingDir: value.workingDir,
      services,
      isGlobal: value.isGlobal,
    });
  }

  return {
    ok: true,
    runtime: out.sort((a, b) => a.project.localeCompare(b.project)),
    error: null,
    checkedAtMs,
  };
}

export async function autoRegisterRuntimeHackProjects(opts: {
  readonly runtime: readonly RuntimeProject[];
}): Promise<void> {
  for (const p of opts.runtime) {
    const wd = p.workingDir ?? "";
    const dirName = resolveProjectDirName(wd);
    if (!dirName) {
      continue;
    }

    const projectDir = wd;
    const repoRoot = resolve(projectDir, "..");
    const composeFile = resolve(projectDir, PROJECT_COMPOSE_FILENAME);
    if (!(await pathExists(composeFile))) {
      continue;
    }

    await upsertProjectRegistration({
      project: {
        projectRoot: repoRoot,
        projectDirName: dirName,
        projectDir,
        composeFile,
        envFile: resolve(projectDir, PROJECT_ENV_FILENAME),
        configFile: resolve(projectDir, PROJECT_CONFIG_FILENAME),
      },
    });
  }
}

export function serializeRuntimeProject(
  runtime: RuntimeProject
): Record<string, unknown> {
  return {
    project: runtime.project,
    working_dir: runtime.workingDir ?? null,
    services: [...runtime.services.values()].map((service) => ({
      service: service.service,
      containers: service.containers.map((container) => ({
        id: container.id,
        state: container.state,
        status: container.status,
        name: container.name,
        ports: container.ports,
        working_dir: container.workingDir ?? null,
        image: container.image,
        labels: container.labels,
        mounts: container.mounts.map((mount) => ({
          type: mount.type,
          source: mount.source,
          destination: mount.destination,
          mode: mount.mode,
          rw: mount.rw,
        })),
        networks: container.networks.map((network) => ({
          name: network.name,
          ip_address: network.ipAddress,
          gateway: network.gateway,
          aliases: network.aliases,
        })),
      })),
    })),
  };
}

export async function readContainerLabels(opts: {
  readonly ids: readonly string[];
}): Promise<Map<string, Record<string, string>>> {
  const inspectById = await readContainerInspectData({ ids: opts.ids });
  const labelsById = new Map<string, Record<string, string>>();
  for (const [id, detail] of inspectById.entries()) {
    labelsById.set(id, detail.labels);
  }
  return labelsById;
}

async function readContainerInspectData(opts: {
  readonly ids: readonly string[];
}): Promise<Map<string, ContainerInspectData>> {
  if (opts.ids.length === 0) {
    return new Map();
  }

  const res = await exec(["docker", "inspect", ...opts.ids], {
    stdin: "ignore",
  });
  if (res.exitCode !== 0) {
    return new Map();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return new Map();
  }
  if (!Array.isArray(parsed)) {
    return new Map();
  }

  const out = new Map<string, ContainerInspectData>();
  for (const item of parsed) {
    if (!isRecord(item)) {
      continue;
    }

    const id = getString(item, "Id") ?? "";
    if (id.length === 0) {
      continue;
    }

    const config = item.Config;
    const labels = parseInspectLabels(config);
    const image = parseInspectImage(config);
    const mounts = parseInspectMounts(item.Mounts);
    const networks = parseInspectNetworks(item.NetworkSettings);

    const detail: ContainerInspectData = {
      labels,
      image,
      mounts,
      networks,
    };
    out.set(id, detail);
    if (id.length >= 12) {
      out.set(id.slice(0, 12), detail);
    }
  }

  return out;
}

function resolveProjectDirName(workingDir: string): ".hack" | ".dev" | null {
  if (workingDir.endsWith("/.hack")) {
    return ".hack";
  }
  if (workingDir.endsWith("/.dev")) {
    return ".dev";
  }
  return null;
}

function parseInspectLabels(config: unknown): Record<string, string> {
  if (!isRecord(config)) {
    return {};
  }
  const labels = config.Labels;
  if (!isRecord(labels)) {
    return {};
  }

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}

function parseInspectImage(config: unknown): string | null {
  if (!isRecord(config)) {
    return null;
  }
  return getString(config, "Image") ?? null;
}

function parseInspectMounts(raw: unknown): RuntimeContainerMount[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const mounts: RuntimeContainerMount[] = [];
  for (const value of raw) {
    if (!isRecord(value)) {
      continue;
    }
    const source = getString(value, "Source") ?? "";
    const destination = getString(value, "Destination") ?? "";
    if (!(source && destination)) {
      continue;
    }
    const rwValue = value.RW;
    mounts.push({
      type: getString(value, "Type") ?? "",
      source,
      destination,
      mode: getString(value, "Mode") ?? "",
      rw: typeof rwValue === "boolean" ? rwValue : null,
    });
  }
  return mounts;
}

function parseInspectNetworks(raw: unknown): RuntimeContainerNetwork[] {
  if (!isRecord(raw)) {
    return [];
  }
  const networks = raw.Networks;
  if (!isRecord(networks)) {
    return [];
  }

  const out: RuntimeContainerNetwork[] = [];
  for (const [name, value] of Object.entries(networks)) {
    if (!isRecord(value)) {
      continue;
    }
    const aliasesRaw = value.Aliases;
    const aliases = Array.isArray(aliasesRaw)
      ? aliasesRaw.filter((alias): alias is string => typeof alias === "string")
      : [];
    out.push({
      name,
      ipAddress: getString(value, "IPAddress") ?? null,
      gateway: getString(value, "Gateway") ?? null,
      aliases,
    });
  }
  return out;
}

function parseLabelString(opts: {
  readonly raw: string;
}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of opts.raw.split(",")) {
    const idx = part.indexOf("=");
    if (idx <= 0) {
      continue;
    }
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key.length === 0) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

function formatDockerError(opts: {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}): string {
  const stderr = opts.stderr.trim();
  if (stderr.length > 0) {
    return stderr;
  }
  const stdout = opts.stdout.trim();
  if (stdout.length > 0) {
    return stdout;
  }
  return `docker ps failed (exit ${opts.exitCode})`;
}
