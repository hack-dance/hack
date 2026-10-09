import { lstat, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../../../src/lib/guards.ts";
import { type CliResult, expect, type Scenario } from "../harness.ts";
import { sourceBindFixtureDirectorySnapshot } from "./native-compose-adoption-source-bind-inputs.ts";
import {
  bootstrapOriginal,
  cleanupOwnedAdoptionFixture,
  createFixtureRuntime,
  prepareFixtureInputs,
  runWithFixtureCleanup,
  sourceBindFixtureCommand,
} from "./native-compose-adoption-worktrees.ts";

type Runtime = ReturnType<typeof createFixtureRuntime>;
type Instance = Runtime["first"];
function refuse(): never {
  throw new Error(
    "Retained source-bind lifecycle check refused; values omitted."
  );
}
function passed(result: CliResult) {
  if (result.exitCode !== 0 || result.timedOut) {
    refuse();
  }
}
function refused(result: CliResult) {
  if (result.exitCode !== 1 || result.timedOut) {
    refuse();
  }
}
function receipt(instance: Instance) {
  return join(
    instance.root,
    ".hack/.internal/legacy-compose-adoption-v1/receipt.json"
  );
}
async function pending(instance: Instance, operation: "start" | "stop") {
  const text = await readFile(receipt(instance), "utf8");
  const value: unknown = JSON.parse(text);
  if (
    !(
      isRecord(value) &&
      value.adoption_receipt_version === 12 &&
      isRecord(value.pendingOperation) &&
      value.pendingOperation.operation === operation &&
      Array.isArray(value.pendingOperation.services) &&
      JSON.stringify([...value.pendingOperation.services].sort()) ===
        '["db","worker"]'
    )
  ) {
    refuse();
  }
  return text;
}
async function running(h: Runtime, instance: Instance) {
  const result: { readonly id: string; readonly running: string }[] = [];
  for (const service of ["db", "worker"]) {
    const id = h.container(instance, service);
    const state = await h.probe([
      "container",
      "inspect",
      "--format",
      "{{.State.Running}}",
      id,
    ]);
    if (state !== "true" && state !== "false") {
      refuse();
    }
    result.push({ id, running: state });
  }
  return JSON.stringify(result);
}
async function unchangedOther(h: Runtime, instance: Instance) {
  await h.check(instance);
  return JSON.stringify({
    resources: await h.resources(instance),
    source: h.anchors.get(instance)?.source,
    directories: await sourceBindFixtureDirectorySnapshot(instance.root),
    row: await h.sql(instance, "SELECT value FROM marker WHERE id=1"),
  });
}

async function directoryReplacementRecovery(h: Runtime) {
  const { first, second } = h;
  const other = await unchangedOther(h, second);
  const partial = await sourceBindFixtureCommand(
    h,
    first,
    ["up", "--detach", "--json"],
    "replace-after-start"
  );
  refused(partial);
  const pendingBytes = await pending(first, "start");
  const states = await running(h, first);
  const original = join(first.root, "bind-rw-original");
  const replacement = join(first.root, "bind-rw");
  const originalInfo = await lstat(original),
    replacementInfo = await lstat(replacement);
  if (
    !(
      originalInfo.isDirectory() &&
      replacementInfo.isDirectory() &&
      originalInfo.ino !== replacementInfo.ino &&
      originalInfo.uid === process.getuid?.() &&
      replacementInfo.uid === process.getuid?.()
    )
  ) {
    refuse();
  }
  // The mounted Source string still exists, but its new pathname incarnation
  // cannot authorize any stop, start or repair of the retained generation.
  refused(await h.cli(first, ["down", "--recover", "--json"]));
  if (
    (await readFile(receipt(first), "utf8")) !== pendingBytes ||
    (await running(h, first)) !== states ||
    (await unchangedOther(h, second)) !== other
  ) {
    refuse();
  }
  // Explicitly restore the SAME original directory; no contents/inode are fabricated.
  await rename(replacement, join(first.root, "bind-rw-refused-replacement"));
  await rename(original, replacement);
  if (
    (await sourceBindFixtureDirectorySnapshot(first.root)) !==
    h.sourceBindAnchors.get(first)
  ) {
    refuse();
  }
  passed(await h.cli(first, ["down", "--recover", "--json"]));
  await h.assertStopped(first);
  if ((await unchangedOther(h, second)) !== other) {
    refuse();
  }
}

async function restartAndRollback(
  h: Runtime,
  instance: Instance,
  other: Instance
) {
  const sibling = await unchangedOther(h, other);
  passed(await h.cli(instance, ["up", "--detach", "--json"]));
  await h.waitReady(instance);
  await h.check(instance, false);
  refused(await h.cli(instance, ["run", "db", "--", "true"]));
  if ((await unchangedOther(h, other)) !== sibling) {
    refuse();
  }
  passed(await h.cli(instance, ["down", "--json"]));
  await h.assertStopped(instance);
  passed(await h.cli(instance, ["config", "adopt", "--rollback", "--json"]));
  await h.effect([
    "container",
    "start",
    h.container(instance, "db"),
    h.container(instance, "worker"),
  ]);
  await h.waitReady(instance);
  await h.check(instance);
  if ((await unchangedOther(h, other)) !== sibling) {
    refuse();
  }
}

/** Existing directory paths/access and original SQL/IDs are qualified together, with no ingress or allocation after bootstrap. */
export const nativeComposeAdoptionSourceBindWorktreesScenario: Scenario = {
  name: "native-compose-adoption-source-bind-worktrees",
  tier: "docker",
  requiresExplicitSelection: true,
  preserveFixtureOnFailure: true,
  summary:
    "linked retained directory access, identity refusal, original SQL and isolated rollback",
  run: async (ctx) => {
    const h = createFixtureRuntime(
      await prepareFixtureInputs(ctx, { sourceBinds: true })
    );
    await runWithFixtureCleanup({
      run: async () => {
        for (const instance of [h.first, h.second]) {
          await bootstrapOriginal(h, instance);
        }
        for (const instance of [h.first, h.second]) {
          const result = await h.cli(instance, [
            "config",
            "adopt",
            "--dry-run",
            "--stop",
            "--json",
          ]);
          passed(result);
          const report: unknown = JSON.parse(result.stdout);
          expect({
            that: isRecord(report) && report.complete === true,
            message: "Expected complete symbolic source-bind preview",
          });
          await h.assertNoState(instance);
        }
        refused(
          await sourceBindFixtureCommand(
            h,
            h.first,
            ["config", "adopt", "--stop", "--json"],
            "prepared-stop"
          )
        );
        await pending(h.first, "stop");
        await h.check(h.second);
        passed(
          await h.cli(h.first, [
            "config",
            "adopt",
            "--recover",
            "--stop",
            "--json",
          ])
        );
        await h.assertStopped(h.first);
        const before = await readFile(receipt(h.first), "utf8");
        refused(await h.cli(h.first, ["up", "db", "--detach", "--json"]));
        if ((await readFile(receipt(h.first), "utf8")) !== before) {
          refuse();
        }
        await h.assertStopped(h.first);
        await directoryReplacementRecovery(h);
        await restartAndRollback(h, h.first, h.second);
        passed(await h.cli(h.second, ["config", "adopt", "--stop", "--json"]));
        await h.assertStopped(h.second);
        await h.check(h.first);
        await restartAndRollback(h, h.second, h.first);
        ctx.log(
          "two linked source-bind access/identity proofs and original SQL/IDs/births survived recovery and both rollbacks"
        );
      },
      cleanup: () =>
        cleanupOwnedAdoptionFixture({ ...h, instances: [h.first, h.second] }),
      secondaryFailure: () =>
        ctx.log(
          "secondary exact-owned cleanup failed; retain source-bind fixture evidence"
        ),
    });
  },
};
