import { mkdir, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import versions from "./versions.json";
let activeRevision = versions.v5.revision;
let activeFiles: readonly string[] = versions.v5.publicFiles;

export const repositoryRoot = resolve(import.meta.dir, "../..");
const canonicalDocsRoot = resolve(repositoryRoot, "docs");
const output = resolve(repositoryRoot, "site/content/docs");
const heading = /^#\s+(.+)$/m;
const links = /(!?\[[^\]\n]*\]\()([^\s)]+)([^)]*\))/g;
const definitions = /^(\s{0,3}\[[^\]\n]+\]:\s*)(\S+)(.*)$/gm;
const privatePath =
  /(?:^|\/)(?:_docs|\.hack-local|\.claude|\.codex|test-execution|node_modules|_internal|internal|evidence)(?:\/|$)/i;
const external = /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i;
const routes = new Map<string, string>();

/** Reject invalid manifest paths before any source file is opened. */
export function resolvePublicSource(file: string): string {
  const source = resolve(repositoryRoot, file);
  const local = relative(canonicalDocsRoot, source);
  if (
    isAbsolute(local) ||
    local === "" ||
    local === ".." ||
    local.startsWith(`..${sep}`) ||
    !/^docs\/(?:[a-z\d][a-z\d-]*\/)*[a-z\d][a-z\d-]*\.md$/i.test(file) ||
    privatePath.test(file)
  ) {
    throw new Error(`Invalid public source: ${file}`);
  }
  return source;
}

/** Local links may point to staged docs or existing tracked public repository files. */
export async function rewriteTarget(
  target: string,
  source: string
): Promise<string> {
  if (external.test(target)) {
    if (
      /^(?:javascript|data|file):/i.test(target) ||
      privatePath.test(decodeURIComponent(target))
    ) {
      throw new Error(`Forbidden external public link: ${target}`);
    }
    return target;
  }
  const hash = target.indexOf("#");
  const file = hash < 0 ? target : target.slice(0, hash);
  const fragment = hash < 0 ? "" : target.slice(hash);
  const absolute = resolve(dirname(source), decodeURIComponent(file));
  const local = relative(repositoryRoot, absolute).split(sep).join("/");
  if (local.startsWith("../") || privatePath.test(local)) {
    throw new Error(
      `Forbidden public link: ${target} in ${relative(repositoryRoot, source)}`
    );
  }
  if (routes.has(absolute)) {
    return `${routes.get(absolute)}${fragment}`;
  }
  if (!activeFiles.includes(local))
    throw new Error(`Missing public source at pinned revision: ${local}`);
  const encoded = local.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/hack-dance/hack/blob/${activeRevision}/${encoded}${fragment}`;
}

async function rewriteLinks(content: string, source: string): Promise<string> {
  // Keep command/code examples byte-for-byte. Only prose links are navigational.
  let fenced = false;
  const result: string[] = [];
  for (const line of content.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
    }
    if (fenced) {
      result.push(line);
      continue;
    }
    let rewritten = line;
    for (const pattern of [links, definitions]) {
      for (const match of [...rewritten.matchAll(pattern)]) {
        const target = match[2];
        if (!target) {
          continue;
        }
        const replacement = await rewriteTarget(target, source);
        rewritten = rewritten.replace(
          match[0],
          `${match[1]}${replacement}${match[3]}`
        );
      }
    }
    result.push(rewritten);
  }
  return result.join("\n");
}

async function writeOrCheck(
  path: string,
  text: string,
  check: boolean
): Promise<void> {
  if (check) {
    if ((await Bun.file(path).text()) !== text) {
      throw new Error(
        `Stale generated file: ${relative(repositoryRoot, path)}`
      );
    }
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, text);
}

async function writeDocuments(
  staged: Map<string, string>,
  check: boolean
): Promise<void> {
  if (check) {
    const existing = [
      ...new Bun.Glob("**/*").scanSync({ cwd: output, onlyFiles: true }),
    ].sort();
    if (
      JSON.stringify(existing) !== JSON.stringify([...staged.keys()].sort())
    ) {
      throw new Error("Staged corpus differs; run bun run docs:prepare");
    }
  } else {
    await rm(output, { recursive: true, force: true });
  }
  for (const [name, text] of staged) {
    await writeOrCheck(resolve(output, name), text, check);
  }
}

export async function prepare(check = false): Promise<void> {
  const staged = new Map<string, string>();
  const exports = new Map<string, string>();
  for (const version of ["v5", "v4"] as const) {
    const manifest = versions[version];
    activeRevision = manifest.revision;
    activeFiles = manifest.publicFiles;
    routes.clear();
    for (const entry of manifest.entries)
      routes.set(
        resolvePublicSource(entry.file),
        `/docs/${version}${entry.slug === "index" ? "" : "/" + entry.slug}`
      );
    for (const { slug } of manifest.editorial)
      routes.set(
        resolvePublicSource(`docs/site/${slug}.md`),
        `/docs/${version}${slug === "index" ? "" : "/" + slug}`
      );
    const index = [
      `# Hack ${manifest.label}`,
      "",
      `Source revision: ${manifest.revision}`,
      "",
    ];
    const corpus: string[] = [];
    const entries = manifest.entries.filter(
      (entry) => !["index", "getting-started"].includes(entry.slug)
    );
    const pages = [
      ...entries.map((entry) => ({ ...entry, editorial: false })),
      ...manifest.editorial.map(({ slug, title }) => ({
        file: `docs/site/${slug}.md`,
        slug,
        title,
        snapshot: `docs/versions/${version}/${slug}.md`,
        sha256: "",
        editorial: true,
      })),
    ];
    for (const entry of pages) {
      const snapshot = resolvePublicSource(entry.snapshot);
      if ((await realpath(snapshot)) !== snapshot)
        throw new Error(`Snapshot follows symlink: ${entry.snapshot}`);
      const raw = await Bun.file(snapshot).text();
      if (
        !entry.editorial &&
        new Bun.CryptoHasher("sha256").update(raw).digest("hex") !==
          entry.sha256
      )
        throw new Error(`Source snapshot changed: ${entry.snapshot}`);
      const text = (
        await rewriteLinks(raw, resolvePublicSource(entry.file))
      ).replace(/dogfooding/gi, "native runtime use");
      const url = `https://hack.foo/docs/${version}${entry.slug === "index" ? "" : "/" + entry.slug}`;
      const provenance = entry.editorial
        ? `Editorial source: ${entry.snapshot}; based on ${manifest.revision}`
        : `Original: ${entry.file}; revision: ${manifest.revision}; SHA-256: ${entry.sha256}`;
      staged.set(
        `${version}/${entry.slug}.md`,
        `---\ntitle: ${JSON.stringify(entry.title)}\n---\n\n${text.replace(heading, "").trim()}\n\n---\n\nSource: [${manifest.label} · ${entry.file}](https://github.com/hack-dance/hack/blob/${manifest.revision}/${entry.editorial ? "README.md" : entry.file}).\n`
      );
      index.push(`- [${entry.title}](${url})`);
      corpus.push(`<!-- ${provenance}; URL: ${url} -->\n${text}`);
    }
    staged.set(
      `${version}/meta.json`,
      JSON.stringify({
        title: manifest.label,
        pages: [
          "index",
          "install",
          "getting-started",
          "core",
          "env",
          "lifecycle",
          "sessions",
          "agent-handoff",
          "guides",
          "integrations",
          "cli",
          "architecture",
          "reference",
        ],
      })
    );
    for (const folder of ["guides", "reference"])
      staged.set(
        `${version}/${folder}/meta.json`,
        JSON.stringify({
          title: folder === "guides" ? "Guides" : "Reference",
          pages: pages
            .filter((entry) => entry.slug.startsWith(folder + "/"))
            .map((entry) => entry.slug.slice(folder.length + 1)),
        })
      );
    exports.set(`${version}/llms.txt`, index.join("\n") + "\n");
    exports.set(`${version}/llms-full.txt`, corpus.join("\n\n---\n\n") + "\n");
  }
  staged.set("meta.json", JSON.stringify({ pages: ["v5", "v4"] }));
  await writeDocuments(staged, check);
  for (const [name, text] of exports) {
    await writeOrCheck(
      resolve(repositoryRoot, "site/public", name),
      text,
      check
    );
  }
  for (const name of ["llms.txt", "llms-full.txt"])
    await writeOrCheck(
      resolve(repositoryRoot, "site/public", name),
      exports.get(`v5/${name}`)!,
      check
    );
  console.log(
    `${check ? "Checked" : "Staged"} versioned allowlisted public documents, navigation and LLM corpus.`
  );
}
if (import.meta.main) {
  await prepare();
}
