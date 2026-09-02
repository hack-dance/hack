import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { readTextFile, writeTextFileIfChanged } from "../lib/fs.ts";

export type LegacyAgentArtifactResult = {
  readonly status: "absent" | "deprecated" | "removed" | "error";
  readonly path: string;
  readonly message?: string;
};

type LegacySkillDefinition = {
  readonly path: string;
  readonly markers: readonly RegExp[];
};

const LEGACY_TICKETS_SKILL_MARKER = /name:\s*hack-tickets\b/i;
const LEGACY_HACK_SKILL_MARKER = /name:\s*hack\b/i;
const LEGACY_HACK_HOMEPAGE_MARKER =
  /homepage:\s*https:\/\/github\.com\/hack-dance\/hack-cli/i;
const LEGACY_TICKETS_DOC_START = "<!-- hack:tickets:start -->";
const LEGACY_TICKETS_DOC_END = "<!-- hack:tickets:end -->";

/** Audit retired project artifacts without treating unrelated user files as Hack-owned. */
export async function checkLegacyProjectAgentArtifacts({
  projectRoot,
}: {
  readonly projectRoot: string;
}): Promise<LegacyAgentArtifactResult[]> {
  return await Promise.all([
    checkLegacySkill({
      definition: {
        path: resolve(projectRoot, ".codex/skills/hack-tickets/SKILL.md"),
        markers: [LEGACY_TICKETS_SKILL_MARKER],
      },
    }),
    checkLegacyInstructionBlock({ path: resolve(projectRoot, "AGENTS.md") }),
    checkLegacyInstructionBlock({ path: resolve(projectRoot, "CLAUDE.md") }),
  ]);
}

/** Remove only retired project artifacts with recognized Hack ownership markers. */
export async function removeLegacyProjectAgentArtifacts({
  projectRoot,
}: {
  readonly projectRoot: string;
}): Promise<LegacyAgentArtifactResult[]> {
  return await Promise.all([
    removeLegacySkill({
      definition: {
        path: resolve(projectRoot, ".codex/skills/hack-tickets/SKILL.md"),
        markers: [LEGACY_TICKETS_SKILL_MARKER],
      },
    }),
    removeLegacyInstructionBlock({ path: resolve(projectRoot, "AGENTS.md") }),
    removeLegacyInstructionBlock({ path: resolve(projectRoot, "CLAUDE.md") }),
  ]);
}

/** Audit retired user-scope skills without reading or removing arbitrary skill directories. */
export async function checkLegacyUserAgentArtifacts({
  home = process.env.HOME,
}: {
  readonly home?: string;
} = {}): Promise<LegacyAgentArtifactResult[]> {
  const definitions = resolveLegacyUserSkillDefinitions({ home });
  if (!definitions.ok) {
    return [
      { status: "error", path: "SKILL.md", message: definitions.message },
    ];
  }
  return await Promise.all(
    definitions.items.map(
      async (definition) => await checkLegacySkill({ definition })
    )
  );
}

/** Remove only retired user-scope skills whose known ownership markers match. */
export async function removeLegacyUserAgentArtifacts({
  home = process.env.HOME,
}: {
  readonly home?: string;
} = {}): Promise<LegacyAgentArtifactResult[]> {
  const definitions = resolveLegacyUserSkillDefinitions({ home });
  if (!definitions.ok) {
    return [
      { status: "error", path: "SKILL.md", message: definitions.message },
    ];
  }
  return await Promise.all(
    definitions.items.map(
      async (definition) => await removeLegacySkill({ definition })
    )
  );
}

function resolveLegacyUserSkillDefinitions({
  home,
}: {
  readonly home?: string;
}):
  | { readonly ok: true; readonly items: readonly LegacySkillDefinition[] }
  | { readonly ok: false; readonly message: string } {
  const resolvedHome = (home ?? "").trim();
  if (!resolvedHome) {
    return {
      ok: false,
      message: "HOME is not set; cannot resolve legacy skills.",
    };
  }
  return {
    ok: true,
    items: [
      {
        path: resolve(resolvedHome, ".codex/skills/hack-tickets/SKILL.md"),
        markers: [LEGACY_TICKETS_SKILL_MARKER],
      },
      {
        path: resolve(resolvedHome, ".ai/skills/hack/SKILL.md"),
        markers: [LEGACY_HACK_SKILL_MARKER, LEGACY_HACK_HOMEPAGE_MARKER],
      },
      {
        path: resolve(resolvedHome, ".ai/skills/hack-tickets/SKILL.md"),
        markers: [LEGACY_TICKETS_SKILL_MARKER],
      },
    ],
  };
}

async function checkLegacySkill({
  definition,
}: {
  readonly definition: LegacySkillDefinition;
}): Promise<LegacyAgentArtifactResult> {
  const content = await readTextFile(definition.path);
  if (!content) {
    return { status: "absent", path: definition.path };
  }
  const owned = definition.markers.every((marker) => marker.test(content));
  return {
    status: owned ? "deprecated" : "error",
    path: definition.path,
    message: owned
      ? `Retired Hack agent artifact remains at ${definition.path}. Run: hack setup sync --all-scopes`
      : `Refusing to remove unrecognized skill at ${definition.path}`,
  };
}

async function removeLegacySkill({
  definition,
}: {
  readonly definition: LegacySkillDefinition;
}): Promise<LegacyAgentArtifactResult> {
  const checked = await checkLegacySkill({ definition });
  if (checked.status !== "deprecated") {
    return checked;
  }
  await rm(dirname(definition.path), { recursive: true, force: true });
  return { status: "removed", path: definition.path };
}

async function checkLegacyInstructionBlock({
  path,
}: {
  readonly path: string;
}): Promise<LegacyAgentArtifactResult> {
  const content = await readTextFile(path);
  if (!content) {
    return { status: "absent", path };
  }
  const start = content.indexOf(LEGACY_TICKETS_DOC_START);
  const end = content.indexOf(LEGACY_TICKETS_DOC_END);
  if (start === -1 && end === -1) {
    return { status: "absent", path };
  }
  if (start === -1 || end === -1 || end < start) {
    return {
      status: "error",
      path,
      message: `Refusing to edit malformed retired Hack instruction markers at ${path}`,
    };
  }
  return {
    status: "deprecated",
    path,
    message: `Retired Hack instruction block remains at ${path}. Run: hack setup sync --all-scopes`,
  };
}

async function removeLegacyInstructionBlock({
  path,
}: {
  readonly path: string;
}): Promise<LegacyAgentArtifactResult> {
  const checked = await checkLegacyInstructionBlock({ path });
  if (checked.status !== "deprecated") {
    return checked;
  }
  const content = (await readTextFile(path)) ?? "";
  const start = content.indexOf(LEGACY_TICKETS_DOC_START);
  const afterEnd =
    content.indexOf(LEGACY_TICKETS_DOC_END) + LEGACY_TICKETS_DOC_END.length;
  const prefix = content.slice(0, start).trimEnd();
  const suffix = content.slice(afterEnd).trimStart();
  const next = [prefix, suffix].filter(Boolean).join("\n\n");
  await writeTextFileIfChanged(path, next ? `${next.trimEnd()}\n` : "");
  return { status: "removed", path };
}
