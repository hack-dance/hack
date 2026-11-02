import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLegacyComposeBranch } from "../src/lib/native-compose-adoption-branch.ts";
import { planLegacyComposeAdoption } from "../src/lib/native-compose-adoption-plan.ts";
import * as importInputs from "../src/lib/native-config-import-inputs.ts";
import { mapLegacyNativeBranchStorageAdoption } from "../src/lib/native-config-import-plan.ts";
import { buildRuntimeHostMetadataOverride } from "../src/lib/runtime-host-metadata.ts";

let root: string;
const configText = JSON.stringify({
  name: "fixture",
  dev_host: "fixture.test",
  worktree: { auto_branch: false },
});
const composeText =
  "name: fixture\nservices:\n  db:\n    image: postgres:17\n    volumes: [data:/data]\nvolumes:\n  data: {}\n";

beforeEach(async () => {
  root = await realpath(
    await mkdtemp(join(tmpdir(), "native-adoption-branch-"))
  );
  await mkdir(join(root, ".hack/.branch"), { recursive: true });
  await writeFile(join(root, ".hack/hack.config.json"), configText);
  await writeFile(join(root, ".hack/docker-compose.yml"), composeText);
  const fragment = buildRuntimeHostMetadataOverride({
    composeYamls: [composeText],
    branch: "feature-api",
    devHost: "fixture.test",
    aliasHost: null,
    composeProject: "fixture--feature-api",
  });
  expect(fragment).toBeTruthy();
  await writeFile(
    join(root, ".hack/.branch/compose.feature-api.runtime.override.yml"),
    fragment ?? ""
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("branch candidate keeps authored base while the private intent selects physical originals", async () => {
  const selected = await acquireLegacyComposeBranch({
    root,
    configText,
    composeText,
    requestedBranch: "feature/api",
  });
  expect(selected?.proof.branch).toBe("feature-api");
  expect(selected?.proof.composeProject).toBe("fixture--feature-api");
  expect(selected?.composeFiles).toEqual([
    join(root, ".hack/docker-compose.yml"),
    join(root, ".hack/.branch/compose.feature-api.runtime.override.yml"),
  ]);
  const mapped = mapLegacyNativeBranchStorageAdoption({
    configText,
    composeText,
  });
  expect(mapped.candidate?.name).toBe("fixture");
  const planned = planLegacyComposeAdoption({
    configText,
    composeText,
    selectedComposeProject: selected?.proof.composeProject,
  });
  expect(planned.intent?.composeProject).toBe("fixture--feature-api");
  expect(planned.intent?.volumes).toEqual([
    { storage: "data", name: "fixture--feature-api_data" },
  ]);
});

test("saved branch proof refuses a different selection and changed generated fragment", async () => {
  const selected = await acquireLegacyComposeBranch({
    root,
    configText,
    composeText,
    requestedBranch: "feature/api",
  });
  if (!selected) {
    throw new Error("Expected selected branch");
  }
  await expect(
    acquireLegacyComposeBranch({
      root,
      configText,
      composeText,
      requestedBranch: "other",
      saved: selected.proof,
    })
  ).rejects.toThrow("values omitted");
  const path = join(
    root,
    ".hack/.branch/compose.feature-api.runtime.override.yml"
  );
  await writeFile(path, `${await readFile(path, "utf8")}# changed\n`);
  await expect(
    acquireLegacyComposeBranch({
      root,
      configText,
      composeText,
      requestedBranch: "feature/api",
      saved: selected.proof,
    })
  ).rejects.toThrow("values omitted");
});

test("extra generated branch input is refused before it can become an implicit Compose file", async () => {
  await writeFile(
    join(root, ".hack/.branch/compose.other.override.yml"),
    "services: {}\n"
  );
  await expect(
    acquireLegacyComposeBranch({
      root,
      configText,
      composeText,
      requestedBranch: "feature/api",
    })
  ).rejects.toThrow("values omitted");
});

test("a same-inode branch directory permission drift refuses a saved owner", async () => {
  const selected = await acquireLegacyComposeBranch({
    root,
    configText,
    composeText,
    requestedBranch: "feature/api",
  });
  if (!selected) {
    throw new Error("Expected selected branch");
  }
  const directory = join(root, ".hack/.branch");
  const original = await lstat(directory);
  const read = importInputs.readNativeConfigImportSourceFile;
  const reader = spyOn(importInputs, "readNativeConfigImportSourceFile");
  let reads = 0;
  reader.mockImplementation(async (options) => {
    const result = await read(options);
    reads++;
    if (reads === 1) {
      await chmod(directory, 0o777);
      const changed = await lstat(directory);
      expect(changed.dev).toBe(original.dev);
      expect(changed.ino).toBe(original.ino);
    }
    return result;
  });
  try {
    await expect(
      acquireLegacyComposeBranch({
        root,
        configText,
        composeText,
        requestedBranch: "feature/api",
        saved: selected.proof,
      })
    ).rejects.toThrow("values omitted");
    expect(reads).toBe(1);
  } finally {
    reader.mockRestore();
    await chmod(directory, original.mode & 0o777);
  }
});
