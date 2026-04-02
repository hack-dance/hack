import { expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  DEV_WRAPPER_MARKER,
  detectHackInstall,
  isHomebrewManagedHackPath,
} from "../src/lib/self-update.ts";

test("isHomebrewManagedHackPath detects common Homebrew hack locations", () => {
  expect(isHomebrewManagedHackPath("/opt/homebrew/bin/hack")).toBe(true);
  expect(
    isHomebrewManagedHackPath("/opt/homebrew/Cellar/hack/2.3.0/bin/hack")
  ).toBe(true);
  expect(isHomebrewManagedHackPath("/usr/local/opt/hack/bin/hack")).toBe(true);
  expect(isHomebrewManagedHackPath("/Users/hack/.hack/bin/hack")).toBe(false);
});

test("detectHackInstall classifies Homebrew symlink installs", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-homebrew-install-"));
  const cellarBin = resolve(root, "opt/homebrew/Cellar/hack/2.3.0/bin");
  const prefixBin = resolve(root, "opt/homebrew/bin");

  await mkdir(cellarBin, { recursive: true });
  await mkdir(prefixBin, { recursive: true });

  const target = resolve(cellarBin, "hack");
  const link = resolve(prefixBin, "hack");
  await writeFile(target, "binary");
  await symlink(target, link);

  const install = await detectHackInstall({ path: link });
  expect(install).toEqual({
    status: "present",
    kind: "homebrew",
    path: link,
    linkTarget: target,
  });
});

test("detectHackInstall classifies local-dev wrapper installs", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-dev-wrapper-"));
  const path = resolve(root, "hack");
  await writeFile(
    path,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `# ${DEV_WRAPPER_MARKER} (auto-generated)`,
      'exec bun /repo/index.ts "$@"',
      "",
    ].join("\n")
  );

  const install = await detectHackInstall({ path });
  expect(install).toEqual({
    status: "present",
    kind: "dev-wrapper",
    path,
  });
});

test("detectHackInstall classifies standalone release binaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-standalone-install-"));
  const path = resolve(root, "hack");
  await writeFile(path, "not-a-wrapper");

  const install = await detectHackInstall({ path });
  expect(install).toEqual({
    status: "present",
    kind: "standalone",
    path,
  });
});
