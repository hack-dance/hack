import { mkdir, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { documents } from "./manifest";

export const repositoryRoot = resolve(import.meta.dir, "../..");
const canonicalDocsRoot = resolve(repositoryRoot, "docs");
const output = resolve(repositoryRoot, "site/content/docs");
const heading = /^#\s+(.+)$/m;
const links = /(!?\[[^\]\n]*\]\()([^\s)]+)([^)]*\))/g;
const definitions = /^(\s{0,3}\[[^\]\n]+\]:\s*)(\S+)(.*)$/gm;
const privatePath =
  /(?:^|\/)(?:_docs|\.hack-local|\.claude|\.codex|test-execution|node_modules|_internal|internal|evidence)(?:\/|$)/i;
const external = /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i;
const routes = new Map<string, string>(
  documents.map(([file, slug]) => [
    resolvePublicSource(file),
    `/docs${slug === "index" ? "" : `/${slug}`}`,
  ])
);

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
  const tracked = Bun.spawnSync(
    ["git", "ls-files", "--error-unmatch", "--", local],
    { cwd: repositoryRoot, stdout: "ignore", stderr: "ignore", timeout: 5000 }
  );
  if (tracked.exitCode !== 0) {
    throw new Error(`Missing or untracked public link: ${local}`);
  }
  const actual = await realpath(absolute);
  if (actual !== absolute) {
    throw new Error(`Public link follows a symlink: ${local}`);
  }
  const encoded = local.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/hack-dance/hack/blob/next/${encoded}${fragment}`;
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
  const corpus: string[] = [];
  const index = [
    "# Hack",
    "",
    "Local-first CLI documentation. Stable Compose setup comes first; native v5 is experimental.",
    "",
  ];
  for (const [file, slug, title] of documents) {
    if (!/^[a-z\d]+[a-z\d-]*(?:\/[a-z\d]+[a-z\d-]*)*$/.test(slug)) {
      throw new Error(`Invalid public document: ${file}`);
    }
    const source = resolvePublicSource(file);
    if ((await realpath(source)) !== source) {
      throw new Error(`Public source follows a symlink: ${file}`);
    }
    const text = await rewriteLinks(await Bun.file(source).text(), source);
    const destination = `${slug}.md`;
    if (staged.has(destination)) {
      throw new Error(`Duplicate route: ${slug}`);
    }
    staged.set(
      destination,
      `---\ntitle: ${JSON.stringify(title)}\n---\n\n${text.replace(heading, "").trim()}\n`
    );
    const url = `https://hack.foo${routes.get(source)}`;
    index.push(`- [${title}](${url})`);
    corpus.push(`<!-- Source: ${file}; URL: ${url} -->\n${text}`);
  }
  staged.set(
    "meta.json",
    JSON.stringify(
      {
        title: "Hack",
        pages: [
          "index",
          "guides",
          "core",
          "env",
          "lifecycle",
          "sessions",
          "integrations",
          "agent-guidance",
          "cli",
          "architecture",
          "reference",
        ],
      },
      null,
      2
    )
  );
  staged.set(
    "guides/meta.json",
    JSON.stringify(
      {
        title: "Guides",
        pages: documents
          .filter(([, slug]) => slug.startsWith("guides/"))
          .map(([, slug]) => slug.slice(7)),
      },
      null,
      2
    )
  );
  staged.set(
    "reference/meta.json",
    JSON.stringify(
      {
        title: "Reference",
        pages: ["cli", "native-config-import", "native-authored-commands"],
      },
      null,
      2
    )
  );
  await writeDocuments(staged, check);
  const exports = new Map([
    ["llms.txt", `${index.join("\n")}\n`],
    ["llms-full.txt", `${corpus.join("\n\n---\n\n")}\n`],
  ]);
  for (const [name, text] of exports) {
    await writeOrCheck(
      resolve(repositoryRoot, "site/public", name),
      text,
      check
    );
  }
  console.log(
    `${check ? "Checked" : "Staged"} ${documents.length} allowlisted public documents, navigation and LLM corpus.`
  );
}
if (import.meta.main) {
  await prepare();
}
