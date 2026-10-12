import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderPluginSkill } from "../scripts/generate-agent-plugins.ts";
import { renderCodexSkill } from "../src/agents/codex-skill.ts";
import {
  renderSkillReference,
  SKILL_REFERENCES,
  skillReferencePath,
  skillReferenceRevision,
  withSkillReferenceLinks,
} from "../src/agents/skill-references.ts";
import { findSkillLinkIssues } from "./helpers/skill-links.ts";

const pluginRoot = join(import.meta.dir, "..", "plugins", "hack");

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

async function fixturePlugin(
  files: Readonly<Record<string, string>>
): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "hack-skill-links-"));
  const root = join(tempDir, "plugins", "hack");
  await mkdir(join(tempDir, "docs"), { recursive: true });
  await Bun.write(join(tempDir, "docs", "env.md"), "# Env\n");
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await Bun.write(join(root, path), text);
  }
  return root;
}

test("packaged skill links stay inside the plugin and work offline", async () => {
  expect(await findSkillLinkIssues({ pluginRoot })).toEqual([]);
});

test("every packaged reference is linked and carries a recomputable revision", async () => {
  expect(SKILL_REFERENCES.length).toBeGreaterThan(0);
  for (const reference of SKILL_REFERENCES) {
    const packaged = await Bun.file(
      join(pluginRoot, skillReferencePath(reference))
    ).text();
    expect(packaged).toBe(renderSkillReference(reference));
    expect(packaged).toContain(
      `Content revision: \`${skillReferenceRevision(reference.render())}\``
    );
    const skill = await Bun.file(
      join(pluginRoot, "skills", reference.skill, "SKILL.md")
    ).text();
    expect(skill).toContain(`](references/${reference.file})`);
  }
});

test("only the plugin skill links references; standalone renders stay unchanged", () => {
  expect(renderCodexSkill()).not.toContain("references/");
  const plugin = renderPluginSkill("hack-cli");
  expect(plugin.startsWith(renderCodexSkill().trimEnd())).toBe(true);
  expect(plugin.slice(renderCodexSkill().trimEnd().length)).toBe(
    "\n\n## References\n\n- [Pattern catalogue](references/patterns.md): reusable project patterns with what Hack supports today, the missing contract and its owner.\n"
  );
  const unchanged = "---\nname: hack-init\n---\n";
  expect(
    withSkillReferenceLinks({ skill: "hack-init", content: unchanged })
  ).toBe(unchanged);
});

test("negative control: a link into repository docs fails the link test", async () => {
  const root = await fixturePlugin({
    "skills/x/SKILL.md": "# X\n\nSee [env](../../docs/env.md).\n",
    "skills/y/SKILL.md": "# Y\n\nSee [env](../../../../docs/env.md).\n",
  });
  expect(await findSkillLinkIssues({ pluginRoot: root })).toEqual([
    { file: "skills/x/SKILL.md", code: "repo-docs-link" },
    { file: "skills/y/SKILL.md", code: "escapes-plugin" },
  ]);
});

test("negative control: absolute, missing, external and unlinked references fail", async () => {
  const root = await fixturePlugin({
    "skills/x/SKILL.md": [
      "# X",
      "",
      "- [abs](/etc/hosts)",
      "- [gone](references/gone.md)",
      "- [web](https://example.com/guide)",
      "- Read https://example.com/bare too.",
      "- `https://schemas.hack/literal.json` is a literal, not a link.",
      "",
      "```sh",
      "curl https://example.com/in-a-fence",
      "```",
      "",
      "## Further reading",
      "",
      "- [ok](https://example.com/ok)",
      "",
    ].join("\n"),
    "skills/x/references/orphan.md": "# Orphan\n",
  });
  expect(await findSkillLinkIssues({ pluginRoot: root })).toEqual([
    { file: "skills/x/SKILL.md", code: "absolute-link" },
    { file: "skills/x/SKILL.md", code: "missing-target" },
    { file: "skills/x/SKILL.md", code: "external-outside-further-reading" },
    { file: "skills/x/SKILL.md", code: "external-outside-further-reading" },
    { file: "skills/x/references/orphan.md", code: "unlinked-reference" },
  ]);
});

test("reference file names are constrained to plain markdown names", () => {
  for (const file of ["../escape.md", "nested/x.md", "x.txt", "X.md"]) {
    expect(() =>
      skillReferencePath({
        skill: "hack-cli",
        file,
        title: "x",
        summary: "x",
        render: () => "",
      })
    ).toThrow("Invalid skill reference file name");
  }
});
