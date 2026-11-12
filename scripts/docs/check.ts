import { resolve } from "node:path";
import { agentCompatibilityCommands, curateCliReference } from "./curate-cli";
import { assertPinnedInstallers } from "./installer-pin";
import {
  pinnedBootstrapText,
  prepare,
  publishedTerminology,
  repositoryRoot,
  resolveEditorialSource,
  resolvePublicSource,
  rewriteTarget,
} from "./prepare";
import { readmeDiagrams } from "./readme-diagrams";
import { isVersionedSearchUrl } from "./version-boundary";
import versions from "./versions.json";

await readmeDiagrams({ check: true });
await prepare(true);
// Prose labels are normalized; source citations and filenames retain their bytes.
for (const [input, expected] of [
  ["Dogfooding.", "native runtime use."],
  ["Dogfooding guide", "native runtime use guide"],
  ["docs/guides/v5-dogfooding.md", "docs/guides/v5-dogfooding.md"],
  ["dogfooding.md", "dogfooding.md"],
] as const) {
  if (publishedTerminology(input) !== expected) {
    throw new Error(`Editorial terminology boundary failed: ${input}`);
  }
}
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
  "../example",
  "../examples/not-a-tracked-directory",
  "site/not-a-manifest-page.md",
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

if (
  (await rewriteTarget("../examples", source)) !==
  `https://github.com/hack-dance/hack/tree/${versions.v4.revision}/examples`
) {
  throw new Error("Tracked directory links must use pinned repository trees");
}
console.log("Tracked directory links and untracked-prefix refusals passed.");
if (
  (await rewriteTarget(
    "reference/cli.md",
    resolve(repositoryRoot, "docs/site/index.md")
  )) !== "/docs/v4/reference/cli"
) {
  throw new Error("Editorial links must survive replacement by snapshots");
}

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
    publishedTerminology(corpus) !== corpus
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

/** Keep the upgrade checklist published, with its current-source citations intact. */
const upgradeChecklist = await Bun.file(
  resolve(v5Root, "guides/upgrade-from-v4.md")
).text();
for (const fact of [
  "to be confirmed in the dogfood run",
  "HACK_RUNTIME_BACKEND=compose",
  "26a142921c9b9aeb8821b7e0a19c2cfb3be0189f/docs/guides/v5-dogfooding.md",
]) {
  if (!upgradeChecklist.includes(fact)) {
    throw new Error(`Upgrade checklist contract missing: ${fact}`);
  }
}
const guideNavigation: unknown = JSON.parse(
  await Bun.file(resolve(v5Root, "guides/meta.json")).text()
);
if (
  !(
    typeof guideNavigation === "object" &&
    guideNavigation !== null &&
    "pages" in guideNavigation &&
    Array.isArray(guideNavigation.pages) &&
    guideNavigation.pages.includes("upgrade-from-v4")
  )
) {
  throw new Error("Upgrade checklist missing from guide navigation");
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
// Installer artifacts and version variables must all select the release pin.
const stagedV5 = resolve(repositoryRoot, "site/content/docs/v5");
const installerTag = `v5.0.0-next.${prerelease}`;
for (const file of new Bun.Glob("**/*.md").scanSync({ cwd: stagedV5 })) {
  assertPinnedInstallers({
    text: await Bun.file(resolve(stagedV5, file)).text(),
    tag: installerTag,
    source: `Published v5 page ${file}`,
  });
}
// The live install examples must name the same prerelease, so the repository
// docs and the site never tell a reader to install different versions.
// The `V=5.0.0-next.N` shell variable used by install and setup examples.
const liveDocs = resolve(repositoryRoot, "docs");
for (const file of new Bun.Glob("**/*.md").scanSync({ cwd: liveDocs })) {
  if (file.startsWith("versions/")) {
    continue;
  }
  assertPinnedInstallers({
    text: await Bun.file(resolve(liveDocs, file)).text(),
    tag: installerTag,
    source: `docs/${file}`,
  });
}
for (const text of [
  "releases/download/v5.0.0-next.1/hack-next-install.sh",
  "releases/download/v4.2.4/hack-next-install.sh?download=1",
  "releases/download/unexpected/hack-next-manager-darwin-arm64)",
  "releases/download/v5.0.0-next.1/INSTALLER-SHA256SUMS",
  "V=5.0.0-next.1 # installed version",
]) {
  let rejected = false;
  try {
    assertPinnedInstallers({
      text,
      tag: installerTag,
      source: "negative control",
    });
  } catch {
    rejected = true;
  }
  if (!rejected) {
    throw new Error(`Stale installer control accepted: ${text}`);
  }
}

if (
  pinnedBootstrapText(
    "releases/download/v5.0.0-next.1/hack-next-install.sh",
    `v5 (next.${prerelease})`
  ) !== `releases/download/v5.0.0-next.${prerelease}/hack-next-install.sh` ||
  pinnedBootstrapText(
    "releases/download/v5.0.0-next.1/other.sh",
    "v5 (next.9)"
  ) !== "releases/download/v5.0.0-next.1/other.sh"
) {
  throw new Error("Bootstrap pinning control failed");
}
for (const artifact of [
  "hack-next-install.sh",
  "hack-next-manager-darwin-arm64",
  "INSTALLER-SHA256SUMS",
]) {
  for (const suffix of [
    "",
    ")",
    "?download=1",
    "#checksum",
    "<",
    "&download",
  ]) {
    const input = `releases/download/v5.0.0-next.1/${artifact}${suffix}`;
    const rewritten = pinnedBootstrapText(input, versions.v5.label);
    if (
      rewritten !== `releases/download/${installerTag}/${artifact}${suffix}`
    ) {
      throw new Error(`Installer artifact pinning failed: ${input}`);
    }
    assertPinnedInstallers({
      text: rewritten,
      tag: installerTag,
      source: input,
    });
  }
}
if (
  pinnedBootstrapText(
    "V=5.0.0-next.1 # installed version",
    `v5 (next.${prerelease})`
  ) !== `V=5.0.0-next.${prerelease} # installed version`
) {
  throw new Error("Installer version-variable pinning failed");
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
const recipeNavigation = await Bun.file(
  resolve(v5Root, "recipes/meta.json")
).json();
const nativeNavigation = await Bun.file(
  resolve(v5Root, "native/meta.json")
).json();
const nativePreflightIndex = nativeNavigation.pages.indexOf("preflight");
if (
  nativePreflightIndex < 1 ||
  nativeNavigation.pages[nativePreflightIndex - 1] !== "try-it"
) {
  throw new Error("Native preflight must follow Try it in navigation");
}
for (const [file, facts] of [
  ["architecture.md", ["proxy network", "proxy_network", "hack global up"]],
  ["reference/cli.md", ["--native-preflight"]],
  ["native/preflight.md", ["runtime_review.status", "ready: false"]],
  ["guides/proxy-network-repair.md", ["hack global up", "ok: null"]],
] as const) {
  const text = await Bun.file(resolve(v5Root, file)).text();
  for (const fact of facts) {
    if (!text.includes(fact)) {
      throw new Error(`Pinned release feature missing: ${file}/${fact}`);
    }
  }
}
if (
  JSON.stringify(recipeNavigation.pages) !==
  JSON.stringify([
    "overview",
    "cli-sign-in",
    "tunnels",
    "remote-database",
    "migrations",
    "environments",
    "deps-service",
    "dependency-directories",
    "cleanup",
    "config-examples",
    "common-pitfalls",
  ])
) {
  throw new Error(
    "Recipe navigation must keep its reading order across source types"
  );
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
