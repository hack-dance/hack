import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("native signal ownership waits for child cleanup before retiring host lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-lifecycle-signal-"));
  const script = join(root, "driver.ts");
  const trace = join(root, "trace");
  const ready = join(root, "ready");
  const module = resolve(
    import.meta.dir,
    "../src/backends/native-project-lifecycle.ts"
  );
  await Bun.write(
    script,
    `
    import { appendFileSync } from "node:fs";
    import { adoptNativeLifecycleCleanup } from ${JSON.stringify(module)};
    const mark = (s) => appendFileSync(${JSON.stringify(trace)}, s + "\\n");
    const child = Bun.spawn([process.execPath,"-e", 'process.on("SIGTERM",async()=>{await Bun.sleep(200);process.stdout.write("cleaned");process.exit(0)});console.log("ready");await Bun.sleep(10000)'], {stdout:"pipe",stderr:"ignore"});
    const reader = child.stdout.getReader(); await reader.read();
    const legacy = () => { mark("legacy-signal"); process.exit(99); };
    process.on("SIGINT",legacy);
    const cleanup = adoptNativeLifecycleCleanup({signalCleanup:{dispose(){process.off("SIGINT",legacy)}},cleanup:async()=>mark("lifecycle-cleaned")});
    process.on("SIGINT",async()=>{
      mark("native-signal"); child.kill("SIGTERM"); if (await child.exited !== 0) process.exit(98);
      mark("native-cleaned"); await cleanup(); process.exit(130);
    });
    await Bun.write(${JSON.stringify(ready)},"ready");
    await Bun.sleep(10000);
  `
  );
  const child = Bun.spawn([process.execPath, script], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const deadline = Date.now() + 3000;
    while (!(await Bun.file(ready).exists()) && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    expect(await Bun.file(ready).exists()).toBe(true);
    child.kill("SIGINT");
    expect(await child.exited).toBe(130);
    expect(await Bun.file(trace).text()).toBe(
      "native-signal\nnative-cleaned\nlifecycle-cleaned\n"
    );
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});
