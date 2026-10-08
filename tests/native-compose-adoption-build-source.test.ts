import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLegacyComposeBuildSource,
  assertSavedLegacyComposeBuildSource,
} from "../src/lib/native-compose-adoption-build.ts";
import { legacyComposeBuildIgnore } from "../src/lib/native-compose-adoption-build-ignore.ts";
import * as importInputs from "../src/lib/native-config-import-inputs.ts";
import { acquireLegacyAdoptionSourceInputs } from "../src/lib/native-config-import-inputs.ts";
import {
  mapLegacyNativeAdoptionBaseline,
  mapLegacyNativeImport,
  mapLegacyNativeRetainedBasicBuild,
  mapLegacyNativeStorageAdoption,
} from "../src/lib/native-config-import-plan.ts";
import { restoreEnv } from "./helpers/env.ts";

const CANARY = "synthetic-private-build-source";
let root: string;
let composeText: string;
let previousCi: string | undefined;
let previousExecutionMode: string | undefined;
beforeEach(async () => {
  previousCi = process.env.CI;
  previousExecutionMode = process.env.HACK_EXECUTION_MODE;
  // These inherited-input cases intentionally exercise the ordinary local
  // selection rather than CI/slim's existing primary-scope opt-out.
  process.env.CI = "";
  process.env.HACK_EXECUTION_MODE = "";
  root = await realpath(
    await mkdtemp(join(tmpdir(), "retained-build-source-"))
  );
  await mkdir(join(root, ".hack"));
  await mkdir(join(root, ".git"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/marker"), CANARY);
  await writeFile(join(root, "Dockerfile"), "FROM scratch\nCOPY src /source\n");
  await writeFile(join(root, ".dockerignore"), "**\n!Dockerfile\n!src\n");
  await writeFile(join(root, ".hack/hack.config.json"), '{"name":"fixture"}');
  composeText = JSON.stringify({
    name: "fixture",
    services: { db: { build: "..", volumes: ["data:/data"] } },
    volumes: { data: {} },
  });
  await writeFile(join(root, ".hack/docker-compose.yml"), composeText);
});
afterEach(async () => {
  restoreEnv("CI", previousCi);
  restoreEnv("HACK_EXECUTION_MODE", previousExecutionMode);
  await rm(root, { recursive: true, force: true });
});
async function acquire(signal?: AbortSignal) {
  const source = await acquireLegacyAdoptionSourceInputs({
    projectRoot: root,
    signal,
    allowLinkedWorktree: true,
  });
  if (!source.ok) {
    throw new Error("Synthetic source setup refused; values omitted.");
  }
  return await acquireLegacyComposeBuildSource({ source, signal });
}
async function red(pending: Promise<unknown>) {
  try {
    await pending;
    throw new Error("unexpected build source admission");
  } catch (error) {
    expect(String(error)).toContain("values omitted");
    expect(String(error)).not.toContain(root);
    expect(String(error)).not.toContain(CANARY);
    expect(JSON.stringify(error)).not.toContain(CANARY);
  }
}
async function linkedSource() {
  async function git(args: readonly string[]) {
    const child = Bun.spawn(["/usr/bin/git", "-C", root, ...args], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    });
    if ((await child.exited) !== 0) {
      throw new Error("Synthetic linked source setup refused; values omitted.");
    }
  }
  await git(["init", "--quiet", "-b", "main"]);
  await git(["add", ".hack", "Dockerfile", ".dockerignore", "src"]);
  await git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  const checkout = join(root, "linked");
  await git(["worktree", "add", "--quiet", "-b", "linked", checkout]);
  const source = await acquireLegacyAdoptionSourceInputs({
    projectRoot: checkout,
    allowLinkedWorktree: true,
  });
  if (!source.ok) {
    throw new Error("Synthetic linked source setup refused; values omitted.");
  }
  return source;
}

test("retained pure intent does not broaden either image-only baseline API", () => {
  const inputs = { configText: '{"name":"fixture"}', composeText };
  expect(mapLegacyNativeAdoptionBaseline(inputs).candidate).toBeUndefined();
  expect(mapLegacyNativeStorageAdoption(inputs).candidate).toBeUndefined();
  expect(mapLegacyNativeRetainedBasicBuild(inputs).candidate).toMatchObject({
    services: { db: { build: { context: "." } } },
  });
});
test("retained mapper explicitly projects non-enumerable private source fields", async () => {
  const source = await acquireLegacyAdoptionSourceInputs({ projectRoot: root });
  if (!source.ok) {
    throw new Error("Synthetic source setup refused; values omitted.");
  }
  expect(Object.keys(source)).not.toContain("composeText");
  expect(mapLegacyNativeRetainedBasicBuild(source).candidate).toEqual(
    mapLegacyNativeRetainedBasicBuild({
      configText: source.configText,
      composeText: source.composeText,
    }).candidate
  );
  expect(mapLegacyNativeRetainedBasicBuild(source).candidate).toMatchObject({
    services: { db: { build: { context: "." } } },
  });
});
test.each([
  ["one-shot", false],
  ["one-shot", true],
  ["completed", false],
  ["completed", true],
] as const)("preview-qualified %s build job (inactive=%s) cannot acquire retained build source", async (kind, inactive) => {
  const db = {
    build: "..",
    ...(inactive ? { profiles: ["later"] } : {}),
    ...(kind === "one-shot"
      ? { labels: { "hack.service.one-shot": "true" } }
      : {}),
  };
  composeText = JSON.stringify({
    name: "fixture",
    services: {
      db,
      ...(kind === "completed"
        ? {
            web: {
              image: "fixture",
              depends_on: {
                db: { condition: "service_completed_successfully" },
              },
            },
          }
        : {}),
    },
  });
  await writeFile(join(root, ".hack/docker-compose.yml"), composeText);
  const inputs = { configText: '{"name":"fixture"}', composeText };
  expect(mapLegacyNativeImport(inputs).report.complete).toBe(true);
  const retained = mapLegacyNativeRetainedBasicBuild(inputs);
  expect(retained.candidate).toBeUndefined();
  expect(retained.report.fields).toContainEqual(
    expect.objectContaining({
      pointer: "/services/db",
      status: "refused",
      code: "completed_job_adoption_unqualified",
    })
  );
  const source = await acquireLegacyAdoptionSourceInputs({
    projectRoot: root,
  });
  if (!source.ok) {
    throw new Error("Synthetic source setup refused; values omitted.");
  }
  const reader = spyOn(importInputs, "readNativeConfigImportSourceFile");
  try {
    await red(acquireLegacyComposeBuildSource({ source }));
    expect(reader).not.toHaveBeenCalled();
  } finally {
    reader.mockRestore();
  }
});
test("root context pins included source and keeps private proof/candidate/callbacks out of reports", async () => {
  const captured = await acquire();
  expect(Object.keys(captured)).toEqual([]);
  expect(JSON.stringify(captured)).toBe("{}");
  expect(Object.isFrozen(captured.proof)).toBe(true);
  expect(JSON.stringify(captured.proof)).not.toContain(CANARY);
  await captured.assertFresh();
  await assertSavedLegacyComposeBuildSource({
    projectRoot: root,
    configText: '{"name":"fixture"}',
    composeText,
    proof: captured.proof,
    checkOwner: async () => {},
  });
});
test.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
] as const)("preview-qualified owned bridge build (internal=%s, inactive=%s) refuses retained source before context reads", async (internal, inactive) => {
  composeText = JSON.stringify({
    name: "fixture",
    services: {
      db: {
        build: "..",
        ...(inactive ? { profiles: ["later"] } : {}),
        networks: { private: { aliases: ["db-reader"] } },
      },
    },
    networks: { private: { driver: "bridge", internal } },
  });
  await writeFile(join(root, ".hack/docker-compose.yml"), composeText);
  const inputs = { configText: '{"name":"fixture"}', composeText };
  const preview = mapLegacyNativeImport(inputs);
  expect(preview.report.complete).toBe(true);
  expect(preview.candidate).toMatchObject({
    services: {
      db: {
        build: { context: "." },
        networks: { private: { aliases: ["db-reader"] } },
      },
    },
    networks: { private: { internal } },
  });
  const retained = mapLegacyNativeRetainedBasicBuild(inputs);
  expect(retained.candidate).toBeUndefined();
  expect(retained.report.fields).toContainEqual(
    expect.objectContaining({
      pointer: "/networks",
      status: "refused",
      code: "retained_build_network_adoption_unqualified",
    })
  );
  const source = await acquireLegacyAdoptionSourceInputs({ projectRoot: root });
  if (!source.ok) {
    throw new Error("Synthetic source setup refused; values omitted.");
  }
  const reader = spyOn(importInputs, "readNativeConfigImportSourceFile");
  try {
    await red(acquireLegacyComposeBuildSource({ source }));
    expect(reader).not.toHaveBeenCalled();
  } finally {
    reader.mockRestore();
  }
});
test.each([
  ["config", false],
  ["config", true],
  ["secret", false],
  ["secret", true],
] as const)("preview-qualified %s build grant (inactive=%s) refuses retained source before context reads", async (kind, inactive) => {
  const namespace = `${kind}s`;
  composeText = JSON.stringify({
    name: "fixture",
    services: {
      db: {
        build: "..",
        ...(inactive ? { profiles: ["later"] } : {}),
        [namespace]: ["settings"],
      },
    },
    [namespace]: { settings: { file: `./${CANARY}` } },
  });
  await writeFile(join(root, ".hack/docker-compose.yml"), composeText);
  const inputs = { configText: '{"name":"fixture"}', composeText };
  const preview = mapLegacyNativeImport(inputs);
  expect(preview.report.complete).toBe(true);
  expect(preview.candidate).toMatchObject({
    [namespace]: { settings: { file: `.hack/${CANARY}` } },
    services: {
      db: {
        build: { context: "." },
        mounts: [{ [kind]: "settings", access: "read-only", mode: "0444" }],
      },
    },
  });
  const retained = mapLegacyNativeRetainedBasicBuild(inputs);
  expect(retained.candidate).toBeUndefined();
  expect(retained.report.fields).toContainEqual(
    expect.objectContaining({
      pointer: `/services/db/${namespace}`,
      status: "refused",
      code: "unsupported_field",
    })
  );
  expect(JSON.stringify(preview.report)).not.toContain(CANARY);
  expect(JSON.stringify(retained.report)).not.toContain(CANARY);
  const source = await acquireLegacyAdoptionSourceInputs({ projectRoot: root });
  if (!source.ok) {
    throw new Error("Synthetic source setup refused; values omitted.");
  }
  const reader = spyOn(importInputs, "readNativeConfigImportSourceFile");
  try {
    await red(acquireLegacyComposeBuildSource({ source }));
    expect(reader).not.toHaveBeenCalled();
  } finally {
    reader.mockRestore();
  }
});
test("creation and edits inside actually ignored owned outputs do not invalidate included source", async () => {
  const captured = await acquire();
  await mkdir(join(root, ".hack/.internal"));
  await writeFile(join(root, ".hack/.internal/private-output"), CANARY);
  await captured.assertFresh();
  await writeFile(
    join(root, ".hack/.internal/private-output"),
    `${CANARY}-changed`
  );
  await captured.assertFresh();
  // A native selector changes the issued authored-source family. Only the saved
  // owner (which separately verifies its published candidate) may read it.
  await writeFile(join(root, ".hack/hack.project.json"), CANARY);
  await red(captured.assertFresh());
  await assertSavedLegacyComposeBuildSource({
    projectRoot: root,
    configText: '{"name":"fixture"}',
    composeText,
    proof: captured.proof,
    checkOwner: async () => {},
  });
});
test("Dockerfile-specific ignore wins, while both optional ignore identities remain pinned", async () => {
  await writeFile(join(root, ".dockerignore"), "src\n.git\n.hack\n");
  await writeFile(
    join(root, "Dockerfile.dockerignore"),
    "**\n!Dockerfile\n!src\n"
  );
  const captured = await acquire();
  expect(captured.proof.contexts[0]?.effectiveIgnore).toBe(
    "Dockerfile.dockerignore"
  );
  await writeFile(join(root, "src/marker"), "changed included source");
  await red(captured.assertFresh());
  await writeFile(join(root, "src/marker"), CANARY);
  await captured.assertFresh();
  await rm(join(root, "Dockerfile.dockerignore"));
  await red(captured.assertFresh());
});
test("a newly added specific ignore refuses even when its effective rules are byte-equal", async () => {
  const captured = await acquire();
  await writeFile(
    join(root, "Dockerfile.dockerignore"),
    await readFile(join(root, ".dockerignore"))
  );
  await red(captured.assertFresh());
});
test.each([
  "bytes",
  "added",
  "removed",
  "replaced",
  "symlink",
  "hardlink",
  "unsafe mode",
])("included %s drift refuses with fixed redacted errors", async (kind) => {
  const captured = await acquire(),
    path = join(root, "src/marker");
  if (kind === "bytes") {
    await writeFile(path, "changed");
  }
  if (kind === "added") {
    await writeFile(join(root, "src/new"), "new");
  }
  if (kind === "removed") {
    await rm(path);
  }
  if (kind === "replaced") {
    await rename(path, join(root, "outside"));
    await writeFile(path, CANARY);
  }
  if (kind === "symlink") {
    await rename(path, join(root, "outside"));
    await symlink(join(root, "outside"), path);
  }
  if (kind === "hardlink") {
    await link(path, join(root, "outside"));
  }
  if (kind === "unsafe mode") {
    await chmod(path, 0o666);
  }
  await red(captured.assertFresh());
});
test("a held root or included directory replacement cannot match same bytes", async () => {
  const captured = await acquire();
  await rename(join(root, "src"), join(root, "old-src"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/marker"), CANARY);
  await red(captured.assertFresh());
});
test("parents of an excluded Dockerfile remain identity-bound special builder inputs", async () => {
  await mkdir(join(root, "definitions"));
  await rename(join(root, "Dockerfile"), join(root, "definitions/Dockerfile"));
  await writeFile(join(root, ".dockerignore"), "**\n!src\n");
  composeText = JSON.stringify({
    name: "fixture",
    services: {
      db: {
        build: { context: "..", dockerfile: "definitions/Dockerfile" },
        volumes: ["data:/data"],
      },
    },
    volumes: { data: {} },
  });
  await writeFile(join(root, ".hack/docker-compose.yml"), composeText);
  const captured = await acquire();
  await rename(join(root, "definitions"), join(root, "old-definitions"));
  await mkdir(join(root, "definitions"));
  await rename(
    join(root, "old-definitions/Dockerfile"),
    join(root, "definitions/Dockerfile")
  );
  await red(captured.assertFresh());
});
test("Dockerfile whitespace is raw source drift even when the recipe remains valid", async () => {
  const captured = await acquire();
  await writeFile(
    join(root, "Dockerfile"),
    "FROM scratch\nCOPY src /source\n\n"
  );
  await red(captured.assertFresh());
});
test("an ignored symlink cannot become a included input or leak its target", async () => {
  await symlink(join(root, "src/marker"), join(root, "ignored-link"));
  const captured = await acquire();
  expect(
    captured.proof.contexts[0]?.nodes.some(
      (node) => node.path === "ignored-link"
    )
  ).toBe(false);
  await rm(join(root, "ignored-link"));
  await symlink(join(root, "Dockerfile"), join(root, "ignored-link"));
  await captured.assertFresh();
});
test("a disjoint context without ignore files pins absent ignore presence", async () => {
  await mkdir(join(root, ".hack/build"));
  await writeFile(join(root, ".hack/build/Dockerfile"), "FROM scratch\n");
  composeText = composeText.replace('"build":".."', '"build":"build"');
  await writeFile(join(root, ".hack/docker-compose.yml"), composeText);
  const captured = await acquire();
  expect(captured.proof.contexts[0]?.effectiveIgnore).toBeNull();
  await writeFile(
    join(root, ".hack/build/.dockerignore"),
    "# no effective rules\n"
  );
  await red(captured.assertFresh());
});
test("same ignore bytes at a replacement inode cannot repair saved source", async () => {
  const captured = await acquire();
  const text = await readFile(join(root, ".dockerignore"));
  await rename(join(root, ".dockerignore"), join(root, "old-ignore"));
  await writeFile(join(root, ".dockerignore"), text);
  await red(captured.assertFresh());
});
test("a cloned source cannot issue a build capability", async () => {
  const source = await acquireLegacyAdoptionSourceInputs({ projectRoot: root });
  if (!source.ok) {
    throw new Error("Synthetic source setup refused; values omitted.");
  }
  await red(acquireLegacyComposeBuildSource({ source: { ...source } }));
});
test("captured cancellation cannot be replaced and the abort reason stays private", async () => {
  const original = new AbortController(),
    captured = await acquire(original.signal);
  original.abort(CANARY);
  await red(captured.assertFresh({ signal: new AbortController().signal }));
  await red(acquire(original.signal));
});
test("explicit build policy refuses before any included context file is opened", async () => {
  composeText = JSON.stringify({
    name: "fixture",
    services: {
      db: { build: "..", pull_policy: "build", volumes: ["data:/data"] },
    },
    volumes: { data: {} },
  });
  await writeFile(join(root, ".hack/docker-compose.yml"), composeText);
  const source = await acquireLegacyAdoptionSourceInputs({
    projectRoot: root,
    allowLinkedWorktree: true,
  });
  if (!source.ok) {
    throw new Error("Synthetic source setup refused; values omitted.");
  }
  const read = spyOn(importInputs, "readNativeConfigImportSourceFile");
  try {
    await red(acquireLegacyComposeBuildSource({ source }));
    expect(read).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
  }
});
test.each([
  ".env",
  ".hack/.env",
  ".hack/hack.env.default.yaml",
  ".hack/hack.local.json",
])("unsupported private layout %s refuses before any context/private material opens", async (relative) => {
  const source = await acquireLegacyAdoptionSourceInputs({ projectRoot: root });
  if (!source.ok) {
    throw new Error("Synthetic source setup refused; values omitted.");
  }
  await writeFile(join(root, relative), CANARY);
  const read = spyOn(importInputs, "readNativeConfigImportSourceFile");
  try {
    await red(acquireLegacyComposeBuildSource({ source }));
    expect(read).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
  }
});
test("new unsupported private inputs refuse saved read before context acquisition", async () => {
  const captured = await acquire();
  await writeFile(join(root, ".env"), CANARY);
  const read = spyOn(importInputs, "readNativeConfigImportSourceFile");
  try {
    await red(
      assertSavedLegacyComposeBuildSource({
        projectRoot: root,
        configText: '{"name":"fixture"}',
        composeText,
        proof: captured.proof,
        checkOwner: async () => {},
      })
    );
    expect(read).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
  }
});
test("private material appearing after the layout check cannot be opened as an included context file", async () => {
  await writeFile(
    join(root, ".dockerignore"),
    ".git\n.hack/.internal\n.hack/.branch\n.hack/hack.config.json\n.hack/docker-compose.yml\n.hack/hack.project.json\n"
  );
  const source = await acquireLegacyAdoptionSourceInputs({ projectRoot: root });
  if (!source.ok) {
    throw new Error("Synthetic source setup refused; values omitted.");
  }
  const original = importInputs.readNativeConfigImportSourceFile;
  const paths: string[] = [];
  const read = spyOn(
    importInputs,
    "readNativeConfigImportSourceFile"
  ).mockImplementation(async (opts) => {
    paths.push(opts.path);
    if (opts.path === join(root, "Dockerfile")) {
      await writeFile(join(root, ".env"), CANARY);
    }
    return await original(opts);
  });
  try {
    await red(acquireLegacyComposeBuildSource({ source }));
    expect(paths).toContain(join(root, "Dockerfile"));
    expect(paths).not.toContain(join(root, ".env"));
  } finally {
    read.mockRestore();
  }
});
test.each([
  ".hack/hack.env.default.local.yaml",
  ".hack/hack.local.json",
])("inherited primary %s refuses before context/private reads", async (relative) => {
  const source = await linkedSource();
  await writeFile(join(root, relative), CANARY);
  const read = spyOn(importInputs, "readNativeConfigImportSourceFile");
  try {
    await red(acquireLegacyComposeBuildSource({ source }));
    expect(read).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
  }
});
test(".hack context excludes switched authored files while preserving its included inputs", async () => {
  await writeFile(join(root, ".hack/Dockerfile"), "FROM scratch\n");
  await writeFile(join(root, ".hack/.dockerignore"), "**\n!Dockerfile\n");
  composeText = composeText.replace('"build":".."', '"build":"."');
  await writeFile(join(root, ".hack/docker-compose.yml"), composeText);
  const captured = await acquire();
  expect(captured.proof.contexts[0]?.context).toBe(".hack");
  await captured.assertFresh();
});
test("parent negation includes descendants: toolchain pattern is not assumed to be a safe whitelist", async () => {
  const rules =
    "**\n!mise.toml\n!.hack\n!.hack/toolchain\n!.hack/toolchain/Dockerfile\n!.hack/toolchain/run.sh\n";
  const ignore = legacyComposeBuildIgnore(rules);
  expect(ignore.excluded(".hack/.internal/arbitrary-future-file")).toBe(false);
  expect(ignore.subtreeExcluded(".hack/.internal")).toBe(false);
  await writeFile(join(root, "Dockerfile.dockerignore"), rules);
  await red(acquire());
});
test("later owned subtree exclusion closes earlier broad inclusion", async () => {
  const ignore = legacyComposeBuildIgnore(
    "**\n!.hack\n.hack/.internal\n.hack/.branch\n"
  );
  expect(ignore.subtreeExcluded(".hack/.internal")).toBe(true);
  expect(ignore.excluded(".hack/toolchain/run.sh")).toBe(false);
  expect(
    legacyComposeBuildIgnore(
      "**\n!.hack\n.hack/.internal\n!.hack/.internal/later\n"
    ).subtreeExcluded(".hack/.internal")
  ).toBe(false);
});
test.each([
  "*.ts",
  "a/**",
  "a?",
  "[ab]",
  "a\\b",
  "!",
  "a/../b",
  "./a",
  "/a",
  "a b",
  "\uFEFF**",
])("unqualified ignore grammar %p refuses", (rule) => {
  expect(() => legacyComposeBuildIgnore(rule)).toThrow("values omitted");
});
