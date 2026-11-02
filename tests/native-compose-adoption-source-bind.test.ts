import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planLegacyComposeSourceBindAdoption } from "../src/lib/native-compose-adoption-plan.ts";
import * as projection from "../src/lib/native-compose-adoption-projection.ts";
import {
  acquireLegacyComposeSourceBind,
  holdSavedLegacyComposeSourceBind,
} from "../src/lib/native-compose-adoption-source-bind.ts";
import * as privateState from "../src/lib/native-compose-private-state.ts";
import { mapLegacyComposeSourceBind } from "../src/lib/native-config-import-bind.ts";
import { acquireLegacyAdoptionSourceInputs } from "../src/lib/native-config-import-inputs.ts";
import {
  mapLegacyNativeAdoptionBaseline,
  mapLegacyNativeImport,
  mapLegacyNativeRetainedBasicBuild,
  mapLegacyNativeRetainedSourceBind,
  mapLegacyNativeStorageAdoption,
} from "../src/lib/native-config-import-plan.ts";
import * as selection from "../src/lib/project-input-selection.ts";
import { restoreEnv } from "./helpers/env.ts";

const CANARY = "synthetic-private-source-directory";
let root: string;
let configText: string;
let composeText: string;
let originalCi: string | undefined;
let originalMode: string | undefined;
function declaration(source = "../ignored", readOnly = true) {
  return {
    type: "bind",
    source,
    target: "/work",
    read_only: readOnly,
    bind: { create_host_path: false },
  };
}
async function setMount(value: unknown) {
  composeText = JSON.stringify({
    name: "fixture",
    services: { db: { image: "fixture", volumes: ["data:/data", value] } },
    volumes: { data: {} },
  });
  await writeFile(join(root, ".hack/docker-compose.yml"), composeText);
}
beforeEach(async () => {
  originalCi = process.env.CI;
  originalMode = process.env.HACK_EXECUTION_MODE;
  process.env.CI = "";
  process.env.HACK_EXECUTION_MODE = "";
  root = await realpath(await mkdtemp(join(tmpdir(), "source-bind-owner-")));
  await mkdir(join(root, ".git"));
  await mkdir(join(root, ".hack"));
  await mkdir(join(root, "ignored"));
  await writeFile(join(root, ".gitignore"), "ignored/\n");
  await writeFile(join(root, "ignored/marker"), CANARY);
  configText = '{"name":"fixture"}';
  await writeFile(join(root, ".hack/hack.config.json"), configText);
  await setMount(declaration());
});
afterEach(async () => {
  restoreEnv("CI", originalCi);
  restoreEnv("HACK_EXECUTION_MODE", originalMode);
  await rm(root, { recursive: true, force: true });
});
async function acquire(signal?: AbortSignal) {
  const source = await acquireLegacyAdoptionSourceInputs({
    projectRoot: root,
    allowLinkedWorktree: true,
    signal,
  });
  if (!source.ok) {
    throw new Error("Synthetic source refused; values omitted.");
  }
  return await acquireLegacyComposeSourceBind({ source, signal });
}
async function red(pending: Promise<unknown>) {
  await expect(pending).rejects.toThrow("values omitted");
  try {
    await pending;
  } catch (error: unknown) {
    expect(String(error)).not.toContain(root);
    expect(String(error)).not.toContain(CANARY);
    expect(JSON.stringify(error)).not.toContain(CANARY);
  }
}
test.each([
  true,
  false,
])("long no-create bind preserves access (RO=%s), raw provenance and private candidate", (readOnly) => {
  const text = JSON.stringify({
    name: "fixture",
    services: {
      web: { image: "fixture", volumes: [declaration("../ignored", readOnly)] },
    },
  });
  const result = mapLegacyNativeImport({ configText, composeText: text });
  expect(result.report.complete).toBe(true);
  expect(result.candidate).toMatchObject({
    services: {
      web: {
        mounts: [
          {
            source: "ignored",
            target: "/work",
            access: readOnly ? "read-only" : "read-write",
          },
        ],
      },
    },
  });
  expect(
    result.report.fields.find(
      (field) => field.pointer === "/services/web/volumes/0/source"
    )
  ).toMatchObject({ code: "compose_bind_source_rebased", line: 1 });
  expect(JSON.stringify(result)).not.toContain("ignored");
});
test.each([
  "..:/work",
  "../ignored:/work:ro",
  "../ignored:/work:rw",
])("short %s stays conditional on the existing-directory owner", async (value) => {
  await setMount(value);
  const input = { configText, composeText };
  expect(mapLegacyNativeImport(input).candidate).toBeUndefined();
  expect(mapLegacyNativeAdoptionBaseline(input).candidate).toBeUndefined();
  expect(mapLegacyNativeStorageAdoption(input).candidate).toBeUndefined();
  expect(mapLegacyNativeRetainedBasicBuild(input).candidate).toBeUndefined();
  expect(mapLegacyNativeRetainedSourceBind(input).candidate).toBeDefined();
  const owned = await acquire();
  expect(Object.keys(owned)).toEqual([]);
  expect(JSON.stringify(owned)).toBe("{}");
  await owned.withFresh({}, async () => {});
});

test("issued non-enumerable source bytes reach both retained mapper and planner", async () => {
  const issued = await acquireLegacyAdoptionSourceInputs({ projectRoot: root });
  if (!issued.ok) {
    throw new Error("Synthetic source refused; values omitted.");
  }
  expect(Object.keys(issued)).not.toContain("configText");
  expect(Object.keys(issued)).not.toContain("composeText");
  const candidate = mapLegacyNativeRetainedSourceBind(issued).candidate;
  expect(candidate).toBeDefined();
  expect(candidate).toMatchObject({
    services: { db: { mounts: [{ storage: "data" }, { source: "ignored" }] } },
  });
  const planned = planLegacyComposeSourceBindAdoption(issued);
  expect(planned.report.supported).toBe(true);
  expect(planned.intent).toMatchObject({
    sourceBinds: [
      { service: "db", source: "ignored", target: "/work", readOnly: true },
    ],
  });
});
test.each([
  "/outside",
  "../../outside",
  "~",
  "../.git",
  "./.internal",
  "./.branch",
  "../${PRIVATE}",
  "../a\\b",
])("unsafe or unsupported source refuses before opening the source directory: %s", async (source) => {
  await setMount(declaration(source));
  const hold = spyOn(privateState, "holdDirectory");
  try {
    await red(acquire());
    expect(
      hold.mock.calls.some(([path]) => path === join(root, "ignored"))
    ).toBe(false);
  } finally {
    hold.mockRestore();
  }
});
test("directory proof admits gitignored source and checkout root, reads no mounted bytes, and allows RW content drift", async () => {
  await setMount(declaration("../ignored", false));
  const owned = await acquire();
  expect(JSON.stringify(owned.proof)).not.toContain(CANARY);
  await writeFile(join(root, "ignored/marker"), "changed runtime contents");
  await writeFile(join(root, "ignored/new-file"), "new runtime file");
  await owned.withFresh({}, async () => {});
  await setMount("..:/work:rw");
  const checkout = await acquire();
  expect(checkout.proof.directories).toHaveLength(1);
  await checkout.withFresh({}, async () => {});
});
test.each([
  "missing",
  "file",
  "symlink",
  "unsafe mode",
])("source %s never creates or repairs a directory", async (kind) => {
  await rm(join(root, "ignored"), { recursive: true });
  if (kind === "file") {
    await writeFile(join(root, "ignored"), CANARY);
  }
  if (kind === "symlink") {
    await symlink(join(root, ".hack"), join(root, "ignored"));
  }
  if (kind === "unsafe mode") {
    await mkdir(join(root, "ignored"));
    await chmod(join(root, "ignored"), 0o777);
  }
  await red(acquire());
  if (kind === "missing") {
    expect(await Bun.file(join(root, "ignored")).exists()).toBe(false);
  }
});
test.each([
  "leaf",
  "parent",
])("held %s replacement refuses before and after the observation", async (kind) => {
  if (kind === "parent") {
    await mkdir(join(root, "ignored/nested"));
    await setMount(declaration("../ignored/nested"));
  }
  const owned = await acquire();
  await red(
    owned.withFresh({}, async () => {
      await rename(join(root, "ignored"), join(root, "original"));
      await mkdir(join(root, "ignored"));
      if (kind === "parent") {
        await mkdir(join(root, "ignored/nested"));
      }
    })
  );
  let called = false;
  await red(
    owned.withFresh({}, async () => {
      called = true;
    })
  );
  expect(called).toBe(false);
});
test("saved proof remains key-free and rejects forged, absent, changed or replaced identities", async () => {
  const owned = await acquire();
  const opts = {
    projectRoot: root,
    configText,
    composeText,
    proof: owned.proof,
  };
  const held = await holdSavedLegacyComposeSourceBind(opts);
  expect(Object.keys(held)).toEqual([]);
  await held.assertFresh();
  await held.close();
  await red(held.assertFresh());
  await red(holdSavedLegacyComposeSourceBind({ ...opts, proof: {} }));
  await rename(join(root, "ignored"), join(root, "original"));
  await mkdir(join(root, "ignored"));
  await red(holdSavedLegacyComposeSourceBind(opts));
});

test.each([
  "fresh",
  "saved",
])("replacement during the last %s layout await refuses before returning", async (kind) => {
  const owned = await acquire();
  const saved =
    kind === "saved"
      ? await holdSavedLegacyComposeSourceBind({
          projectRoot: root,
          configText,
          composeText,
          proof: owned.proof,
        })
      : undefined;
  const original = projection.hasLegacyComposeGeneratedSources;
  let armed = kind === "saved";
  let replaced = false;
  const read = spyOn(
    projection,
    "hasLegacyComposeGeneratedSources"
  ).mockImplementation(async (...args) => {
    const result = await original(...args);
    if (armed && !replaced) {
      replaced = true;
      await rename(join(root, "ignored"), join(root, "original"));
      await mkdir(join(root, "ignored"));
    }
    return result;
  });
  try {
    await red(
      saved
        ? saved.assertFresh()
        : owned.withFresh({}, async () => {
            armed = true;
          })
    );
    expect(armed).toBe(true);
    expect(replaced).toBe(true);
  } finally {
    read.mockRestore();
    await saved?.close();
  }
});

test("replacement during the final issued-source await is rechecked by mounted-directory owner", async () => {
  const owned = await acquire();
  const original = selection.inspectProjectInputsAtRoot;
  let observed = false;
  let replaced = false;
  const read = spyOn(
    selection,
    "inspectProjectInputsAtRoot"
  ).mockImplementation(async (...args) => {
    const result = await original(...args);
    if (observed && !replaced) {
      replaced = true;
      await rename(join(root, "ignored"), join(root, "original"));
      await mkdir(join(root, "ignored"));
    }
    return result;
  });
  try {
    await red(
      owned.withFresh({}, async () => {
        observed = true;
      })
    );
    expect(replaced).toBe(true);
  } finally {
    read.mockRestore();
  }
});
test("original cancellation cannot be replaced and callback does not run", async () => {
  const controller = new AbortController();
  const owned = await acquire(controller.signal);
  controller.abort(CANARY);
  let called = false;
  await red(
    owned.withFresh({ signal: new AbortController().signal }, async () => {
      called = true;
    })
  );
  expect(called).toBe(false);
});
test("two linked checkout directories are independent and wrong-family source changes refuse", async () => {
  async function git(args: readonly string[]) {
    const child = Bun.spawn(["/usr/bin/git", "-C", root, ...args], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: {
        PATH: "/usr/bin:/bin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    });
    if ((await child.exited) !== 0) {
      throw new Error("Synthetic Git setup refused; values omitted.");
    }
  }
  await git(["init", "--quiet", "-b", "main"]);
  await git(["add", ".hack", ".gitignore"]);
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
  const linked = join(root, "linked");
  await git(["worktree", "add", "--quiet", "-b", "linked", linked]);
  await mkdir(join(linked, "ignored"));
  await writeFile(
    join(linked, "ignored/marker"),
    "independent runtime contents"
  );
  const original = await acquire();
  const selected = await acquireLegacyAdoptionSourceInputs({
    projectRoot: linked,
    allowLinkedWorktree: true,
  });
  if (!selected.ok) {
    throw new Error("Synthetic linked source refused; values omitted.");
  }
  const second = await acquireLegacyComposeSourceBind({ source: selected });
  expect(second.proof.directories).not.toEqual(original.proof.directories);
  await rename(join(linked, "ignored"), join(linked, "original"));
  await mkdir(join(linked, "ignored"));
  await red(second.withFresh({}, async () => {}));
  await original.withFresh({}, async () => {});
  await writeFile(
    join(linked, ".git"),
    "gitdir: /unrelated/synthetic/checkout\n"
  );
  await red(second.withFresh({}, async () => {}));
});
test("unknown/inactive intersecting fields and managed names refuse before source-directory opens", async () => {
  const raw = JSON.parse(composeText);
  raw.services.db.profiles = ["inactive"];
  await writeFile(join(root, ".hack/docker-compose.yml"), JSON.stringify(raw));
  await red(acquire());
  await setMount(declaration());
  await writeFile(join(root, ".hack/hack.env.default.yaml"), CANARY);
  const hold = spyOn(privateState, "holdDirectory");
  try {
    await red(acquire());
    expect(
      hold.mock.calls.some(([path]) => path === join(root, "ignored"))
    ).toBe(false);
  } finally {
    hold.mockRestore();
  }
});
test("bind mapping keeps exact RO/RW and refuses missing creation fence, extra options and overlapping targets", () => {
  for (const value of [
    { ...declaration(), bind: {} },
    { ...declaration(), bind: { create_host_path: true } },
    { ...declaration(), consistency: "cached" },
    { ...declaration(), read_only: "false" },
  ]) {
    expect(
      mapLegacyComposeSourceBind(value, { retainedExisting: true })
    ).toBeUndefined();
  }
  const compose = JSON.parse(composeText);
  compose.services.db.volumes.push({ ...declaration(), target: "/work/child" });
  expect(
    mapLegacyNativeRetainedSourceBind({
      configText,
      composeText: JSON.stringify(compose),
    }).candidate
  ).toBeUndefined();
});

test.each([
  undefined,
  "never",
])("retained source bind preserves omitted/never pull policy (%s)", async (pullPolicy) => {
  const compose = {
    name: "fixture",
    services: {
      db: {
        image: "fixture",
        ...(pullPolicy === undefined ? {} : { pull_policy: pullPolicy }),
        volumes: ["data:/data", declaration()],
      },
    },
    volumes: { data: {} },
  };
  composeText = JSON.stringify(compose);
  await writeFile(join(root, ".hack/docker-compose.yml"), composeText);
  expect(
    mapLegacyNativeRetainedSourceBind({ configText, composeText }).candidate
  ).toBeDefined();
  const owned = await acquire();
  await owned.withFresh({}, async () => {});
});

test.each([
  "always",
  "missing",
])("retained source bind refuses image acquisition (%s) before directory opens", async (pullPolicy) => {
  composeText = JSON.stringify({
    name: "fixture",
    services: {
      db: {
        image: "fixture",
        pull_policy: pullPolicy,
        volumes: ["data:/data", declaration()],
      },
    },
    volumes: { data: {} },
  });
  await writeFile(join(root, ".hack/docker-compose.yml"), composeText);
  const planned = mapLegacyNativeRetainedSourceBind({
    configText,
    composeText,
  });
  expect(planned.candidate).toBeUndefined();
  expect(planned.report.fields).toContainEqual(
    expect.objectContaining({
      pointer: "/services/db/pull_policy",
      code: "retained_bind_image_acquisition_unsupported",
    })
  );
  const hold = spyOn(privateState, "holdDirectory");
  try {
    await red(acquire());
    expect(
      hold.mock.calls.some(([path]) => path === join(root, "ignored"))
    ).toBe(false);
  } finally {
    hold.mockRestore();
  }
});
