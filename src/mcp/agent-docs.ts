import { resolve } from "node:path";

import {
  normalizeInstructionText,
  renderInstructionSections,
} from "../agents/instruction-source.ts";
import { pathExists, readTextFile, writeTextFileIfChanged } from "../lib/fs.ts";

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
      const existing = await readTextFile(path);
      if (!existing) {
        results.push({ target, status: "missing", path });
        continue;
      }

      if (!hasAgentDocSnippet({ content: existing })) {
        results.push({
          target,
          status: "error",
          path,
          message: "Missing hack agent-docs markers.",
        });
        continue;
      }

      const region = extractSnippetRegion({ content: existing });
      if (region === null) {
        results.push({
          target,
          status: "error",
          path,
          message: "Malformed hack agent-docs markers.",
        });
        continue;
      }

      if (normalizeInstructionText({ text: region }) !== expected) {
        results.push({
          target,
          status: "stale",
          path,
          message:
            "hack agent-docs content is out of date. Run: hack setup sync",
        });
        continue;
      }

      results.push({ target, status: "present", path });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to read file";
      results.push({ target, status: "error", path, message });
    }
  }

  return results;
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

function hasAgentDocSnippet(opts: { readonly content: string }): boolean {
  return (
    opts.content.includes(DOC_MARKER_START) &&
    opts.content.includes(DOC_MARKER_END)
  );
}

function escapeRegex(opts: { readonly value: string }): string {
  return opts.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ensureTrailingNewline(opts: { readonly text: string }): string {
  return opts.text.endsWith("\n") ? opts.text : `${opts.text}\n`;
}
