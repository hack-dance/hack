import { afterEach, describe, expect, test } from "bun:test";
import {
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { renderCliReferenceMarkdown } from "../src/cli/reference.ts";
import { CLI_SPEC } from "../src/cli/spec.ts";
import { fixtureChildren } from "./helpers/fixture-children.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

const DOCS_PATH = resolve(import.meta.dir, "..", "docs", "reference", "cli.md");
const children = fixtureChildren("projected CLI reference");
let scratch: string | undefined;
afterEach(async () => {
  await children.stopAll();
  if (scratch) {
    await rm(scratch, { recursive: true, force: true });
    scratch = undefined;
  }
});

describe("generated CLI reference", () => {
  test("docs/reference/cli.md matches CLI_SPEC (run: bun run docs:cli-reference)", async () => {
    const committed = await Bun.file(DOCS_PATH).text();
    const rendered = renderCliReferenceMarkdown({ cli: CLI_SPEC });
    expect(committed).toBe(rendered);
  });

  test("reference covers every top-level command", () => {
    const rendered = renderCliReferenceMarkdown({ cli: CLI_SPEC });
    for (const command of CLI_SPEC.commands) {
      expect(rendered).toContain(`hack ${command.name}`);
    }
  });

  test("documented generator renders exact source in scratch without changing committed docs", async () => {
    const original = await Bun.file(DOCS_PATH).text();
    scratch = await realpath(
      await mkdtemp(join(tmpdir(), "hack-cli-reference-"))
    );
    await mkdir(join(scratch, "scripts"));
    const source = resolve(
      import.meta.dir,
      "../scripts/generate-cli-reference.ts"
    );
    const script = join(scratch, "scripts/generate-cli-reference.ts");
    await copyFile(source, script);
    await symlink(
      resolve(import.meta.dir, "../src"),
      join(scratch, "src"),
      "dir"
    );
    expect(await Bun.file(script).text()).toBe(await Bun.file(source).text());
    const result = await children.run({
      cmd: [process.execPath, script],
      cwd: scratch,
      env: privateCliEnv({
        root: scratch,
        env: { PATH: join(scratch, "empty-path") },
      }),
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(await Bun.file(join(scratch, "docs/reference/cli.md")).text()).toBe(
      renderCliReferenceMarkdown({ cli: CLI_SPEC })
    );
    expect(await Bun.file(DOCS_PATH).text()).toBe(original);
  });

  test("experimental commands are listed but not expanded", () => {
    const rendered = renderCliReferenceMarkdown({ cli: CLI_SPEC });
    expect(rendered).toContain("## Experimental (unsupported)");
    expect(rendered).not.toContain("## `hack node pair`");
  });
});
