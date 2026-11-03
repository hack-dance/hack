import { rename, writeFile } from "node:fs/promises";

/** Filesystem/stdin subset consumed by the generated static stand-ins. Their
 * parents already exist and writes have no consumed return value. */
const NODE_FIXTURE_IO = `import * as fixtureFs from "node:fs/promises";
const Bun = {
 file(path) { return {
  async exists() { try { return (await fixtureFs.stat(path)).isFile(); }
   catch(error) { if(error.code === "ENOENT" || error.code === "ENOTDIR") return false; throw error; } },
  async text() { return await fixtureFs.readFile(path, "utf8"); },
  async json() { return JSON.parse(await fixtureFs.readFile(path, "utf8")); }
 }; },
 async write(path, value) { await fixtureFs.writeFile(path, value); },
 stdin: { async text() { const chunks=[]; for await(const chunk of process.stdin) chunks.push(chunk); return Buffer.concat(chunks).toString("utf8"); } }
};
`;
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Optional transport for generated stand-ins whose inputs are argv, stdin
 * and fixture files, never inherited environment. Resolve Node before fixture
 * PATH changes. An absent runtime leaves the original Bun executable untouched.
 * The owning production code still controls process groups, IO and deadlines.
 */
export async function installStaticFixtureNode(opts: {
  readonly binary: string;
  readonly node: string | null;
}): Promise<boolean> {
  if (!opts.node) {
    return false;
  }
  const original = await Bun.file(opts.binary).text();
  const source = `${opts.binary}.node.mjs`;
  await writeFile(
    source,
    NODE_FIXTURE_IO + original.replace(/^#![^\n]*\n/, ""),
    {
      mode: 0o600,
    }
  );
  const wrapper = `${opts.binary}.node-wrapper`;
  await writeFile(
    wrapper,
    `#!/bin/sh\nexec /usr/bin/env -i PATH=/usr/bin:/bin ${quote(opts.node)} ${quote(source)} "$@"\n`,
    { mode: 0o700 }
  );
  await rename(wrapper, opts.binary);
  return true;
}
