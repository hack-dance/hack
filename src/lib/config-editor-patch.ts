import { applyEdits, findNodeAtLocation, modify } from "jsonc-parser";
import { z } from "zod";
import { HackCliError, type HackErrorCode } from "./cli-result.ts";
import {
  type ConfigIssue,
  changeComposeRoute,
  editableComposeField,
  parseComposeSource,
  parseRouteAddress,
  validComposeShortPort,
  validHost,
  validPort,
} from "./config-editor-compose.ts";
import {
  CONFIG_EDITOR_SCHEMA,
  CONFIG_SOURCE_LIMIT,
  type ConfigSnapshot,
  type LayerSnapshot,
  patchedBaseHosts,
  readConfigLayer,
  showConfigEditor,
} from "./config-editor-model.ts";
import {
  configLine,
  isConfigSecret,
  jsonConfigTree,
  restoreConfigSource,
} from "./config-editor-source.ts";
import { withEnvLayerLock } from "./env-layer-lock.ts";
import {
  AtomicWriteConflictError,
  writeTextFileAtomicIfChanged,
} from "./fs.ts";
import { isRecord } from "./guards.ts";
import {
  ENV_CONFIG_NAME_MAX_LENGTH,
  normalizeEnvConfigName,
  parseProjectConfigRecord,
} from "./project.ts";
import {
  isValidProjectEnvScopeName,
  mutateProjectEnvLayer,
  type ProjectEnvLayerChange,
  projectEnvLayerFits,
} from "./project-env-config.ts";
import { assertLegacyProjectDirectory } from "./project-input-selection.ts";

const BASE_REV = /^[a-f0-9]{64}$/;
const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;
const SERVICE = /^[\w.-]+$/;
const HOSTS = /[\s,]+/;
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
  return { layer: change.layer, path, message, code, line };
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
    normalizeEnvConfigName(value) !== value
  ) {
    return "Use a lowercase overlay name with letters, digits and dashes.";
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
          ? validComposeShortPort(value)
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
    source.doc.setIn(path, change.value);
    file.text = source.doc.toString({ lineWidth: 0 });
    return null;
  } catch {
    return configIssue(change, path, "Edit this service in Source.");
  }
}

function invalidJsonSourceLine(text: string): number | null {
  const tree = jsonConfigTree(text);
  return tree.ok ? null : configLine(text, tree.error?.offset ?? 0);
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
  const invalidLine = json
    ? invalidJsonSourceLine(change.text)
    : parseComposeSource(change.text).invalid;
  if (invalidLine !== null) {
    return configIssue(
      change,
      [],
      json ? "Expected a valid JSON object." : "Expected valid Compose YAML.",
      "E_CONFIG_PARSE",
      invalidLine
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
        layer: id,
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

function prospectiveSnapshot(
  snapshot: ConfigSnapshot,
  files: Map<string, Prepared>
) {
  const layers = snapshot.layers.map((layer) => {
    const file = files.get(layer.id);
    return file ? { ...layer, text: file.text } : layer;
  });
  const project = files.get("1");
  if (!(project?.text && jsonConfigTree(project.text).ok)) {
    return { ...snapshot, layers };
  }
  const parsed: unknown = JSON.parse(project.text);
  const baseHosts = isRecord(parsed)
    ? patchedBaseHosts(parsed, project.layer.file, snapshot.hostFallback)
    : snapshot.baseHosts;
  return { ...snapshot, layers, baseHosts };
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

function layerSizeIssues(
  snapshot: ConfigSnapshot,
  files: Map<string, Prepared>
): ConfigIssue[] {
  const inheritsLocal = snapshot.layers.some((layer) => layer.inherited);
  return [...files.values()].flatMap(({ layer, text, env }) => {
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

export function assessConfigPatch(snapshot: ConfigSnapshot, patch: Patch) {
  const { files, issues } = preparePatch(snapshot, patch);
  if (issues.some((issue) => issue.code === "E_CONFLICT")) {
    return { files, issues, previews: {} };
  }
  const sizeIssues = layerSizeIssues(snapshot, files);
  if (sizeIssues.length > 0) {
    return { files, issues: [...issues, ...sizeIssues], previews: {} };
  }
  const next = showConfigEditor(prospectiveSnapshot(snapshot, files));
  const previews = Object.fromEntries(
    next.layers
      .filter((layer) => files.has(layer.id) && layer.kind !== "env")
      .map(({ id, source }) => [id, source])
  );
  return {
    files,
    previews,
    issues: [...issues, ...sourceIssues(files), ...next.issues],
  };
}

/** Validate a whole patch before effect and publish each affected file once. */
export async function applyConfigPatch(snapshot: ConfigSnapshot, patch: Patch) {
  const { files, issues } = assessConfigPatch(snapshot, patch);
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
    // Preflight every compared file before the first commit. Writers also
    // recheck the actual bytes inside their per-file lock at commit time.
    for (const layer of snapshot.layers) {
      if (
        patch.base[layer.id] !== undefined &&
        layer.active &&
        (await readConfigLayer(layer.file)) !== layer.text
      ) {
        throw new AtomicWriteConflictError();
      }
    }
    for (const file of files.values()) {
      const didChange = await writePreparedLayer(snapshot, file);
      if (didChange) {
        changed.push(file.layer.id);
      }
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
  file: Prepared
): Promise<boolean> {
  const { layer, text } = file;
  if (layer.kind === "env") {
    return (
      await mutateProjectEnvLayer({
        ...snapshot.project,
        envName: layer.overlay ?? null,
        local: layer.ownership === "local",
        changes: file.env,
        expected: { file: layer.file, text: layer.text },
        maxBytes: CONFIG_SOURCE_LIMIT,
      })
    ).changed;
  }
  if (text === null || text === layer.text) {
    return false;
  }
  const validate = async () =>
    await assertLegacyProjectDirectory({
      projectDir: snapshot.project.projectDir,
    });
  await validate();
  return await withEnvLayerLock({
    layerPath: layer.file,
    run: async () =>
      (
        await writeTextFileAtomicIfChanged(layer.file, text, {
          expectedExisting: layer.text,
          validatePath: validate,
          noFollowTarget: true,
        })
      ).changed,
  });
}
