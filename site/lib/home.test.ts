import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import rootPackage from "../../package.json";
import { pinnedBootstrapText } from "../../scripts/docs/prepare";
import versions from "../../scripts/docs/versions.json";
import {
  description,
  descriptionParts,
  installCommand,
  prereleaseTag,
  releaseUrl,
  stableInstallCommand,
  stableTag,
  tagline,
  taglineLines,
} from "./home";

const repository = resolve(import.meta.dirname, "../..");

test("the headline and description are the published ones", () => {
  expect(tagline).toBe("Hack on your project, not your setup");
  expect(description).toBe(
    "One command starts your API, your database and the tunnel to staging, and catches the sign-in you forgot. Every branch gets its own running copy. One config, any machine. Docker optional."
  );
});

test("the page's pieces of the headline and description add up to the metadata", () => {
  expect(taglineLines.join(" ")).toBe(tagline);
  expect(Object.values(descriptionParts).join(" ")).toBe(description);
  expect(description).toContain(descriptionParts.emphasis);
});

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
    await readFile(resolve(repository, "docs/versions/v5/install.md"), "utf8"),
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

test("the stable install command is the one the README and the v4 install page give", async () => {
  for (const file of ["README.md", "docs/versions/v4/install.md"]) {
    const lines = (await readFile(resolve(repository, file), "utf8")).split(
      "\n"
    );
    expect(lines).toContain(stableInstallCommand);
  }
});

test("a plain release version gives the stable tag", () => {
  expect(stableTag("4.3.1")).toBe("v4.3.1");
  expect(stableTag("4.10.0")).toBe("v4.10.0");
});

test("a version that is not a plain release gives no stable tag", () => {
  for (const version of [
    "5.0.0-next.22",
    "4.3.1+build.2",
    "v4.3.1",
    "4.3",
    "",
  ]) {
    expect(stableTag(version)).toBeUndefined();
  }
});

test("the root package gives the stable eyebrow, or none", () => {
  const tag = stableTag(rootPackage.version);
  expect([undefined, `v${rootPackage.version}`]).toContain(tag);
  expect(tag).not.toBe(prereleaseTag(versions.v5.label));
});

test("the eyebrow links to the release page of a tag", () => {
  expect(releaseUrl("v4.3.1")).toBe(
    "https://github.com/hack-dance/hack/releases/tag/v4.3.1"
  );
  // A release page is not an installer download, which must stay pinned.
  expect(releaseUrl("v5.0.0-next.22")).not.toContain("releases/download/");
});
