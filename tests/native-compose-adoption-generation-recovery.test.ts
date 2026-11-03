import { test as boundedTest, expect } from "bun:test";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  PENDING_CHANGED_SWITCH_BUSY_NEXT_STEP,
  PENDING_LITERAL_SWITCH_BUSY_NEXT_STEP,
  PENDING_ROLLBACK_BUSY_NEXT_STEP,
} from "../src/commands/config-adopt.ts";
import { checkComposeEnvOverrideAtRest } from "../src/commands/doctor.ts";
import {
  inspectComposeEnvAtRest,
  removePlaintextComposeEnvOverride,
} from "../src/lib/compose-env-at-rest.ts";
import { renderComposeEnvReferenceOverride } from "../src/lib/compose-managed-env.ts";
import {
  LegacyComposeAdoptedGenerationError,
  openLegacyComposeAdoptedGenerationStore,
} from "../src/lib/native-compose-adoption-generation.ts";
import { inspectLegacyComposeAdoptionSelection } from "../src/lib/native-compose-adoption-marker.ts";
import {
  LEGACY_ADOPTION_LITERAL_ENV_OVERRIDE_CODE,
  previewLegacyComposeAdoption,
} from "../src/lib/native-compose-adoption-preview.ts";
import { setProjectEnvValue } from "../src/lib/project-env-config.ts";
import { managedEnvCompilerFixture } from "./helpers/managed-env-compiler.ts";
import { createAdoptionGenerationFixture } from "./helpers/native-compose-adoption-generation-fixture.ts";

const context = createAdoptionGenerationFixture();
const {
  ADOPTION_CASE_TIMEOUT_MS,
  retainedOperationCaseTimeout,
  test,
  CANARY,
  ROLLBACK_RECOVERY_BUDGET_MS,
  ID,
  CREATED,
  composeReferenceHash,
  save,
  container,
  volume,
  stateRoot,
  managedGenerated,
  trackedManagedCheckout,
  adoptableManagedFixture,
  runNamedRecoveryStep,
  adoptCli,
  artifactPath,
  refusal,
  readReceipt,
  writeReceipt,
  originalSnapshots,
  expectOriginals,
} = context;

boundedTest(
  "CLI adoption and its preview refuse a literal env override that the same fixture otherwise adopts (HACK-1273)",
  async () => {
    const { override, binary } = await adoptableManagedFixture("literal");
    for (const flags of [
      [],
      ["--dry-run"],
      ["--stop"],
      ["--dry-run", "--json"],
    ]) {
      const result = await adoptCli(flags, binary);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain(
        flags.includes("--json")
          ? LEGACY_ADOPTION_LITERAL_ENV_OVERRIDE_CODE
          : "Run 'hack up' once so Hack rewrites it with references only"
      );
      expect(result.output).not.toContain(CANARY);
      expect(await Bun.file(join(context.root, "commands")).exists()).toBe(
        false
      );
      expect(await Bun.file(stateRoot()).exists()).toBe(false);
    }
    // Control: once the current writer rewrites the override with references
    // (what `hack up` does), the same fixture adopts. Each refusal above came
    // from the literal check.
    await writeFile(
      override,
      renderComposeEnvReferenceOverride({
        targetServices: ["db"],
        globalEnv: { MANAGED: CANARY, EMPTY: "" },
        serviceEnv: { db: { MANAGED: CANARY, EMPTY: "" } },
      })?.text ?? ""
    );
    const adopted = await adoptCli(["--json"], binary);
    expect(adopted.code).toBe(0);
    expect(JSON.parse(adopted.stdout)).toMatchObject({ status: "active" });
    expect(adopted.output).not.toContain(CANARY);
    expect(
      await inspectLegacyComposeAdoptionSelection({
        projectRoot: context.projectRoot,
      })
    ).toBe("active");
  },
  ADOPTION_CASE_TIMEOUT_MS
);

boundedTest(
  "CLI recovery neither publishes nor completes a preparation bound to an earlier version's literal env override (HACK-1318)",
  async () => {
    const { override, binary } = await adoptableManagedFixture("literal");
    const original = await originalSnapshots();
    // Models a preparation that an earlier version made over its literal
    // file, left with an interrupted preparation stop. The store itself does
    // not refuse preparing it; only the CLI's new-preparation check does.
    const store = await openLegacyComposeAdoptedGenerationStore({
      projectRoot: context.projectRoot,
    });
    try {
      const generation = await store.prepare({ binary });
      expect(
        await store.withPreparationStop({
          generation,
          binary,
          run: async () => 7,
        })
      ).toBe(7);
    } finally {
      await store.close();
    }
    expect(
      await inspectLegacyComposeAdoptionSelection({
        projectRoot: context.projectRoot,
      })
    ).toBe("pending");
    const pinned = await lstat(override);
    // Interrupted preparation stop, before any switch (HACK-1414): rollback,
    // explicit or plain, refuses and changes nothing, so doctor must name
    // `--recover --stop` first, not `--recover --rollback`.
    const interrupted = await readReceipt();
    expect(interrupted.pendingOperation).not.toBeNull();
    expect(interrupted.publication).toBeNull();
    for (const flags of [
      ["--recover", "--rollback", "--json"],
      ["--rollback", "--json"],
    ]) {
      const refused = await adoptCli(flags, binary);
      expect(refused.code).not.toBe(0);
      expect(refused.output).not.toContain(CANARY);
      expect(await readReceipt()).toEqual(interrupted);
    }
    expect(
      await inspectComposeEnvAtRest({
        projectDir: join(context.projectRoot, ".hack"),
      })
    ).toMatchObject({
      override: { kind: "plaintext" },
      adoptionBound: true,
      adoptionPending: "preparation-stop",
    });
    const beforeStop = await checkComposeEnvOverrideAtRest({
      startDir: context.projectRoot,
    });
    expect(beforeStop.status).toBe("warn");
    expect(beforeStop.message).toContain(
      "first retry the interrupted adoption stop with 'hack config adopt --recover --stop'"
    );
    expect(beforeStop.message).not.toContain(
      "release the pending adoption switch with"
    );
    expect(beforeStop.message).not.toContain(CANARY);
    // `--recover --stop` retries the stop and then publishes; plain
    // `--recover` completes the journaled switch. Both refuse before any
    // original moves and name the release step.
    for (const flags of [
      ["--recover", "--stop", "--json"],
      ["--recover", "--json"],
    ]) {
      const result = await adoptCli(flags, binary);
      expect(result.code).not.toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        ok: false,
        error: {
          code: "E_CONFIG_INVALID",
          message: new LegacyComposeAdoptedGenerationError(
            "E_LEGACY_ADOPTION_LITERAL_ENV"
          ).message,
          detail: {
            legacy_adoption_publication_refusal: {
              stage: "publication-inputs",
              reason: "literal-env-override",
            },
          },
        },
      });
      expect(result.output).toContain("hack config adopt --recover --rollback");
      expect(result.output).not.toContain(CANARY);
      const receipt = await readReceipt();
      expect(receipt.pendingOperation).toBeNull();
      expect(receipt.publication).toMatchObject({
        phase: "switching",
        native: null,
      });
      await expectOriginals(original);
      expect((await lstat(override)).ino).toBe(pinned.ino);
    }
    // A second `--recover --stop` no longer reaches the publication boundary:
    // the switch is already journaled, so the retried preparation stop refuses
    // it as a pending publication (the generic busy code) without the
    // literal-env message or a publication diagnostic (HACK-1391). Plain
    // `--recover` (the busy text's "interrupted-lock recovery") completes the
    // switch, which refuses the literal override, so the message names the
    // release step instead (HACK-1414).
    const repeated = await adoptCli(["--recover", "--stop", "--json"], binary);
    expect(repeated.code).not.toBe(0);
    expect(JSON.parse(repeated.stdout)).toEqual({
      ok: false,
      error: {
        code: "E_CONFIG_INVALID",
        message: `${
          new LegacyComposeAdoptedGenerationError("E_LEGACY_ADOPTION_BUSY")
            .message
        } ${PENDING_LITERAL_SWITCH_BUSY_NEXT_STEP}`,
      },
    });
    expect(repeated.output).toContain("hack config adopt --recover --rollback");
    expect(repeated.output).not.toContain("'hack config adopt --recover' to");
    expect(repeated.output).not.toContain(CANARY);
    expect((await readReceipt()).publication).toMatchObject({
      phase: "switching",
      native: null,
    });
    // Doctor's next step for the pinned literal override must be a command
    // this pending state accepts: explicit recovery rollback, not plain
    // rollback or `hack down`, which it refuses (HACK-1391).
    const report = await inspectComposeEnvAtRest({
      projectDir: join(context.projectRoot, ".hack"),
    });
    expect(report).toMatchObject({
      override: { kind: "plaintext" },
      adoptionBound: true,
      adoptionPending: "switch",
    });
    const checked = await checkComposeEnvOverrideAtRest({
      startDir: context.projectRoot,
    });
    expect(checked.status).toBe("warn");
    expect(checked.message).toContain("pins this file");
    expect(checked.message).toContain("hack config adopt --recover --rollback");
    expect(checked.message).not.toContain("'hack config adopt --rollback'");
    expect(checked.message).not.toContain("stop the adopted containers");
    expect(checked.message).not.toContain(CANARY);
    // The named step releases the switch; nothing pins the file afterwards.
    const released = await adoptCli(
      ["--recover", "--rollback", "--json"],
      binary
    );
    expect(released.code).toBe(0);
    expect(JSON.parse(released.stdout)).toMatchObject({
      status: "rolled-back",
    });
    await expectOriginals(original);
    expect(
      await inspectLegacyComposeAdoptionSelection({
        projectRoot: context.projectRoot,
      })
    ).toBe("rolled-back");
    expect(
      await removePlaintextComposeEnvOverride({
        projectDir: join(context.projectRoot, ".hack"),
        includeUnverifiable: true,
      })
    ).toMatchObject({ removed: true, adoptionBound: false });
  },
  retainedOperationCaseTimeout(1)
);

boundedTest(
  "CLI busy refusal over an interrupted rollback names only the recovery rollback that finishes it (HACK-1427)",
  async () => {
    // A reference-form override, so the busy step cannot come from the
    // literal-override branch.
    const { override, binary } = await adoptableManagedFixture("reference");
    const original = await originalSnapshots();
    const adopted = await adoptCli(["--json"], binary);
    expect(adopted.code).toBe(0);
    const active = await readReceipt();
    expect(active.publication).toMatchObject({ phase: "active" });
    const pinned = await lstat(override);
    // An interrupted rollback: `rollback()` journals `rolling-back` and is
    // stopped before it restores the originals.
    const rollingBack = {
      ...active,
      publication: { ...active.publication, phase: "rolling-back" },
    };
    await writeReceipt(rollingBack);
    const busy = await adoptCli(["--recover", "--stop", "--json"], binary);
    expect(busy.code).not.toBe(0);
    expect(JSON.parse(busy.stdout)).toEqual({
      ok: false,
      error: {
        code: "E_CONFIG_INVALID",
        message: `${
          new LegacyComposeAdoptedGenerationError("E_LEGACY_ADOPTION_BUSY")
            .message
        } ${PENDING_ROLLBACK_BUSY_NEXT_STEP}`,
      },
    });
    expect(busy.output).not.toContain("'hack config adopt --recover' to");
    expect(busy.output).not.toContain(CANARY);
    expect(await readReceipt()).toEqual(rollingBack);
    // Plain `--recover`, which the generic pending-switch step names first,
    // refuses in this state and changes nothing.
    const completed = await adoptCli(["--recover", "--json"], binary);
    expect(completed.code).not.toBe(0);
    expect(completed.output).not.toContain(CANARY);
    expect(await readReceipt()).toEqual(rollingBack);
    // The named step finishes the rollback.
    const released = await adoptCli(
      ["--recover", "--rollback", "--json"],
      binary
    );
    expect(released.code).toBe(0);
    expect(JSON.parse(released.stdout)).toMatchObject({
      status: "rolled-back",
    });
    await expectOriginals(original);
    expect((await lstat(override)).ino).toBe(pinned.ino);
    expect(
      await inspectLegacyComposeAdoptionSelection({
        projectRoot: context.projectRoot,
      })
    ).toBe("rolled-back");
  },
  ADOPTION_CASE_TIMEOUT_MS
);

boundedTest(
  "CLI busy refusal over an interrupted rollback of a literal-bound switch does not name plain recovery once the override is moved aside, and that rollback finishes (HACK-1427, HACK-1437)",
  async () => {
    // The reported state: the HACK-1318 fixture after its switch is
    // journaled, rewritten to an interrupted rollback, with the bound literal
    // override moved aside so the busy step no longer comes from the
    // literal-override branch.
    const { override, binary } = await adoptableManagedFixture("literal");
    const original = await originalSnapshots();
    const store = await openLegacyComposeAdoptedGenerationStore({
      projectRoot: context.projectRoot,
    });
    try {
      const generation = await store.prepare({ binary });
      expect(
        await store.withPreparationStop({
          generation,
          binary,
          run: async () => 7,
        })
      ).toBe(7);
    } finally {
      await store.close();
    }
    const journaled = await adoptCli(["--recover", "--stop", "--json"], binary);
    expect(journaled.code).not.toBe(0);
    const switching = await readReceipt();
    expect(switching.publication).toMatchObject({ phase: "switching" });
    const rollingBack = {
      ...switching,
      publication: { ...switching.publication, phase: "rolling-back" },
    };
    await writeReceipt(rollingBack);
    const literalText = await readFile(override, "utf8");
    const literalInfo = await lstat(override);
    const aside = join(context.root, "moved-aside-override.yml");
    await rename(override, aside);
    for (const flags of [
      ["--recover", "--stop", "--json"],
      ["--json"],
      ["--stop", "--json"],
    ]) {
      const busy = await adoptCli(flags, binary);
      expect(busy.code).not.toBe(0);
      expect(JSON.parse(busy.stdout)).toEqual({
        ok: false,
        error: {
          code: "E_CONFIG_INVALID",
          message: `${
            new LegacyComposeAdoptedGenerationError("E_LEGACY_ADOPTION_BUSY")
              .message
          } ${PENDING_ROLLBACK_BUSY_NEXT_STEP}`,
        },
      });
      expect(busy.output).not.toContain("'hack config adopt --recover' to");
      expect(busy.output).not.toContain(CANARY);
      expect(await readReceipt()).toEqual(rollingBack);
    }
    // The step the generic message named first refuses here, and its
    // refusal names the step that state accepts (HACK-1437).
    const completed = await adoptCli(["--recover", "--json"], binary);
    expect(completed.code).not.toBe(0);
    expect(JSON.parse(completed.stdout).error.message).toEndWith(
      ` ${PENDING_ROLLBACK_BUSY_NEXT_STEP}`
    );
    expect(completed.output).not.toContain(CANARY);
    expect(await readReceipt()).toEqual(rollingBack);
    // The named step finishes the rollback with the override still moved
    // aside: rollback releases it instead of looping (HACK-1437).
    await runNamedRecoveryStep({
      message: PENDING_ROLLBACK_BUSY_NEXT_STEP,
      binary,
      original,
      moved: { path: aside, text: literalText, ino: literalInfo.ino },
      override,
    });
  },
  ROLLBACK_RECOVERY_BUDGET_MS
);

boundedTest(
  "CLI recovery rollback finishes a pending switch whose bound literal override was moved aside and back, without hand edits (HACK-1437)",
  async () => {
    // The reachable state: the HACK-1318 literal fixture with its switch
    // journaled by the CLI itself, then the bound override moved aside.
    const { override, binary } = await adoptableManagedFixture("literal");
    const original = await originalSnapshots();
    const store = await openLegacyComposeAdoptedGenerationStore({
      projectRoot: context.projectRoot,
    });
    try {
      const generation = await store.prepare({ binary });
      expect(
        await store.withPreparationStop({
          generation,
          binary,
          run: async () => 7,
        })
      ).toBe(7);
    } finally {
      await store.close();
    }
    const journaled = await adoptCli(["--recover", "--stop", "--json"], binary);
    expect(journaled.code).not.toBe(0);
    const switching = await readReceipt();
    expect(switching.publication).toMatchObject({ phase: "switching" });
    const literalText = await readFile(override, "utf8");
    const pinned = await lstat(override);
    const aside = join(context.root, "moved-aside-override.yml");
    await rename(override, aside);
    // Busy names only the step this state accepts: completing refuses,
    // because the saved read binds the override's bytes and identity.
    const busy = await adoptCli(["--recover", "--stop", "--json"], binary);
    expect(busy.code).not.toBe(0);
    expect(JSON.parse(busy.stdout)).toEqual({
      ok: false,
      error: {
        code: "E_CONFIG_INVALID",
        message: `${
          new LegacyComposeAdoptedGenerationError("E_LEGACY_ADOPTION_BUSY")
            .message
        } ${PENDING_CHANGED_SWITCH_BUSY_NEXT_STEP}`,
      },
    });
    expect(busy.output).not.toContain("'hack config adopt --recover' to");
    expect(busy.output).not.toContain(CANARY);
    // Plain completion refuses, journals nothing, and names the same step.
    const completed = await adoptCli(["--recover", "--json"], binary);
    expect(completed.code).not.toBe(0);
    expect(JSON.parse(completed.stdout).error.message).toEndWith(
      ` ${PENDING_CHANGED_SWITCH_BUSY_NEXT_STEP}`
    );
    expect(completed.output).not.toContain(CANARY);
    expect(await readReceipt()).toEqual(switching);
    // Moving it back keeps its bytes and inode but not its ctime, which the
    // saved read binds; rollback does not depend on it. The literal bytes
    // are back, so the step comes from the literal branch.
    await rename(aside, override);
    const restored = await lstat(override);
    expect(restored.ino).toBe(pinned.ino);
    expect(restored.ctimeMs).not.toBe(pinned.ctimeMs);
    const busyBack = await adoptCli(["--recover", "--stop", "--json"], binary);
    expect(JSON.parse(busyBack.stdout).error.message).toEndWith(
      ` ${PENDING_LITERAL_SWITCH_BUSY_NEXT_STEP}`
    );
    await runNamedRecoveryStep({
      message: PENDING_LITERAL_SWITCH_BUSY_NEXT_STEP,
      binary,
      original,
      moved: { path: override, text: literalText, ino: pinned.ino },
      override,
    });
    // Nothing pins the literal file once the switch is rolled back.
    expect(
      await removePlaintextComposeEnvOverride({
        projectDir: join(context.projectRoot, ".hack"),
        includeUnverifiable: true,
      })
    ).toMatchObject({ removed: true, adoptionBound: false });
  },
  ROLLBACK_RECOVERY_BUDGET_MS
);

boundedTest(
  "CLI rollback of an active adoption releases a replaced generated env override while plain recovery stays refused (HACK-1437)",
  async () => {
    const { override, binary } = await adoptableManagedFixture("reference");
    const original = await originalSnapshots();
    const adopted = await adoptCli(["--json"], binary);
    expect(adopted.code).toBe(0);
    // A different value-free override at the bound path (a new inode).
    const replaced = `${await readFile(override, "utf8")}# replaced\n`;
    await rm(override);
    await writeFile(override, replaced, { mode: 0o600 });
    const rolledBack = await adoptCli(["--rollback", "--json"], binary);
    expect(rolledBack.code).toBe(0);
    expect(JSON.parse(rolledBack.stdout)).toMatchObject({
      status: "rolled-back",
    });
    expect(rolledBack.output).not.toContain(CANARY);
    await expectOriginals(original);
    // Rollback neither read nor rewrote the replaced file.
    expect(await readFile(override, "utf8")).toBe(replaced);
    expect(
      await inspectLegacyComposeAdoptionSelection({
        projectRoot: context.projectRoot,
      })
    ).toBe("rolled-back");
  },
  ROLLBACK_RECOVERY_BUDGET_MS
);

test("v3 value-free env override binds the engine config hash computed with the values (HACK-1273)", async () => {
  Reflect.deleteProperty(process.env, "CI");
  Reflect.deleteProperty(process.env, "HACK_EXECUTION_MODE");
  await trackedManagedCheckout();
  // Distinct from CANARY, which the stub engine also uses as its engine ID.
  const value = "synthetic-private-reference-env-value";
  const files = await managedGenerated("reference");
  expect(await readFile(files[2] ?? "", "utf8")).not.toContain(CANARY);
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
    value,
    secret: true,
  });
  const reference = renderComposeEnvReferenceOverride({
    targetServices: ["db"],
    globalEnv: { MANAGED: value, EMPTY: "" },
    serviceEnv: { db: { MANAGED: value, EMPTY: "" } },
  });
  if (!reference) {
    throw new Error("Synthetic reference projection missing");
  }
  // The label Compose writes when Hack starts the stack with the values in
  // its environment, and the hash the same files give without them.
  const label = await composeReferenceHash({ files, env: reference.env });
  const blank = await composeReferenceHash({ files, env: {} });
  expect(label).not.toBe(blank);
  context.fixture.envConfigHash = true;
  context.fixture.configHash = label;
  await save();
  const binary = await managedEnvCompilerFixture(
    join(context.root, "managed-compiler")
  );
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
    const metaText = await readFile(
      await artifactPath("manifest.json"),
      "utf8"
    );
    const meta = JSON.parse(metaText);
    expect(meta.binding.composeFiles).toEqual(files);
    expect(meta.runtimeConfig).toEqual([
      { id: ID, service: "db", hash: label },
    ]);
    for (const text of [metaText, JSON.stringify(generation)]) {
      expect(text).not.toContain(value);
      expect(text).not.toContain("HACK_ENV_");
    }
    await store.publish({ generation, binary });
    await store.close();
    // Saved reads run without key or value delivery.
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
      let effects = 0;
      await savedStore.withLease({
        generation: active,
        run: async (input) => {
          effects++;
          expect(input.binding.containers[0]?.id).toBe(ID);
        },
      });
      expect(effects).toBe(1);
      // A recreated container carries a different engine label.
      context.fixture.configHash = "e".repeat(64);
      await save();
      await refusal(
        savedStore.withLease({
          generation: active,
          run: async () => {
            effects++;
          },
        })
      );
      expect(effects).toBe(1);
    } finally {
      await savedStore.close();
    }
    expect(
      await readFile(join(context.root, "commands"), "utf8")
    ).not.toContain(value);
  } finally {
    await store.close();
  }
});

test("v3 raw managed drift fences saved execution and preserves the original stopped IDs", async () => {
  Reflect.deleteProperty(process.env, "CI");
  Reflect.deleteProperty(process.env, "HACK_EXECUTION_MODE");
  await trackedManagedCheckout();
  await managedGenerated();
  const binary = await managedEnvCompilerFixture(
    join(context.root, "managed-compiler")
  );
  const store = await openLegacyComposeAdoptedGenerationStore({
    projectRoot: context.projectRoot,
  });
  try {
    const generation = await store.prepare({ binary });
    await store.publish({ generation, binary });
    const path = join(context.projectRoot, ".hack/hack.env.default.yaml");
    await writeFile(path, `${await readFile(path, "utf8")}\n`);
    let effects = 0;
    await refusal(
      store.withLease({
        generation,
        run: async () => {
          effects++;
        },
      })
    );
    expect(effects).toBe(0);
    expect(container().id).toBe(ID);
    expect(volume().createdAt).toBe(CREATED);
    expect(
      await inspectLegacyComposeAdoptionSelection({
        projectRoot: context.projectRoot,
      })
    ).toBe("active");
  } finally {
    await store.close();
  }
});
