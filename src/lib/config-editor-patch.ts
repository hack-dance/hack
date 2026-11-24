import { lstat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { applyEdits, findNodeAtLocation, modify } from "jsonc-parser";
import { z } from "zod";
import {
  ClosedCliError,
  HackCliError,
  type HackErrorCode,
} from "./cli-result.ts";
import {
  type ConfigIssue,
  changeComposeRoute,
  editableComposeField,
  parseComposeSource,
  parseRouteAddress,
  updateComposeServiceField,
  validComposePort,
  validHost,
  validPort,
} from "./config-editor-compose.ts";
import {
  assertConfigEnvReadable,
  assertConfigLayerDirectory,
  CONFIG_EDITOR_SCHEMA,
  CONFIG_SOURCE_LIMIT,
  type ConfigSnapshot,
  captureConfigEditor,
  type LayerSnapshot,
  readConfigLayer,
  showConfigEditor,
} from "./config-editor-model.ts";
import {
  configLine,
  hasPrivateOverlayValue,
  isConfigSecret,
  isPrivateConfigOverlay,
  jsonConfigDiagnostic,
  jsonConfigTree,
  privateProjectOverlayNames,
  redactConfigPath,
  restoreConfigSource,
} from "./config-editor-source.ts";
import {
  PRIVATE_OVERLAY_MIGRATION_CONFLICT,
  privateOverlayFileConflict,
} from "./config-overlay-files.ts";
import { withEnvLayerLock } from "./env-layer-lock.ts";
import {
  applyEnvMigration,
  assertEnvMigrationConsent,
  type ImplicitEnvMigrationPlan,
  type MigrationConfigWrite,
  prepareImplicitEnvMigration,
  withEnvMigrationConfigEdits,
} from "./env-migration.ts";
import { migrationDigest } from "./env-migration-files.ts";
import { envMigrationSnapshots } from "./env-migration-snapshot.ts";
import {
  AtomicWriteConflictError,
  writeTextFileAtomicIfChanged,
} from "./fs.ts";
import { isRecord } from "./guards.ts";
import { readHackEnvContract, readHackEnvRuntimeConfig } from "./hack-env.ts";
import {
  ENV_BASE_SELECTION_ALIASES,
  ENV_CONFIG_NAME_MAX_LENGTH,
  parseEnvConfigSelection,
  parseProjectConfigRecord,
} from "./project.ts";
import {
  discoverComposeServiceNames,
  isGitIgnoredProjectEnvPath,
  isValidProjectEnvScopeName,
  mutateProjectEnvLayer,
  type ProjectEnvLayerChange,
  preflightLegacyEnvContract,
  projectEnvConfigExistsForMutation,
  projectEnvLayerFits,
} from "./project-env-config.ts";
import { assertLegacyProjectDirectory } from "./project-input-selection.ts";
import { resolveFileSecretStorePaths } from "./secret-store.ts";

const BASE_REV = /^[a-f0-9]{64}$/;
const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;
const SERVICE = /^[\w.-]+$/;
const HOSTS = /[\s,]+/;
const PRIVATE_OVERLAY_CONFLICT_MESSAGES = {
  existing:
    "Move or rename the env layer with a private filename before replacing this setting.",
  planned: PRIVATE_OVERLAY_MIGRATION_CONFLICT,
};
const layerId = z.string().max(ENV_CONFIG_NAME_MAX_LENGTH + "3:".length);
const serviceName = z.string().max(160).regex(SERVICE);

const changeSchema = z.discriminatedUnion("kind", [
  z.object({
    layer: layerId,
    kind: z.literal("project"),
    path: z.string().max(120),
    value: z.union([z.string(), z.boolean()]),
  }),
  z.object({
    layer: layerId,
    kind: z.literal("route"),
    service: serviceName,
    sites: z.string(),
    port: z.union([z.number(), z.string()]),
  }),
  z.object({
    layer: layerId,
    kind: z.literal("service"),
    service: serviceName,
    field: z.enum(["image", "ports", "depends_on"]),
    value: z.union([z.string(), z.array(z.union([z.string(), z.number()]))]),
  }),
  z.object({
    layer: layerId,
    kind: z.literal("env"),
    scope: z.string().max(160),
    key: z.string().max(160).regex(ENV_KEY),
    value: z.string().nullable(),
    secret: z.boolean().default(false),
  }),
  z.object({
    layer: layerId,
    kind: z.literal("source"),
    text: z.string().max(CONFIG_SOURCE_LIMIT),
  }),
]);
const patchSchema = z.object({
  base: z.record(layerId, z.string().regex(BASE_REV)),
  changes: z.array(changeSchema).max(200),
});
type Patch = z.infer<typeof patchSchema>;
type Change = z.infer<typeof changeSchema>;

export function readConfigPatch(input: string): Patch {
  try {
    const result = patchSchema.safeParse(JSON.parse(input));
    if (result.success) {
      return result.data;
    }
  } catch {
    // JSON and schema errors can contain input values.
  }
  throw new HackCliError({
    code: "E_USAGE",
    message: "Expected a config patch with base revisions and a changes array.",
  });
}

type Prepared = {
  readonly layer: LayerSnapshot;
  text: string | null;
  readonly env: ProjectEnvLayerChange[];
  source: boolean;
};

function configIssue(
  change: Change,
  path: readonly string[],
  message: string,
  code: HackErrorCode = "E_CONFIG_INVALID",
  line: number | null = null
): ConfigIssue {
  return {
    layer: publicPatchLayerId(change.layer),
    path: redactConfigPath(path),
    message,
    code,
    line,
  };
}

function publicPatchLayerId(id: string): string {
  return isConfigSecret("", id) ? "[redacted]" : id;
}

const PROJECT_TOGGLES = new Set([
  "internal.dns",
  "internal.tls",
  "oauth.enabled",
  "worktree.auto_branch",
  "worktree.inherit_local",
  "logs.clear_on_down",
]);
const PROJECT_STRINGS = new Set([
  "name",
  "dev_host",
  "oauth.tld",
  "open.prefer",
  "logs.follow_backend",
  "logs.snapshot_backend",
  "logs.retention_period",
  "env.defaultOverlay",
]);

function projectFieldError(path: string, value: unknown): string | null {
  if (PROJECT_TOGGLES.has(path)) {
    return typeof value === "boolean" ? null : "Choose on or off.";
  }
  if (!PROJECT_STRINGS.has(path) || typeof value !== "string") {
    return "This field is edited in Source.";
  }
  if (path === "dev_host" || path === "oauth.tld") {
    return validHost(value) && (path === "oauth.tld" || value.includes("."))
      ? null
      : "Use letters, digits, dots and dashes, such as storefront.hack.";
  }
  if (path === "name" && !SERVICE.test(value)) {
    return "Use letters, digits, dots, underscores and dashes.";
  }
  if (
    path === "env.defaultOverlay" &&
    !ENV_BASE_SELECTION_ALIASES.has(value) &&
    parseEnvConfigSelection(value) !== value
  ) {
    return "Use up to 128 lowercase letters, digits and dashes, or enter default for base layers.";
  }
  if (path === "open.prefer" && !["auto", "dev", "alias"].includes(value)) {
    return "Choose auto, dev or alias.";
  }
  if (path.endsWith("_backend") && !["compose", "loki"].includes(value)) {
    return "Choose compose or loki.";
  }
  return null;
}

function prepareProjectField(
  change: Extract<Change, { kind: "project" }>,
  file: Prepared
) {
  const path = change.path.split(".");
  const text = file.text ?? "{}\n";
  const tree = jsonConfigTree(text);
  const node = tree.root ? findNodeAtLocation(tree.root, path) : undefined;
  const line = node ? configLine(text, node.offset) : null;
  const error = projectFieldError(change.path, change.value);
  if (error || !tree.ok) {
    return configIssue(
      change,
      path,
      error ?? "Fix the JSON in Source first.",
      "E_CONFIG_INVALID",
      line
    );
  }
  try {
    file.text = applyEdits(
      text,
      modify(text, path, change.value, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      })
    );
    return null;
  } catch {
    return configIssue(
      change,
      path,
      "The parent field must be an object.",
      "E_CONFIG_INVALID",
      line
    );
  }
}

function prepareRoute(
  change: Extract<Change, { kind: "route" }>,
  file: Prepared
) {
  const path = ["services", change.service, "route"];
  const addresses = change.sites.trim().split(HOSTS).filter(Boolean);
  if (addresses.length === 0 || !addresses.every(parseRouteAddress)) {
    return configIssue(
      change,
      path,
      "Enter valid hostnames separated by commas."
    );
  }
  const port = Number(change.port);
  if (!validPort(port)) {
    return configIssue(
      change,
      [...path, "port"],
      "Use a port between 1 and 65535."
    );
  }
  const source = parseComposeSource(file.text ?? "");
  if (
    source.invalid !== null ||
    !changeComposeRoute({
      source,
      service: change.service,
      sites: addresses.join(", "),
      port,
    })
  ) {
    return configIssue(change, path, "Edit this route in Source.");
  }
  file.text = source.doc.toString({ lineWidth: 0 });
  return null;
}

function prepareService(
  change: Extract<Change, { kind: "service" }>,
  file: Prepared
) {
  const path = ["services", change.service, change.field];
  const source = parseComposeSource(file.text ?? "");
  if (
    source.invalid !== null ||
    !Object.hasOwn(source.services, change.service)
  ) {
    return configIssue(
      change,
      path,
      "Choose a service from this Compose file."
    );
  }
  if (
    !editableComposeField({
      source,
      service: change.service,
      field: change.field,
    })
  ) {
    return configIssue(change, path, "Edit this service field in Source.");
  }
  if (change.field === "image") {
    if (
      typeof change.value !== "string" ||
      !change.value.trim() ||
      isConfigSecret("", change.value)
    ) {
      return configIssue(change, path, "Enter a container image reference.");
    }
  } else if (
    !(
      Array.isArray(change.value) &&
      change.value.every((value) =>
        change.field === "ports"
          ? validComposePort(value)
          : typeof value === "string" && Object.hasOwn(source.services, value)
      )
    )
  ) {
    return configIssue(
      change,
      path,
      change.field === "ports"
        ? "Enter Compose port mappings."
        : "Choose services defined in this Compose file."
    );
  }
  try {
    updateComposeServiceField({ source, path, value: change.value });
    file.text = source.doc.toString({ lineWidth: 0 });
    return null;
  } catch {
    return configIssue(change, path, "Edit this service in Source.");
  }
}

function prepareSource(
  change: Extract<Change, { kind: "source" }>,
  file: Prepared
) {
  if (file.layer.kind === "env") {
    return configIssue(
      change,
      [],
      "Edit values in Env layers.",
      "E_LAYER_READ_ONLY"
    );
  }
  const json = file.layer.kind === "project";
  // Diagnose a syntactically invalid draft without passing it to an output
  // path that could render a pasted credential from the invalid source.
  const invalid = json
    ? jsonConfigDiagnostic(change.text)
    : composeSourceDiagnostic(change.text);
  if (invalid) {
    return configIssue(
      change,
      [],
      invalid.message,
      "E_CONFIG_PARSE",
      invalid.line
    );
  }
  const restored = restoreConfigSource({
    original: file.layer.text ?? (json ? "{}" : "services: {}"),
    draft: change.text,
    format: json ? "json" : "yaml",
  });
  if (restored === null) {
    return configIssue(
      change,
      [],
      "Keep private fields in place or open the file in your editor."
    );
  }
  file.text = restored;
  file.source = true;
  return null;
}

function composeSourceDiagnostic(text: string) {
  const line = parseComposeSource(text).invalid;
  return line === null
    ? null
    : { line, message: "Expected valid Compose YAML." };
}

function prepareEnv(change: Extract<Change, { kind: "env" }>, file: Prepared) {
  const path = ["values", change.scope, change.key];
  if (!isValidProjectEnvScopeName({ scopeName: change.scope })) {
    return configIssue(change, path, "Choose a valid env scope.");
  }
  if (
    change.value !== null &&
    !change.secret &&
    isConfigSecret(change.key, change.value)
  ) {
    return configIssue(change, path, "Set this value as a secret.");
  }
  const { key, scope } = change;
  file.env.push(
    change.value === null
      ? { key, scope, op: "unset" }
      : { key, scope, op: "set", value: change.value, secret: change.secret }
  );
  return null;
}

function matchesLayer(change: Change, layer: LayerSnapshot) {
  switch (change.kind) {
    case "project":
      return layer.kind === "project";
    case "route":
    case "service":
      return layer.kind === "compose";
    case "env":
      return layer.kind === "env";
    case "source":
      return (
        layer.kind === "project" ||
        layer.kind === "compose" ||
        layer.kind === "env"
      );
    default:
      return false;
  }
}

function prepareChange(change: Change, file: Prepared) {
  switch (change.kind) {
    case "project":
      return prepareProjectField(change, file);
    case "route":
      return prepareRoute(change, file);
    case "service":
      return prepareService(change, file);
    case "env":
      return prepareEnv(change, file);
    case "source":
      return prepareSource(change, file);
    default:
      return null;
  }
}

function preparePatch(snapshot: ConfigSnapshot, patch: Patch) {
  const issues: ConfigIssue[] = [];
  const files = new Map<string, Prepared>();
  // Check every supplied base, including dependencies of the patched file.
  for (const [id, base] of Object.entries(patch.base)) {
    const layer = snapshot.layers.find((entry) => entry.id === id);
    if (layer?.revision !== base) {
      issues.push({
        layer: publicPatchLayerId(id),
        path: [],
        line: null,
        code: "E_CONFLICT",
        message: "Changed outside Hack. Reload before saving.",
      });
    }
  }
  if (issues.length > 0) {
    return { files, issues };
  }
  for (const change of patch.changes) {
    const layer = snapshot.layers.find((entry) => entry.id === change.layer);
    const mixed = patch.changes.some(
      (other) =>
        other !== change &&
        other.layer === change.layer &&
        (other.kind === "source" || change.kind === "source")
    );
    if (!layer?.writable || layer.file.endsWith(".toml")) {
      issues.push(
        configIssue(change, [], "This layer is read-only.", "E_LAYER_READ_ONLY")
      );
    } else if (patch.base[layer.id] === undefined) {
      issues.push(
        configIssue(
          change,
          [],
          "Include the layer's base revision.",
          "E_CONFLICT"
        )
      );
    } else if (mixed) {
      issues.push(
        configIssue(
          change,
          [],
          "Use one Source replacement or structured changes for this file."
        )
      );
    } else if (matchesLayer(change, layer)) {
      const file = files.get(layer.id) ?? {
        layer,
        text: layer.text,
        source: false,
        env: [],
      };
      const issue = prepareChange(change, file);
      if (issue) {
        issues.push(issue);
      }
      files.set(layer.id, file);
    } else {
      issues.push(
        configIssue(change, [], "This change belongs in a different layer.")
      );
    }
  }
  return { files, issues };
}

async function prospectiveSnapshot(
  snapshot: ConfigSnapshot,
  files: Map<string, Prepared>
) {
  const project = files.get("1");
  const prospective =
    project?.text !== undefined && project.text !== project.layer.text
      ? await captureConfigEditor({
          ...snapshot,
          projectLayer: { ...project.layer, text: project.text },
        })
      : snapshot;
  const layers = prospective.layers.map((layer) => {
    const file = files.get(layer.id);
    return file && file.layer.file === layer.file
      ? { ...layer, text: file.text }
      : layer;
  });
  return { ...prospective, layers };
}

function sourceIssues(files: Map<string, Prepared>): ConfigIssue[] {
  const project = files.get("1");
  if (!(project?.source && project.text && jsonConfigTree(project.text).ok)) {
    return [];
  }
  const parsed: unknown = JSON.parse(project.text);
  const issues: ConfigIssue[] = [];
  const tree = jsonConfigTree(project.text);
  for (const field of [...PROJECT_TOGGLES, ...PROJECT_STRINGS]) {
    const path = field.split(".");
    const node = tree.root && findNodeAtLocation(tree.root, path);
    if (!node) {
      continue;
    }
    const message = projectFieldError(field, node.value);
    if (message) {
      issues.push({
        layer: "1",
        path,
        line: configLine(project.text, node.offset),
        code: "E_CONFIG_INVALID",
        message,
      });
    }
  }
  if (parseProjectConfigRecord(parsed, project.layer.file).parseError) {
    issues.push({
      layer: "1",
      path: [],
      line: 1,
      code: "E_CONFIG_INVALID",
      message: "Check the project settings and their types.",
    });
  }
  return issues;
}

function removedPrivateOverlays(
  before: ConfigSnapshot,
  remaining: ReadonlySet<string>
): string[] {
  return [...before.privateOverlays].filter((name) => !remaining.has(name));
}

/** An existing legacy store may have undiscovered overlays. Inspect metadata only. */
async function legacyStoreMayContainOverlays(
  snapshot: ConfigSnapshot
): Promise<boolean> {
  const { project } = snapshot;
  const legacy = await readHackEnvContract(project);
  if (!legacy.exists) {
    return false;
  }
  if (
    await projectEnvConfigExistsForMutation({
      ...project,
      inheritLocal: inheritedEnvDir(snapshot) !== null,
    })
  ) {
    return false;
  }
  const { active, storePath } = await resolveFileSecretStorePaths({
    projectDir: project.projectDir,
    strict: true,
  });
  if (!active) {
    return false;
  }
  const usesStore =
    legacy.parseError ||
    legacy.contract.vars.some(({ source }) => source === "keychain") ||
    (await readHackEnvRuntimeConfig(project)).storePlaintextInBackend;
  if (!usesStore) {
    return false;
  }
  const store = await lstat(storePath).catch((error: unknown) => {
    if (isRecord(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  return store !== null && (!store.isFile() || store.size > 0);
}

async function privateOverlayReplacementMessage(opts: {
  readonly before: ConfigSnapshot;
  readonly after: ConfigSnapshot;
  readonly projectText: string | null | undefined;
  readonly outputs: ReadonlyMap<string, string> | null;
}): Promise<string | null> {
  const { before, after, projectText, outputs } = opts;
  if (before.privateOverlays.size === 0) {
    return null;
  }
  const layer = before.layers.find(({ id }) => id === "1");
  const migrationText = layer && outputs?.get(layerDestination(layer));
  for (const text of [migrationText, projectText]) {
    if (!(text && jsonConfigTree(text).ok)) {
      continue;
    }
    const project: unknown = JSON.parse(text);
    if (!isRecord(project)) {
      continue;
    }
    const removed = removedPrivateOverlays(
      before,
      privateProjectOverlayNames(project)
    );
    if (removed.length === 0) {
      continue;
    }
    if (hasPrivateOverlayValue(project, new Set(removed))) {
      return "Remove the remaining private overlay reference before replacing this setting.";
    }
    try {
      const conflict = await privateOverlayFileConflict({
        projectDir: before.project.projectDir,
        inheritedDirs: [inheritedEnvDir(before), inheritedEnvDir(after)],
        names: removed,
        planned: outputs,
      });
      if (conflict) {
        return PRIVATE_OVERLAY_CONFLICT_MESSAGES[conflict];
      }
      if (!outputs && (await legacyStoreMayContainOverlays(after))) {
        return "The legacy secret store may contain this overlay. Migrate the legacy env before replacing this setting.";
      }
    } catch {
      return "Could not verify the private env inputs before replacing this setting.";
    }
  }
  return null;
}

function layerSizeIssues(
  snapshot: ConfigSnapshot,
  files: Map<string, Prepared>,
  envOnly: boolean
): ConfigIssue[] {
  const inheritsLocal = snapshot.layers.some((layer) => layer.inherited);
  return [...files.values()].flatMap(({ layer, text, env }) => {
    if ((layer.kind === "env") !== envOnly) {
      return [];
    }
    const fits =
      layer.kind === "env"
        ? projectEnvLayerFits({
            path: layer.file,
            text,
            envName: layer.overlay ?? null,
            changes: env,
            inheritsLocal: layer.ownership === "local" && inheritsLocal,
            maxBytes: CONFIG_SOURCE_LIMIT,
          })
        : text === null || Buffer.byteLength(text) <= CONFIG_SOURCE_LIMIT;
    return fits
      ? []
      : [
          {
            layer: layer.id,
            path: [],
            line: null,
            code: "E_CONFIG_INVALID",
            message: "The updated file exceeds the 512 KiB limit.",
          },
        ];
  });
}

export async function assessConfigPatch(
  snapshot: ConfigSnapshot,
  patch: Patch,
  mode: "validate" | "apply" = "validate"
) {
  const initial = preparePatch(snapshot, patch);
  const { issues } = initial;
  const invalid = {
    files: initial.files,
    previews: {},
    prospective: snapshot,
    migration: null,
  };
  if (issues.some((issue) => issue.code === "E_CONFLICT")) {
    return { ...invalid, issues };
  }
  // Bound staged text before deriving a new selection from it.
  const sizeIssues = layerSizeIssues(snapshot, initial.files, false);
  if (sizeIssues.length > 0) {
    return { ...invalid, issues: [...issues, ...sizeIssues] };
  }
  const { migration, outputs, issue } =
    issues.length === 0
      ? await stageConfigMigration(snapshot, initial.files, mode)
      : { migration: null, outputs: null, issue: undefined };
  if (issue) {
    return { ...invalid, issues: [...issues, issue] };
  }
  const files = outputs
    ? prepareAfterMigration({ files: initial.files, outputs, patch, issues })
    : initial.files;
  const projectSizes = outputs ? layerSizeIssues(snapshot, files, false) : [];
  if (projectSizes.length > 0) {
    return { ...invalid, issues: [...issues, ...projectSizes] };
  }
  const prospective = await prospectiveSnapshot(snapshot, files);
  const privateOverlayIssue = await privateOverlayReplacementMessage({
    before: snapshot,
    after: prospective,
    projectText: files.get("1")?.text,
    outputs,
  });
  if (privateOverlayIssue) {
    return {
      ...invalid,
      issues: [
        ...issues,
        {
          layer: "1",
          path: ["env", "defaultOverlay"],
          line: null,
          code: "E_CONFIG_INVALID",
          message: privateOverlayIssue,
        } satisfies ConfigIssue,
      ],
    };
  }
  const envSizes = layerSizeIssues(prospective, files, true);
  if (envSizes.length > 0) {
    return { ...invalid, issues: [...issues, ...envSizes] };
  }
  const next = showConfigEditor(prospective);
  const previews = Object.fromEntries(
    next.layers
      .filter((layer) => files.has(layer.id) && layer.kind !== "env")
      .map(({ id, source }) => [id, source])
  );
  return {
    files,
    prospective,
    migration,
    previews,
    issues: [...issues, ...sourceIssues(files), ...next.issues],
  };
}

function layerDestination(layer: LayerSnapshot): string {
  return resolve(
    layer.directory?.path ?? dirname(layer.file),
    basename(layer.file)
  );
}

async function writesLocalEnvForMigration(
  projectRoot: string,
  inheritLocal: boolean,
  files: ReadonlyMap<string, Prepared>
): Promise<boolean> {
  const localFiles = [...files.values()].filter(
    ({ layer, env }) =>
      layer.kind === "env" && layer.ownership === "local" && env.length > 0
  );
  if (localFiles.some(({ env }) => env.some(({ op }) => op === "set"))) {
    return true;
  }
  // A linked unset writes a null override. It only needs a repair when the
  // destination is missing effective ignore coverage.
  if (inheritLocal) {
    for (const { layer } of localFiles) {
      if (
        (await isGitIgnoredProjectEnvPath({
          projectRoot,
          path: layerDestination(layer),
        })) !== true
      ) {
        return true;
      }
    }
  }
  return false;
}

async function stageConfigMigration(
  snapshot: ConfigSnapshot,
  files: Map<string, Prepared>,
  mode: "validate" | "apply"
): Promise<{
  migration: ImplicitEnvMigrationPlan | null;
  outputs: ReadonlyMap<string, string> | null;
  issue?: ConfigIssue;
}> {
  const env = [...files.values()].find(({ layer }) => layer.kind === "env");
  if (!env) {
    return { migration: null, outputs: null };
  }
  const { project } = snapshot;
  try {
    await assertConfigLayerDirectory(env.layer);
    const prospective = await prospectiveSnapshot(snapshot, files);
    const inheritLocal = prospective.layers.some(({ inherited }) => inherited);
    if (await projectEnvConfigExistsForMutation({ ...project, inheritLocal })) {
      return { migration: null, outputs: null };
    }
    const legacy = await readHackEnvContract(project);
    if (!legacy.exists) {
      return { migration: null, outputs: null };
    }
    if (legacy.parseError) {
      throw new ClosedCliError(
        "Fix the legacy env contract before saving env changes."
      );
    }
    const writesLocalEnv = await writesLocalEnvForMigration(
      project.projectRoot,
      inheritLocal,
      files
    );
    if (mode === "validate") {
      const outputs = await preflightLegacyEnvContract({
        ...project,
        contract: legacy.contract,
        projectText:
          snapshot.layers.find(
            ({ id, file }) =>
              id === "1" && basename(file) === "hack.config.json"
          )?.text ?? null,
        writesLocalEnv,
        maxLayerBytes: CONFIG_SOURCE_LIMIT,
      });
      await assertEnvMigrationConsent(project, [...outputs.keys()], false);
      return { migration: null, outputs };
    }
    const migration = await prepareImplicitEnvMigration(
      {
        ...project,
        projectName: snapshot.projectName,
        serviceNames: await discoverComposeServiceNames({
          composeFile: project.composeFile,
        }),
      },
      {
        writesLocalEnv,
        inheritLocal,
        edits: [...files.values()].map(({ layer }) => ({
          path: layerDestination(layer),
          text: layer.text,
        })),
      }
    );
    await assertConfigMigrationInputs(snapshot, migration);
    return {
      migration,
      outputs: new Map(
        migration.prepared.files.map(({ path }) => [
          path,
          migration.prepared.payload(path),
        ])
      ),
    };
  } catch (error) {
    const conflict = error instanceof AtomicWriteConflictError;
    return {
      migration: null,
      outputs: null,
      issue: {
        layer: env.layer.id,
        path: [],
        line: null,
        code: conflict ? "E_CONFLICT" : "E_CONFIG_INVALID",
        message: conflict
          ? "Changed outside Hack. Reload before saving."
          : configMigrationErrorMessage(error, snapshot.privateOverlays),
      },
    };
  }
}

function configMigrationErrorMessage(
  error: unknown,
  privateOverlays: ReadonlySet<string>
): string {
  if (!(error instanceof ClosedCliError || error instanceof HackCliError)) {
    return "Could not prepare the legacy env migration.";
  }
  let message = error.message;
  for (const name of [...privateOverlays].sort((a, b) => b.length - a.length)) {
    message = message.replaceAll(name, "[redacted]");
  }
  return message;
}

async function assertConfigMigrationInputs(
  snapshot: ConfigSnapshot,
  migration: ImplicitEnvMigrationPlan
) {
  // The patch can carry only the env base, but migration also uses the
  // project identity and the declared services from this snapshot.
  for (const layer of snapshot.layers.filter(
    ({ id }) => id === "1" || id === "2"
  )) {
    const observed = migration.sources.find(
      (source) => source.path === layerDestination(layer)
    );
    const expected =
      layer.text === null ? null : migrationDigest(Buffer.from(layer.text));
    const changed = observed
      ? observed.sha256 !== expected
      : (await readConfigLayer(layer.file)) !== layer.text;
    if (changed) {
      throw new AtomicWriteConflictError();
    }
  }
  const { prepared } = migration;
  for (const file of prepared.files) {
    if (
      ["layer", "local_layer", "config", "compose"].includes(file.kind) &&
      Buffer.byteLength(prepared.payload(file.path)) > CONFIG_SOURCE_LIMIT
    ) {
      throw new HackCliError({
        code: "E_CONFIG_INVALID",
        message: "A migrated config file exceeds the 512 KiB limit.",
      });
    }
  }
}

function prepareAfterMigration(opts: {
  readonly files: Map<string, Prepared>;
  readonly outputs: ReadonlyMap<string, string>;
  readonly patch: Patch;
  readonly issues: ConfigIssue[];
}): Map<string, Prepared> {
  for (const file of opts.files.values()) {
    const baseline = opts.outputs.get(layerDestination(file.layer));
    if (baseline === undefined) {
      continue;
    }
    const migrated = { ...file, layer: { ...file.layer, text: baseline } };
    opts.files.set(file.layer.id, migrated);
    if (file.source) {
      const text = mergeMigratedSource(file.layer.text, file.text, baseline);
      if (text === null) {
        opts.issues.push({
          layer: file.layer.id,
          path: [],
          line: null,
          code: "E_CONFIG_INVALID",
          message:
            "This Source edit and the env migration change the same setting.",
        });
      }
      migrated.text = text;
      continue;
    }
    migrated.text = baseline;
    for (const change of opts.patch.changes) {
      if (change.kind === "project" && change.layer === file.layer.id) {
        const issue = prepareProjectField(change, migrated);
        if (issue) {
          opts.issues.push(issue);
        }
      }
    }
  }
  return opts.files;
}

function mergeMigratedSource(
  original: string | null,
  draft: string | null,
  migrated: string
): string | null {
  if (!(original && draft)) {
    return null;
  }
  const edits: { path: string[]; value: unknown }[] = [];
  if (
    !collectMigrationSourceEdits(
      JSON.parse(original),
      JSON.parse(draft),
      JSON.parse(migrated),
      [],
      edits
    )
  ) {
    return null;
  }
  return edits.reduce(
    (text, edit) =>
      applyEdits(
        text,
        modify(text, edit.path, edit.value, {
          formattingOptions: { insertSpaces: true, tabSize: 2 },
        })
      ),
    draft
  );
}

function collectMigrationSourceEdits(
  original: unknown,
  edited: unknown,
  migrated: unknown,
  path: string[],
  edits: { path: string[]; value: unknown }[]
): boolean {
  if (
    isDeepStrictEqual(original, migrated) ||
    isDeepStrictEqual(edited, migrated)
  ) {
    return true;
  }
  if (isRecord(original) && isRecord(edited) && isRecord(migrated)) {
    return [
      ...new Set([...Object.keys(original), ...Object.keys(migrated)]),
    ].every((key) =>
      collectMigrationSourceEdits(
        ownJsonProperty(original, key),
        ownJsonProperty(edited, key),
        ownJsonProperty(migrated, key),
        [...path, key],
        edits
      )
    );
  }
  if (isDeepStrictEqual(original, edited)) {
    edits.push({ path, value: migrated });
    return true;
  }
  return false;
}

function ownJsonProperty(
  record: Record<string, unknown>,
  key: string
): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Validate a whole patch before effect and publish each affected file once. */
export async function applyConfigPatch(snapshot: ConfigSnapshot, patch: Patch) {
  const { files, issues, prospective, migration } = await assessConfigPatch(
    snapshot,
    patch,
    "apply"
  );
  const code = patchIssueCode(issues);
  if (code !== null) {
    throw new HackCliError({
      code,
      message: "Config could not be saved.",
      detail: { issues },
    });
  }
  const changed: string[] = [];
  try {
    await assertConfigBaseUnchanged(snapshot, patch.base);
    const manifestPath = migration
      ? await publishConfigMigration(snapshot, migration, changed)
      : null;
    const publication = {
      snapshot: prospective,
      files,
      changed,
      removedPrivateOverlays: removedPrivateOverlays(
        snapshot,
        prospective.privateOverlays
      ),
      originalInheritedDir: inheritedEnvDir(snapshot),
    };
    if (migration && manifestPath) {
      await withEnvMigrationConfigEdits({
        project: migration.project,
        manifestPath,
        run: (edits) => publishPreparedLayers(publication, edits),
      });
    } else {
      await publishPreparedLayers(publication);
    }
  } catch (error) {
    if (error instanceof AtomicWriteConflictError) {
      throw new HackCliError({
        code: "E_CONFLICT",
        message: "Changed outside Hack. Reload before saving.",
        detail: { changed },
      });
    }
    if (error instanceof HackCliError) {
      throw new HackCliError({
        code: error.code,
        message: "Could not write the selected config layer.",
        detail: { changed },
      });
    }
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message: "Could not write the selected config layer.",
      detail: { changed },
    });
  }
  return {
    schema: CONFIG_EDITOR_SCHEMA,
    changed,
    restart_offered:
      changed.includes("2") ||
      (changed.includes("1") &&
        patch.changes.some(
          (change) =>
            change.layer === "1" &&
            !(change.kind === "project" && change.path.startsWith("env."))
        )),
  };
}

async function assertConfigBaseUnchanged(
  snapshot: ConfigSnapshot,
  base: Patch["base"]
): Promise<void> {
  // Recheck every supplied dependency before the first commit. The
  // individual writers recheck again at their locked commit points.
  for (const layer of snapshot.layers) {
    if (base[layer.id] === undefined) {
      continue;
    }
    if (layer.directory && layer.ownership !== "generated") {
      await assertConfigLayerDirectory(layer);
    }
    if ((await readConfigLayer(layer.file)) !== layer.text) {
      throw new AtomicWriteConflictError();
    }
  }
}
async function publishPreparedLayers(
  opts: {
    readonly snapshot: ConfigSnapshot;
    readonly files: Map<string, Prepared>;
    readonly changed: string[];
    readonly removedPrivateOverlays: readonly string[];
    readonly originalInheritedDir: string | null;
  },
  edits?: {
    readonly prepare: (write: MigrationConfigWrite) => Promise<void>;
    readonly commit: (path: string) => Promise<void>;
  }
) {
  const { snapshot, files, changed } = opts;
  const ordered = [...files.values()];
  // Apply project policy before the env writer evaluates inheritance for unsets.
  for (const file of [
    ...ordered.filter((file) => file.layer.kind !== "env"),
    ...ordered.filter((file) => file.layer.kind === "env"),
  ]) {
    const path = layerDestination(file.layer);
    const beforePublish = edits
      ? (after: string, mode: number) =>
          edits.prepare({ path, before: file.layer.text, after, mode })
      : undefined;
    if (
      !(await writePreparedLayer(
        snapshot,
        file,
        beforePublish,
        opts.removedPrivateOverlays,
        opts.originalInheritedDir
      ))
    ) {
      continue;
    }
    if (!changed.includes(file.layer.id)) {
      changed.push(file.layer.id);
    }
    await edits?.commit(path);
  }
}

function inheritedEnvDir(snapshot: ConfigSnapshot): string | null {
  const inherited = snapshot.layers.find((layer) => layer.inherited);
  return inherited ? dirname(inherited.file) : null;
}

async function publishConfigMigration(
  snapshot: ConfigSnapshot,
  migration: ImplicitEnvMigrationPlan,
  changed: string[]
) {
  const projectLayer = snapshot.layers.find((layer) => layer.id === "1");
  if (!projectLayer) {
    throw new AtomicWriteConflictError();
  }
  const layerIds = migrationLayerIds(snapshot, migration);
  const result = await applyEnvMigration({
    project: migration.project,
    plan: migration,
    acceptTrackedChanges: false,
    snapshots: envMigrationSnapshots(),
    repairCompose: false,
    validateDestination: async () =>
      await assertConfigLayerDirectory(projectLayer),
    onPublished: ({ path }) => {
      const id = layerIds.get(path);
      if (id && !changed.includes(id)) {
        changed.push(id);
      }
    },
  });
  return result.manifestPath;
}

function migrationLayerIds(
  snapshot: ConfigSnapshot,
  migration: ImplicitEnvMigrationPlan
): Map<string, string> {
  const layers = new Map(
    snapshot.layers.map((layer) => [layerDestination(layer), layer.id])
  );
  for (const file of migration.prepared.files) {
    if (
      layers.has(file.path) ||
      (file.kind !== "layer" && file.kind !== "local_layer")
    ) {
      continue;
    }
    const stem = basename(file.path).slice("hack.env.".length, -".yaml".length);
    const local = file.kind === "local_layer";
    const overlay =
      local && stem.endsWith(".local") ? stem.slice(0, -".local".length) : stem;
    const id = local ? "5" : "3";
    const publicOverlay = isPrivateConfigOverlay(
      overlay,
      snapshot.privateOverlays
    )
      ? "[redacted]"
      : overlay;
    layers.set(
      file.path,
      ["local", "default"].includes(overlay) ? id : `${id}:${publicOverlay}`
    );
  }
  return layers;
}
function patchIssueCode(issues: readonly ConfigIssue[]): HackErrorCode | null {
  if (issues.length === 0) {
    return null;
  }
  for (const code of ["E_CONFLICT", "E_LAYER_READ_ONLY"] as const) {
    if (issues.some((issue) => issue.code === code)) {
      return code;
    }
  }
  return "E_CONFIG_INVALID";
}

async function writePreparedLayer(
  snapshot: ConfigSnapshot,
  file: Prepared,
  beforePublish: ((text: string, mode: number) => Promise<void>) | undefined,
  removedOverlayNames: readonly string[],
  originalInheritedDir: string | null
): Promise<boolean> {
  const { layer, text } = file;
  const validate = async () => {
    await assertConfigLayerDirectory(layer);
    await assertLegacyProjectDirectory({
      projectDir: snapshot.project.projectDir,
    });
    if (layer.kind === "env") {
      await assertConfigEnvReadable(
        snapshot.project.projectRoot,
        inheritedEnvDir(snapshot)
      );
    }
    if (
      layer.kind === "project" &&
      removedOverlayNames.length > 0 &&
      ((await privateOverlayFileConflict({
        projectDir: snapshot.project.projectDir,
        inheritedDirs: [originalInheritedDir, inheritedEnvDir(snapshot)],
        names: removedOverlayNames,
      })) ||
        (await legacyStoreMayContainOverlays(snapshot)))
    ) {
      throw new AtomicWriteConflictError();
    }
  };
  if (layer.kind === "env") {
    return (
      await mutateProjectEnvLayer({
        ...snapshot.project,
        envName: layer.overlay ?? null,
        local: layer.ownership === "local",
        changes: file.env,
        expected: { file: layer.file, text: layer.text, validate },
        beforePublish,
        repairGitignore: beforePublish === undefined,
        maxBytes: CONFIG_SOURCE_LIMIT,
      })
    ).changed;
  }
  if (text === null || text === layer.text) {
    return false;
  }
  await validate();
  return await withEnvLayerLock({
    layerPath: layer.file,
    run: async () =>
      (
        await writeTextFileAtomicIfChanged(layer.file, text, {
          expectedExisting: layer.text,
          validatePath: validate,
          beforePublish: beforePublish
            ? (mode) => beforePublish(text, mode)
            : undefined,
          noFollowTarget: true,
        })
      ).changed,
  });
}
