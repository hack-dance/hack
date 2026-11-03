import { test as boundedTest, expect, spyOn } from "bun:test";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { checkComposeEnvOverrideAtRest } from "../src/commands/doctor.ts";
import {
  composeEnvAtRestRepairs,
  describeComposeEnvAtRest,
  inspectComposeEnvAtRest,
  removePlaintextComposeEnvOverride,
} from "../src/lib/compose-env-at-rest.ts";
import * as composeManagedEnv from "../src/lib/compose-managed-env.ts";
import { openLegacyComposeAdoptedGenerationStore } from "../src/lib/native-compose-adoption-generation.ts";
import { inspectLegacyComposeAdoptionSelection } from "../src/lib/native-compose-adoption-marker.ts";
import { previewLegacyComposeAdoption } from "../src/lib/native-compose-adoption-preview.ts";
import { setProjectEnvValue } from "../src/lib/project-env-config.ts";
import { managedEnvCompilerFixture } from "./helpers/managed-env-compiler.ts";
import { createAdoptionGenerationFixture } from "./helpers/native-compose-adoption-generation-fixture.ts";

const context = createAdoptionGenerationFixture();
const {
  test,
  CANARY,
  ROLLBACK_RECOVERY_BUDGET_MS,
  ID,
  CREATED,
  stateRoot,
  managedGenerated,
  trackedManagedCheckout,
  publishedManagedAdoption,
  artifactPath,
  refusal,
  readReceipt,
} = context;

test("v3 saved adoption consumes canonical original generated sources without env or key delivery", async () => {
  Reflect.deleteProperty(process.env, "CI");
  Reflect.deleteProperty(process.env, "HACK_EXECUTION_MODE");
  await trackedManagedCheckout();
  const files = await managedGenerated();
  const envOverride = await readFile(files[2] ?? "", "utf8");
  await writeFile(
    join(context.projectRoot, ".hack.secret.key"),
    "synthetic-v3-key"
  );
  await setProjectEnvValue({
    projectRoot: context.projectRoot,
    projectDir: join(context.projectRoot, ".hack"),
    envName: null,
    scope: "global",
    key: "MANAGED",
    value: CANARY,
    secret: true,
  });
  const binary = await managedEnvCompilerFixture(
    join(context.root, "managed-compiler")
  );
  // The current writer's reference form; an earlier version's literal form
  // can be neither prepared through the CLI nor published (HACK-1273/1318).
  expect(envOverride).not.toContain(CANARY);
  expect(
    (
      await previewLegacyComposeAdoption({
        projectRoot: context.projectRoot,
        binary,
      })
    ).complete
  ).toBe(true);
  const store = await openLegacyComposeAdoptedGenerationStore({
    projectRoot: context.projectRoot,
  });
  try {
    const generation = await store.prepare({ binary });
    expect(generation.report.adoption_generation_version).toBe(3);
    const receipt = JSON.parse(
      await readFile(join(stateRoot(), "receipt.json"), "utf8")
    );
    expect(receipt.adoption_receipt_version).toBe(3);
    const metaText = await readFile(
      await artifactPath("manifest.json"),
      "utf8"
    );
    const meta = JSON.parse(metaText);
    expect(meta.adoption_generation_version).toBe(3);
    expect(meta.binding.composeFiles).toEqual(files);
    expect(meta.runtimeConfig).toEqual([
      { id: ID, service: "db", hash: "d".repeat(64) },
    ]);
    expect(metaText).not.toContain('"MANAGED"');
    expect(JSON.stringify(generation)).not.toContain(
      meta.projectionProof.managedRevision
    );
    await store.publish({ generation, binary });
    await store.close();
    await rm(join(context.projectRoot, ".hack.secret.key"));
    await mkdir(join(context.projectRoot, ".hack.secret.key"));
    const savedStore = await openLegacyComposeAdoptedGenerationStore({
      projectRoot: context.projectRoot,
      mode: "saved",
    });
    try {
      const active = await savedStore.loadActive();
      if (!active) {
        throw new Error("Expected active adopted generation");
      }
      expect(active.report.adoption_generation_version).toBe(3);
      await savedStore.withLease({
        generation: active,
        run: async (input) => {
          expect(input.binding.containers[0]?.id).toBe(ID);
          expect(input.binding.volumes[0]?.createdAt).toBe(CREATED);
          expect(JSON.stringify(input)).toBe("{}");
        },
      });
      await savedStore.rollback();
      expect(await readFile(files[0] ?? "", "utf8")).toContain("name: fixture");
      expect(await readFile(files[2] ?? "", "utf8")).toBe(envOverride);
      expect(
        await inspectLegacyComposeAdoptionSelection({
          projectRoot: context.projectRoot,
        })
      ).toBe("rolled-back");
    } finally {
      await savedStore.close();
    }
  } finally {
    await store.close();
  }
});

boundedTest(
  "rollback releases a moved-aside generated env override that execution still refuses (HACK-1437)",
  async () => {
    const files = await publishedManagedAdoption();
    const override = files[2] ?? "";
    const envText = await readFile(override, "utf8");
    const aside = join(context.root, "moved-aside-override.yml");
    await rename(override, aside);
    const saved = await openLegacyComposeAdoptedGenerationStore({
      projectRoot: context.projectRoot,
      mode: "saved",
    });
    try {
      // Execution keeps the exact binding: the adoption no longer loads.
      await refusal(saved.loadActive());
      expect((await readReceipt()).publication.phase).toBe("active");
      // Rollback never reads or writes the override, so it is released.
      await saved.rollback();
    } finally {
      await saved.close();
    }
    expect(
      await inspectLegacyComposeAdoptionSelection({
        projectRoot: context.projectRoot,
      })
    ).toBe("rolled-back");
    expect(await readFile(files[0] ?? "", "utf8")).toContain("name: fixture");
    expect(await lstat(override).catch(() => null)).toBeNull();
    expect(await readFile(aside, "utf8")).toBe(envText);
  },
  ROLLBACK_RECOVERY_BUDGET_MS
);

boundedTest(
  "rollback still binds the generated runtime override when the env override is released (HACK-1437)",
  async () => {
    const files = await publishedManagedAdoption();
    // Releasing the env override must not release its sibling: a runtime
    // override rewritten with its exact bytes (new mtime and ctime, so only
    // the identity proof can notice) still refuses rollback before anything
    // moves.
    await rename(
      files[2] ?? "",
      join(context.root, "moved-aside-override.yml")
    );
    const runtimeText = await readFile(files[1] ?? "", "utf8");
    const runtimeBefore = await lstat(files[1] ?? "");
    await Bun.sleep(5);
    await writeFile(files[1] ?? "", runtimeText);
    expect(await readFile(files[1] ?? "", "utf8")).toBe(runtimeText);
    expect((await lstat(files[1] ?? "")).ctimeMs).not.toBe(
      runtimeBefore.ctimeMs
    );
    const saved = await openLegacyComposeAdoptedGenerationStore({
      projectRoot: context.projectRoot,
      mode: "saved",
    });
    try {
      await refusal(saved.rollback());
    } finally {
      await saved.close();
    }
    expect((await readReceipt()).publication.phase).toBe("active");
    expect(
      await Bun.file(
        join(context.projectRoot, ".hack/hack.project.json")
      ).exists()
    ).toBe(true);
  },
  ROLLBACK_RECOVERY_BUDGET_MS
);

test("an adoption bound to an earlier version's literal env override keeps it loadable until rollback frees it (HACK-1273)", async () => {
  Reflect.deleteProperty(process.env, "CI");
  Reflect.deleteProperty(process.env, "HACK_EXECUTION_MODE");
  await trackedManagedCheckout();
  const files = await managedGenerated("literal");
  const override = files[2] ?? "";
  const projectDir = join(context.projectRoot, ".hack");
  await writeFile(
    join(context.projectRoot, ".hack.secret.key"),
    "synthetic-v3-key"
  );
  await setProjectEnvValue({
    projectRoot: context.projectRoot,
    projectDir,
    envName: null,
    scope: "global",
    key: "MANAGED",
    value: CANARY,
    secret: true,
  });
  const binary = await managedEnvCompilerFixture(
    join(context.root, "managed-compiler")
  );
  // Models an adoption that an earlier version published over its literal
  // file: that version had no publication check, so the bound form reads as
  // references during this one publish only (HACK-1318 now refuses it).
  const store = await openLegacyComposeAdoptedGenerationStore({
    projectRoot: context.projectRoot,
  });
  const earlierVersion = spyOn(
    composeManagedEnv,
    "classifyComposeEnvOverrideText"
  ).mockReturnValue({ kind: "references" });
  try {
    const generation = await store.prepare({ binary });
    await store.publish({ generation, binary });
  } finally {
    earlierVersion.mockRestore();
    await store.close();
  }
  const pinned = await lstat(override);

  // What `hack doctor --fix` and the down and no-override scrubs run.
  const kept = await removePlaintextComposeEnvOverride({
    projectDir,
    includeUnverifiable: true,
  });
  expect(kept).toMatchObject({ removed: false, adoptionBound: true });
  expect(kept.state.kind).toBe("plaintext");
  expect((await lstat(override)).ino).toBe(pinned.ino);
  expect(await readFile(override, "utf8")).toContain(CANARY);
  const report = await inspectComposeEnvAtRest({ projectDir });
  expect(report.adoptionBound).toBe(true);
  expect(composeEnvAtRestRepairs(report)).toEqual({
    override: false,
    asides: false,
  });
  const described = describeComposeEnvAtRest({
    report,
    projectDirName: ".hack",
  });
  expect(described.status).toBe("warn");
  expect(described.message).toContain("hack config adopt --rollback");
  expect(JSON.stringify([kept, report, described])).not.toContain(CANARY);
  // The doctor check reaches the adopted project, whose inputs ordinary
  // discovery now refuses, and names the supported next step.
  const checked = await checkComposeEnvOverrideAtRest({
    startDir: context.projectRoot,
  });
  expect(checked.status).toBe("warn");
  expect(checked.message).toContain("pins this file");
  expect(checked.message).toContain("hack config adopt --rollback");
  expect(checked.message).not.toContain(CANARY);

  // The adoption still loads with key-free saved reads, then rolls back.
  await rm(join(context.projectRoot, ".hack.secret.key"));
  const savedStore = await openLegacyComposeAdoptedGenerationStore({
    projectRoot: context.projectRoot,
    mode: "saved",
  });
  try {
    expect(await savedStore.loadActive()).toBeTruthy();
    await savedStore.rollback();
  } finally {
    await savedStore.close();
  }
  expect(
    await inspectLegacyComposeAdoptionSelection({
      projectRoot: context.projectRoot,
    })
  ).toBe("rolled-back");
  // Rolled back, nothing pins the file: the same removal now takes it.
  expect(
    await removePlaintextComposeEnvOverride({
      projectDir,
      includeUnverifiable: true,
    })
  ).toMatchObject({ removed: true, adoptionBound: false });
  expect(await lstat(override).catch(() => null)).toBeNull();
});
