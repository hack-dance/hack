import { resolve } from "node:path";

import { readOptionalTextFile } from "../lib/fs.ts";
import { renderCodexSkill } from "./codex-skill.ts";
import { normalizeInstructionText } from "./instruction-source.ts";
import {
  type IntegrationPreservedReason,
  installOwnedIntegrationFile,
  removeOwnedIntegrationFile,
} from "./integration-ownership.ts";

export type SharedSkillResult = {
  readonly status:
    | "created"
    | "updated"
    | "noop"
    | "absent"
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

const SHARED_SKILLS_DIR = ".ai/skills";
const HACK_CLI_SKILL_NAME = "hack-cli";
const SKILL_FILENAME = "SKILL.md";
const HACK_CLI_MARKER = /name:\s*hack-cli\b/i;

/**
 * Install the canonical Hack skill in the shared agent skill root.
 *
 * Overwrites only Hack-owned content; an edited or foreign SKILL.md is
 * reported as `preserved` and left unchanged.
 */
export async function installSharedHackSkill(): Promise<SharedSkillResult> {
  const resolved = resolveSharedSkillPath({ skillName: HACK_CLI_SKILL_NAME });
  if (!resolved.ok) {
    return { status: "error", path: SKILL_FILENAME, message: resolved.message };
  }

  const outcome = await installOwnedIntegrationFile({
    surface: "hack-cli-skill",
    path: resolved.path,
    render: renderCodexSkill(),
  });
  if (outcome.status === "preserved") {
    return {
      status: "preserved",
      path: resolved.path,
      reason: outcome.reason,
      message: outcome.message,
    };
  }
  return { status: outcome.status, path: resolved.path };
}

/** Check the shared Hack skill against the same canonical render used by Codex. */
export async function checkSharedHackSkill(): Promise<SharedSkillResult> {
  const resolved = resolveSharedSkillPath({ skillName: HACK_CLI_SKILL_NAME });
  if (!resolved.ok) {
    return { status: "error", path: SKILL_FILENAME, message: resolved.message };
  }

  const file = await readOptionalTextFile(resolved.path);
  if (file.kind === "unreadable") {
    return {
      status: "error",
      path: resolved.path,
      message: "Hack-managed file exists but could not be read.",
    };
  }
  const content = file.kind === "text" ? file.text : "";
  if (!content) {
    return { status: "missing", path: resolved.path };
  }
  if (!HACK_CLI_MARKER.test(content)) {
    return {
      status: "error",
      path: resolved.path,
      message: "Shared Hack skill is missing the hack-cli marker.",
    };
  }
  if (
    normalizeInstructionText({ text: content }) !==
    normalizeInstructionText({ text: renderCodexSkill() })
  ) {
    return {
      status: "stale",
      path: resolved.path,
      message: `Shared Hack skill is stale at ${resolved.path}. Inspect this shared file and refresh only the authorized integration. Full global sync also changes other clients; use it only when that scope is requested.`,
    };
  }
  return { status: "noop", path: resolved.path };
}

/**
 * Remove the shared Hack skill. Deletes only a Hack-owned SKILL.md and removes
 * the skill directory only when it is empty afterwards.
 */
export async function removeSharedHackSkill(): Promise<SharedSkillResult> {
  const resolved = resolveSharedSkillPath({ skillName: HACK_CLI_SKILL_NAME });
  if (!resolved.ok) {
    return { status: "error", path: SKILL_FILENAME, message: resolved.message };
  }
  const outcome = await removeOwnedIntegrationFile({
    surface: "hack-cli-skill",
    path: resolved.path,
    currentRender: renderCodexSkill(),
    removeEmptyDirectory: true,
  });
  if (outcome.status === "preserved") {
    return {
      status: "preserved",
      path: resolved.path,
      reason: outcome.reason,
      message: outcome.message,
    };
  }
  if (outcome.status === "removed" && outcome.message) {
    return { status: "removed", path: resolved.path, message: outcome.message };
  }
  return { status: outcome.status, path: resolved.path };
}

function resolveSharedSkillPath(opts: {
  readonly skillName: string;
}):
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly message: string } {
  const home = (process.env.HOME ?? "").trim();
  if (!home) {
    return {
      ok: false,
      message: "HOME is not set; cannot resolve shared skills.",
    };
  }
  return {
    ok: true,
    path: resolve(home, SHARED_SKILLS_DIR, opts.skillName, SKILL_FILENAME),
  };
}
