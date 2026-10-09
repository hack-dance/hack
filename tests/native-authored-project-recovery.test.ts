import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as files from "node:fs/promises";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseNativeAuthoredReceipt } from "../src/backends/native-authored-graph-protocol.ts";
import * as incarnation from "../src/backends/native-authored-process-incarnation.ts";
import { recoverNativeAuthoredProject } from "../src/backends/native-authored-project-recovery.ts";
import {
  loadNativeAuthoredProjectRun,
  withNativeAuthoredProjectAdmission,
} from "../src/backends/native-authored-project-run.ts";
import type { invokeNativeRuntime } from "../src/backends/native-runtime-client.ts";
import { tryNativeAuthoredCommand } from "../src/lib/native-authored-command.ts";

let activeOriginalCases = 0;
let originalLifetimeUnknown = false;
beforeEach(() => {
  if (originalLifetimeUnknown) {
    throw new Error("Original-owner fixture lifetime unknown; retained.");
  }
});
function originalCase(name: string, body: () => Promise<void>) {
  test(name, async () => {
    activeOriginalCases++;
    try {
      await body();
    } finally {
      activeOriginalCases--;
    }
  }, 30_000);
}
const fixtures: Array<{
  root: string;
  child: ReturnType<typeof Bun.spawn>;
  finish?: () => Promise<void>;
}> = [];
afterEach(async () => {
  if (activeOriginalCases !== 0) {
    originalLifetimeUnknown = true;
  }
  if (originalLifetimeUnknown) {
    return;
  }
  const retained = fixtures.splice(0);
  for (const current of retained) {
    if (current.finish) {
      await current.finish();
    } else if (current.child.exitCode === null) {
      current.child.kill("SIGKILL");
    }
    await current.child.exited;
  }
  for (const root of new Set(retained.map((item) => item.root))) {
    await rm(root, { recursive: true, force: true });
  }
});
function receipt() {
  const run = "a".repeat(32);
  const provenance = {
    version: 1,
    kind: "native",
    namespace: "b".repeat(64),
    run,
    input: {
      semantic_hash: "c".repeat(64),
      local_resolution_hash: "d".repeat(64),
      environment_policy_hash: "e".repeat(64),
      selected_profiles: [],
    },
  };
  return parseNativeAuthoredReceipt({
    version: 2,
    kind: "native-graph-runtime",
    owner: "f".repeat(32),
    boot: "00000000-0000-0000-0000-000000000001",
    review: {
      provenance,
      review_id: createHash("sha256")
        .update("hack.native-graph-review/v1\0")
        .update(JSON.stringify(provenance))
        .digest("hex"),
    },
    phase: "ready-observed",
    readiness: { web: "healthy" },
    resources: {
      "network:default": {
        kind: "network",
        key: "default",
        name: `hkn-${run}-network-0`,
        id: "1".repeat(64),
        image: null,
        phase: "created",
        outbound: true,
      },
      "container:web": {
        kind: "container",
        key: "web",
        name: `hkn-${run}-container-0`,
        id: "2".repeat(64),
        image: `sha256:${"3".repeat(64)}`,
        phase: "started",
        networks: ["default"],
      },
    },
  });
}
function removed() {
  const original = receipt();
  return parseNativeAuthoredReceipt({
    ...original,
    phase: "removed",
    resources: Object.fromEntries(
      Object.entries(original.resources).map(([key, value]) => [
        key,
        { ...value, phase: "removed" },
      ])
    ),
  });
}
async function fixture(bootSession = false, liveStop = false) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-frontend-recovery-"))
  );
  await chmod(root, 0o700);
  const scope = {
    projectRoot: root,
    projectDir: join(root, ".hack"),
    nativeHome: join(root, "candidate"),
    branch: "qa",
  };
  await mkdir(scope.projectDir, { mode: 0o700 });
  await mkdir(scope.nativeHome, { mode: 0o700 });
  const program = [
    `import { withNativeAuthoredProjectAdmission } from ${JSON.stringify(join(import.meta.dir, "../src/backends/native-authored-project-run.ts"))};`,
    `const scope = ${JSON.stringify(scope)}; const receipt = ${JSON.stringify(receipt())};`,
    ...(liveStop ? ["let native, phase='admission'; try {"] : []),
    "await withNativeAuthoredProjectAdmission(scope, async admission => {",
    ...(liveStop ? ["phase='source';"] : []),
    "const source=await admission.prepareSource({run:receipt.review.provenance.run,metadata:{metadata_version:1,overlay:null,overlay_exists:true,workloads:{web:{TOKEN:{scope:'global',secret:true}}},inactive_scopes:[]}});",
    ...(liveStop ? ["phase='reserve';"] : []),
    "const start = await admission.reserve({review:receipt.review});",
    ...(liveStop ? ["phase='publish';"] : []),
    "const ready=await admission.publish({expectedStart:start,record:{version:2,kind:'native-authored-project-run',receipt}});",
    ...(liveStop
      ? [
          `const {captureNativeAuthoredProcessIncarnation}=await import(${JSON.stringify(join(import.meta.dir, "../src/backends/native-authored-process-incarnation.ts"))});`,
          "phase='spawn';native=Bun.spawn(['/bin/sleep','120'],{detached:true,stdin:'ignore',stdout:'ignore',stderr:'ignore'});",
          "phase='capture';const original=await captureNativeAuthoredProcessIncarnation({pid:native.pid,selected:'/bin/sleep'});",
          "phase='endpoint';await admission.publishLiveStop({expectedStart:start,expectedRun:ready,source,original,assertFresh:async()=>undefined,stop:async()=>false});",
          "void (async()=>{while(!(await Bun.file(scope.projectRoot+'/stop-original').exists()))await Bun.sleep(10);if(native.exitCode===null)native.kill('SIGKILL');await native.exited;await Bun.write(scope.projectRoot+'/native-settled','yes');process.exit(77)})();",
        ]
      : []),
    "await Bun.write(scope.projectRoot+'/witness','ready');",
    "await new Promise(resolve=>setTimeout(resolve,120000)); });",
    ...(liveStop
      ? [
          "} catch {await Bun.write(scope.projectRoot+'/setup-failure',phase);throw new Error('Original fixture setup refused; values omitted.')} finally {if(native){if(native.exitCode===null)native.kill('SIGKILL');await native.exited;await Bun.write(scope.projectRoot+'/native-settled','yes');}}",
        ]
      : []),
  ].join("\n");
  const child = Bun.spawn([process.execPath, "--eval", program], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
  });
  const finish = liveStop
    ? async () => {
        if (child.exitCode === null) {
          await Bun.write(join(root, "stop-original"), "yes");
        }
        const complete = child.exited.then(() => true);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const known = await Promise.race([
          complete,
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), 2000);
          }),
        ]);
        clearTimeout(timer);
        if (
          !(known && (await Bun.file(join(root, "native-settled")).exists()))
        ) {
          originalLifetimeUnknown = true;
          throw new Error("Original fixture settlement is unknown; retained.");
        }
      }
    : undefined;
  fixtures.push({ root, child, finish });
  const deadline = performance.now() + 5000;
  while (!(await Bun.file(join(root, "witness")).exists())) {
    if (child.exitCode !== null || performance.now() >= deadline) {
      const captured =
        liveStop && (await Bun.file(join(root, "setup-failure")).exists())
          ? await Bun.file(join(root, "setup-failure")).text()
          : "unknown";
      const phase = [
        "admission",
        "source",
        "reserve",
        "publish",
        "spawn",
        "capture",
        "endpoint",
      ].includes(captured)
        ? captured
        : "unknown";
      throw new Error(
        `Owned frontend did not publish Ready (${phase}); values omitted.`
      );
    }
    await Bun.sleep(10);
  }
  const dir = join(scope.projectDir, ".internal", "native-authored-runs");
  const key = createHash("sha256")
    .update(JSON.stringify(scope.branch))
    .digest("hex");
  const paths = {
    dir,
    ready: join(dir, `${key}.json`),
    start: join(dir, `${key}.start.json`),
    source: join(dir, `${"a".repeat(32)}.source.json`),
    admission: join(dir, `${key}.admission.lock`),
    recovery: join(dir, `${key}.admission.recovery`),
    intent: join(dir, `${key}.json.recovery.json`),
  };
  const calls: string[][] = [];
  let cleanupCalls = 0;
  const selection = {
    version: bootSession ? 2 : 1,
    kind: "native-graph-recovery-selection",
    run: "a".repeat(32),
    receipt: receipt(),
    receipt_sha256: "4".repeat(64),
    owner_sha256: "5".repeat(64),
    ...(bootSession
      ? { host_boot_uuid: "12345678-abcd-abcd-abcd-123456789abc" }
      : { host_boot_micros: 1_791_000_000_000_000 }),
  };
  const result = {
    version: 1,
    kind: "native-graph-live-owner-recovered",
    run: selection.run,
    same_boot: true,
    publication_retired: true,
    receipt: removed(),
  };
  const request: typeof invokeNativeRuntime = (opts) => {
    expect(opts.privateInput).toBeUndefined();
    expect(opts.cwd).toBe(root);
    calls.push([...opts.args]);
    if (opts.args[2] === "recovery-selection") {
      expect(opts.args).toEqual([
        "graph",
        "native",
        "recovery-selection",
        "--run-id",
        selection.run,
        "--json",
      ]);
      expect(opts.boundNativeAuthoredRecoveryDrain).toBe("selection");
      return Promise.resolve(structuredClone(selection));
    }
    if (opts.args[2] === "recover-live-owner") {
      expect(opts.args).toEqual([
        "graph",
        "native",
        "recover-live-owner",
        "--run-id",
        selection.run,
        "--expect-receipt",
        selection.receipt_sha256,
        "--expect-owner",
        selection.owner_sha256,
        "--json",
      ]);
      expect(opts.boundNativeAuthoredRecoveryDrain).toBe("cleanup");
      cleanupCalls++;
      return Promise.resolve(structuredClone(result));
    }
    expect(opts.args).toEqual([
      "graph",
      "native",
      "inspect",
      "--run-id",
      selection.run,
      "--json",
    ]);
    expect(opts.boundNativeAuthoredReadDrain).toBe(true);
    return Promise.resolve({ receipt: removed(), observations: { web: null } });
  };
  const options = {
    scope,
    runtime: {
      binary: liveStop ? "/bin/sleep" : join(root, "native-request-seam"),
      home: scope.nativeHome,
    },
    timeoutMs: 30_000,
    request,
  };
  return {
    root,
    child,
    scope,
    paths,
    calls,
    request,
    options,
    selection,
    result,
    cleanupCalls: () => cleanupCalls,
    async kill() {
      if (liveStop) {
        await Bun.write(join(root, "stop-original"), "yes");
      } else {
        child.kill("SIGKILL");
      }
      expect(await child.exited).toBe(liveStop ? 77 : 137);
    },
  };
}

test("explicit frontend recovery refuses a live admission before any native request", async () => {
  const current = await fixture();
  await expect(recoverNativeAuthoredProject(current.options)).rejects.toThrow();
  expect(current.calls).toEqual([]);
  expect(
    (await loadNativeAuthoredProjectRun(current.scope))?.record.receipt
  ).toEqual(receipt());
  expect(await Bun.file(current.paths.intent).exists()).toBe(false);
});

test("dead frontend recovery binds the stored run, holds startup, retires only after Removed/null and archives completed history", async () => {
  const current = await fixture();
  await current.kill();
  let ordinaryAction = false;
  const request: typeof invokeNativeRuntime = async (opts) => {
    await expect(
      withNativeAuthoredProjectAdmission(current.scope, async () => {
        ordinaryAction = true;
      })
    ).rejects.toThrow();
    return await current.request(opts);
  };
  const result = await recoverNativeAuthoredProject({
    ...current.options,
    request,
  });
  expect(result.receipt.phase).toBe("removed");
  expect(ordinaryAction).toBe(false);
  expect(current.cleanupCalls()).toBe(1);
  expect((await readdir(current.paths.dir)).sort()).toEqual(
    [".gitignore", basename(current.paths.intent)].sort()
  );
  const saved = JSON.parse(await Bun.file(current.paths.intent).text());
  expect(saved.record.phase).toBe("complete");
  expect(saved.record.lease_releasing).toBe(true);
  await recoverNativeAuthoredProject(current.options);
  expect(current.cleanupCalls()).toBe(1);
  await withNativeAuthoredProjectAdmission(current.scope, async () => {
    ordinaryAction = true;
  });
  expect(ordinaryAction).toBe(true);
  expect(await readdir(current.paths.dir)).toEqual([
    ".gitignore",
    `${current.selection.run}.frontend-recovered.json`,
  ]);
  expect(
    (
      await lstat(
        join(
          current.paths.dir,
          `${current.selection.run}.frontend-recovered.json`
        )
      )
    ).nlink
  ).toBe(1);
});

test("frontend recovery preserves UUID selection through complete retry without changing Ready or control versions", async () => {
  const current = await fixture(true);
  await current.kill();
  await recoverNativeAuthoredProject(current.options);
  const saved = JSON.parse(await Bun.file(current.paths.intent).text());
  expect(saved.record.native.version).toBe(2);
  expect(saved.record.native.host_boot_uuid).toBe(
    "12345678-abcd-abcd-abcd-123456789abc"
  );
  expect(saved.record.native).not.toHaveProperty("host_boot_micros");
  expect(saved.record.native.receipt.version).toBe(2);
  await recoverNativeAuthoredProject(current.options);
  expect(current.cleanupCalls()).toBe(1);
});

test("recovery refuses foreign Removed membership or nonnull current observations and retains frontend authority", async () => {
  for (const attack of ["id", "observation"]) {
    const current = await fixture();
    await current.kill();
    const request: typeof invokeNativeRuntime = async (opts) => {
      const value = await current.request(opts);
      if (opts.args[2] === "inspect") {
        if (attack === "id") {
          const receipt = removed();
          return {
            receipt: {
              ...receipt,
              resources: {
                ...receipt.resources,
                "container:web": {
                  ...receipt.resources["container:web"],
                  id: "9".repeat(64),
                },
              },
            },
            observations: { web: null },
          };
        }
        return {
          receipt: removed(),
          observations: { web: { state: "running", health: "healthy" } },
        };
      }
      return value;
    };
    await expect(
      recoverNativeAuthoredProject({ ...current.options, request })
    ).rejects.toThrow();
    expect(current.cleanupCalls()).toBe(1);
    for (const path of [
      current.paths.ready,
      current.paths.start,
      current.paths.source,
      current.paths.admission,
    ]) {
      expect(await lstat(path)).toBeDefined();
    }
    expect(
      JSON.parse(await Bun.file(current.paths.intent).text()).record.phase
    ).toBe("native-removed");
  }
});

test("same-byte source replacement after cleanup cannot authorize frontend retirement", async () => {
  const current = await fixture();
  await current.kill();
  const original = (await lstat(current.paths.source)).ino;
  const request: typeof invokeNativeRuntime = async (opts) => {
    const value = await current.request(opts);
    if (opts.args[2] === "recover-live-owner") {
      await copyFile(current.paths.source, join(current.root, "replacement"));
      await chmod(join(current.root, "replacement"), 0o600);
      await rename(join(current.root, "replacement"), current.paths.source);
    }
    return value;
  };
  await expect(
    recoverNativeAuthoredProject({ ...current.options, request })
  ).rejects.toThrow();
  expect((await lstat(current.paths.source)).ino).not.toBe(original);
  expect(await Bun.file(current.paths.ready).exists()).toBe(true);
  expect(
    JSON.parse(await Bun.file(current.paths.intent).text()).record.phase
  ).toBe("prepared");
});

test("retirement intent authorizes only its exact file absence after interrupted unlink", async () => {
  const current = await fixture();
  await current.kill();
  const originalUnlink = files.unlink;
  let interrupted = false;
  const spy = spyOn(files, "unlink").mockImplementation(async (path) => {
    await originalUnlink(path);
    if (path === current.paths.ready && !interrupted) {
      interrupted = true;
      throw new Error("Exact unlink completed before interrupted phase save.");
    }
  });
  try {
    await expect(
      recoverNativeAuthoredProject(current.options)
    ).rejects.toThrow();
  } finally {
    spy.mockRestore();
  }
  expect(interrupted).toBe(true);
  expect(await Bun.file(current.paths.ready).exists()).toBe(false);
  expect(
    JSON.parse(await Bun.file(current.paths.intent).text()).record.phase
  ).toBe("ready-retirement");
  await recoverNativeAuthoredProject(current.options);
  expect(current.cleanupCalls()).toBe(1);
  expect(
    JSON.parse(await Bun.file(current.paths.intent).text()).record.phase
  ).toBe("complete");
});

test("unexpected ready absence and pending intent never become retry or ordinary startup authority", async () => {
  const current = await fixture();
  await current.kill();
  const request: typeof invokeNativeRuntime = async (opts) => {
    const value = await current.request(opts);
    if (opts.args[2] === "inspect") {
      throw new Error("Inspection retained.");
    }
    return value;
  };
  await expect(
    recoverNativeAuthoredProject({ ...current.options, request })
  ).rejects.toThrow();
  expect(
    JSON.parse(await Bun.file(current.paths.intent).text()).record.phase
  ).toBe("native-removed");
  await unlink(current.paths.ready);
  const before = current.calls.length;
  await expect(recoverNativeAuthoredProject(current.options)).rejects.toThrow();
  expect(current.calls.length).toBe(before);
  await Bun.write(`${current.paths.intent}.pending`, "retained");
  await chmod(`${current.paths.intent}.pending`, 0o600);
  await expect(recoverNativeAuthoredProject(current.options)).rejects.toThrow();
  let called = false;
  await expect(
    withNativeAuthoredProjectAdmission(current.scope, async () => {
      called = true;
    })
  ).rejects.toThrow();
  expect(called).toBe(false);
});

async function interruptTakeover(
  current: Awaited<ReturnType<typeof fixture>>,
  stage: "reserved" | "promoted" | "released-owner" | "unreserved",
  kill = true
) {
  const witness = join(current.root, `takeover-${stage}`);
  const program = [
    "import {spyOn} from 'bun:test'; import * as files from 'node:fs/promises';",
    `import {recoverNativeAuthoredProject} from ${JSON.stringify(join(import.meta.dir, "../src/backends/native-authored-project-recovery.ts"))};`,
    `const paths=${JSON.stringify(current.paths)}; const stage=${JSON.stringify(stage)}; const witness=${JSON.stringify(witness)};`,
    "const pause=async()=>{await Bun.write(witness,stage);await new Promise(resolve=>setTimeout(resolve,120000));};",
    "const rename=files.rename, unlink=files.unlink, open=files.open;",
    "spyOn(files,'rename').mockImplementation(async(from,to)=>{",
    "if(stage==='reserved'&&from===paths.recovery+'/owner.pending'&&to===paths.recovery+'/owner'){await pause();}",
    "await rename(from,to);",
    "if(stage==='promoted'&&from===paths.recovery+'/owner.pending'&&to===paths.recovery+'/owner'){await pause();}",
    "});",
    "spyOn(files,'unlink').mockImplementation(async(path)=>{await unlink(path);if(stage==='released-owner'&&path===paths.recovery+'/owner'){await pause();}});",
    "spyOn(files,'open').mockImplementation(async(...args)=>{if(stage==='unreserved'&&args[0]===paths.intent+'.pending'){await pause();}return Reflect.apply(open,files,args);});",
    `const selection=${JSON.stringify(current.selection)};const result=${JSON.stringify(current.result)};`,
    `await recoverNativeAuthoredProject({scope:${JSON.stringify(current.scope)},runtime:${JSON.stringify(current.options.runtime)},timeoutMs:30000,request:async opts=>{`,
    "if(opts.args[2]!=='inspect'){throw new Error('Already removed retry must not replay cleanup.');}",
    "return {receipt:result.receipt,observations:{web:null}};}});",
    "await Bun.write(witness,'unexpected-completion');",
  ].join("\n");
  const child = Bun.spawn([process.execPath, "--eval", program], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
  });
  fixtures.push({ root: current.root, child });
  const deadline = performance.now() + 5000;
  while (!(await Bun.file(witness).exists())) {
    if (child.exitCode !== null || performance.now() >= deadline) {
      throw new Error("Owned takeover did not reach the named interruption.");
    }
    await Bun.sleep(10);
  }
  expect(await Bun.file(witness).text()).toBe(stage);
  if (kill) {
    child.kill("SIGKILL");
    expect(await child.exited).toBe(137);
  }
  return child;
}

test("durably reserved takeover survives exact abrupt exits before promotion, after promotion and during final release", async () => {
  for (const stage of ["reserved", "promoted", "released-owner"] as const) {
    const current = await fixture();
    await current.kill();
    const request: typeof invokeNativeRuntime = async (opts) => {
      const value = await current.request(opts);
      if (opts.args[2] === "inspect") {
        throw new Error("Retain native-removed for the next exact attempt.");
      }
      return value;
    };
    await expect(
      recoverNativeAuthoredProject({ ...current.options, request })
    ).rejects.toThrow();
    const original = JSON.parse(
      await Bun.file(current.paths.intent).text()
    ).record;
    expect(original.phase).toBe("native-removed");
    await interruptTakeover(current, stage);
    const interrupted = JSON.parse(
      await Bun.file(current.paths.intent).text()
    ).record;
    for (const key of ["ready", "start", "source", "admission", "native"]) {
      expect(interrupted[key]).toEqual(original[key]);
    }
    if (stage === "released-owner") {
      expect(interrupted.lease_releasing).toBe(true);
      expect(interrupted.next_lease).toBeNull();
      expect(await readdir(current.paths.recovery)).toEqual([]);
    } else {
      expect(interrupted.next_lease).not.toBeNull();
      expect(
        (
          await lstat(
            join(
              current.paths.recovery,
              stage === "reserved" ? "owner.pending" : "owner"
            )
          )
        ).ino
      ).toBe(interrupted.next_lease.file.ino);
    }
    expect(
      (await recoverNativeAuthoredProject(current.options)).receipt.phase
    ).toBe("removed");
    expect(current.cleanupCalls()).toBe(1);
    expect(
      JSON.parse(await Bun.file(current.paths.intent).text()).record.phase
    ).toBe("complete");
  }
}, 30_000);

test("an abrupt exit before candidate reservation retains unknown pending publication without runtime replay", async () => {
  const current = await fixture();
  await current.kill();
  const request: typeof invokeNativeRuntime = async (opts) => {
    const value = await current.request(opts);
    if (opts.args[2] === "inspect") {
      throw new Error("Retain native-removed.");
    }
    return value;
  };
  await expect(
    recoverNativeAuthoredProject({ ...current.options, request })
  ).rejects.toThrow();
  await interruptTakeover(current, "unreserved");
  const record = JSON.parse(await Bun.file(current.paths.intent).text()).record;
  expect(record.next_lease).toBeNull();
  expect(await readdir(current.paths.recovery)).toEqual(["owner.pending"]);
  const before = current.calls.length;
  await expect(recoverNativeAuthoredProject(current.options)).rejects.toThrow();
  expect(current.calls.length).toBe(before);
  expect(await readdir(current.paths.recovery)).toEqual(["owner.pending"]);
});

test("reserved takeover refuses live candidates and same-byte replaced pending inodes before requests", async () => {
  for (const attack of ["live", "replacement"] as const) {
    const current = await fixture();
    await current.kill();
    const request: typeof invokeNativeRuntime = async (opts) => {
      const value = await current.request(opts);
      if (opts.args[2] === "inspect") {
        throw new Error("Retain native-removed.");
      }
      return value;
    };
    await expect(
      recoverNativeAuthoredProject({ ...current.options, request })
    ).rejects.toThrow();
    const child = await interruptTakeover(
      current,
      "reserved",
      attack !== "live"
    );
    const pending = join(current.paths.recovery, "owner.pending");
    const original = await lstat(pending);
    if (attack === "replacement") {
      const replacement = join(current.root, "replacement-owner");
      await Bun.write(replacement, await Bun.file(pending).text());
      await chmod(replacement, 0o600);
      await rename(replacement, pending);
      expect((await lstat(pending)).ino).not.toBe(original.ino);
    }
    const before = current.calls.length;
    await expect(
      recoverNativeAuthoredProject(current.options)
    ).rejects.toThrow();
    expect(current.calls.length).toBe(before);
    expect(await Bun.file(current.paths.ready).exists()).toBe(true);
    if (attack === "live") {
      expect(child.exitCode).toBeNull();
      expect((await lstat(pending)).ino).toBe(original.ino);
      child.kill("SIGKILL");
      expect(await child.exited).toBe(137);
      await recoverNativeAuthoredProject(current.options);
      expect(current.cleanupCalls()).toBe(1);
    } else {
      expect((await lstat(pending)).ino).not.toBe(original.ino);
    }
  }
}, 30_000);

test("fresh recovery release failure retains each exact owner until a dead-owner retry", async () => {
  for (const guard of ["mutation", "lease"] as const) {
    const current = await fixture();
    await current.kill();
    const witness = join(current.root, `fresh-release-${guard}`);
    const program = [
      "import {spyOn} from 'bun:test'; import * as files from 'node:fs/promises';",
      `import {recoverNativeAuthoredProject} from ${JSON.stringify(join(import.meta.dir, "../src/backends/native-authored-project-recovery.ts"))};`,
      `const paths=${JSON.stringify(current.paths)}, guard=${JSON.stringify(guard)}, witness=${JSON.stringify(witness)};`,
      "const open=files.open;let rejected=false,cleanupCalls=0;",
      "spyOn(files,'open').mockImplementation(async(...args)=>{",
      "if(!rejected&&args[0]===paths.intent+'.pending'&&await Bun.file(paths.intent).exists()){",
      "const record=(await Bun.file(paths.intent).json()).record;",
      "if(record.phase==='complete'&&record.mutation_releasing===(guard==='lease')){rejected=true;throw new Error('Fixed release publication refusal.');}",
      "}return Reflect.apply(open,files,args);});",
      `const selection=${JSON.stringify(current.selection)},result=${JSON.stringify(current.result)};`,
      `try{await recoverNativeAuthoredProject({scope:${JSON.stringify(current.scope)},runtime:${JSON.stringify(current.options.runtime)},timeoutMs:30000,request:async opts=>{`,
      "if(opts.args[2]==='recovery-selection'){return selection;}if(opts.args[2]==='recover-live-owner'){cleanupCalls++;return result;}",
      "return {receipt:result.receipt,observations:{web:null}};}});throw new Error('Unexpected recovery success.');}",
      "catch{if(!rejected){throw new Error('Release boundary not observed.');}}",
      "await Bun.write(witness,JSON.stringify({rejected,cleanupCalls}));",
    ].join("\n");
    const child = Bun.spawn([process.execPath, "--eval", program], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
    });
    fixtures.push({ root: current.root, child });
    const deadline = performance.now() + 5000;
    while (!(await Bun.file(witness).exists())) {
      if (child.exitCode !== null || performance.now() >= deadline) {
        throw new Error("Owned fresh recovery did not reach release refusal.");
      }
      await Bun.sleep(10);
    }
    expect(await child.exited).toBe(0);
    expect(await Bun.file(witness).json()).toEqual({
      rejected: true,
      cleanupCalls: 1,
    });
    const record = JSON.parse(
      await Bun.file(current.paths.intent).text()
    ).record;
    expect(record.phase).toBe("complete");
    expect(
      record[guard === "lease" ? "lease_releasing" : "mutation_releasing"]
    ).toBe(false);
    const owner =
      guard === "lease"
        ? join(current.paths.recovery, "owner")
        : join(
            current.paths.dir,
            `${basename(current.paths.ready, ".json")}.lock`,
            "owner"
          );
    expect((await lstat(owner)).ino).toBe(record[guard].file.ino);
    expect(
      (await recoverNativeAuthoredProject(current.options)).receipt.phase
    ).toBe("removed");
    expect(current.cleanupCalls()).toBe(0);
    expect(await Bun.file(owner).exists()).toBe(false);
  }
}, 30_000);

originalCase(
  "new no-host death uses real read-only quiescence facts and retires only its exact bound record",
  async () => {
    const current = await fixture(true, true);
    await expect(
      recoverNativeAuthoredProject(current.options)
    ).rejects.toThrow();
    expect(current.calls).toEqual([]);
    await current.kill();
    let observedFailure: unknown;
    const observe = incarnation.assertNativeAuthoredProcessQuiescent;
    const observer = spyOn(
      incarnation,
      "assertNativeAuthoredProcessQuiescent"
    ).mockImplementation(async (...args) => {
      try {
        return await observe(...args);
      } catch (error) {
        observedFailure = error;
        throw error;
      }
    });
    try {
      if (process.platform === "darwin") {
        let actualFailure: unknown;
        const publicResult = tryNativeAuthoredCommand({
          selected: { kind: "native", projectRoot: current.root },
          options: {
            cwd: current.root,
            operation: "down",
            recover: true,
            instance: "qa",
          },
          env: {
            HACK_RUNTIME_BACKEND: "native",
            HACK_NATIVE_BINARY: "/bin/sleep",
            HACK_NATIVE_HOME: current.scope.nativeHome,
            HACK_COMPOSE_STARTUP_TIMEOUT_MS: "30000",
          },
          recover: async (options) => {
            try {
              return await recoverNativeAuthoredProject({
                ...options,
                request: current.request,
              });
            } catch (error) {
              actualFailure = error;
              throw error;
            }
          },
          serve: () => {
            throw new Error("Recovery must not start a generation.");
          },
        });
        try {
          expect(await publicResult).toBe(0);
        } catch (error) {
          throw observedFailure ?? actualFailure ?? error;
        }
      } else {
        expect(
          (await recoverNativeAuthoredProject(current.options)).receipt.phase
        ).toBe("removed");
      }
    } finally {
      if (!originalLifetimeUnknown) {
        observer.mockRestore();
      }
    }
    expect(current.cleanupCalls()).toBe(1);
    expect((await readdir(current.paths.dir)).sort()).toEqual(
      [".gitignore", basename(current.paths.intent)].sort()
    );
    const saved = JSON.parse(await Bun.file(current.paths.intent).text());
    expect(saved.record.version).toBe(2);
    expect(saved.record.live_stop_retired).toBe(true);
    expect(saved.record.live_stop.original.parent).toBe(current.child.pid);
  }
);
for (const attack of [
  "legacy",
  "foreign",
  "replaced",
  "occupied",
  "last-await",
] as const) {
  originalCase(
    `new no-host recovery retains original bindings on ${attack}`,
    async () => {
      const current = await fixture(true, true);
      await current.kill();
      const endpoint = (await readdir(current.paths.dir)).find((name) =>
        name.endsWith(".live-stop.json")
      );
      if (!endpoint) {
        throw new Error("Missing owned endpoint");
      }
      const path = join(current.paths.dir, endpoint);
      const text = await Bun.file(path).text();
      const value = JSON.parse(text);
      if (attack === "legacy") {
        value.version = 1;
        value.original = undefined;
        await files.writeFile(path, JSON.stringify(value));
      }
      if (attack === "foreign") {
        value.original.parent++;
        await files.writeFile(path, JSON.stringify(value));
      }
      if (attack === "replaced") {
        await rename(path, `${path}.old`);
        await files.writeFile(path, text, { mode: 0o600 });
      }
      if (attack === "occupied") {
        value.original.pid = process.pid;
        value.original.group = process.pid;
        value.original.session = String(process.pid);
        await files.writeFile(path, JSON.stringify(value));
      }
      const request: typeof invokeNativeRuntime = async (opts) => {
        const reply = await current.request(opts);
        if (attack === "last-await" && opts.args[2] === "recover-live-owner") {
          await files.writeFile(path, `${text} `);
        }
        return reply;
      };
      // Rebirth before the first selection is not historical authority; pinning is
      // performed under the recovery lease, so replace during the selected await.
      if (attack === "replaced") {
        const atSelection: typeof invokeNativeRuntime = async (opts) => {
          const reply = await request(opts);
          if (opts.args[2] === "recovery-selection") {
            await rename(path, `${path}.again`);
            await files.writeFile(path, text, { mode: 0o600 });
          }
          return reply;
        };
        await expect(
          recoverNativeAuthoredProject({
            ...current.options,
            request: atSelection,
          })
        ).rejects.toThrow();
      } else {
        await expect(
          recoverNativeAuthoredProject({ ...current.options, request })
        ).rejects.toThrow();
      }
      expect(await Bun.file(current.paths.ready).exists()).toBe(true);
      expect(await Bun.file(current.paths.start).exists()).toBe(true);
      expect(await Bun.file(current.paths.source).exists()).toBe(true);
      expect(await Bun.file(path).exists()).toBe(true);
      expect(current.cleanupCalls()).toBe(attack === "last-await" ? 1 : 0);
    }
  );
}

originalCase(
  "unknown original session census retains every binding before native selection",
  async () => {
    const current = await fixture(true, true);
    await current.kill();
    const spy = spyOn(
      incarnation,
      "assertNativeAuthoredProcessQuiescent"
    ).mockRejectedValue(
      new Error("Unknown complete session census; values omitted.")
    );
    try {
      await expect(
        recoverNativeAuthoredProject(current.options)
      ).rejects.toThrow();
      expect(current.calls).toEqual([]);
      for (const path of [
        current.paths.ready,
        current.paths.start,
        current.paths.source,
      ]) {
        expect(await Bun.file(path).exists()).toBe(true);
      }
      expect(await Bun.file(current.paths.intent).exists()).toBe(false);
    } finally {
      if (!originalLifetimeUnknown) {
        spy.mockRestore();
      }
    }
  }
);
