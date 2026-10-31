import assert from "node:assert/strict";
import { join } from "node:path";
import { renderCodexSkill } from "../../src/agents/codex-skill.ts";
import { runCli } from "../../src/cli/run.ts";
import { REPO_GUIDANCE_ROOTS, snapshotFileHashes } from "../e2e/fixture.ts";
import { requireFixtureRoot } from "./fixture-root.ts";

/** Run only init and explicitly selected handlers, in a caller-owned private environment. */
const root = requireFixtureRoot(
  process.argv[2],
  "explicit integration fixture"
);
const home = join(root, "home"),
  repo = join(root, "repo");
assert.equal(process.env.HOME, home);
assert.equal(process.env.HACK_HOME, join(root, "state"));
assert.equal(process.env.CODEX_HOME, join(home, ".codex"));
assert.equal(process.env.PATH, join(root, "empty-path"));
const originals = [
  "AGENTS.md",
  "CLAUDE.md",
  ".claude/settings.json",
  ".cursor/rules/hack.mdc",
  ".ai/skills/hack-cli/SKILL.md",
];
for (const base of [home, repo]) {
  for (const path of originals) {
    await Bun.write(join(base, path), `original: ${path}\n`);
  }
  await Bun.write(
    join(base, ".claude/settings.local.json"),
    JSON.stringify({
      custom: "preserve",
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "hack agent prime" }] },
        ],
      },
    })
  );
}
// A real generated render plus a customization must never be refreshed or adopted.
const globalSkill = join(home, ".codex/skills/hack-cli/SKILL.md");
const globalOriginal = `${renderCodexSkill()}\nUser customization: preserve.\n`;
await Bun.write(globalSkill, globalOriginal);
await Bun.write(join(repo, ".git/HEAD"), "ref: refs/heads/fixture\n");
const roots = [home, repo].flatMap((base) =>
  REPO_GUIDANCE_ROOTS.map((path) => join(base, path))
);
const baseline = await snapshotFileHashes({ roots });
process.chdir(repo);
assert.equal(await runCli(["init", "--auto", "--name", "fixture"]), 0);
assert.deepEqual(
  await snapshotFileHashes({ roots }),
  baseline,
  "ordinary init changed agent files"
);

const retired = [
  ["setup", "agents"],
  ["setup", "agents", "--remove"],
  ["setup", "claude"],
  ["setup", "cursor", "--global"],
  ["setup", "sync", "--all-scopes", "--install-missing"],
  ["setup", "sync", "--remove"],
  ...["--docs", "--agents-md", "--claude-md"].map((flag) => [
    "mcp",
    "install",
    "--codex",
    flag,
  ]),
];
assert.equal(
  await runCli(["setup", "mcp"]),
  1,
  "MCP requires a client selection"
);
assert.deepEqual(await snapshotFileHashes({ roots }), baseline);
for (const args of retired) {
  assert.equal(await runCli(args), 1, args.join(" "));
  assert.deepEqual(
    await snapshotFileHashes({ roots }),
    baseline,
    `${args.join(" ")} changed agent files`
  );
}
for (const flags of [[], ["--check"]]) {
  let notice = "";
  const write = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    notice += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    assert.equal(await runCli(["agent", "prime", ...flags]), 0);
  } finally {
    process.stdout.write = write;
  }
  assert.match(notice, /automatic agent primer is retired in v5/);
  assert.match(notice, /explicitly invoked Hack plugin skills or opt-in MCP/);
  assert.ok(
    notice.length < 250,
    "legacy hooks must not inject full instructions"
  );
  assert.doesNotMatch(
    notice,
    /hack CLI primer|Product boundary|hack up --detach/
  );
}
assert.deepEqual(
  await snapshotFileHashes({ roots }),
  baseline,
  "legacy hook command changed surfaces"
);
assert.equal(await runCli(["setup", "codex"]), 0);
assert.match(
  await Bun.file(join(repo, ".codex/skills/hack-cli/SKILL.md")).text(),
  /explicit opt-ins/
);
const afterSkill = await snapshotFileHashes({ roots });
const skill = join(repo, ".codex/skills/hack-cli/SKILL.md");
assert.notEqual(
  afterSkill.get(skill),
  baseline.get(skill),
  "opt-in skill must actually be installed"
);
assert.equal(
  await runCli(["mcp", "install", "--codex", "--scope", "project"]),
  0
);
assert.match(
  await Bun.file(join(repo, ".codex/config.toml")).text(),
  /mcp_servers.hack/
);
assert.equal(await Bun.file(globalSkill).text(), globalOriginal);
for (const base of [home, repo]) {
  for (const path of originals) {
    assert.equal(
      await Bun.file(join(base, path)).text(),
      `original: ${path}\n`
    );
  }
}
const final = await snapshotFileHashes({ roots });
for (const [path, hash] of baseline) {
  assert.equal(final.get(path), hash, path);
}
for (const [path, hash] of final) {
  if (!baseline.has(path)) {
    assert.ok(
      [
        join(repo, ".codex"),
        join(repo, ".codex/skills"),
        join(repo, ".codex/skills/hack-cli"),
        skill,
        join(repo, ".codex/skills/hack-init"),
        join(repo, ".codex/skills/hack-init/SKILL.md"),
        join(repo, ".codex/config.toml"),
      ].includes(path),
      `unexpected integration effect: ${path}`
    );
    assert.ok(hash.length > 0);
  }
}
// Independent mutation control: verify that the snapshot oracle notices a byte change.
const control = join(repo, "AGENTS.md");
const beforeControl = await snapshotFileHashes({ roots });
const original = await Bun.file(control).text();
await Bun.write(control, `${original}fixture mutation control\n`);
assert.notDeepEqual(await snapshotFileHashes({ roots }), beforeControl);
await Bun.write(control, original);
assert.deepEqual(await snapshotFileHashes({ roots }), beforeControl);
console.log("explicit-integrations-fixture:ok");
