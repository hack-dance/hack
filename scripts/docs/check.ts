import { resolve } from "node:path";
import { agentCompatibilityCommands, curateCliReference } from "./curate-cli";
import {
  prepare,
  repositoryRoot,
  resolvePublicSource,
  rewriteTarget,
} from "./prepare";
import { isVersionedSearchUrl } from "./version-boundary";

await prepare(true);
// Boundary checks: traversal, private evidence, untracked input must never become a link.
const source = resolve(repositoryRoot, "docs/README.md");
for (const target of [
  "../../outside.md",
  "../_docs/private.md",
  "../_internal/native-evidence.md",
  "https://example.com/%5Fdocs/private.md",
  "javascript:alert(1)",
  "../.hack-local/evidence.md",
  "../test-execution/log.md",
  "missing-public-document.md",
]) {
  let rejected = false;
  try {
    await rewriteTarget(target, source);
  } catch {
    rejected = true;
  }
  if (!rejected) {
    throw new Error(`Public boundary accepted ${target}`);
  }
}
if (
  (await rewriteTarget("core.md#commands", source)) !== "/docs/v4/core#commands"
) {
  throw new Error("Canonical doc links must use site routes");
}
console.log("Public link boundaries and canonical route rewriting passed.");

// Manifest inputs are independently validated before realpath/Bun.file can read them.
for (const file of [
  "docs/../../outside.md",
  "docs/../README.md",
  "/tmp/outside.md",
  "../docs/core.md",
  "docs/_internal/native-evidence.md",
  "docs/core.ts",
  "docs/../docs/core.md",
  "docs\\..\\outside.md",
]) {
  let rejected = false;
  try {
    resolvePublicSource(file);
  } catch {
    rejected = true;
  }
  if (!rejected) {
    throw new Error(`Manifest boundary accepted ${file}`);
  }
}
if (
  resolvePublicSource("docs/core.md") !==
  resolve(repositoryRoot, "docs/core.md")
) {
  throw new Error("Canonical Markdown source rejected");
}
console.log(
  "Manifest source containment and Markdown schema boundaries passed."
);

for (const version of ["v4", "v5"]) {
  const cli = await Bun.file(
    resolve(repositoryRoot, `site/content/docs/${version}/reference/cli.md`)
  ).text();
  if (
    /^## `hack (gateway|node|remote|dispatch|internal|the|ssh|x)(?:\s|`)/m.test(
      cli
    ) ||
    /^## (Beta|Experimental \(unsupported\)|Internal|Fun|Extensions)$/m.test(
      cli
    )
  ) {
    throw new Error(`Excluded CLI surface published: ${version}`);
  }
  for (const section of [
    "## `hack logs ",
    "## `hack env list`",
    version === "v4" ? "## `hack setup sync`" : "## `hack setup tmux`",
    "## `hack branch`",
  ]) {
    if (!cli.includes(section)) {
      throw new Error(`Public CLI section lost: ${version}/${section}`);
    }
  }
  const corpus = await Bun.file(
    resolve(repositoryRoot, `site/public/${version}/llms-full.txt`)
  ).text();
  const other = version === "v4" ? "v5" : "v4";
  if (
    corpus.includes(`https://hack.foo/docs/${other}/`) ||
    /dogfooding/i.test(corpus)
  ) {
    throw new Error(`Mixed or obsolete public corpus: ${version}`);
  }
  const index = await Bun.file(
    resolve(repositoryRoot, `site/public/${version}/llms.txt`)
  ).text();
  for (const route of ["install", "getting-started", "agent-handoff"]) {
    if (!index.includes(`/docs/${version}/${route}`)) {
      throw new Error(`Missing entry point: ${version}/${route}`);
    }
  }
}
if (
  (await Bun.file(resolve(repositoryRoot, "site/public/llms.txt")).text()) !==
  (await Bun.file(resolve(repositoryRoot, "site/public/v5/llms.txt")).text())
) {
  throw new Error("Default agent index must select v5");
}
console.log(
  "Version-isolated exports, entry points and default version passed."
);

/** Keep retiring instruction management out of the recommended v5 corpus. */
function assertExplicitAgentContent(text: string): void {
  if (
    /(?:^|[\s`"'|])(?:[^\s`"'|]*\/)?hack(?:-cli|-next|-v5)?["']?\s+(?:agent prime|setup (?:cursor|claude|codex|agents|sync|mcp)|mcp install)(?=[\s`]|$)/m.test(
      text
    ) ||
    /hack init[^\n]*--with/.test(text) ||
    /^\| `--(?:docs|agents-md|claude-md|install-missing|with)(?:[\s`])/m.test(
      text
    ) ||
    /### SetupSync|^\| `SetupSync/m.test(text)
  ) {
    throw new Error("Retiring agent setup promoted in the v5 publication");
  }
}

const v5Root = resolve(repositoryRoot, "site/content/docs/v5");
for (const file of new Bun.Glob("**/*.md").scanSync({ cwd: v5Root })) {
  const text = await Bun.file(resolve(v5Root, file)).text();
  assertExplicitAgentContent(text);
  if (
    file === "reference/agent-compatibility.md" &&
    (text.includes("```") || text.includes("~~~"))
  ) {
    throw new Error("Agent compatibility must not become a runnable tutorial");
  }
}
for (const file of [
  "site/public/v5/llms-full.txt",
  "site/public/llms-full.txt",
]) {
  assertExplicitAgentContent(
    await Bun.file(resolve(repositoryRoot, file)).text()
  );
}
const integrations = await Bun.file(resolve(v5Root, "integrations.md")).text();
for (const fact of [
  "codex plugin marketplace add /absolute/path/to/reviewed-checkout",
  "Registration does not install or load the plugin",
  "SessionStart/PreCompact",
  "has not shipped in this pin",
  "hack-mcp",
  "--bundle",
  "--cli",
  "--runtime-directory",
  "actual preview host",
  "/tree/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/plugins/hack/skills",
]) {
  if (!integrations.includes(fact)) {
    throw new Error(`Agent interface source boundary lost: ${fact}`);
  }
}
for (const skill of [
  "hack-cli",
  "hack-branches",
  "hack-env",
  "hack-diagnose",
  "hack-init",
  "hack-install",
  "hack-remote",
]) {
  if (!integrations.includes(`| ${skill} |`)) {
    throw new Error(`Shipped skill missing: ${skill}`);
  }
}

// Positive controls preserve unrelated runtime contracts and factual archaeology.
assertExplicitAgentContent(
  "Env injection; lifecycle definition freshness; hooks for application startup."
);
assertExplicitAgentContent(
  "The pinned source still declares `setup sync`; it is not the onboarding path."
);
for (const bad of [
  "Run `hack setup sync --all-scopes` after upgrading.",
  "```sh\nhack agent prime --check\n```",
  "| `--agents-md` | Write repository guidance |",
  "### SetupSyncTargetResult",
  "hack init --with codex",
  "/absolute/bundle/hack-cli mcp install --claude --scope user",
  '"$HOME/.hack-next/bin/hack-next" mcp install --codex',
  "/absolute/bundle/hack-v5 setup sync",
]) {
  let rejected = false;
  try {
    assertExplicitAgentContent(bad);
  } catch {
    rejected = true;
  }
  if (!rejected) {
    throw new Error(`Agent curation accepted a promotional fixture: ${bad}`);
  }
}

/** The v5 entry pages must not inherit the stable Compose quick-start recipe. */
function assertNativeOnboarding(text: string): void {
  if (
    /(?:up[^\n]*--detach|logs[^\n]*--pretty|(?:up|down|restart)[^\n]*--json)/.test(
      text
    ) ||
    /defaults to a branch instance/.test(text)
  ) {
    throw new Error("Compose defaults promoted as native onboarding");
  }
}
for (const file of ["core.md", "guides/init-project.md"]) {
  const text = await Bun.file(resolve(v5Root, file)).text();
  assertNativeOnboarding(text);
  for (const boundary of ["Native preparation", "Getting started", "v4"]) {
    if (!text.includes(boundary)) {
      throw new Error(`Native entry boundary missing: ${file}/${boundary}`);
    }
  }
}
for (const bad of [
  "hack up --detach",
  "hack logs --pretty",
  "hack restart --json",
  "hack up defaults to a branch instance",
]) {
  let rejected = false;
  try {
    assertNativeOnboarding(bad);
  } catch {
    rejected = true;
  }
  if (!rejected) {
    throw new Error(`Native onboarding accepted a Compose fixture: ${bad}`);
  }
}
assertNativeOnboarding("Env delivery and lifecycle definition freshness.");
// Exercise both publication branches against identical synthetic source sections.
for (const command of agentCompatibilityCommands) {
  const fixture = `## \`hack ${command}\`\n\nPinned compatibility body\n\n## \`hack logs [service]\`\n\nRuntime logs\n`;
  if (
    !curateCliReference(fixture, { version: "v4" }).includes(command) ||
    curateCliReference(fixture, { version: "v5" }).includes(command) ||
    !curateCliReference(fixture, { version: "v5" }).includes("Runtime logs")
  ) {
    throw new Error(
      `Version-specific agent command curation failed: ${command}`
    );
  }
}
console.log("Explicit-agent publication and legacy/runtime controls passed.");

for (const version of ["v4", "v5"] as const) {
  const other = version === "v4" ? "v5" : "v4";
  for (const url of [
    `/docs/${version}`,
    `/docs/${version}#setup`,
    `/docs/${version}/install`,
    `/docs/${version}/env#keys`,
  ]) {
    if (!isVersionedSearchUrl(url, version)) {
      throw new Error(`Rejected valid search URL: ${url}`);
    }
  }
  for (const url of [
    `/docs/${other}`,
    `/docs/${other}/install`,
    `/docs/${version}0`,
    `/docs/${version}-other`,
    `/docs/${version}/../${other}/env`,
    `//example.com/docs/${version}`,
    `/\\example.com/docs/${version}`,
    `https://example.com/docs/${version}`,
    null,
  ]) {
    if (isVersionedSearchUrl(url, version)) {
      throw new Error(`Accepted escaping search URL: ${url}`);
    }
  }
}
console.log(
  "Search index/anchor acceptance and cross-version negative controls passed."
);
