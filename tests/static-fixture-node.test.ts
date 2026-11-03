import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { optionalFixtureNode } from "./helpers/optional-fixture-node.ts";
import { installStaticFixtureNode } from "./helpers/static-fixture-node.ts";

const node = await optionalFixtureNode();

test("missing optional transport leaves the original generated executable byte-identical", async () => {
  const root = await mkdtemp(join(tmpdir(), "static-fixture-original-"));
  try {
    const binary = join(root, "compiler");
    const source = "#!/bin/sh\nexit 97\n";
    await writeFile(binary, source, { mode: 0o700 });
    expect(await installStaticFixtureNode({ binary, node: null })).toBe(false);
    expect(await readFile(binary, "utf8")).toBe(source);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(node === null)(
  "static transport preserves UTF-8 stdin, file JSON and quoted argv without ambient Node loading",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "static fixture's-"));
    try {
      const binary = join(root, "fixture'compiler");
      const data = join(root, "data");
      const missing = join(root, "missing");
      const marker = join(root, "preload-executed");
      const preload = join(root, "preload.cjs");
      await writeFile(
        preload,
        `require('node:fs').writeFileSync(${JSON.stringify(marker)},'reached');process.exit(87);`
      );
      await writeFile(
        binary,
        `#!${process.execPath}\nconst raw=await Bun.stdin.text();await Bun.write(${JSON.stringify(data)},raw);console.log(JSON.stringify({args:process.argv.slice(2),text:await Bun.file(${JSON.stringify(data)}).text(),data:await Bun.file(${JSON.stringify(data)}).json(),missing:await Bun.file(${JSON.stringify(missing)}).exists()}));\n`,
        { mode: 0o700 }
      );
      expect(await installStaticFixtureNode({ binary, node })).toBe(true);
      const value = { text: "Δ 😀", array: [1, 2] };
      const text = JSON.stringify(value);
      const args = ["a b", "'quoted'", "Δ"];
      const child = Bun.spawn([binary, ...args], {
        env: {
          PATH: "/usr/bin:/bin",
          NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
          NODE_PATH: root,
          NODE_V8_COVERAGE: join(root, "coverage"),
        },
        stdin: new TextEncoder().encode(text),
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
        killSignal: "SIGKILL",
      });
      const [output, errors, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).toBe(0);
      expect(errors).toBe("");
      expect(JSON.parse(output)).toEqual({
        args,
        text,
        data: value,
        missing: false,
      });
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(join(root, "coverage"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000
);
