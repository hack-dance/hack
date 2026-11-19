import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pinnedBootstrapText } from "../../scripts/docs/prepare";
import versions from "../../scripts/docs/versions.json";
import { installCommand, prereleaseTag } from "./home";

test("the manifest label gives the pinned prerelease tag", () => {
  expect(prereleaseTag("v5 (next.16)")).toBe("v5.0.0-next.16");
  expect(prereleaseTag("v5 (next.22)")).toBe("v5.0.0-next.22");
});

test("a label without a prerelease number fails instead of guessing", () => {
  for (const label of ["v5", "v5.0.0", "v4.2.4", "v5 (beta.1)", ""]) {
    expect(() => prereleaseTag(label)).toThrow();
  }
});

test("the install block is the pinned install page's own commands", async () => {
  const tag = prereleaseTag(versions.v5.label);
  const page = pinnedBootstrapText(
    await readFile(
      resolve(import.meta.dirname, "../../docs/versions/v5/install.md"),
      "utf8"
    ),
    versions.v5.label
  );
  const lines = installCommand(tag).split("\n");
  expect(lines.length).toBe(5);
  for (const line of lines) {
    expect(page).toContain(line);
  }
  // The page shows these five lines in this order, as one block.
  expect(page).toContain(installCommand(tag));
});
