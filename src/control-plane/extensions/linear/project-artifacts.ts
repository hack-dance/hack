import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { YAML } from "bun";

import { isRecord } from "../../../lib/guards.ts";

export type LinearProjectArtifactKind =
  | "linear-project-document"
  | "linear-project-milestone"
  | "linear-project-status-update";

export type LinearProjectArtifactFamily =
  | "documents"
  | "milestones"
  | "status-updates";

export type LinearProjectStatusUpdateState = "draft" | "published";

type LinearProjectArtifactBase = {
  readonly kind: LinearProjectArtifactKind;
  readonly linearProjectId: string;
  readonly title: string;
  readonly linearId?: string;
  readonly slug?: string;
  readonly archived: boolean;
  readonly updatedAt?: string;
  readonly body: string;
};

export type LinearProjectArtifactSnapshot =
  | (LinearProjectArtifactBase & {
      readonly kind: "linear-project-document";
      readonly sortOrder?: number;
      readonly icon?: string;
    })
  | (LinearProjectArtifactBase & {
      readonly kind: "linear-project-milestone";
      readonly targetDate?: string;
      readonly state?: string;
      readonly sortOrder?: number;
    })
  | (LinearProjectArtifactBase & {
      readonly kind: "linear-project-status-update";
      readonly date?: string;
      readonly health?: string;
      readonly linkedMilestoneIds?: readonly string[];
    });

export type LocalLinearProjectArtifact = LinearProjectArtifactSnapshot & {
  readonly path: string;
};

export type LinearProjectArtifactPlan = {
  readonly errors: readonly string[];
  readonly create: readonly LocalLinearProjectArtifact[];
  readonly update: readonly {
    readonly local: LocalLinearProjectArtifact;
    readonly remote: LinearProjectArtifactSnapshot;
  }[];
  readonly noop: readonly {
    readonly local: LocalLinearProjectArtifact;
    readonly remote: LinearProjectArtifactSnapshot;
  }[];
  readonly remoteOnly: readonly LinearProjectArtifactSnapshot[];
};

const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---\n?/;
const YAML_EDGE_WHITESPACE_PATTERN = /^\s|\s$/;
const YAML_COMMENT_PATTERN = /(^|\s)#/;
const YAML_COLON_SPACE_PATTERN = /:\s/;
const YAML_PLAIN_SAFE_PATTERN = /^[A-Za-z_./][A-Za-z0-9_./ -]*$/;
const YAML_SPECIAL_CHARACTER_PATTERN = /[\n\r[\]{}&,*!|>'"%@`]/;
const YAML_RESERVED_LITERAL_PATTERN = /^(?:true|false|null|~)$/i;

/** Resolve the repo-backed root for all managed artifacts of a bound Linear project. */
export const resolveLinearProjectArtifactsRoot = ({
  projectDir,
  linearProjectId,
}: {
  readonly projectDir: string;
  readonly linearProjectId: string;
}): string => join(projectDir, ".hack/linear/projects", linearProjectId);

/** Resolve the canonical directory for a specific Linear project artifact family. */
export const resolveLinearProjectArtifactsFamilyRoot = ({
  projectDir,
  linearProjectId,
  family,
}: {
  readonly projectDir: string;
  readonly linearProjectId: string;
  readonly family: LinearProjectArtifactFamily;
}): string =>
  join(
    resolveLinearProjectArtifactsRoot({ projectDir, linearProjectId }),
    family
  );

/** Parse a repo-managed Markdown artifact into a normalized record for planning and sync. */
export const parseLinearProjectArtifactFile = ({
  filePath,
  text,
}: {
  readonly filePath: string;
  readonly text: string;
}): LocalLinearProjectArtifact => {
  const match = text.match(FRONTMATTER_PATTERN);
  if (!match) {
    throw new Error(`Missing YAML frontmatter in ${filePath}`);
  }

  const parsed = YAML.parse(match[1] ?? "") as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`Invalid YAML frontmatter in ${filePath}`);
  }

  const kind = parseKind(parsed.kind, filePath);
  const linearProjectId = readRequiredString({
    value: parsed.linearProjectId,
    key: "linearProjectId",
    filePath,
  });
  const title = readRequiredString({
    value: parsed.title,
    key: "title",
    filePath,
  });
  const body = text.slice(match[0].length);
  const base = {
    kind,
    linearProjectId,
    title,
    ...(typeof parsed.linearId === "string"
      ? { linearId: parsed.linearId }
      : {}),
    ...(typeof parsed.slug === "string" ? { slug: parsed.slug } : {}),
    archived: parsed.archived === true,
    ...(typeof parsed.updatedAt === "string"
      ? { updatedAt: parsed.updatedAt }
      : {}),
    body,
    path: filePath,
  } as const;

  if (kind === "linear-project-document") {
    return {
      ...base,
      ...(typeof parsed.sortOrder === "number"
        ? { sortOrder: parsed.sortOrder }
        : {}),
      ...(typeof parsed.icon === "string" ? { icon: parsed.icon } : {}),
    };
  }

  if (kind === "linear-project-milestone") {
    return {
      ...base,
      ...(typeof parsed.targetDate === "string"
        ? { targetDate: parsed.targetDate }
        : {}),
      ...(typeof parsed.state === "string" ? { state: parsed.state } : {}),
      ...(typeof parsed.sortOrder === "number"
        ? { sortOrder: parsed.sortOrder }
        : {}),
    };
  }

  return {
    ...base,
    ...(typeof parsed.date === "string" ? { date: parsed.date } : {}),
    ...(typeof parsed.health === "string" ? { health: parsed.health } : {}),
    ...(Array.isArray(parsed.linkedMilestoneIds)
      ? {
          linkedMilestoneIds: parsed.linkedMilestoneIds.filter(
            (value): value is string => typeof value === "string"
          ),
        }
      : {}),
  };
};

/** Serialize an artifact back to stable frontmatter + Markdown body for pull/apply workflows. */
export const serializeLinearProjectArtifactFile = ({
  artifact,
}: {
  readonly artifact: LocalLinearProjectArtifact;
}): string => {
  const lines = ["---", ...serializeCommonFrontmatter({ artifact })];
  lines.push(...serializeKindSpecificFrontmatter({ artifact }));
  lines.push("---");
  return `${lines.join("\n")}\n${artifact.body}`;
};

/** Compare local and remote artifact snapshots to produce explicit create/update/noop actions. */
export const planLinearProjectArtifactChanges = ({
  localArtifacts,
  remoteArtifacts,
}: {
  readonly localArtifacts: readonly LocalLinearProjectArtifact[];
  readonly remoteArtifacts: readonly LinearProjectArtifactSnapshot[];
}): LinearProjectArtifactPlan => {
  const errors = [
    ...detectLocalDuplicates({ artifacts: localArtifacts }),
    ...detectRemoteDuplicates({ artifacts: remoteArtifacts }),
  ];
  if (errors.length > 0) {
    return {
      errors,
      create: [],
      update: [],
      noop: [],
      remoteOnly: [],
    };
  }

  const remoteByKey = new Map<string, LinearProjectArtifactSnapshot>();
  const remoteBySlugKey = new Map<string, LinearProjectArtifactSnapshot>();
  const remoteByTitleKey = new Map<
    string,
    LinearProjectArtifactSnapshot | null
  >();
  for (const artifact of remoteArtifacts) {
    remoteByKey.set(buildArtifactKey({ artifact }), artifact);
    if (artifact.slug) {
      remoteBySlugKey.set(buildArtifactSlugKey({ artifact }), artifact);
    }
    const titleKey = buildArtifactTitleKey({ artifact });
    const existing = remoteByTitleKey.get(titleKey);
    remoteByTitleKey.set(titleKey, existing ? null : artifact);
  }

  const create: LocalLinearProjectArtifact[] = [];
  const update: {
    local: LocalLinearProjectArtifact;
    remote: LinearProjectArtifactSnapshot;
  }[] = [];
  const noop: {
    local: LocalLinearProjectArtifact;
    remote: LinearProjectArtifactSnapshot;
  }[] = [];
  const seenRemoteKeys = new Set<string>();

  for (const local of localArtifacts) {
    const key = buildArtifactKey({ artifact: local });
    const remote = remoteByKey.get(key);
    if (!remote) {
      const matchedRemote = findRemoteArtifactAliasMatch({
        artifact: local,
        remoteBySlugKey,
        remoteByTitleKey,
      });
      if (matchedRemote) {
        errors.push(
          `Local artifact ${local.path} matches remote linearId "${matchedRemote.linearId}" by slug/title. Pull first or add the remote linearId before apply.`
        );
        continue;
      }
      create.push(local);
      continue;
    }
    seenRemoteKeys.add(key);
    if (artifactsEqual({ local, remote })) {
      noop.push({ local, remote });
      continue;
    }
    update.push({ local, remote });
  }

  const remoteOnly = remoteArtifacts.filter(
    (artifact) => !seenRemoteKeys.has(buildArtifactKey({ artifact }))
  );

  if (errors.length > 0) {
    return {
      errors,
      create: [],
      update: [],
      noop: [],
      remoteOnly: [],
    };
  }

  return {
    errors,
    create,
    update,
    noop,
    remoteOnly,
  };
};

/** Load repo-managed Linear project artifacts from a file or directory target. */
export const loadLocalLinearProjectArtifacts = async ({
  projectDir,
  linearProjectId,
  family,
  path,
  ignoreParseErrors = false,
}: {
  readonly projectDir: string;
  readonly linearProjectId: string;
  readonly family: LinearProjectArtifactFamily;
  readonly path?: string;
  readonly ignoreParseErrors?: boolean;
}): Promise<readonly LocalLinearProjectArtifact[]> => {
  const targetPath =
    resolveArtifactInputPath({
      projectDir,
      linearProjectId,
      family,
      path,
    }) ??
    resolveLinearProjectArtifactsFamilyRoot({
      projectDir,
      linearProjectId,
      family,
    });

  const targetStat = await safeStat(targetPath);
  if (!targetStat) {
    return [];
  }

  const markdownPaths = targetStat.isFile()
    ? [targetPath]
    : await collectMarkdownFiles(targetPath);
  const loaded: LocalLinearProjectArtifact[] = [];

  for (const filePath of markdownPaths.sort((left, right) =>
    left.localeCompare(right)
  )) {
    const text = await Bun.file(filePath).text();
    let artifact: LocalLinearProjectArtifact;
    try {
      artifact = parseLinearProjectArtifactFile({ filePath, text });
    } catch (error) {
      if (ignoreParseErrors) {
        continue;
      }
      throw error;
    }
    if (artifact.linearProjectId !== linearProjectId) {
      continue;
    }
    if (resolveArtifactFamily({ kind: artifact.kind }) !== family) {
      continue;
    }
    loaded.push(artifact);
  }

  return loaded;
};

/** Convert a snapshot into a local repo-managed artifact with a canonical file path. */
export const materializeLocalLinearProjectArtifact = ({
  projectDir,
  artifact,
  statusUpdateState,
}: {
  readonly projectDir: string;
  readonly artifact: LinearProjectArtifactSnapshot;
  readonly statusUpdateState?: LinearProjectStatusUpdateState;
}): LocalLinearProjectArtifact => ({
  ...artifact,
  path: resolveLinearProjectArtifactPath({
    projectDir,
    artifact,
    statusUpdateState,
  }),
});

/** Resolve a canonical artifact file path for a local snapshot. */
export const resolveLinearProjectArtifactPath = ({
  projectDir,
  artifact,
  statusUpdateState,
}: {
  readonly projectDir: string;
  readonly artifact: LinearProjectArtifactSnapshot;
  readonly statusUpdateState?: LinearProjectStatusUpdateState;
}): string => {
  if (artifact.kind === "linear-project-status-update") {
    const datePart =
      artifact.date ?? artifact.updatedAt?.slice(0, 10) ?? "undated";
    const slug = normalizeArtifactSlug({
      slug: artifact.slug,
      title: artifact.title,
    });
    const state = statusUpdateState ?? "published";
    return join(
      resolveLinearProjectArtifactsFamilyRoot({
        projectDir,
        linearProjectId: artifact.linearProjectId,
        family: "status-updates",
      }),
      state === "draft" ? "drafts" : "published",
      `${datePart}-${slug}.md`
    );
  }

  const family = resolveArtifactFamily({ kind: artifact.kind });
  return join(
    resolveLinearProjectArtifactsFamilyRoot({
      projectDir,
      linearProjectId: artifact.linearProjectId,
      family,
    }),
    `${normalizeArtifactSlug({
      slug: artifact.slug,
      title: artifact.title,
    })}.md`
  );
};

/** Normalize an artifact title into a stable repo filename slug. */
export const slugifyLinearProjectArtifactTitle = ({
  title,
}: {
  readonly title: string;
}): string => normalizeArtifactSlug({ title });

const parseKind = (
  value: unknown,
  filePath: string
): LinearProjectArtifactKind => {
  if (
    value === "linear-project-document" ||
    value === "linear-project-milestone" ||
    value === "linear-project-status-update"
  ) {
    return value;
  }
  throw new Error(`Invalid or missing kind in ${filePath}`);
};

const resolveArtifactFamily = ({
  kind,
}: {
  readonly kind: LinearProjectArtifactKind;
}): LinearProjectArtifactFamily => {
  if (kind === "linear-project-document") {
    return "documents";
  }
  if (kind === "linear-project-milestone") {
    return "milestones";
  }
  return "status-updates";
};

const normalizeArtifactSlug = ({
  slug,
  title,
}: {
  readonly slug?: string;
  readonly title: string;
}): string => {
  const raw = (slug?.trim() || title.trim()).toLowerCase();
  const normalized = raw
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .replaceAll(/-{2,}/g, "-");
  return normalized || "untitled";
};

const resolveArtifactInputPath = ({
  projectDir,
  linearProjectId,
  family,
  path,
}: {
  readonly projectDir: string;
  readonly linearProjectId: string;
  readonly family: LinearProjectArtifactFamily;
  readonly path?: string;
}): string | null => {
  const candidate = path?.trim();
  if (!candidate) {
    return null;
  }
  if (isAbsolute(candidate)) {
    return candidate;
  }
  if (candidate.startsWith(".hack/")) {
    return resolve(projectDir, candidate);
  }
  return resolve(
    resolveLinearProjectArtifactsFamilyRoot({
      projectDir,
      linearProjectId,
      family,
    }),
    candidate
  );
};

const safeStat = async (
  path: string
): Promise<Awaited<ReturnType<typeof stat>> | null> => {
  try {
    return await stat(path);
  } catch {
    return null;
  }
};

const collectMarkdownFiles = async (root: string): Promise<string[]> => {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = join(root, entry.name);
      if (entry.isDirectory()) {
        return await collectMarkdownFiles(absolutePath);
      }
      if (entry.isFile() && absolutePath.endsWith(".md")) {
        return [absolutePath];
      }
      return [];
    })
  );
  return nested.flat();
};

const readRequiredString = ({
  value,
  key,
  filePath,
}: {
  readonly value: unknown;
  readonly key: string;
  readonly filePath: string;
}): string => {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  throw new Error(`Missing ${key} in ${filePath}`);
};

const serializeCommonFrontmatter = ({
  artifact,
}: {
  readonly artifact: LocalLinearProjectArtifact;
}): string[] => {
  const lines = [
    serializeFrontmatterValue({ key: "kind", value: artifact.kind }),
    serializeFrontmatterValue({
      key: "linearProjectId",
      value: artifact.linearProjectId,
    }),
    serializeFrontmatterValue({ key: "title", value: artifact.title }),
  ];

  if (artifact.linearId) {
    lines.push(
      serializeFrontmatterValue({ key: "linearId", value: artifact.linearId })
    );
  }
  if (artifact.slug) {
    lines.push(
      serializeFrontmatterValue({ key: "slug", value: artifact.slug })
    );
  }
  lines.push(
    serializeFrontmatterValue({ key: "archived", value: artifact.archived })
  );
  if (artifact.updatedAt) {
    lines.push(
      serializeFrontmatterValue({
        key: "updatedAt",
        value: artifact.updatedAt,
      })
    );
  }

  return lines;
};

const serializeKindSpecificFrontmatter = ({
  artifact,
}: {
  readonly artifact: LocalLinearProjectArtifact;
}): string[] => {
  if (artifact.kind === "linear-project-document") {
    return serializeDocumentFrontmatter({ artifact });
  }

  if (artifact.kind === "linear-project-milestone") {
    return serializeMilestoneFrontmatter({ artifact });
  }

  return serializeStatusUpdateFrontmatter({ artifact });
};

const serializeDocumentFrontmatter = ({
  artifact,
}: {
  readonly artifact: Extract<
    LocalLinearProjectArtifact,
    { readonly kind: "linear-project-document" }
  >;
}): string[] => {
  const lines: string[] = [];
  if (artifact.sortOrder !== undefined) {
    lines.push(
      serializeFrontmatterValue({ key: "sortOrder", value: artifact.sortOrder })
    );
  }
  if (artifact.icon) {
    lines.push(
      serializeFrontmatterValue({ key: "icon", value: artifact.icon })
    );
  }
  return lines;
};

const serializeMilestoneFrontmatter = ({
  artifact,
}: {
  readonly artifact: Extract<
    LocalLinearProjectArtifact,
    { readonly kind: "linear-project-milestone" }
  >;
}): string[] => {
  const lines: string[] = [];
  if (artifact.targetDate) {
    lines.push(
      serializeFrontmatterValue({
        key: "targetDate",
        value: artifact.targetDate,
      })
    );
  }
  if (artifact.state) {
    lines.push(
      serializeFrontmatterValue({ key: "state", value: artifact.state })
    );
  }
  if (artifact.sortOrder !== undefined) {
    lines.push(
      serializeFrontmatterValue({ key: "sortOrder", value: artifact.sortOrder })
    );
  }
  return lines;
};

const serializeStatusUpdateFrontmatter = ({
  artifact,
}: {
  readonly artifact: Extract<
    LocalLinearProjectArtifact,
    { readonly kind: "linear-project-status-update" }
  >;
}): string[] => {
  const lines: string[] = [];
  if (artifact.date) {
    lines.push(
      serializeFrontmatterValue({ key: "date", value: artifact.date })
    );
  }
  if (artifact.health) {
    lines.push(
      serializeFrontmatterValue({ key: "health", value: artifact.health })
    );
  }
  if (artifact.linkedMilestoneIds && artifact.linkedMilestoneIds.length > 0) {
    lines.push("linkedMilestoneIds:");
    for (const milestoneId of artifact.linkedMilestoneIds) {
      lines.push(`  - ${serializeYamlString({ value: milestoneId })}`);
    }
  }
  return lines;
};

const serializeFrontmatterValue = ({
  key,
  value,
}: {
  readonly key: string;
  readonly value: boolean | number | string;
}): string => `${key}: ${serializeYamlPrimitive({ value })}`;

const serializeYamlPrimitive = ({
  value,
}: {
  readonly value: boolean | number | string;
}): string => {
  if (typeof value === "string") {
    return serializeYamlString({ value });
  }
  return String(value);
};

const serializeYamlString = ({ value }: { readonly value: string }): string =>
  needsYamlQuoting({ value }) ? JSON.stringify(value) : value;

const needsYamlQuoting = ({ value }: { readonly value: string }): boolean =>
  value.length === 0 ||
  !YAML_PLAIN_SAFE_PATTERN.test(value) ||
  YAML_EDGE_WHITESPACE_PATTERN.test(value) ||
  YAML_COMMENT_PATTERN.test(value) ||
  YAML_COLON_SPACE_PATTERN.test(value) ||
  YAML_SPECIAL_CHARACTER_PATTERN.test(value) ||
  YAML_RESERVED_LITERAL_PATTERN.test(value);

const detectLocalDuplicates = ({
  artifacts,
}: {
  readonly artifacts: readonly LocalLinearProjectArtifact[];
}): string[] => {
  const errors: string[] = [];
  const seenLinearIds = new Map<string, string>();
  const seenSlugs = new Map<string, string>();

  for (const artifact of artifacts) {
    if (artifact.linearId) {
      const existing = seenLinearIds.get(artifact.linearId);
      if (existing) {
        errors.push(
          `Duplicate local linearId "${artifact.linearId}" in ${existing} and ${artifact.path}`
        );
      } else {
        seenLinearIds.set(artifact.linearId, artifact.path);
      }
    }

    if (artifact.slug) {
      const slugKey = `${artifact.kind}:${artifact.linearProjectId}:${artifact.slug}`;
      const existing = seenSlugs.get(slugKey);
      if (existing) {
        errors.push(
          `Duplicate local slug "${artifact.slug}" in ${existing} and ${artifact.path}`
        );
      } else {
        seenSlugs.set(slugKey, artifact.path);
      }
    }
  }

  return errors;
};

const detectRemoteDuplicates = ({
  artifacts,
}: {
  readonly artifacts: readonly LinearProjectArtifactSnapshot[];
}): string[] => {
  const errors: string[] = [];
  const seenKeys = new Set<string>();
  const seenSlugKeys = new Set<string>();
  for (const artifact of artifacts) {
    const key = buildArtifactKey({ artifact });
    if (seenKeys.has(key)) {
      errors.push(`Duplicate remote artifact mapping for ${key}`);
      continue;
    }
    seenKeys.add(key);

    if (artifact.slug) {
      const slugKey = buildArtifactSlugKey({ artifact });
      if (seenSlugKeys.has(slugKey)) {
        errors.push(`Duplicate remote artifact slug mapping for ${slugKey}`);
      } else {
        seenSlugKeys.add(slugKey);
      }
    }
  }
  return errors;
};

const findRemoteArtifactAliasMatch = ({
  artifact,
  remoteBySlugKey,
  remoteByTitleKey,
}: {
  readonly artifact: LocalLinearProjectArtifact;
  readonly remoteBySlugKey: ReadonlyMap<string, LinearProjectArtifactSnapshot>;
  readonly remoteByTitleKey: ReadonlyMap<
    string,
    LinearProjectArtifactSnapshot | null
  >;
}): LinearProjectArtifactSnapshot | null => {
  if (artifact.slug) {
    const matchedBySlug = remoteBySlugKey.get(
      buildArtifactSlugKey({ artifact })
    );
    if (matchedBySlug?.linearId) {
      return matchedBySlug;
    }
  }

  const matchedByTitle = remoteByTitleKey.get(
    buildArtifactTitleKey({ artifact })
  );
  if (matchedByTitle?.linearId) {
    return matchedByTitle;
  }

  return null;
};

const buildArtifactKey = ({
  artifact,
}: {
  readonly artifact: LinearProjectArtifactSnapshot;
}): string => {
  if (artifact.linearId) {
    return `${artifact.kind}:id:${artifact.linearId}`;
  }
  if (artifact.slug) {
    return `${artifact.kind}:slug:${artifact.linearProjectId}:${artifact.slug}`;
  }
  return `${artifact.kind}:title:${artifact.linearProjectId}:${artifact.title}`;
};

const buildArtifactSlugKey = ({
  artifact,
}: {
  readonly artifact: Pick<
    LinearProjectArtifactSnapshot,
    "kind" | "linearProjectId" | "slug"
  >;
}): string =>
  `${artifact.kind}:slug:${artifact.linearProjectId}:${artifact.slug}`;

const buildArtifactTitleKey = ({
  artifact,
}: {
  readonly artifact: Pick<
    LinearProjectArtifactSnapshot,
    "kind" | "linearProjectId" | "title"
  >;
}): string =>
  `${artifact.kind}:title:${artifact.linearProjectId}:${artifact.title}`;

const artifactsEqual = ({
  local,
  remote,
}: {
  readonly local: LocalLinearProjectArtifact;
  readonly remote: LinearProjectArtifactSnapshot;
}): boolean =>
  JSON.stringify(normalizeArtifactForComparison({ artifact: local })) ===
  JSON.stringify(normalizeArtifactForComparison({ artifact: remote }));

const normalizeArtifactForComparison = ({
  artifact,
}: {
  readonly artifact: LinearProjectArtifactSnapshot;
}): Record<
  string,
  string | number | boolean | readonly string[] | undefined
> => {
  const base = {
    kind: artifact.kind,
    linearProjectId: artifact.linearProjectId,
    title: artifact.title,
    linearId: artifact.linearId,
    slug: artifact.slug,
    archived: artifact.archived,
    body: artifact.body,
  };

  if (artifact.kind === "linear-project-document") {
    return {
      ...base,
      sortOrder: artifact.sortOrder,
      icon: artifact.icon,
    };
  }

  if (artifact.kind === "linear-project-milestone") {
    return {
      ...base,
      targetDate: artifact.targetDate,
      state: artifact.state,
      sortOrder: artifact.sortOrder,
    };
  }

  return {
    ...base,
    date: artifact.date,
    health: artifact.health,
    linkedMilestoneIds: artifact.linkedMilestoneIds,
  };
};
