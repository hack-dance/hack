import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../../../src/lib/guards.ts";
import {
  readPrivate,
  writeExclusive,
} from "../../../src/lib/native-compose-private-state.ts";
import { nativeComposeProxyRoutesMatch } from "../../../src/lib/native-compose-proxy-routes.ts";
import type { CliResult, Scenario } from "../harness.ts";
import {
  retainedRoutingFixtureLocalSnapshot,
  retainedRoutingFixtureOrigins,
} from "./native-compose-adoption-routing-inputs.ts";
import {
  bootstrapOriginal,
  cleanupOwnedAdoptionFixture,
  createFixtureRuntime,
  prepareFixtureInputs,
  runWithFixtureCleanup,
} from "./native-compose-adoption-worktrees.ts";
import { nativeRoutedDownClaimSnapshot } from "./native-config-routed-down-hooks.ts";
import { prepareNativeRoutingFixtureIngress } from "./native-routing-fixture-ingress.ts";

type Runtime = ReturnType<typeof createFixtureRuntime>;
type Instance = Runtime["first"];
type Ingress = Awaited<ReturnType<typeof prepareNativeRoutingFixtureIngress>>;
const SERVICES = ["db", "web", "worker"];
function refuse(): never {
  throw new Error("Retained routing lifecycle check refused; values omitted.");
}
function passed(result: CliResult) {
  if (result.timedOut || result.exitCode !== 0) {
    return refuse();
  }
  return result;
}
function object(text: string) {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return refuse();
  }
  if (!isRecord(value)) {
    return refuse();
  }
  return value;
}
function receiptPath(instance: Instance) {
  return join(
    instance.root,
    ".hack/.internal/legacy-compose-adoption-v1/receipt.json"
  );
}
async function receipt(instance: Instance) {
  const value = object(
    (await readPrivate(receiptPath(instance), 128 * 1024)).text
  );
  if (!value || value.adoption_receipt_version !== 14) {
    return refuse();
  }
  return value;
}
function originalIds(h: Runtime, instance: Instance): readonly string[] {
  return SERVICES.map((service) => h.container(instance, service));
}

/** Closed forwarding control. It performs exactly one known partial stop, then
 * the real CLI's routing process owner records the known nonzero disposition. */
export function retainedRoutingPartialStopScript(opts: {
  readonly engine: string;
  readonly engineId: string;
  readonly receipt: string;
  readonly ids: readonly string[];
  readonly stopId: string;
  readonly marker: string;
}): string {
  if (
    opts.ids.length !== 3 ||
    new Set(opts.ids).size !== 3 ||
    !opts.ids.includes(opts.stopId) ||
    opts.ids.some((id) => !/^[a-f0-9]{64}$/.test(id))
  ) {
    return refuse();
  }
  return `#!${process.execPath}
import { readPrivate } from ${JSON.stringify(new URL("../../../src/lib/native-compose-private-state.ts", import.meta.url).href)};
import { writeFile } from 'node:fs/promises';
const args=process.argv.slice(2), engine=${JSON.stringify(opts.engine)};
if(args[0]==='container' && args[1]==='stop') {
 if(JSON.stringify(args)!==JSON.stringify(['container','stop',...${JSON.stringify(opts.ids)}])) process.exit(99);
 let value;try{value=JSON.parse((await readPrivate(${JSON.stringify(opts.receipt)},131072)).text)}catch{process.exit(98)}
 if(value.adoption_receipt_version!==14 || value.pendingOperation?.operation!=='stop' || JSON.stringify([...value.pendingOperation.services].sort())!==JSON.stringify(${JSON.stringify(SERVICES)}) || value.routingOperation?.disposition!=='prospective' || value.routingOperation?.code!==null || value.routingHandoff!=='held') process.exit(98);
 const observed=Bun.spawn([engine,'info','--format','{{json .ID}}'],{stdin:'ignore',stdout:'pipe',stderr:'ignore'});
 const observedText=await new Response(observed.stdout).text();
 if(await observed.exited!==0 || observedText.trim()!==${JSON.stringify(opts.engineId)}) process.exit(97);
 const child=Bun.spawn([engine,'container','stop',${JSON.stringify(opts.stopId)}],{stdin:'ignore',stdout:'ignore',stderr:'ignore'});
 if(await child.exited!==0) process.exit(96);
 await writeFile(${JSON.stringify(opts.marker)},'known-routing-partial-stop',{flag:'wx',mode:0o600});
 process.exit(71);
}
const child=Bun.spawn([engine,...args],{stdin:'inherit',stdout:'inherit',stderr:'inherit'});process.exit(await child.exited);
`;
}

async function partialStop(h: Runtime) {
  const root = join(h.ctx.tempRoot, "retained-routing-partial-stop");
  await mkdir(root, { mode: 0o700 });
  const marker = join(root, "known-stop");
  const shim = join(root, "docker");
  await writeFile(
    shim,
    retainedRoutingPartialStopScript({
      engine: h.engine,
      engineId: h.engineId,
      receipt: receiptPath(h.first),
      ids: originalIds(h, h.first),
      stopId: h.container(h.first, "db"),
      marker,
    }),
    { mode: 0o700 }
  );
  await chmod(shim, 0o700);
  const result = await h.cli(h.first, ["config", "adopt", "--stop", "--json"], {
    PATH: `${root}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  });
  await retainRoutingAdoptStopResult({ root, result });
  if (
    result.timedOut ||
    result.exitCode !== 71 ||
    (await readPrivate(marker, 128)).text !== "known-routing-partial-stop"
  ) {
    return refuse();
  }
  const saved = await receipt(h.first);
  if (
    !isRecord(saved.pendingOperation) ||
    saved.pendingOperation.operation !== "stop" ||
    !isRecord(saved.routingOperation) ||
    saved.routingOperation.disposition !== "settled" ||
    saved.routingOperation.code !== 71 ||
    saved.routingHandoff !== "held"
  ) {
    return refuse();
  }
  const pendingBytes = (await readPrivate(receiptPath(h.first), 128 * 1024))
    .text;
  const states = async () =>
    JSON.stringify(
      await Promise.all(
        originalIds(h, h.first).map(async (id) => ({
          id,
          running: await h.probe([
            "container",
            "inspect",
            "--format",
            "{{.State.Running}}",
            id,
          ]),
        }))
      )
    );
  const before = await states();
  const blocked = await h.cli(h.first, ["up", "--detach", "--json"]);
  if (
    blocked.timedOut ||
    blocked.exitCode !== 1 ||
    !blocked.combined.includes("E_CONFIG_INVALID") ||
    (await readPrivate(receiptPath(h.first), 128 * 1024)).text !==
      pendingBytes ||
    (await states()) !== before
  ) {
    return refuse();
  }
  passed(
    await h.cli(h.first, ["config", "adopt", "--recover", "--stop", "--json"])
  );
  await h.assertStopped(h.first);
}

/** Preserve the known CLI return before the fixture's stop oracle can refuse.
 * These private streams are evidence only; they grant no cleanup authority. */
export async function retainRoutingAdoptStopResult(opts: {
  readonly root: string;
  readonly result: CliResult;
}): Promise<void> {
  const { exitCode, timedOut, stdout, stderr } = opts.result;
  if (
    !Number.isInteger(exitCode) ||
    exitCode < 0 ||
    exitCode > 255 ||
    typeof timedOut !== "boolean" ||
    Buffer.byteLength(stdout) > 64 * 1024 ||
    Buffer.byteLength(stderr) > 64 * 1024
  ) {
    return refuse();
  }
  await writeExclusive(
    join(opts.root, "adopt-stop-result.json"),
    `${JSON.stringify({ phase: "adopt-stop-return", exitCode, timedOut, stdout, stderr })}\n`
  );
}

async function savedOpen(h: Runtime, instance: Instance) {
  const selected = instance.routing;
  if (!selected) {
    return refuse();
  }
  const automatic =
    selected.prefer === "alias" ? selected.aliasHost : selected.devHost;
  if (
    object(passed(await h.cli(instance, ["open", "--json"])).stdout).url !==
      `https://${automatic}` ||
    object(
      passed(await h.cli(instance, ["open", "--prefer", "dev", "--json"]))
        .stdout
    ).url !== `https://${selected.devHost}`
  ) {
    return refuse();
  }
  // Alpha's authored and primary-local dev selections differ from its saved
  // checkout-local alias, so this public open result proves that precedence.
}
async function routes(ingress: Ingress, instance: Instance) {
  if (!instance.routing) {
    return refuse();
  }
  for (const origin of retainedRoutingFixtureOrigins(instance.routing)) {
    await ingress.tls(origin, instance.routing.marker);
  }
  await ingress.tls(`https://${ingress.canaryHost}`, ingress.canaryMarker);
  await ingress.preservedUnchanged();
}
async function absent(ingress: Ingress, instance: Instance) {
  if (!instance.routing) {
    return refuse();
  }
  const hosts = retainedRoutingFixtureOrigins(instance.routing).map(
    (origin) => new URL(origin).hostname
  );
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const matched = nativeComposeProxyRoutesMatch({
      servers: await ingress.admin(),
      expected: [],
      absentHostnames: hosts,
    });
    if (matched && Date.now() < deadline) {
      return;
    }
    await Bun.sleep(250);
  }
  return refuse();
}
async function originalBaseline(
  h: Runtime,
  ingress: Ingress,
  instance: Instance,
  source = true
) {
  await h.waitReady(instance);
  await h.check(instance, source);
  await routes(ingress, instance);
}
async function roundTrip(
  h: Runtime,
  ingress: Ingress,
  instance: Instance,
  sibling: Instance,
  prepared: boolean
) {
  if (!prepared) {
    passed(await h.cli(instance, ["config", "adopt", "--stop", "--json"]));
    await h.assertStopped(instance);
  }
  await absent(ingress, instance);
  await originalBaseline(h, ingress, sibling);
  for (let index = 0; index < 2; index++) {
    passed(await h.cli(instance, ["up", "--detach", "--json"]));
    await originalBaseline(h, ingress, instance, false);
    await savedOpen(h, instance);
    if (
      passed(
        await h.cli(instance, [
          "exec",
          "db",
          "--",
          "psql",
          "-U",
          "postgres",
          "-d",
          "fixture",
          "-At",
          "-c",
          "SELECT value FROM marker WHERE id=1",
        ])
      ).stdout.trim() !== instance.marker
    ) {
      return refuse();
    }
    await originalBaseline(h, ingress, sibling);
    passed(await h.cli(instance, ["down", "--json"]));
    await h.assertStopped(instance);
    await absent(ingress, instance);
    await originalBaseline(h, ingress, sibling);
  }
  passed(await h.cli(instance, ["config", "adopt", "--rollback", "--json"]));
  const rolledBack = await receipt(instance);
  if (
    !isRecord(rolledBack.publication) ||
    rolledBack.publication.phase !== "rolled-back"
  ) {
    return refuse();
  }
  await h.effect(["container", "start", ...originalIds(h, instance)]);
  await originalBaseline(h, ingress, instance);
  await originalBaseline(h, ingress, sibling);
}

/** Same old instances keep literal browser origins, SQL, resources and local
 * precedence. Only the existing temporary ingress owner may serve this fixture. */
export const nativeComposeAdoptionRoutingWorktreesScenario: Scenario = {
  name: "native-compose-adoption-routing-worktrees",
  tier: "docker",
  requiresExplicitSelection: true,
  preserveFixtureOnFailure: true,
  summary:
    "original routed linked checkouts retain TLS aliases, saved open, SQL and recovery/rollback",
  run: async (ctx) => {
    const h = createFixtureRuntime(
      await prepareFixtureInputs(ctx, { routing: true })
    );
    const ingress = await prepareNativeRoutingFixtureIngress({
      ctx,
      docker: h.probe,
    });
    if (
      h.first.routing?.image !== ingress.bunImage ||
      h.second.routing?.image !== ingress.bunImage
    ) {
      return refuse();
    }
    const localPins = new Map<Instance, string>();
    let claimsRoot: string | null = null;
    let complete = false;
    await runWithFixtureCleanup({
      run: async () => {
        const binding = await ingress.start();
        claimsRoot = join(
          ctx.hackHome,
          "compose-routing",
          createHash("sha256").update(binding.engineId).digest("hex"),
          "claims"
        );
        for (const instance of [h.first, h.second]) {
          localPins.set(
            instance,
            await retainedRoutingFixtureLocalSnapshot({
              primary: h.primary,
              instance,
            })
          );
          await bootstrapOriginal(h, instance);
          await originalBaseline(h, ingress, instance);
        }
        await partialStop(h);
        await roundTrip(h, ingress, h.first, h.second, true);
        await roundTrip(h, ingress, h.second, h.first, false);
        for (const instance of [h.first, h.second]) {
          if (
            (await retainedRoutingFixtureLocalSnapshot({
              primary: h.primary,
              instance,
            })) !== localPins.get(instance)
          ) {
            return refuse();
          }
        }
        if ((await nativeRoutedDownClaimSnapshot(claimsRoot)) !== "") {
          return refuse();
        }
        complete = true;
        ctx.log(
          "original literal TLS/OAuth origins, checkout-local saved open, SQL/IDs and known partial-stop recovery/rollback verified"
        );
      },
      cleanup: async () => {
        if (
          !(complete && claimsRoot) ||
          (await nativeRoutedDownClaimSnapshot(claimsRoot)) !== ""
        ) {
          return refuse();
        }
        // The rolled-back original workloads are stopped and their exact routes
        // disappear before any project cleanup or temporary ingress retirement.
        for (const instance of [h.first, h.second]) {
          await h.check(instance);
          await h.effect(["container", "stop", ...originalIds(h, instance)]);
          await h.assertStopped(instance);
          await absent(ingress, instance);
        }
        await cleanupOwnedAdoptionFixture({
          ...h,
          instances: [h.first, h.second],
        });
        await ingress.cleanup();
      },
      secondaryFailure: () =>
        ctx.retainFixtures(
          "Retained routing fixture ownership or cleanup is uncertain"
        ),
    });
  },
};
