import { afterEach, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addNativeHostAliases } from "../src/backends/native-project-host-aliases.ts";
import { readNativeSelection } from "../src/backends/native-project-selection.ts";
import {
  expectCodedRefusal,
  expectCodedThrow,
} from "./helpers/closed-refusal.ts";

/**
 * Private native selection files and host-alias selections are user
 * configuration: a malformed one is a coded `E_CONFIG_INVALID` refusal, which
 * the CLI prints as one line without a stack.
 */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

test("a malformed or linked selection file is a coded configuration refusal", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-selection-"));
  roots.push(root);
  const malformed = join(root, "malformed.json");
  await writeFile(malformed, "{not json", { mode: 0o600 });
  const linked = join(root, "linked.json");
  await symlink(malformed, linked);
  for (const path of [malformed, linked, "relative.json"]) {
    await expectCodedRefusal(
      readNativeSelection(path),
      "E_CONFIG_INVALID",
      "Native selection requires a bounded, unchanged regular JSON file; values omitted."
    );
  }
});

test("a conflicting host alias selection is a coded configuration refusal", () => {
  for (const selection of [
    [],
    { web: [] },
    { web: ["not a host"] },
    { missing: ["api.example.com"] },
  ]) {
    expectCodedThrow(
      () =>
        addNativeHostAliases({
          services: { web: { image: "busybox" } },
          selection,
        }),
      "E_CONFIG_INVALID",
      "Native host alias selection conflicts with declared configuration; values omitted."
    );
  }
});
