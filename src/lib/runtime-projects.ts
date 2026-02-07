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
  readonly image: string | null;
  readonly ip: string | null;
  readonly mounts: readonly RuntimeMount[];
  readonly labels: Readonly<Record<string, string>>;
  readonly workingDir: string | null;
};

export type RuntimeMount = {
  readonly source: string | null;
  readonly destination: string | null;
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
  const psResult = await readDockerComposePs();
  if (!psResult.ok) {
    return { ok: false, runtime: [], error: psResult.error, checkedAtMs };
  }

  const globalRoot = resolveGlobalHackRoot();
  const containers = buildRuntimeContainers({
    rows: psResult.rows,
    inspectById: psResult.inspectById,
    globalRoot,
    includeGlobal: opts.includeGlobal,
  });
  const out = buildRuntimeProjects({
    containers,
    globalRoot,
  });

  return {
    ok: true,
    runtime: out.sort((a, b) => a.project.localeCompare(b.project)),
    error: null,
    checkedAtMs,
  };
}

type DockerComposePsResult =
  | {
      readonly ok: true;
      readonly rows: readonly unknown[];
      readonly inspectById: Map<string, ContainerInspectMeta>;
    }
  | { readonly ok: false; readonly error: string };

async function readDockerComposePs(): Promise<DockerComposePsResult> {
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
      error: formatDockerError({
        exitCode: res.exitCode,
        stdout: res.stdout,
        stderr: res.stderr,
      }),
    };
  }

  const rows = parseJsonLines(res.stdout);
  const ids = rows
    .map((row) => getString(row, "ID") ?? getString(row, "Id") ?? "")
    .filter((id) => id.length > 0);
  const inspectById = await readContainerInspectMeta({ ids });
  return { ok: true, rows, inspectById };
}

function resolveGlobalHackRoot(): string {
  const home = process.env.HOME ?? "";
  return home ? resolve(home, GLOBAL_HACK_DIR_NAME) : "";
}

function buildRuntimeContainers(opts: {
  readonly rows: readonly unknown[];
  readonly inspectById: Map<string, ContainerInspectMeta>;
  readonly globalRoot: string;
  readonly includeGlobal: boolean;
}): RuntimeContainer[] {
  const containers: RuntimeContainer[] = [];

  for (const row of opts.rows) {
    const container = parseRuntimeContainerRow({
      row,
      inspectById: opts.inspectById,
      globalRoot: opts.globalRoot,
    });
    if (!container) {
      continue;
    }

    if (
      !opts.includeGlobal &&
      isGlobalWorkingDir({
        globalRoot: opts.globalRoot,
        workingDir: container.workingDir,
      })
    ) {
      continue;
    }

    containers.push(container);
  }

  return containers;
}

function parseRuntimeContainerRow(opts: {
  readonly row: unknown;
  readonly inspectById: Map<string, ContainerInspectMeta>;
  readonly globalRoot: string;
}): RuntimeContainer | null {
  if (!isRecord(opts.row)) {
    return null;
  }
  const row = opts.row;

  const id = getString(row, "ID") ?? getString(row, "Id") ?? "";
  const imageFromPs = getString(row, "Image") ?? null;
  const labelsRaw = getString(row, "Labels");
  const inspect = id.length > 0 ? opts.inspectById.get(id) : undefined;
  const labels =
    inspect?.labels ?? (labelsRaw ? parseLabelString({ raw: labelsRaw }) : {});
  const project = labels["com.docker.compose.project"] ?? null;
  const service = labels["com.docker.compose.service"] ?? null;
  const oneoff =
    (labels["com.docker.compose.oneoff"] ?? "").toLowerCase() === "true";
  if (!(project && service) || oneoff) {
    return null;
  }

  const workingDir = labels["com.docker.compose.project.working_dir"] ?? null;

  return {
    id,
    project,
    service,
    state: getString(row, "State") ?? "",
    status: getString(row, "Status") ?? "",
    name: getString(row, "Names") ?? "",
    ports: getString(row, "Ports") ?? "",
    image: inspect?.image ?? imageFromPs,
    ip: inspect?.ip ?? null,
    mounts: inspect?.mounts ?? [],
    labels,
    workingDir,
  };
}

function isGlobalWorkingDir(opts: {
  readonly globalRoot: string;
  readonly workingDir: string | null;
}): boolean {
  return opts.globalRoot.length > 0 && opts.workingDir !== null
    ? opts.workingDir.startsWith(opts.globalRoot)
    : false;
}

function buildRuntimeProjects(opts: {
  readonly containers: readonly RuntimeContainer[];
  readonly globalRoot: string;
}): RuntimeProject[] {
  const byProject = new Map<
    string,
    {
      workingDir: string | null;
      byService: Map<string, RuntimeContainer[]>;
      isGlobal: boolean;
    }
  >();

  for (const container of opts.containers) {
    const existing = byProject.get(container.project);
    if (!existing) {
      const byService = new Map<string, RuntimeContainer[]>();
      byService.set(container.service, [container]);
      byProject.set(container.project, {
        workingDir: container.workingDir,
        byService,
        isGlobal: isGlobalWorkingDir({
          globalRoot: opts.globalRoot,
          workingDir: container.workingDir,
        }),
      });
      continue;
    }

    const list = existing.byService.get(container.service);
    if (list) {
      list.push(container);
    } else {
      existing.byService.set(container.service, [container]);
    }
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

  return out;
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
        image: container.image,
        ip: container.ip,
        mounts: container.mounts.map((mount) => ({
          source: mount.source,
          destination: mount.destination,
        })),
        labels: container.labels,
        working_dir: container.workingDir ?? null,
      })),
    })),
  };
}

type ContainerInspectMeta = {
  readonly labels: Readonly<Record<string, string>>;
  readonly image: string | null;
  readonly ip: string | null;
  readonly mounts: readonly RuntimeMount[];
};

export async function readContainerInspectMeta(opts: {
  readonly ids: readonly string[];
}): Promise<Map<string, ContainerInspectMeta>> {
  if (opts.ids.length === 0) {
    return new Map();
  }

  const res = await exec(
    [
      "docker",
      "inspect",
      "--format",
      "{{.Id}}\t{{.Config.Image}}\t{{json .Config.Labels}}\t{{json .Mounts}}\t{{json .NetworkSettings.Networks}}",
      ...opts.ids,
    ],
    { stdin: "ignore" }
  );
  if (res.exitCode !== 0) {
    return new Map();
  }

  const out = new Map<string, ContainerInspectMeta>();
  for (const line of res.stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const [idRaw, imageRaw, labelsRaw, mountsRaw, networksRaw] =
      trimmed.split("\t");
    const id = (idRaw ?? "").trim();
    if (id.length === 0) {
      continue;
    }

    const image = (imageRaw ?? "").trim();
    const meta: ContainerInspectMeta = {
      labels: filterLabelsForUi(parseLabelsJson({ raw: labelsRaw ?? "" })),
      image: image.length > 0 ? image : null,
      ip: parseIpFromNetworksJson({ raw: networksRaw ?? "" }),
      mounts: parseMountsJson({ raw: mountsRaw ?? "" }),
    };

    out.set(id, meta);
    if (id.length >= 12) {
      out.set(id.slice(0, 12), meta);
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

function parseLabelsJson(opts: {
  readonly raw: string;
}): Record<string, string> {
  if (!opts.raw || opts.raw === "null") {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(opts.raw);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) {
    return {};
  }

  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === "string") {
      out[k] = v;
    }
  }
  return out;
}

function filterLabelsForUi(
  labels: Record<string, string>
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    if (key.startsWith("caddy")) {
      out[key] = value;
      continue;
    }
    if (key.startsWith("com.docker.compose.")) {
      out[key] = value;
    }
  }
  return out;
}

function parseMountsJson(opts: {
  readonly raw: string;
}): readonly RuntimeMount[] {
  const raw = opts.raw.trim();
  if (raw.length === 0 || raw === "null") {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }

  const out: RuntimeMount[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) {
      continue;
    }
    const source =
      getString(entry, "Source") ?? getString(entry, "Name") ?? null;
    const destination = getString(entry, "Destination") ?? null;
    if (!(source || destination)) {
      continue;
    }
    out.push({ source, destination });
  }
  return out;
}

function parseIpFromNetworksJson(opts: {
  readonly raw: string;
}): string | null {
  const raw = opts.raw.trim();
  if (raw.length === 0 || raw === "null") {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }

  for (const value of Object.values(parsed)) {
    if (!isRecord(value)) {
      continue;
    }
    const ip = getString(value, "IPAddress");
    if (ip && ip.length > 0) {
      return ip;
    }
  }

  return null;
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
