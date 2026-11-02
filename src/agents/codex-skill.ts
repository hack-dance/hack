import { resolve } from "node:path";

import { readOptionalTextFile } from "../lib/fs.ts";
import {
  checkHackInitSkill,
  installHackInitSkill,
  removeHackInitSkill,
} from "./hack-init-skill.ts";
import {
  normalizeInstructionText,
  renderInstructionSections,
} from "./instruction-source.ts";
import {
  type IntegrationPreservedReason,
  installOwnedIntegrationFile,
  removeOwnedIntegrationFile,
} from "./integration-ownership.ts";

export type CodexSkillScope = "project" | "user";

export type CodexSkillResult = {
  readonly scope: CodexSkillScope;
  readonly status:
    | "created"
    | "updated"
    | "noop"
    | "stale"
    | "removed"
    | "missing"
    | "preserved"
    | "error";
  readonly path: string;
  readonly message?: string;
  /** Set with `preserved`: why an existing file was left unchanged. */
  readonly reason?: IntegrationPreservedReason;
};

const SKILL_NAME = "hack-cli";
const SKILL_FILENAME = "SKILL.md";
const SKILL_DIR = ".codex/skills";
const HACK_CLI_MARKER_REGEX = /name:\s*hack-cli\b/i;

/**
 * Install or update the Codex skills for hack usage.
 *
 * Writes the main `hack-cli` skill and the companion `/hack-init` onboarding
 * skill. The returned path points at the main skill; the status reflects both
 * artifacts (any change reports as created/updated).
 *
 * Each file is overwritten only when Hack owns it. If either file is edited or
 * foreign, it is left unchanged and the result is `preserved` with that file's
 * path and reason; the other file is still installed.
 */
export async function installCodexSkill(opts: {
  readonly scope: CodexSkillScope;
  readonly projectRoot?: string;
}): Promise<CodexSkillResult> {
  const resolved = resolveCodexSkillPath(opts);
  if (!resolved.ok) {
    return {
      scope: opts.scope,
      status: "error",
      path: resolved.path ?? SKILL_FILENAME,
      message: resolved.message,
    };
  }

  const path = resolved.path;
  const outcome = await installOwnedIntegrationFile({
    surface: "hack-cli-skill",
    path,
    render: renderCodexSkill(),
  });

  const initResult = await installHackInitSkill({
    client: "codex",
    scope: opts.scope,
    projectRoot: opts.projectRoot,
  });
  if (initResult.status === "error") {
    return {
      scope: opts.scope,
      status: "error",
      path: initResult.path,
      message: initResult.message,
    };
  }

  if (outcome.status === "preserved") {
    return {
      scope: opts.scope,
      status: "preserved",
      path,
      reason: outcome.reason,
      message: outcome.message,
    };
  }
  if (initResult.status === "preserved") {
    return {
      scope: opts.scope,
      status: "preserved",
      path: initResult.path,
      reason: initResult.reason,
      message: initResult.message,
    };
  }

  const initChanged =
    initResult.status === "created" || initResult.status === "updated";
  return {
    scope: opts.scope,
    status: resolveInstallStatus({ main: outcome.status, initChanged }),
    path,
  };
}

/**
 * Check whether the Codex skill is installed and current.
 *
 * Reports `stale` when the skill file exists but its content no longer
 * matches the current render (normalized comparison).
 */
export async function checkCodexSkill(opts: {
  readonly scope: CodexSkillScope;
  readonly projectRoot?: string;
}): Promise<CodexSkillResult> {
  const resolved = resolveCodexSkillPath(opts);
  if (!resolved.ok) {
    return {
      scope: opts.scope,
      status: "error",
      path: resolved.path ?? SKILL_FILENAME,
      message: resolved.message,
    };
  }

  const path = resolved.path;
  const file = await readOptionalTextFile(path);
  if (file.kind === "unreadable") {
    return {
      scope: opts.scope,
      status: "error",
      path,
      message: "Hack-managed file exists but could not be read.",
    };
  }
  const content = file.kind === "text" ? file.text : "";
  if (!content) {
    return { scope: opts.scope, status: "missing", path };
  }

  if (!HACK_CLI_MARKER_REGEX.test(content)) {
    return { scope: opts.scope, status: "error", path };
  }

  const current = normalizeInstructionText({ text: renderCodexSkill() });
  if (normalizeInstructionText({ text: content }) !== current) {
    return {
      scope: opts.scope,
      status: "stale",
      path,
      message: "Codex skill content is out of date. Run: hack setup codex",
    };
  }

  const initResult = await checkHackInitSkill({
    client: "codex",
    scope: opts.scope,
    projectRoot: opts.projectRoot,
  });
  if (initResult.status !== "noop") {
    return {
      scope: opts.scope,
      status: initResult.status === "error" ? "error" : "stale",
      path: initResult.path,
      message:
        initResult.message ??
        "hack-init skill is missing or out of date. Run: hack setup codex",
    };
  }

  return { scope: opts.scope, status: "noop", path };
}

/**
 * Remove the Codex skills for hack CLI usage.
 *
 * Deletes only Hack-owned SKILL.md files and removes each skill directory only
 * when it is empty afterwards. Edited or foreign files are left unchanged and
 * reported as `preserved`.
 */
export async function removeCodexSkill(opts: {
  readonly scope: CodexSkillScope;
  readonly projectRoot?: string;
}): Promise<CodexSkillResult> {
  const resolved = resolveCodexSkillPath(opts);
  if (!resolved.ok) {
    return {
      scope: opts.scope,
      status: "error",
      path: resolved.path ?? SKILL_FILENAME,
      message: resolved.message,
    };
  }

  const path = resolved.path;

  const initResult = await removeHackInitSkill({
    client: "codex",
    scope: opts.scope,
    projectRoot: opts.projectRoot,
  });
  const outcome = await removeOwnedIntegrationFile({
    surface: "hack-cli-skill",
    path,
    currentRender: renderCodexSkill(),
    removeEmptyDirectory: true,
  });

  if (outcome.status === "preserved") {
    return {
      scope: opts.scope,
      status: "preserved",
      path,
      reason: outcome.reason,
      message: outcome.message,
    };
  }
  if (initResult.status === "preserved" || initResult.status === "error") {
    return {
      scope: opts.scope,
      status: initResult.status,
      path: initResult.path,
      reason: initResult.reason,
      message: initResult.message,
    };
  }
  if (outcome.status === "missing") {
    const status = initResult.status === "removed" ? "removed" : "missing";
    return { scope: opts.scope, status, path };
  }
  return {
    scope: opts.scope,
    status: "removed",
    path,
    ...(outcome.message ? { message: outcome.message } : {}),
  };
}

/**
 * Render the Codex skill template for hack CLI usage.
 *
 * Frontmatter and top-level framing live here; the instructional content is
 * the `skill`-tagged sections from the shared instruction source. Standalone
 * installs ship no focused skills, so this variant keeps broad routing.
 */
export function renderCodexSkill(): string {
  return renderHackCliSkill({
    descriptionLines: [
      "description: >",
      "  Use the hack CLI for local runtime orchestration (compose, DNS/TLS, logs, env, persistent project workspaces) and agent setup.",
      "  Trigger when asked to run/start/stop services, inspect logs, manage lifecycle/workspace workflows, or update",
      "  agent integrations. Prefer CLI over MCP when shell access is available.",
    ],
  });
}

/**
 * Render the `hack-cli` SKILL.md with the given frontmatter description
 * lines. The standalone and plugin variants share the body; only routing
 * differs.
 */
export function renderHackCliSkill(opts: {
  readonly descriptionLines: readonly string[];
}): string {
  const lines = [
    "---",
    "name: hack-cli",
    ...opts.descriptionLines,
    "---",
    "",
    "# hack CLI",
    "",
    "Use `hack` as the primary interface for local-first development.",
    "",
    renderInstructionSections({ surface: "skill", headingStyle: "markdown" }),
    "",
  ];

  return lines.join("\n");
}

function resolveCodexSkillPath(opts: {
  readonly scope: CodexSkillScope;
  readonly projectRoot?: string;
}):
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly message: string; readonly path?: string } {
  if (opts.scope === "project" && !opts.projectRoot) {
    return {
      ok: false,
      message: "Missing project root for project-scoped Codex skill.",
    };
  }

  const root = opts.scope === "user" ? resolveHomeDir() : opts.projectRoot;
  if (!root) {
    return {
      ok: false,
      message: "HOME is not set; cannot resolve Codex skill path.",
    };
  }

  return {
    ok: true,
    path: resolve(root, SKILL_DIR, SKILL_NAME, SKILL_FILENAME),
  };
}

function resolveHomeDir(): string | null {
  const home = (process.env.HOME ?? "").trim();
  return home.length > 0 ? home : null;
}

function resolveInstallStatus(opts: {
  readonly main: "created" | "updated" | "noop";
  readonly initChanged: boolean;
}): "created" | "updated" | "noop" {
  if (opts.main !== "noop" || !opts.initChanged) {
    return opts.main;
  }
  return "updated";
}
