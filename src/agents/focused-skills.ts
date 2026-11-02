/**
 * Focused plugin skills composed from canonical instruction sections.
 *
 * Each focused skill names the {@link INSTRUCTION_SECTIONS} ids it renders, in
 * order; no guidance prose lives here. Only the frontmatter description (the
 * routing contract) is owned by this module, built from a summary and a list
 * of trigger phrases. A trigger phrase belongs to exactly one plugin skill,
 * which `tests/focused-skills.test.ts` enforces across every description.
 */

import {
  INSTRUCTION_SECTIONS,
  type InstructionSection,
  renderInstructionSection,
} from "./instruction-source.ts";

export type FocusedSkillName = "hack-branches" | "hack-env" | "hack-diagnose";

/** One canonical section in a focused skill, optionally marked as optional. */
export type FocusedSkillSection = {
  readonly id: string;
  /** A secondary entry, rendered with an "(optional)" title suffix. */
  readonly optional?: boolean;
};

/** The routing contract a skill's frontmatter description renders from. */
export type SkillRouting = {
  readonly summary: string;
  /** Intents that select this skill; each phrase is unique to one skill. */
  readonly triggers: readonly string[];
  /** Optional closing sentences, e.g. where neighbouring intents go. */
  readonly closing?: string;
};

export type FocusedSkillSpec = {
  readonly name: FocusedSkillName;
  readonly heading: string;
  readonly routing: SkillRouting;
  readonly sections: readonly FocusedSkillSection[];
};

/**
 * Routing for the plugin's `hack-cli` skill. It keeps general runtime work
 * and hands branch, env and diagnosis intents to the focused skills. The
 * standalone `hack setup` render keeps its broad description because those
 * installs ship no focused skills.
 */
export const HACK_CLI_PLUGIN_ROUTING: SkillRouting = {
  summary:
    "Use the hack CLI for local runtime orchestration (compose, DNS/TLS, routed URLs, persistent project workspaces) and agent setup.",
  triggers: [
    "run, start or stop services",
    "tail service logs",
    "open a routed app URL",
    "manage lifecycle or workspace workflows",
    "update agent integrations",
  ],
  closing:
    "Use hack-branches for branch instances, hack-env for env values and hack-diagnose for a failing project. Prefer CLI over MCP when shell access is available.",
};

/** Focused plugin skills, in generation order. */
export const FOCUSED_SKILLS: readonly FocusedSkillSpec[] = [
  {
    name: "hack-branches",
    heading: "Hack branch instances",
    routing: {
      summary:
        "Run parallel branch instances of a Hack project with `--branch <name>` and manage their aliases with `hack branch`.",
      triggers: [
        "run two versions of a project side by side",
        "start, open, tail or stop a branch instance",
        "review a pull request in its own instance",
        "add, list, open or remove a branch alias",
      ],
    },
    sections: [
      { id: "branch-instances" },
      { id: "branch-aliases" },
      { id: "worktrees", optional: true },
    ],
  },
  {
    name: "hack-env",
    heading: "Hack env",
    routing: {
      summary:
        "Inspect and change Hack-managed env values, overlays and worktree-local overrides without exposing secret values.",
      triggers: [
        "explain where an env value comes from",
        "list, get or set an env value",
        "select or compare env overlays",
        "write a worktree-local env override",
        "run a host command with managed env",
        "refresh a service after an env change",
      ],
    },
    sections: [
      { id: "env-composition" },
      { id: "env-commands" },
      { id: "env-safety" },
    ],
  },
  {
    name: "hack-diagnose",
    heading: "Diagnose a Hack project",
    routing: {
      summary:
        "Diagnose a Hack-managed project by reading its state first and repairing only within the request.",
      triggers: [
        "find out why a service is unhealthy or did not start",
        "interpret an E_* error code from a JSON envelope",
        "review hack doctor findings",
        "investigate routing or global infrastructure failures",
      ],
    },
    sections: [{ id: "diagnose" }, { id: "operating-rules" }],
  },
];

/** Look up a focused skill by name. */
export function focusedSkill(name: FocusedSkillName): FocusedSkillSpec {
  const spec = FOCUSED_SKILLS.find((candidate) => candidate.name === name);
  if (!spec) {
    throw new Error("Unknown focused skill");
  }
  return spec;
}

/**
 * Render a skill description sentence: the summary, the trigger phrases, and
 * the optional closing sentences.
 */
export function renderSkillDescription(routing: SkillRouting): string {
  const triggers = routing.triggers;
  const last = triggers.at(-1);
  if (last === undefined) {
    throw new Error("A skill description needs at least one trigger phrase");
  }
  const joined =
    triggers.length === 1
      ? last
      : `${triggers.slice(0, -1).join("; ")}; or ${last}`;
  return [
    routing.summary,
    `Trigger when asked to ${joined}.`,
    ...(routing.closing ? [routing.closing] : []),
  ].join(" ");
}

/**
 * Render a description as a YAML folded block (`description: >`) wrapped at
 * a readable width. Folding joins the lines back into one sentence.
 */
export function renderDescriptionFrontmatter(description: string): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of description.split(" ")) {
    if (current.length > 0 && current.length + word.length + 1 > 96) {
      lines.push(`  ${current}`);
      current = word;
    } else {
      current = current.length > 0 ? `${current} ${word}` : word;
    }
  }
  if (current.length > 0) {
    lines.push(`  ${current}`);
  }
  return ["description: >", ...lines];
}

/**
 * Compose canonical sections by id, in the given order.
 *
 * Throws on an unknown or repeated id so a renamed canonical section cannot
 * silently drop out of a focused skill. Errors are closed and do not echo the
 * id.
 */
export function composeCanonicalSections(opts: {
  readonly sections: readonly FocusedSkillSection[];
  readonly source?: readonly InstructionSection[];
}): string {
  const source = opts.source ?? INSTRUCTION_SECTIONS;
  const seen = new Set<string>();
  const blocks = opts.sections.map((entry) => {
    if (seen.has(entry.id)) {
      throw new Error("Duplicate instruction section id in focused skill");
    }
    seen.add(entry.id);
    const section = source.find((candidate) => candidate.id === entry.id);
    if (!section) {
      throw new Error("Unknown instruction section id in focused skill");
    }
    return renderInstructionSection({
      section: entry.optional
        ? { ...section, title: `${section.title} (optional)` }
        : section,
      headingStyle: "markdown",
    });
  });
  return blocks.join("\n\n");
}

/** Render a focused skill's SKILL.md (without packaged reference links). */
export function renderFocusedSkill(name: FocusedSkillName): string {
  const spec = focusedSkill(name);
  return [
    "---",
    `name: ${spec.name}`,
    ...renderDescriptionFrontmatter(renderSkillDescription(spec.routing)),
    "---",
    "",
    `# ${spec.heading}`,
    "",
    composeCanonicalSections({ sections: spec.sections }),
    "",
  ].join("\n");
}
