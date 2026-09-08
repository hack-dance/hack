import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  ensureDir,
  pathExists,
  readTextFile,
  writeTextFileIfChanged,
} from "../lib/fs.ts";
import { renderCodexSkill } from "./codex-skill.ts";
import { normalizeInstructionText } from "./instruction-source.ts";

export type SharedSkillResult = {
  readonly status:
    | "created"
    | "updated"
    | "noop"
    | "absent"
    | "stale"
    | "removed"
    | "missing"
    | "error";
  readonly path: string;
  readonly message?: string;
};

const SHARED_SKILLS_DIR = ".ai/skills";
const HACK_CLI_SKILL_NAME = "hack-cli";
const SKILL_FILENAME = "SKILL.md";
const HACK_CLI_MARKER = /name:\s*hack-cli\b/i;

/** Install the canonical Hack skill in the shared agent skill root. */
export async function installSharedHackSkill(): Promise<SharedSkillResult> {
  const resolved = resolveSharedSkillPath({ skillName: HACK_CLI_SKILL_NAME });
  if (!resolved.ok) {
    return { status: "error", path: SKILL_FILENAME, message: resolved.message };
  }

  await ensureDir(dirname(resolved.path));
  const existed = await pathExists(resolved.path);
  const result = await writeTextFileIfChanged(
    resolved.path,
    renderCodexSkill()
  );
  let status: SharedSkillResult["status"] = "noop";
  if (result.changed) {
    status = existed ? "updated" : "created";
  }
  return { status, path: resolved.path };
}

/** Check the shared Hack skill against the same canonical render used by Codex. */
export async function checkSharedHackSkill(): Promise<SharedSkillResult> {
  const resolved = resolveSharedSkillPath({ skillName: HACK_CLI_SKILL_NAME });
  if (!resolved.ok) {
    return { status: "error", path: SKILL_FILENAME, message: resolved.message };
  }

  const content = await readTextFile(resolved.path);
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
      message: `Shared Hack skill is stale at ${resolved.path}. Run: hack setup sync --all-scopes`,
    };
  }
  return { status: "noop", path: resolved.path };
}

export async function removeSharedHackSkill(): Promise<SharedSkillResult> {
  const resolved = resolveSharedSkillPath({ skillName: HACK_CLI_SKILL_NAME });
  if (!resolved.ok) {
    return { status: "error", path: SKILL_FILENAME, message: resolved.message };
  }
  if (!(await pathExists(resolved.path))) {
    return { status: "missing", path: resolved.path };
  }
  await rm(dirname(resolved.path), { recursive: true, force: true });
  return { status: "removed", path: resolved.path };
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
