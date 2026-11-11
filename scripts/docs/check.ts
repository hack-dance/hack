import { resolve } from "node:path";
import { agentCompatibilityCommands, curateCliReference } from "./curate-cli";
import {
  prepare,
  repositoryRoot,
  resolveEditorialSource,
  resolvePublicSource,
  rewriteTarget,
} from "./prepare";
import { isVersionedSearchUrl } from "./version-boundary";
import versions from "./versions.json";

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

/** Retired agent automation must never be published as a runnable v5 recipe. */
const retiredAutomation =
  /(?:^|[\s`"'|])(?:[^\s`"'|]*\/)?hack(?:-cli|-next|-v5)?["']?\s+(?:agent prime|setup (?:cursor|claude|codex|agents|sync))(?=[\s`]|$)/m;

function fencedBlocks(text: string): string[] {
  return [...text.matchAll(/^(```|~~~)[^\n]*\n([\s\S]*?)\n\1/gm)].map(
    (match) => match[2] ?? ""
  );
}

function assertExplicitAgentContent(text: string): void {
  if (
    /--(?:docs|agents-md|claude-md|install-missing)(?:[\s=`]|$)/m.test(text)
  ) {
    throw new Error("Instruction-write flag promoted");
  }
  if (/### SetupSync|^\| `SetupSync/m.test(text)) {
    throw new Error("Retired setup-sync report promoted");
  }
  for (const block of fencedBlocks(text)) {
    if (retiredAutomation.test(block)) {
      throw new Error("Retired agent automation published as a recipe");
    }
  }
}

const v5Root = resolve(repositoryRoot, "site/content/docs/v5");
for (const file of new Bun.Glob("**/*.md").scanSync({ cwd: v5Root })) {
  assertExplicitAgentContent(await Bun.file(resolve(v5Root, file)).text());
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
  "codex plugin marketplace add hack-dance/hack",
  "claude plugin install hack@hack-dance",
  "hack-mcp",
  "hack mcp serve",
  "retired automatic instruction injection",
]) {
  if (!integrations.includes(fact)) {
    throw new Error(`Agent interface fact lost: ${fact}`);
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
  "hack-feedback",
]) {
  if (!integrations.includes(`| ${skill} |`)) {
    throw new Error(`Shipped skill missing: ${skill}`);
  }
}

// Positive and negative controls for the guard and editorial provenance.
assertExplicitAgentContent(
  "In v5, `hack setup sync` and `hack agent prime` refuse with a retirement notice."
);
assertExplicitAgentContent(
  "```sh\nhack init --with codex\nhack agent onboard\n```"
);
for (const bad of [
  "```sh\nhack setup sync --all-scopes\n```",
  "```sh\nhack agent prime --check\n```",
  '~~~sh\n"$HOME/.hack-next/bin/hack-next" setup codex\n~~~',
  "| `--agents-md` | Write repository guidance |",
  "### SetupSyncTargetResult",
]) {
  let rejected = false;
  try {
    assertExplicitAgentContent(bad);
  } catch {
    rejected = true;
  }
  if (!rejected) {
    throw new Error(`Agent curation accepted a retired fixture: ${bad}`);
  }
}
const sampleSource = versions.v5.editorial.find(
  (page) => "sourceRevision" in page
);
if (!(sampleSource && "sourceRevision" in sampleSource)) {
  throw new Error("Expected at least one explicitly sourced editorial page");
}
const sourceDefaults = {
  revision: versions.v5.revision,
  label: versions.v5.label,
};
resolveEditorialSource(sampleSource, sourceDefaults);
for (const invalid of [
  { sourceRevision: "bad", sourceLabel: "x", sourceFile: "docs/core.md" },
  { sourceRevision: versions.v5.revision },
  {
    sourceRevision: versions.v5.revision,
    sourceLabel: "x",
    sourceFile: "docs/../private.md",
  },
]) {
  let rejected = false;
  try {
    resolveEditorialSource(invalid, sourceDefaults);
  } catch {
    rejected = true;
  }
  if (!rejected) {
    throw new Error("Invalid editorial provenance accepted");
  }
}

/** v5 leads with the default Compose backend and names native as opt-in. */
for (const [file, facts] of [
  ["getting-started.md", ["hack up --detach", "Compose", "native"]],
  [
    "core.md",
    ["Compose backend", "native backend", "HACK_RUNTIME_BACKEND=native"],
  ],
  ["upgrade.md", ["Compose", "native", "Retired", "Hack Tickets", "dashboard"]],
  ["install.md", ["HACK_RUNTIME_BACKEND=compose", "hack global install"]],
] as const) {
  const text = await Bun.file(resolve(v5Root, file)).text();
  for (const fact of facts) {
    if (!text.includes(fact)) {
      throw new Error(`v5 framing fact missing: ${file}/${fact}`);
    }
  }
}
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
console.log("Explicit-agent publication and v5 framing controls passed.");

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

// The install page must point at the pinned prerelease's shell bootstrap.
const prerelease = /next\.(\d+)/.exec(versions.v5.label)?.[1];
if (!prerelease) {
  throw new Error(
    "v5 label must name the pinned prerelease, e.g. v5 (next.12)"
  );
}
const install = await Bun.file(resolve(v5Root, "install.md")).text();
const bootstrapUrl = `https://github.com/hack-dance/hack/releases/download/v5.0.0-next.${prerelease}/hack-next-install.sh`;
for (const fact of [bootstrapUrl, "sh hack-next-install.sh", "Apple Silicon"]) {
  if (!install.includes(fact)) {
    throw new Error(`Installation boundary missing: ${fact}`);
  }
}
if (
  new RegExp(`releases/download/v5\\.0\\.0-next\\.(?!${prerelease}/)`).test(
    install
  )
) {
  throw new Error("Install page names a different prerelease than the pin");
}
const navigation = await Bun.file(resolve(v5Root, "meta.json")).json();
if (navigation.title !== versions.v5.label) {
  throw new Error("Stale v5 navigation label");
}
for (const file of ["site/public/llms.txt", "site/public/v5/llms.txt"]) {
  const text = await Bun.file(resolve(repositoryRoot, file)).text();
  if (!text.includes(versions.v5.revision)) {
    throw new Error(`Stale v5 release provenance: ${file}`);
  }
}
console.log(
  "Pinned installer, navigation and release-export contracts passed."
);

function assertNoObsoleteInstallRecipe(text: string): void {
  if (
    /(?:python3?\s+[^\n]*(?:install-prerelease\.py|hack-next-install\.py|manager\.py)|--version\s+5\.0\.0-next\.1(?:\s|$))/m.test(
      text
    )
  ) {
    throw new Error("Obsolete Python/next.1 installation recipe promoted");
  }
}
for (const text of [
  "python3 hack-next-install.py install --version 5.0.0-next.1",
  'python3 "$HOME/.hack-next/manager.py" status',
  "sh hack-next-install.sh --version 5.0.0-next.1",
]) {
  let rejected = false;
  try {
    assertNoObsoleteInstallRecipe(text);
  } catch {
    rejected = true;
  }
  if (!rejected) {
    throw new Error("Obsolete installer negative control was accepted");
  }
}
assertNoObsoleteInstallRecipe(
  "The next.1 Python recipe is historical; use the shell bootstrap."
);
for (const file of [
  "site/public/v5/llms-full.txt",
  "site/public/llms-full.txt",
]) {
  assertNoObsoleteInstallRecipe(
    await Bun.file(resolve(repositoryRoot, file)).text()
  );
}
console.log("Python/next.1 recipe negative controls and full exports passed.");
