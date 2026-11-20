import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NATIVE_SOURCE_NOTIFY_BACK,
  NATIVE_SOURCE_NOTIFY_STOPPED,
  NATIVE_SOURCE_NOTIFY_UNAVAILABLE,
  nativeHotReloadUsesWatcher,
  startNativeSourceNotify,
} from "../src/backends/native-source-notify.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

const WATCHER_POOL = { hot_reload: { state: "watcher", reason: "watcher" } };

/** A stand-in for `hack-native runtime source-notify`, driven by a mode file. */
async function fixture(mode: string) {
  const home = await mkdtemp(join(tmpdir(), "hack-source-notify-"));
  roots.push(home);
  const binary = join(home, "native");
  await writeFile(join(home, "mode"), mode);
  await writeFile(
    binary,
    `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const home = ${JSON.stringify(home)};
const mode = readFileSync(home + "/mode", "utf8");
const first = !existsSync(home + "/starts");
appendFileSync(home + "/starts", "s");
writeFileSync(home + "/argv", JSON.stringify(process.argv.slice(2)));
writeFileSync(home + "/env", JSON.stringify(Object.keys(process.env).sort()));
if (mode === "unavailable") {
  console.error("noise");
  console.error(JSON.stringify({ code: "source_notify_unavailable", message: "synthetic-private-value" }));
  process.exit(2);
}
console.log("source-notify: forwarding");
if (mode === "die-once" && first) {
  await Bun.sleep(30);
  process.exit(1);
}
if (mode === "ignore-stop") {
  await Bun.sleep(60_000);
}
await Bun.stdin.text();
appendFileSync(home + "/stopped", "x");
`
  );
  await chmod(binary, 0o700);
  return { home, binary };
}

async function settled<T>(
  read: () => Promise<T | undefined> | T | undefined
): Promise<T> {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    await Bun.sleep(10);
  }
  throw new Error("The stand-in watcher did not settle within its budget");
}

const text = (path: string) => readFile(path, "utf8").catch(() => undefined);

test("HACK-2409: only a pool in watcher mode gets a watcher child", async () => {
  expect(nativeHotReloadUsesWatcher(WATCHER_POOL)).toBe(true);
  for (const pool of [
    { hot_reload: { state: "on" } },
    { hot_reload: { state: "off", reason: "large_share", limit: 100_000 } },
    { hot_reload: null },
    {},
    null,
  ]) {
    expect(nativeHotReloadUsesWatcher(pool)).toBe(false);
    const runtime = await fixture("ok");
    expect(
      startNativeSourceNotify({
        runtime,
        projectRoot: runtime.home,
        pool,
        warn: () => undefined,
      })
    ).toBeUndefined();
    expect(await text(join(runtime.home, "starts"))).toBeUndefined();
  }
});

test("HACK-2409: the watcher child runs for the project with a closed environment and stops when its input closes", async () => {
  const runtime = await fixture("ok");
  const warnings: string[] = [];
  const prior = process.env.HACK_SOURCE_NOTIFY_CANARY;
  process.env.HACK_SOURCE_NOTIFY_CANARY = "synthetic-private-canary";
  try {
    const stop = startNativeSourceNotify({
      runtime,
      projectRoot: runtime.home,
      pool: WATCHER_POOL,
      warn: (line) => warnings.push(line),
    });
    expect(stop).toBeDefined();
    const argv = await settled(() => text(join(runtime.home, "argv")));
    expect(JSON.parse(argv)).toEqual([
      "--candidate-root",
      runtime.home,
      "runtime",
      "source-notify",
      "--project",
      runtime.home,
      "--until-stdin-closes",
    ]);
    const env = await settled(() => text(join(runtime.home, "env")));
    expect(JSON.parse(env)).not.toContain("HACK_SOURCE_NOTIFY_CANARY");
    await stop?.();
    // It ended because its input closed, not because it was killed.
    expect(await text(join(runtime.home, "stopped"))).toBe("x");
    expect(warnings).toEqual([]);
    expect(await text(join(runtime.home, "starts"))).toBe("s");
  } finally {
    if (prior === undefined) {
      Reflect.deleteProperty(process.env, "HACK_SOURCE_NOTIFY_CANARY");
    } else {
      process.env.HACK_SOURCE_NOTIFY_CANARY = prior;
    }
  }
});

test("HACK-2409: a watcher that dies mid-run is reported once, restarted, and reported back", async () => {
  const runtime = await fixture("die-once");
  const warnings: string[] = [];
  const stop = startNativeSourceNotify({
    runtime,
    projectRoot: runtime.home,
    pool: WATCHER_POOL,
    warn: (line) => warnings.push(line),
    restartDelaysMs: [20],
  });
  await settled(() =>
    warnings.includes(NATIVE_SOURCE_NOTIFY_BACK) ? true : undefined
  );
  expect(warnings).toEqual([
    NATIVE_SOURCE_NOTIFY_STOPPED,
    NATIVE_SOURCE_NOTIFY_BACK,
  ]);
  expect(await text(join(runtime.home, "starts"))).toBe("ss");
  await stop?.();
  expect(await text(join(runtime.home, "stopped"))).toBe("x");
  // Nothing is restarted after the run has stopped.
  await Bun.sleep(80);
  expect(await text(join(runtime.home, "starts"))).toBe("ss");
});

test("HACK-2409: a guest that takes no file-change events is said once and not retried, and the runtime's text is not shown", async () => {
  const runtime = await fixture("unavailable");
  const warnings: string[] = [];
  const stop = startNativeSourceNotify({
    runtime,
    projectRoot: runtime.home,
    pool: WATCHER_POOL,
    warn: (line) => warnings.push(line),
    restartDelaysMs: [20],
  });
  await settled(() => (warnings.length > 0 ? true : undefined));
  await Bun.sleep(120);
  expect(warnings).toEqual([NATIVE_SOURCE_NOTIFY_UNAVAILABLE]);
  expect(warnings.join("\n")).not.toContain("synthetic-private-value");
  expect(await text(join(runtime.home, "starts"))).toBe("s");
  await stop?.();
});

test("HACK-2409: stopping a watcher that ignores the request ends it anyway", async () => {
  const runtime = await fixture("ignore-stop");
  const stop = startNativeSourceNotify({
    runtime,
    projectRoot: runtime.home,
    pool: WATCHER_POOL,
    warn: () => undefined,
  });
  await settled(() => text(join(runtime.home, "argv")));
  const started = performance.now();
  await stop?.();
  expect(performance.now() - started).toBeLessThan(4000);
  expect(await text(join(runtime.home, "stopped"))).toBeUndefined();
}, 10_000);
