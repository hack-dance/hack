import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveNativeProjectGraph } from "../src/backends/native-project-process.ts";

const roots: string[] = [];
const run = "a".repeat(32);
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
async function fixture(program: string) {
  const root = await mkdtemp(join(tmpdir(), "native-process-"));
  roots.push(root);
  const script = join(root, "fake.ts"),
    binary = join(root, "fake-native");
  await writeFile(script, program);
  await writeFile(
    binary,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`
  );
  await chmod(binary, 0o700);
  return {
    runtime: { binary, home: root },
    projectRoot: root,
    run,
    args: ["--project", root],
    startupTimeoutMs: 2000,
  };
}
test("foreground owner receives private stdin, reports readiness once and returns completion", async () => {
  const opts = await fixture(`
    const input = JSON.parse(await Bun.stdin.text());
    if (input.value !== "synthetic-private-input" || process.argv.some(a => a.includes("synthetic-private-input"))) process.exit(19);
    console.log(JSON.stringify({kind:"graph_foreground_ready",run:"${run}"}));
    await Bun.sleep(30);
    console.log(JSON.stringify({phase:"cleaned"}));
  `);
  let ready = 0;
  const code = await serveNativeProjectGraph({
    ...opts,
    privateInput: new TextEncoder().encode(
      JSON.stringify({ value: "synthetic-private-input" })
    ),
    onReady: async () => {
      ready++;
    },
  });
  expect(code).toBe(0);
  expect(ready).toBe(1);
});
test("wrong readiness identity never publishes a mapping and stops the owned child", async () => {
  const opts = await fixture(
    `console.log(JSON.stringify({kind:"graph_foreground_ready",run:"${"b".repeat(32)}"})); await Bun.sleep(10000);`
  );
  let ready = false;
  await expect(
    serveNativeProjectGraph({
      ...opts,
      onReady: async () => {
        ready = true;
      },
    })
  ).rejects.toThrow("identity");
  expect(ready).toBe(false);
});
test("startup timeout and pre-cancellation do not become readiness", async () => {
  const opts = await fixture("await Bun.sleep(10000)");
  let ready = false;
  await expect(
    serveNativeProjectGraph({
      ...opts,
      startupTimeoutMs: 30,
      onReady: async () => {
        ready = true;
      },
    })
  ).rejects.toThrow("interrupted");
  const controller = new AbortController();
  controller.abort();
  await expect(
    serveNativeProjectGraph({
      ...opts,
      signal: controller.signal,
      onReady: async () => {
        ready = true;
      },
    })
  ).rejects.toThrow("canceled");
  expect(ready).toBe(false);
});
test("failed owner preserves nonzero completion and callback failure terminates ownership", async () => {
  const opts = await fixture(
    `console.log(JSON.stringify({kind:"graph_foreground_ready",run:"${run}"})); await Bun.sleep(20); process.exit(23);`
  );
  expect(
    await serveNativeProjectGraph({ ...opts, onReady: async () => {} })
  ).toBe(23);
  const waiting = await fixture(
    `console.log(JSON.stringify({kind:"graph_foreground_ready",run:"${run}"})); await Bun.sleep(10000);`
  );
  await expect(
    serveNativeProjectGraph({
      ...waiting,
      onReady: async () => {
        throw new Error("mapping refused");
      },
    })
  ).rejects.toThrow("mapping refused");
});

test("structured startup failure exposes its code without stderr values", async () => {
  const opts = await fixture(
    'console.error(JSON.stringify({code:"graph_budget",message:"synthetic-private-detail"}));process.exit(2);'
  );
  let failure = "";
  try {
    await serveNativeProjectGraph({
      ...opts,
      onReady: async () => {
        throw new Error("must not become ready");
      },
    });
  } catch (error) {
    failure = String(error);
  }
  expect(failure).toContain("graph_budget");
  expect(failure).not.toContain("synthetic-private-detail");
});

test("cancellation preserves the owner's graceful cleanup beyond five seconds", async () => {
  const opts = await fixture(`
    process.on("SIGTERM", async () => {
      await Bun.sleep(6000);
      await Bun.write(${JSON.stringify("PLACEHOLDER")}, "cleaned");
      process.exit(0);
    });
    console.log(JSON.stringify({kind:"graph_foreground_ready",run:"${run}"}));
    await Bun.sleep(30000);
  `);
  const marker = join(opts.projectRoot, "cleanup-complete");
  const file = join(opts.projectRoot, "fake.ts");
  await Bun.write(
    file,
    (await Bun.file(file).text()).replace("PLACEHOLDER", marker)
  );
  const controller = new AbortController();
  await expect(
    serveNativeProjectGraph({
      ...opts,
      signal: controller.signal,
      onReady: async () => {
        setTimeout(() => controller.abort(), 20);
      },
    })
  ).rejects.toThrow("interrupted");
  expect(await Bun.file(marker).text()).toBe("cleaned");
}, 15_000);

test("early receiver rejection drains its safe code despite a broken private-input pipe", async () => {
  const opts = await fixture(`
    import { appendFileSync, closeSync } from "node:fs";
    appendFileSync("attempts", "attempt\\n");
    closeSync(0);
    await Bun.sleep(20);
    console.error(JSON.stringify({code:"graph_budget",message:"synthetic-private-detail"}));
    process.exit(2);
  `);
  let failure = "";
  let ready = 0;
  try {
    await serveNativeProjectGraph({
      ...opts,
      privateInput: new TextEncoder().encode(
        "synthetic-private-payload".repeat(10_000)
      ),
      onReady: async () => {
        ready++;
      },
    });
  } catch (error) {
    failure = String(error);
  }
  expect(failure).toContain("graph_budget");
  expect(failure).not.toContain("synthetic-private");
  expect(ready).toBe(0);
  expect(await Bun.file(join(opts.projectRoot, "attempts")).text()).toBe(
    "attempt\n"
  );
});

test("readiness rejection retains identity while observing safe native cleanup code", async () => {
  const opts = await fixture(`
    process.on("SIGTERM", () => {
      console.error(JSON.stringify({code:"graph_owner_recovery",message:"synthetic-private-cleanup"}));
      process.exit(2);
    });
    console.log(JSON.stringify({kind:"graph_foreground_ready",run:"${run}"}));
    await Bun.sleep(10000);
  `);
  const failure = new Error("synthetic TLS failure");
  let diagnostic: unknown;
  await expect(
    serveNativeProjectGraph({
      ...opts,
      onReady: async () => {
        throw failure;
      },
      onExitDiagnostic: (value) => {
        diagnostic = value;
        throw new Error("observer failure");
      },
    })
  ).rejects.toBe(failure);
  expect(diagnostic).toEqual({
    exitCode: 2,
    nativeCode: "graph_owner_recovery",
  });
  expect(Bun.inspect(diagnostic)).not.toContain("synthetic-private-cleanup");
});

test("owned exit completes without waiting for descendant-held stdout and stderr", async () => {
  const opts = await fixture(`
    const keeper = Bun.spawn(["/bin/sh", "-c", "sleep 3"], {
      stdin: "ignore", stdout: "inherit", stderr: "inherit", detached: true,
    });
    keeper.unref();
    console.log(JSON.stringify({kind:"graph_foreground_ready",run:"${run}"}));
    console.error(JSON.stringify({code:"graph_owner_recovery",message:"synthetic-private-detail"}));
    process.exit(0);
  `);
  let diagnostic: unknown;
  const started = performance.now();
  const result = await serveNativeProjectGraph({
    ...opts,
    onReady: async () => {},
    onExitDiagnostic: (value) => {
      diagnostic = value;
    },
  });
  expect(result).toBe(0);
  expect(performance.now() - started).toBeLessThan(1500);
  expect(diagnostic).toEqual({
    exitCode: 0,
    nativeCode: "graph_owner_recovery",
  });
  expect(Bun.inspect(diagnostic)).not.toContain("synthetic-private-detail");
}, 6000);

test("early native failure retains its safe code when descendant pipes stay open", async () => {
  const opts = await fixture(`
    const keeper = Bun.spawn(["/bin/sh", "-c", "sleep 3"], {
      stdin: "ignore", stdout: "inherit", stderr: "inherit", detached: true,
    });
    keeper.unref();
    console.error(JSON.stringify({code:"graph_budget",message:"synthetic-private-detail"}));
    process.exit(2);
  `);
  let ready = false;
  const started = performance.now();
  await expect(
    serveNativeProjectGraph({
      ...opts,
      onReady: async () => {
        ready = true;
      },
    })
  ).rejects.toThrow("graph_budget");
  expect(ready).toBe(false);
  expect(performance.now() - started).toBeLessThan(1500);
}, 6000);
