import { expect, test } from "bun:test";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { renderPluginSkill } from "../scripts/generate-agent-plugins.ts";
import { renderErrorCodeReference } from "../src/agents/error-code-reference.ts";
import { HACK_FEEDBACK_ROUTING } from "../src/agents/feedback-skill.ts";
import {
  composeCanonicalSections,
  FOCUSED_SKILLS,
  type FocusedSkillName,
  focusedSkill,
  HACK_CLI_PLUGIN_ROUTING,
  renderSkillDescription,
} from "../src/agents/focused-skills.ts";
import { renderHackInitSkill } from "../src/agents/hack-init-skill.ts";
import { renderHackInstallSkill } from "../src/agents/install-skill.ts";
import {
  INSTRUCTION_SECTIONS,
  type InstructionSection,
} from "../src/agents/instruction-source.ts";
import { renderHackRemoteSkill } from "../src/agents/remote-bootstrap-skill.ts";
import { CLI_SPEC } from "../src/cli/spec.ts";
import { HACK_ERROR_CODES } from "../src/lib/cli-result.ts";
import { isRecord } from "../src/lib/guards.ts";
import {
  extractHackInvocations,
  findGuidanceCommandIssues,
} from "./helpers/cli-guidance-commands.ts";

const pluginRoot = join(import.meta.dir, "..", "plugins", "hack");

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;

/** The frontmatter `description` of a rendered skill, as YAML parses it. */
function descriptionOf(rendered: string): string {
  const parsed: unknown = parseYaml(FRONTMATTER.exec(rendered)?.[1] ?? "");
  if (!(isRecord(parsed) && typeof parsed.description === "string")) {
    throw new Error("skill render lacks a string description");
  }
  return parsed.description.trim();
}

function sectionById(id: string): InstructionSection {
  const section = INSTRUCTION_SECTIONS.find((candidate) => candidate.id === id);
  if (!section) {
    throw new Error(`missing canonical section ${id}`);
  }
  return section;
}

/** Rendered SKILL.md body of a focused skill, without its frontmatter. */
function bodyOf(name: FocusedSkillName): string {
  const rendered = renderPluginSkill(name);
  return rendered.slice(rendered.indexOf("\n---\n") + 5);
}

type RoutedSkill = {
  readonly name: string;
  readonly description: string;
  readonly triggers: readonly string[];
};

/** Every plugin skill's description, with the trigger phrases it owns. */
function pluginRouting(): RoutedSkill[] {
  return [
    {
      name: "hack-cli",
      description: descriptionOf(renderPluginSkill("hack-cli")),
      triggers: HACK_CLI_PLUGIN_ROUTING.triggers,
    },
    ...FOCUSED_SKILLS.map((skill) => ({
      name: skill.name,
      description: descriptionOf(renderPluginSkill(skill.name)),
      triggers: skill.routing.triggers,
    })),
    {
      name: "hack-feedback",
      description: descriptionOf(renderPluginSkill("hack-feedback")),
      triggers: HACK_FEEDBACK_ROUTING.triggers,
    },
    ...[
      ["hack-init", renderHackInitSkill()],
      ["hack-install", renderHackInstallSkill()],
      ["hack-remote", renderHackRemoteSkill()],
    ].map(([name, rendered]) => ({
      name: name ?? "",
      description: descriptionOf(rendered ?? ""),
      triggers: [],
    })),
  ];
}

/**
 * Closed overlap findings: a trigger phrase owned by one skill that also
 * appears (case-insensitively) in another skill's description.
 */
function triggerOverlaps(skills: readonly RoutedSkill[]): string[] {
  const findings: string[] = [];
  for (const owner of skills) {
    for (const trigger of owner.triggers) {
      for (const other of skills) {
        if (
          other !== owner &&
          other.description.toLowerCase().includes(trigger.toLowerCase())
        ) {
          findings.push(`${owner.name} -> ${other.name}`);
        }
      }
    }
  }
  return findings;
}

/** Codes listed in the first column of the reference table, in order. */
function referenceCodes(rendered: string): string[] {
  return [...rendered.matchAll(/^\| `(E_[A-Z0-9_]+)` \|/gm)].map(
    (match) => match[1] ?? ""
  );
}

/** Parity between the reference rows and the exported registry. */
function errorCodeParityIssues(opts: {
  readonly rendered: string;
  readonly registry: readonly string[];
}): string[] {
  const listed = referenceCodes(opts.rendered);
  return [
    ...opts.registry
      .filter((code) => !listed.includes(code))
      .map((code) => `missing ${code}`),
    ...listed
      .filter((code) => !opts.registry.includes(code))
      .map((code) => `unexpected ${code}`),
    ...listed
      .filter((code, index) => listed.indexOf(code) !== index)
      .map((code) => `duplicate ${code}`),
  ];
}

test("every focused skill section id exists in the canonical source", () => {
  const ids = new Set(INSTRUCTION_SECTIONS.map((section) => section.id));
  expect(FOCUSED_SKILLS.map((skill) => skill.name)).toEqual([
    "hack-branches",
    "hack-env",
    "hack-diagnose",
  ]);
  for (const skill of FOCUSED_SKILLS) {
    expect(skill.sections.length, skill.name).toBeGreaterThan(0);
    for (const entry of skill.sections) {
      expect(ids.has(entry.id), `${skill.name}: ${entry.id}`).toBe(true);
    }
  }
});

test("focused skills render canonical sections verbatim, in order", () => {
  for (const skill of FOCUSED_SKILLS) {
    const body = bodyOf(skill.name);
    let previous = -1;
    for (const entry of skill.sections) {
      const section = sectionById(entry.id);
      const title = entry.optional
        ? `## ${section.title} (optional)`
        : `## ${section.title}`;
      const at = body.indexOf(title);
      expect(at, `${skill.name}: ${entry.id} heading order`).toBeGreaterThan(
        previous
      );
      for (const bullet of section.bullets) {
        expect(body, `${skill.name}: ${entry.id}`).toContain(`- ${bullet}`);
      }
      previous = at;
    }
    // Only canonical headings appear: no skill-local prose sections.
    const headings = [...body.matchAll(/^## (.+)$/gm)].map(
      (match) => match[1] ?? ""
    );
    expect(headings.filter((heading) => heading !== "References")).toEqual(
      skill.sections.map((entry) => {
        const title = sectionById(entry.id).title;
        return entry.optional ? `${title} (optional)` : title;
      })
    );
  }
});

test("negative control: an unknown or repeated section id fails composition", () => {
  expect(() =>
    composeCanonicalSections({ sections: [{ id: "no-such-section" }] })
  ).toThrow("Unknown instruction section id in focused skill");
  expect(() =>
    composeCanonicalSections({
      sections: [{ id: "env-composition" }, { id: "env-composition" }],
    })
  ).toThrow("Duplicate instruction section id in focused skill");
  // The refusal is closed: it never echoes the caller's id.
  let message = "";
  try {
    composeCanonicalSections({ sections: [{ id: "secret-looking-id" }] });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toBe("Unknown instruction section id in focused skill");
});

test("focused-only canonical sections stay out of the broad surfaces", () => {
  for (const id of [
    "branch-aliases",
    "env-commands",
    "env-safety",
    "diagnose",
  ]) {
    expect(sectionById(id).surfaces, id).toEqual([]);
  }
});

test("hack-branches leads with --branch and the branch subcommands; worktrees are optional", () => {
  const spec = focusedSkill("hack-branches");
  expect(spec.sections[0]?.id).toBe("branch-instances");
  expect(spec.routing.summary).toContain("`--branch <name>`");
  const body = bodyOf("hack-branches");
  const first = extractHackInvocations(body)[0] ?? "";
  expect(first).toContain("--branch <name>");
  for (const subcommand of ["add", "list", "open", "remove"]) {
    expect(body).toContain(`\`hack branch ${subcommand}`);
  }
  const worktrees = spec.sections.find((entry) => entry.id === "worktrees");
  expect(worktrees?.optional).toBe(true);
  expect(spec.sections.filter((entry) => entry.optional)).toEqual([
    { id: "worktrees", optional: true },
  ]);
  expect(body.indexOf("## Linked git worktrees (optional)")).toBeGreaterThan(
    body.indexOf("## Branch aliases")
  );
});

test("hack-env covers its commands and states precedence only from the canonical env section", () => {
  const spec = focusedSkill("hack-env");
  expect(spec.sections[0]?.id).toBe("env-composition");
  const body = bodyOf("hack-env");
  for (const command of [
    "`hack env list",
    "`hack env get",
    "`hack env explain",
    "`hack env apply",
    "`hack env set <key> <value> --local`",
    "`hack env set <key> --secret`",
    "`hack env exec",
    ".hack/hack.env.<overlay>.yaml",
    ".hack/hack.env.local.yaml",
  ]) {
    expect(body, command).toContain(command);
  }
  // Precedence wording lives in `env-composition` alone; skill-specific
  // sections must not restate (and so cannot contradict) it.
  const precedence =
    /\b(?:layer order|precedence|override[sn]?\s+`global`|values last)\b/i;
  for (const entry of spec.sections) {
    if (entry.id === "env-composition") {
      continue;
    }
    for (const bullet of sectionById(entry.id).bullets) {
      expect(precedence.test(bullet), `${entry.id}: ${bullet}`).toBe(false);
    }
  }
  expect(
    sectionById("env-composition").bullets.some((bullet) =>
      precedence.test(bullet)
    )
  ).toBe(true);
});

test("hack-env keeps secret values out of argv and treats get as a plaintext sink", () => {
  const body = bodyOf("hack-env");
  expect(body).toContain(
    "A secret value never goes in command arguments or agent prompts"
  );
  expect(body).toContain("are plaintext sinks");
  expect(body).toContain("`hack env explain <KEY>");
  // No rendered example passes a secret-looking value as an argument or
  // assignment.
  for (const pattern of [
    /--(?:password|passwd|token|secret|api-key|apikey)(?:=|\s+)(?!-)[^\s`]/i,
    /\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY)=\S/,
    /`hack env (?:set|add) <key> <value> --secret/,
  ]) {
    expect(pattern.test(body), String(pattern)).toBe(false);
  }
});

test("hack-diagnose reads first in the documented order and repairs only within the request", () => {
  const spec = focusedSkill("hack-diagnose");
  expect(spec.sections[0]?.id).toBe("diagnose");
  const body = bodyOf("hack-diagnose");
  const order = [
    "`hack ps --json`",
    "`hack doctor --json`",
    "`hack logs --json --no-follow --tail 200`",
    "`hack env explain <key> --service <service>`",
    "`hack global status`",
  ].map((step) => body.indexOf(step));
  expect(order.every((index) => index >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(body).toContain(
    "apply `hack doctor --fix` only for repairs covered by the request"
  );
  // Every `--fix` mention comes after the read-first steps.
  expect(body.indexOf("--fix")).toBeGreaterThan(order.at(-1) ?? 0);
  expect(body).toContain("](references/error-codes.md)");
});

test("every hack command and flag in the focused skills resolves in CLI_SPEC", () => {
  const rendered: Record<string, string> = {
    "hack-cli": renderPluginSkill("hack-cli"),
    "error-codes": renderErrorCodeReference(),
  };
  for (const skill of FOCUSED_SKILLS) {
    rendered[skill.name] = renderPluginSkill(skill.name);
  }
  for (const [name, text] of Object.entries(rendered)) {
    expect(extractHackInvocations(text).length, name).toBeGreaterThan(0);
    expect(
      findGuidanceCommandIssues({ cli: CLI_SPEC, rendered: text })
    ).toEqual([]);
  }
  // The walker still rejects a bad branch or env invocation.
  for (const fixture of [
    "`hack branch rename <name>`",
    "`hack env set <key> --shared`",
    "`hack logs --json --no-follow --last 200`",
  ]) {
    expect(
      findGuidanceCommandIssues({ cli: CLI_SPEC, rendered: fixture }),
      fixture
    ).not.toEqual([]);
  }
});

test("the error-code reference lists exactly the exported registry", async () => {
  const rendered = renderErrorCodeReference();
  expect(HACK_ERROR_CODES.length).toBeGreaterThan(0);
  expect(referenceCodes(rendered)).toEqual([...HACK_ERROR_CODES]);
  expect(
    errorCodeParityIssues({ rendered, registry: HACK_ERROR_CODES })
  ).toEqual([]);
  const packaged = await Bun.file(
    join(pluginRoot, "skills/hack-diagnose/references/error-codes.md")
  ).text();
  expect(packaged.startsWith(rendered.trimEnd())).toBe(true);
  expect(referenceCodes(packaged)).toEqual([...HACK_ERROR_CODES]);
});

test("negative control: a fake or missing E_* code fails registry parity", () => {
  const rendered = renderErrorCodeReference();
  expect(
    errorCodeParityIssues({
      rendered: `${rendered}| \`E_FAKE_CODE\` | Not a real code. | \`hack doctor --json\` |\n`,
      registry: HACK_ERROR_CODES,
    })
  ).toEqual(["unexpected E_FAKE_CODE"]);
  expect(
    errorCodeParityIssues({
      rendered: rendered.replace(/^\| `E_USAGE` \|.*\n/m, ""),
      registry: HACK_ERROR_CODES,
    })
  ).toEqual(["missing E_USAGE"]);
  expect(
    errorCodeParityIssues({
      rendered,
      registry: [...HACK_ERROR_CODES, "E_NOT_RENDERED"],
    })
  ).toEqual(["missing E_NOT_RENDERED"]);
});

test("rendered descriptions are the routing sentences and parse as YAML", () => {
  expect(descriptionOf(renderPluginSkill("hack-cli"))).toBe(
    renderSkillDescription(HACK_CLI_PLUGIN_ROUTING)
  );
  for (const skill of FOCUSED_SKILLS) {
    expect(descriptionOf(renderPluginSkill(skill.name))).toBe(
      renderSkillDescription(skill.routing)
    );
  }
  expect(descriptionOf(renderPluginSkill("hack-feedback"))).toBe(
    renderSkillDescription(HACK_FEEDBACK_ROUTING)
  );
  const cli = descriptionOf(renderPluginSkill("hack-cli"));
  for (const name of [
    "hack-branches",
    "hack-env",
    "hack-diagnose",
    "hack-feedback",
  ]) {
    expect(cli).toContain(name);
  }
});

test("no trigger phrase is shared between plugin skill descriptions", () => {
  const skills = pluginRouting();
  expect(skills.map((skill) => skill.name)).toHaveLength(8);
  const owned = skills.flatMap((skill) => skill.triggers);
  expect(owned.length).toBeGreaterThan(0);
  expect(new Set(owned.map((trigger) => trigger.toLowerCase())).size).toBe(
    owned.length
  );
  expect(triggerOverlaps(skills)).toEqual([]);
});

test("negative control: a duplicated trigger phrase fails the overlap test", () => {
  const skills = pluginRouting();
  const env = skills.find((skill) => skill.name === "hack-env");
  const borrowed = env?.triggers[0];
  if (!borrowed) {
    throw new Error("hack-env has no trigger phrases");
  }
  const withDuplicate = skills.map((skill) =>
    skill.name === "hack-diagnose"
      ? {
          ...skill,
          description: renderSkillDescription({
            ...focusedSkill("hack-diagnose").routing,
            triggers: [
              ...focusedSkill("hack-diagnose").routing.triggers,
              borrowed,
            ],
          }),
        }
      : skill
  );
  expect(triggerOverlaps(withDuplicate)).toEqual(["hack-env -> hack-diagnose"]);
});
