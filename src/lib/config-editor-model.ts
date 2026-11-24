import { constants } from "node:fs";
import { access, lstat, open, realpath, stat } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { PROJECT_CONFIG_LEGACY_FILENAME } from "../constants.ts";
import { autoWorktreeBranch, resolveEffectiveBranch } from "./branches.ts";
import { HackCliError } from "./cli-result.ts";
import { type ConfigIssue, composeModel } from "./config-editor-compose.ts";
import {
  configLine,
  isConfigSecret,
  isPrivateOverlayValue,
  jsonConfigTree,
  privateProjectOverlayNames,
  safeJsonProject,
  safeJsonSource,
  safeYamlSource,
} from "./config-editor-source.ts";
import {
  assertEnvMigrationReadable,
  EnvMigrationPendingError,
} from "./env-migration-state.ts";
import { AtomicWriteConflictError } from "./fs.ts";
import { listGitWorktrees } from "./git-worktree.ts";
import { isRecord } from "./guards.ts";
import { MACHINE_SCHEMAS } from "./machine-output.ts";
import {
  defaultProjectDevHost,
  findProjectContext,
  findProjectContextAtRoot,
  legacyProjectDevHost,
  type ProjectConfig,
  type ProjectContext,
  parseEnvConfigSelection,
  parseProjectConfigRecord,
  projectNameForConfig,
  readAuthoredProjectOverlaySettings,
  resolveProjectDefaultEnvOverlay,
  resolveProjectOauthAliasHost,
  resolveProjectRouteBaseHosts,
  resolveWorktreeAutoBranch,
  sanitizeBranchSlug,
} from "./project.ts";
import {
  listProjectEnvOverlays,
  type ProjectEnvStoredValue,
  parseProjectEnvConfigText,
  resolveProjectEnvConfigPath,
  resolveProjectEnvEffectiveLocalConfigPath,
  resolveProjectEnvLocalConfigPath,
  resolveProjectEnvSelection,
} from "./project-env-config.ts";
import { assertProjectEnvLayerPath } from "./project-env-layer-path.ts";
import {
  resolvePrimaryLocalProjectDir,
  validatePrimaryLocalFile,
} from "./worktree-local-config.ts";

export const CONFIG_EDITOR_SCHEMA = MACHINE_SCHEMAS.config;
export const CONFIG_SOURCE_LIMIT = 512 * 1024;

type Layer = {
  readonly id: string;
  readonly file: string;
  readonly kind: "project" | "compose" | "env" | "branch" | "internal";
  readonly ownership: "shared" | "local" | "generated";
  readonly active: boolean;
  readonly inherited?: boolean;
  readonly overlay?: string | null;
};

export type LayerSnapshot = Layer & {
  readonly writable: boolean;
  readonly revision: string;
  readonly text: string | null;
  readonly directory: ConfigDirectory | null;
};

type ConfigDirectory = {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
};

async function configDirectory(file: string): Promise<ConfigDirectory | null> {
  try {
    const path = await realpath(dirname(file));
    const info = await stat(path);
    if (info.isDirectory()) {
      return { path, device: info.dev, inode: info.ino };
    }
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return null;
    }
  }
  throw new HackCliError({
    code: "E_PATH_CONFLICT",
    message: "The config layer directory could not be verified.",
  });
}

export async function assertConfigLayerDirectory(
  layer: LayerSnapshot
): Promise<void> {
  const current = await configDirectory(layer.file).catch(() => null);
  if (
    !current ||
    current.path !== layer.directory?.path ||
    current.device !== layer.directory.device ||
    current.inode !== layer.directory.inode
  ) {
    throw new AtomicWriteConflictError();
  }
}

function configRevision(
  layer: Layer,
  project: ProjectContext,
  text: string | null,
  directory: ConfigDirectory | null
): string {
  // Even an absent file belongs to one checkout and destination.
  return new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify([
        project.projectRoot,
        layer.file,
        layer.ownership === "generated" ? null : directory,
        text,
      ])
    )
    .digest("hex");
}

export async function readConfigLayer(file: string): Promise<string | null> {
  try {
    // A layer can be replaced by another editor between discovery and read.
    // Read the opened object without following a swapped link or waiting on a pipe.
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > CONFIG_SOURCE_LIMIT) {
        throw new Error("Expected a bounded, regular config file.");
      }
      const bytes = Buffer.alloc(
        Math.min(info.size + 1, CONFIG_SOURCE_LIMIT + 1)
      );
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(
          bytes,
          length,
          bytes.length - length,
          length
        );
        if (bytesRead === 0) {
          break;
        }
        length += bytesRead;
      }
      if (length === bytes.length) {
        throw new Error("Config file grew while it was being read.");
      }
      return bytes.toString("utf8", 0, length);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return null;
    }
    throw new HackCliError({
      code: "E_PERMISSION",
      message: "Could not read a regular config file within the size limit.",
    });
  }
}

async function writableLayer(layer: Layer, exists: boolean): Promise<boolean> {
  if (!layer.active || layer.inherited || layer.ownership === "generated") {
    return false;
  }
  try {
    await access(dirname(layer.file), constants.W_OK);
    if (exists) {
      await access(layer.file, constants.W_OK);
    }
    return true;
  } catch {
    return false;
  }
}

async function snapshotLayer(
  layer: Layer,
  project: ProjectContext
): Promise<LayerSnapshot> {
  const root = layer.inherited
    ? dirname(dirname(layer.file))
    : project.projectRoot;
  if (layer.kind === "env") {
    await assertProjectEnvLayerPath({ projectRoot: root, path: layer.file });
    if (layer.inherited) {
      await validatePrimaryLocalFile(layer.file);
    }
  }
  // Managed source paths can contain runtime state. Follow only real
  // directories inside the selected checkout and never follow a leaf link.
  const directory = await configDirectory(layer.file);
  if (
    directory !== null &&
    directory.path !==
      resolve(
        await realpath(project.projectRoot),
        relative(project.projectRoot, dirname(layer.file))
      ) &&
    !layer.inherited
  ) {
    throw new HackCliError({
      code: "E_PATH_CONFLICT",
      message: "A config layer directory is linked outside its checkout.",
    });
  }
  const text = await readConfigLayer(layer.file);
  return {
    ...layer,
    text,
    directory,
    revision: configRevision(layer, project, text, directory),
    writable: await writableLayer(layer, text !== null),
  };
}

async function selectedProject(
  start: string,
  requestedBranch: string | undefined
) {
  const project = await findProjectContext(start);
  const branch = requestedBranch?.trim();
  if (!(project && branch)) {
    return { project, explicit: null };
  }
  const slug = sanitizeBranchSlug(branch);
  if (!slug) {
    throw new HackCliError({
      code: "E_USAGE",
      message: "Use a valid branch instance name.",
    });
  }
  const worktrees = await listGitWorktrees({
    repoRoot: project.projectRoot,
    timeoutMs: 3000,
  });
  // The primary checkout's git branch is the base instance. An explicit
  // instance with the same name is only a linked checkout if Git lists one.
  const linked = worktrees
    ?.slice(1)
    .find(
      (entry) =>
        entry.branch &&
        (entry.branch === branch ||
          autoWorktreeBranch(entry.branch, worktrees) === branch)
    );
  if (!linked) {
    return { project, explicit: slug };
  }
  const checkout = await findProjectContextAtRoot({
    projectRoot: linked.path,
    projectDirName: project.projectDirName,
  });
  if (!checkout) {
    throw new HackCliError({
      code: "E_PROJECT_NOT_FOUND",
      message: "The selected worktree has no Hack Compose config.",
    });
  }
  return {
    project: checkout,
    explicit: linked.branch
      ? autoWorktreeBranch(linked.branch, worktrees)
      : slug,
  };
}

function envLayer(opts: {
  readonly id: string;
  readonly file: string;
  readonly ownership: "local" | "shared";
  readonly overlay?: string | null;
  readonly inherited?: boolean;
  readonly active?: boolean;
}): Layer {
  return { ...opts, kind: "env", active: opts.active ?? true };
}

async function readProjectLayer(
  project: ProjectContext
): Promise<LayerSnapshot> {
  const legacy = resolve(project.projectDir, PROJECT_CONFIG_LEGACY_FILENAME);
  const json = await snapshotLayer(
    {
      id: "1",
      file: project.configFile,
      kind: "project",
      ownership: "shared",
      active: true,
    },
    project
  );
  if (
    json.text !== null ||
    !(await lstat(legacy).then(
      () => true,
      () => false
    ))
  ) {
    return json;
  }
  return await snapshotLayer({ ...json, file: legacy }, project);
}

async function configLayers(opts: {
  readonly project: ProjectContext;
  readonly projectLayer: LayerSnapshot;
  readonly branch: string | null;
  readonly overlay: string | null | undefined;
  readonly defaultOverlay: string | null;
  readonly privateOverlays: ReadonlySet<string>;
  readonly config: ProjectConfig;
}) {
  const p = opts.project;
  const defaultEnv = opts.defaultOverlay;
  const inherited = await resolvePrimaryLocalProjectDir({
    ...p,
    inheritLocal: opts.config.worktree?.inheritLocal !== false,
  });
  await assertConfigEnvReadable(p.projectRoot, inherited);
  const [env, overlays] = await Promise.all([
    resolveProjectEnvSelection({ ...p, envName: opts.overlay, defaultEnv }),
    listProjectEnvOverlays({ ...p, defaultEnv, primaryDir: inherited }),
  ]);
  const overlay = env.effectiveEnv;
  const names = [
    ...new Set([
      ...overlays.map((entry) => entry.name),
      ...(overlay ? [overlay] : []),
    ]),
  ].filter(
    (name) =>
      !opts.privateOverlays.has(name) && parseEnvConfigSelection(name) === name
  );
  const layers: Layer[] = [
    {
      id: "2",
      file: p.composeFile,
      kind: "compose",
      ownership: "shared",
      active: true,
    },
    envLayer({ id: "3", file: env.defaultPath, ownership: "shared" }),
  ];
  for (const name of names) {
    const file = resolveProjectEnvConfigPath({
      projectDir: p.projectDir,
      envName: name,
    });
    if (file === env.localDefaultPath || file === env.defaultPath) {
      continue;
    }
    layers.push(
      envLayer({
        id: `3:${name}`,
        file,
        ownership: "shared",
        overlay: name,
        active: name === overlay,
      })
    );
  }
  if (inherited) {
    layers.push(
      envLayer({
        id: "4",
        ownership: "local",
        inherited: true,
        file: await resolveProjectEnvEffectiveLocalConfigPath({
          projectRoot: dirname(inherited),
          projectDir: inherited,
          envName: null,
        }),
      })
    );
    if (overlay) {
      layers.push(
        envLayer({
          id: `4:${overlay}`,
          ownership: "local",
          inherited: true,
          overlay,
          file: resolveProjectEnvLocalConfigPath({
            projectDir: inherited,
            envName: overlay,
          }),
        })
      );
    }
  }
  layers.push(
    envLayer({ id: "5", file: env.localDefaultPath, ownership: "local" })
  );
  if (overlay && env.localOverlayPath) {
    layers.push(
      envLayer({
        id: `5:${overlay}`,
        file: env.localOverlayPath,
        ownership: "local",
        overlay,
      })
    );
  }
  if (opts.branch) {
    layers.push({
      id: "6",
      file: resolve(
        p.projectDir,
        ".branch",
        `compose.${opts.branch}.override.yml`
      ),
      kind: "branch",
      ownership: "generated",
      active: true,
    });
  }
  layers.push(
    {
      id: "7",
      file: resolve(p.projectDir, ".internal", "compose.override.yml"),
      kind: "internal",
      ownership: "generated",
      active: true,
    },
    {
      id: "8",
      file: resolve(p.projectDir, ".internal", "extra-hosts.json"),
      kind: "internal",
      ownership: "generated",
      active: true,
    }
  );
  return {
    layers: [
      opts.projectLayer,
      ...(await Promise.all(layers.map((layer) => snapshotLayer(layer, p)))),
    ],
    overlay,
    overlays: names,
  };
}

export async function assertConfigEnvReadable(
  projectRoot: string,
  inherited: string | null
): Promise<void> {
  try {
    await assertEnvMigrationReadable({ projectRoot });
    if (inherited) {
      await assertEnvMigrationReadable({ projectRoot: dirname(inherited) });
    }
  } catch (error) {
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message:
        error instanceof EnvMigrationPendingError
          ? error.message
          : "The env migration journal could not be verified.",
    });
  }
}

export async function readConfigEditor(opts: {
  readonly start: string;
  readonly branch: string | undefined;
  readonly overlay: string | null | undefined;
}) {
  const { project, explicit } = await selectedProject(opts.start, opts.branch);
  if (!project) {
    return null;
  }
  return await captureConfigEditor({
    project,
    projectLayer: await readProjectLayer(project),
    explicitBranch: explicit,
    requestedOverlay: opts.overlay,
  });
}

function configOverlaySelection(
  raw: Record<string, unknown>,
  config: ProjectConfig,
  requested: string | null | undefined
) {
  const configured = resolveProjectDefaultEnvOverlay(config);
  const { current, legacy } = readAuthoredProjectOverlaySettings(raw);
  const authoredDefault = config.env?.defaultOverlay
    ? (current[0] ?? current[1])
    : (legacy[0] ?? legacy[1]);
  // Even an overridden alias may have a layer on disk under its normalized name.
  const privateOverlays = privateProjectOverlayNames(raw);
  const redactDefault =
    isConfigSecret("", authoredDefault) ||
    (configured !== null && privateOverlays.has(configured));
  return {
    privateOverlays,
    defaultOverlay: redactDefault ? null : configured,
    displayDefault: redactDefault ? "[redacted]" : (configured ?? "default"),
    requested:
      typeof requested === "string" && privateOverlays.has(requested)
        ? null
        : requested,
  };
}

/** Observe the selected layers using the supplied, possibly edited project file. */
export async function captureConfigEditor(opts: {
  readonly project: ProjectContext;
  readonly projectLayer: LayerSnapshot;
  readonly explicitBranch: string | null;
  readonly requestedOverlay: string | null | undefined;
}) {
  const { project, projectLayer, explicitBranch } = opts;
  const raw = parseProjectLayer(projectLayer);
  if (raw !== null) {
    await assertConfigEnvReadable(project.projectRoot, null);
  }
  const cfg = parseProjectConfigRecord(raw ?? {}, projectLayer.file);
  const selection = configOverlaySelection(
    raw ?? {},
    cfg,
    opts.requestedOverlay
  );
  const branch = (
    await resolveEffectiveBranch({
      explicitBranch,
      projectRoot: project.projectRoot,
      autoBranchEnabled: resolveWorktreeAutoBranch(cfg),
    })
  ).branch;
  const devHost =
    cfg.devHost ??
    (raw !== null
      ? legacyProjectDevHost(await readConfigLayer(project.envFile))
      : null) ??
    (branch === null ? defaultProjectDevHost(project.projectRoot) : null);
  const baseHosts = devHost
    ? resolveProjectRouteBaseHosts({
        devHost,
        aliasHost: resolveProjectOauthAliasHost({ oauth: cfg.oauth, devHost }),
      })
    : [];
  const layers =
    raw === null
      ? {
          layers: [projectLayer],
          overlay: selection.requested ?? null,
          overlays: [],
        }
      : await configLayers({
          project,
          projectLayer,
          branch,
          overlay: selection.requested,
          defaultOverlay: selection.defaultOverlay,
          privateOverlays: selection.privateOverlays,
          config: cfg,
        });
  return {
    ...layers,
    project,
    projectName: projectNameForConfig(cfg, project.projectRoot),
    branch,
    baseHosts,
    defaultOverlay: raw === null ? null : selection.displayDefault,
    privateOverlays: selection.privateOverlays,
    explicitBranch,
    requestedOverlay: selection.requested,
  };
}

export type ConfigSnapshot = NonNullable<
  Awaited<ReturnType<typeof readConfigEditor>>
>;

function parseProjectLayer(
  layer: LayerSnapshot
): Record<string, unknown> | null {
  if (layer.text === null) {
    return {};
  }
  if (!(layer.file.endsWith(".toml") || jsonConfigTree(layer.text).ok)) {
    return null;
  }
  try {
    const raw: unknown = layer.file.endsWith(".toml")
      ? Bun.TOML.parse(layer.text)
      : JSON.parse(layer.text);
    return isRecord(raw) ? raw : null;
  } catch {
    return null;
  }
}

function projectModel(
  layer: LayerSnapshot,
  issues: ConfigIssue[]
): Record<string, unknown> {
  if (layer.text === null) {
    return {};
  }
  if (basename(layer.file) === PROJECT_CONFIG_LEGACY_FILENAME) {
    try {
      const raw: unknown = Bun.TOML.parse(layer.text);
      return isRecord(raw)
        ? scrubLegacyProject(raw, privateProjectOverlayNames(raw))
        : {};
    } catch {
      issues.push({
        layer: layer.id,
        path: [],
        line: 1,
        code: "E_CONFIG_PARSE",
        message: "Invalid project TOML.",
      });
      return {};
    }
  }
  const safe = safeJsonProject(layer.text);
  if (safe === null) {
    const tree = jsonConfigTree(layer.text);
    issues.push({
      layer: layer.id,
      path: [],
      line: configLine(
        layer.text,
        tree.duplicate?.offset ?? tree.error?.offset ?? 0
      ),
      code: "E_CONFIG_PARSE",
      message: tree.duplicate
        ? "Each JSON field must appear once."
        : "Expected a valid JSON object.",
    });
    return {};
  }
  return safe;
}

function scrubLegacyProject(
  record: Record<string, unknown>,
  privateOverlays: ReadonlySet<string>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).flatMap(([key, value]) => {
      if (isConfigSecret("", key)) {
        return [];
      }
      if (
        ["startup", "lifecycle"].includes(key) ||
        isPrivateOverlayValue(value, privateOverlays) ||
        (isConfigSecret(key, value) && key !== "oauth")
      ) {
        return [[key, "[redacted]"]];
      }
      if (isRecord(value)) {
        return [[key, scrubLegacyProject(value, privateOverlays)]];
      }
      return Array.isArray(value) ? [] : [[key, value]];
    })
  );
}

function publicLayer(
  layer: LayerSnapshot,
  privateKeys: ReadonlySet<string>,
  invalid: boolean
) {
  const { text, directory: _directory, ...rest } = layer;
  const legacy = basename(layer.file) === PROJECT_CONFIG_LEGACY_FILENAME;
  let source = { source: null as string | null, hidden: legacy || invalid };
  if (text !== null && !(legacy || invalid)) {
    source = layer.file.endsWith(".json")
      ? safeJsonSource(text)
      : safeYamlSource(
          text,
          layer.kind !== "env",
          layer.kind === "env" ? privateKeys : undefined
        );
  }
  return {
    ...rest,
    ...source,
    exists: text !== null,
    writable: layer.writable && !legacy,
    source_writable:
      layer.writable &&
      source.source !== null &&
      (layer.kind === "project" || layer.kind === "compose"),
  };
}

type EnvEntry = {
  layer: string;
  secret: boolean;
  value?: string | number | boolean;
  unset?: boolean;
};
type EnvRow = {
  key: string;
  scope: string;
  values: EnvEntry[];
  winning: string | null;
};

function addEnvLayer(opts: {
  readonly rows: Map<string, EnvRow>;
  readonly layer: string;
  readonly scope: string;
  readonly values: Readonly<Record<string, ProjectEnvStoredValue>>;
  readonly privateKeys: Set<string>;
}): void {
  for (const [key, value] of Object.entries(opts.values)) {
    const id = `${opts.scope}/${key}`;
    const row = opts.rows.get(id) ?? {
      key,
      scope: opts.scope,
      values: [],
      winning: null,
    };
    const base = { layer: opts.layer, secret: false };
    if (value === null) {
      row.values.push({ ...base, unset: true });
    } else if (typeof value === "object" || isConfigSecret(key, value)) {
      opts.privateKeys.add(key);
      row.values.push({ ...base, secret: true });
    } else {
      row.values.push({ ...base, value });
    }
    row.winning = value === null ? null : opts.layer;
    opts.rows.set(id, row);
  }
}

function envModel(layers: readonly LayerSnapshot[], issues: ConfigIssue[]) {
  const rows = new Map<string, EnvRow>();
  const privateKeys = new Set<string>();
  for (const layer of layers) {
    if (layer.kind !== "env" || !layer.active || layer.text === null) {
      continue;
    }
    const read = parseProjectEnvConfigText({
      path: layer.file,
      environment: layer.overlay ?? "default",
      text: layer.text,
    });
    if (read.parseError) {
      issues.push({
        layer: layer.id,
        path: [],
        line: null,
        code: "E_CONFIG_PARSE",
        message: "Check the env YAML and its values.",
      });
      continue;
    }
    for (const [scope, values] of Object.entries(read.config.values)) {
      addEnvLayer({ rows, layer: layer.id, scope, values, privateKeys });
    }
  }
  const env = [...rows.values()].map((row) => {
    if (!privateKeys.has(row.key)) {
      return row;
    }
    return {
      ...row,
      values: row.values.map((cell) =>
        cell.unset ? cell : { layer: cell.layer, secret: true }
      ),
    };
  });
  return { env, privateKeys };
}

export function showConfigEditor(snapshot: ConfigSnapshot | null) {
  const issues: ConfigIssue[] = [];
  const layers = snapshot?.layers ?? [];
  const projectLayer = layers.find((layer) => layer.id === "1");
  const compose = layers.find((layer) => layer.id === "2");
  const project = projectLayer ? projectModel(projectLayer, issues) : {};
  const missingBranchHost = snapshot?.branch && snapshot.baseHosts.length === 0;
  if (missingBranchHost && issues.length === 0) {
    issues.push({
      layer: "1",
      path: ["dev_host"],
      line: null,
      code: "E_CONFIG_INVALID",
      message: "Set dev_host before starting or restarting this branch.",
    });
  }
  const result =
    compose?.text != null && snapshot
      ? composeModel({
          text: compose.text,
          branch: snapshot.branch,
          baseHosts: snapshot.baseHosts,
        })
      : { services: [], issues: [] };
  issues.push(...result.issues);
  const { env, privateKeys } = envModel(layers, issues);
  const invalid = issues.some((issue) => issue.code === "E_CONFIG_PARSE");
  const state = snapshot ? "ready" : "missing";
  return {
    schema: CONFIG_EDITOR_SCHEMA,
    state: invalid ? "invalid" : state,
    project,
    services: result.services,
    env,
    issues,
    layers: layers.map((layer) =>
      publicLayer(
        layer,
        privateKeys,
        issues.some(
          (issue) => issue.layer === layer.id && issue.code === "E_CONFIG_PARSE"
        )
      )
    ),
    branch: snapshot?.branch ?? null,
    overlay: snapshot?.overlay ?? null,
    default_overlay: snapshot?.defaultOverlay ?? null,
    overlays: snapshot?.overlays ?? [],
    checkout: snapshot?.project.projectRoot ?? null,
    writable: layers.some((layer) => layer.writable),
  };
}
