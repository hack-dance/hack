import { resolve } from "node:path";

import {
  normalizeInstructionText,
  renderInstructionSections,
} from "../agents/instruction-source.ts";
import {
  pathExists,
  readOptionalTextFile,
  readTextFile,
  writeTextFileIfChanged,
} from "../lib/fs.ts";

export type AgentDocTarget = "agents" | "claude";

export type AgentDocUpdateResult = {
  readonly target: AgentDocTarget;
  readonly status: "created" | "updated" | "noop" | "error";
  readonly path: string;
  readonly message?: string;
};

export type AgentDocCheckResult = {
  readonly target: AgentDocTarget;
  readonly status: "present" | "stale" | "missing" | "error";
  readonly path: string;
  readonly message?: string;
  /**
   * Set only when the file is readable and carries neither Hack marker, so it
   * is a user-owned doc without a Hack-managed section. A doc with exactly one
   * marker is a corrupted managed section and is never `unmanaged`.
   */
  readonly unmanaged?: true;
  /**
   * Set only when the Hack markers are present but do not form one
   * start-before-end pair, so the managed section cannot be located safely.
   */
  readonly malformed?: true;
};

export type AgentDocRemoveResult = {
  readonly target: AgentDocTarget;
  readonly status: "removed" | "noop" | "error";
  readonly path: string;
  readonly message?: string;
};

const DOC_MARKER_START = "<!-- hack:agent-docs:start -->";
const DOC_MARKER_END = "<!-- hack:agent-docs:end -->";

/**
 * Upsert hack usage instructions into AGENTS.md / CLAUDE.md for a project.
 */
export async function upsertAgentDocs(opts: {
  readonly projectRoot: string;
  readonly targets: readonly AgentDocTarget[];
}): Promise<AgentDocUpdateResult[]> {
  const results: AgentDocUpdateResult[] = [];
  const snippet = renderAgentDocsSnippet();

  for (const target of opts.targets) {
    const path = resolveAgentDocPath({ projectRoot: opts.projectRoot, target });
    try {
      const existed = await pathExists(path);
      const existing = (await readTextFile(path)) ?? "";
      const next = upsertSnippet({ existing, snippet });
      const result = await writeTextFileIfChanged(path, next);
      const status = resolveUpsertStatus({ changed: result.changed, existed });
      results.push({ target, status, path });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to update file";
      results.push({ target, status: "error", path, message });
    }
  }

  return results;
}

/**
 * Detect which agent doc files already exist in a project.
 */
export async function getExistingAgentDocs(opts: {
  readonly projectRoot: string;
}): Promise<AgentDocTarget[]> {
  const targets: AgentDocTarget[] = [];
  const agentsPath = resolveAgentDocPath({
    projectRoot: opts.projectRoot,
    target: "agents",
  });
  const claudePath = resolveAgentDocPath({
    projectRoot: opts.projectRoot,
    target: "claude",
  });

  if (await pathExists(agentsPath)) {
    targets.push("agents");
  }
  if (await pathExists(claudePath)) {
    targets.push("claude");
  }

  return targets;
}

/**
 * Check whether agent docs include the current hack snippet.
 *
 * Reports `stale` when the markers exist but the wrapped content no longer
 * matches the current render (normalized comparison), so `setup sync --check`
 * can flag content drift and an explicit sync can repair it.
 */
export async function checkAgentDocs(opts: {
  readonly projectRoot: string;
  readonly targets: readonly AgentDocTarget[];
}): Promise<AgentDocCheckResult[]> {
  const results: AgentDocCheckResult[] = [];
  const expected = normalizeInstructionText({
    text: renderAgentDocsSnippet(),
  });

  for (const target of opts.targets) {
    const path = resolveAgentDocPath({ projectRoot: opts.projectRoot, target });
    try {
      results.push(await checkAgentDocTarget({ target, path, expected }));
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to read file";
      results.push({ target, status: "error", path, message });
    }
  }

  return results;
}

/**
 * Classify one agent doc. Absent or empty docs are `missing`; an unreadable
 * doc is `error`; a readable doc with neither Hack marker is a user-owned
 * `unmanaged` error; a doc with only one marker is a corrupted (managed)
 * section and is `error` without `unmanaged`.
 */
async function checkAgentDocTarget(opts: {
  readonly target: AgentDocTarget;
  readonly path: string;
  readonly expected: string;
}): Promise<AgentDocCheckResult> {
  const { target, path } = opts;
  const file = await readOptionalTextFile(path);
  if (file.kind === "unreadable") {
    return {
      target,
      status: "error",
      path,
      message: "Agent doc exists but could not be read.",
    };
  }
  const existing = file.kind === "text" ? file.text : "";
  if (!existing) {
    return { target, status: "missing", path };
  }

  const markers = inspectAgentDocMarkers({ content: existing });
  if (!(markers.hasStart || markers.hasEnd)) {
    return {
      target,
      status: "error",
      path,
      message: "Missing hack agent-docs markers.",
      unmanaged: true,
    };
  }
  if (!(markers.hasStart && markers.hasEnd)) {
    return {
      target,
      status: "error",
      path,
      message:
        "Malformed hack agent-docs markers: only one of the start/end markers is present.",
      malformed: true,
    };
  }

  const region = extractSnippetRegion({ content: existing });
  if (region === null) {
    return {
      target,
      status: "error",
      path,
      message: "Malformed hack agent-docs markers.",
      malformed: true,
    };
  }
  if (normalizeInstructionText({ text: region }) !== opts.expected) {
    return {
      target,
      status: "stale",
      path,
      message: "hack agent-docs content is out of date. Run: hack setup sync",
    };
  }
  return { target, status: "present", path };
}

/**
 * Remove the hack snippet from agent docs.
 */
export async function removeAgentDocs(opts: {
  readonly projectRoot: string;
  readonly targets: readonly AgentDocTarget[];
}): Promise<AgentDocRemoveResult[]> {
  const results: AgentDocRemoveResult[] = [];

  for (const target of opts.targets) {
    const path = resolveAgentDocPath({ projectRoot: opts.projectRoot, target });
    try {
      const existing = await readTextFile(path);
      if (!existing) {
        results.push({ target, status: "noop", path });
        continue;
      }

      const next = removeSnippet({ existing });
      if (next === existing) {
        results.push({ target, status: "noop", path });
        continue;
      }

      await writeTextFileIfChanged(path, next);
      results.push({ target, status: "removed", path });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to update file";
      results.push({ target, status: "error", path, message });
    }
  }

  return results;
}

/**
 * Render the hack usage snippet for agent-facing docs.
 *
 * Content comes from the shared instruction source so AGENTS.md/CLAUDE.md
 * cannot drift from the other generated surfaces.
 */
export function renderAgentDocsSnippet(): string {
  const lines = [
    DOC_MARKER_START,
    "## hack CLI (local dev + MCP)",
    "",
    "Use `hack` as the single interface for local-first runtime orchestration (compose, DNS/TLS, logs, env, and persistent project workspaces).",
    "",
    renderInstructionSections({ surface: "docs", headingStyle: "plain" }),
    DOC_MARKER_END,
    "",
  ];

  return lines.join("\n");
}

export function resolveAgentDocPath(opts: {
  readonly projectRoot: string;
  readonly target: AgentDocTarget;
}): string {
  return resolve(
    opts.projectRoot,
    resolveAgentDocFilename({ target: opts.target })
  );
}

function resolveAgentDocFilename(opts: {
  readonly target: AgentDocTarget;
}): string {
  return opts.target === "agents" ? "AGENTS.md" : "CLAUDE.md";
}

function resolveUpsertStatus(opts: {
  readonly changed: boolean;
  readonly existed: boolean;
}): "created" | "updated" | "noop" {
  if (!opts.changed) {
    return "noop";
  }
  return opts.existed ? "updated" : "created";
}

function upsertSnippet(opts: {
  readonly existing: string;
  readonly snippet: string;
}): string {
  const pattern = new RegExp(
    `${escapeRegex({ value: DOC_MARKER_START })}[\\s\\S]*?${escapeRegex({ value: DOC_MARKER_END })}`
  );

  if (pattern.test(opts.existing)) {
    const replaced = opts.existing.replace(pattern, opts.snippet.trimEnd());
    return ensureTrailingNewline({ text: replaced });
  }

  const trimmed = opts.existing.trimEnd();
  if (trimmed.length === 0) {
    return opts.snippet;
  }
  return ensureTrailingNewline({
    text: `${trimmed}\n\n${opts.snippet.trimEnd()}`,
  });
}

function removeSnippet(opts: { readonly existing: string }): string {
  const pattern = new RegExp(
    `${escapeRegex({ value: DOC_MARKER_START })}[\\s\\S]*?${escapeRegex({ value: DOC_MARKER_END })}\\s*\\n?`,
    "m"
  );

  if (!pattern.test(opts.existing)) {
    return opts.existing;
  }

  const replaced = opts.existing.replace(pattern, "").trimEnd();
  if (replaced.length === 0) {
    return "";
  }
  return ensureTrailingNewline({ text: replaced.replace(/\n{3,}/g, "\n\n") });
}

function extractSnippetRegion(opts: {
  readonly content: string;
}): string | null {
  const pattern = new RegExp(
    `${escapeRegex({ value: DOC_MARKER_START })}[\\s\\S]*?${escapeRegex({ value: DOC_MARKER_END })}`
  );
  const match = opts.content.match(pattern);
  return match ? match[0] : null;
}

function inspectAgentDocMarkers(opts: { readonly content: string }): {
  readonly hasStart: boolean;
  readonly hasEnd: boolean;
} {
  return {
    hasStart: opts.content.includes(DOC_MARKER_START),
    hasEnd: opts.content.includes(DOC_MARKER_END),
  };
}

function escapeRegex(opts: { readonly value: string }): string {
  return opts.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ensureTrailingNewline(opts: { readonly text: string }): string {
  return opts.text.endsWith("\n") ? opts.text : `${opts.text}\n`;
}
