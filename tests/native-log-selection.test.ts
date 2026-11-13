import { expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectNativeLogContainer } from "../src/backends/native-log-selection.ts";

const selection = {
  run: "a".repeat(32),
  owner: "b".repeat(32),
  plan: "c".repeat(64),
  namespace: "d".repeat(64),
  native: false,
};
const response = {
  version: 1,
  kind: "native-log-selection",
  service: "web",
  container: "e".repeat(64),
};

async function fixture(script = "") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "log-select-")));
  const binary = join(root, "runtime");
  await writeFile(binary, `#!${process.execPath}\n${script}`);
  await chmod(binary, 0o700);
  return {
    root,
    input: {
      runtime: { binary, home: root },
      cwd: root,
      service: "web",
      selection,
      signal: new AbortController().signal,
    },
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

test("finite selection binds service and mapping, uses no stream flags, and strictly parses the response", async () => {
  const f = await fixture();
  try {
    const selected = await selectNativeLogContainer({
      ...f.input,
      invoke: async (request) => {
        expect(request.args).toEqual([
          "graph",
          "logs-follow",
          "--selection-only",
          "--run-id",
          selection.run,
          "--service",
          "web",
          "--expect-owner",
          selection.owner,
          "--expect-plan",
          selection.plan,
          "--expect-namespace",
          selection.namespace,
        ]);
        expect(request.timeoutMs).toBe(5000);
        expect(request.signal).toBe(f.input.signal);
        expect(request.processGroup).toBe("own");
        return response;
      },
    });
    expect(selected).toEqual({ ...selection, container: response.container });
    for (const invalid of [
      null,
      {},
      { ...response, version: 2 },
      { ...response, service: "db" },
      { ...response, container: "bad" },
      { ...response, extra: true },
    ]) {
      await expect(
        selectNativeLogContainer({ ...f.input, invoke: async () => invalid })
      ).rejects.toThrow("selection");
    }
  } finally {
    await f.dispose();
  }
});

for (const mode of ["cancel", "timeout"] as const) {
  test(`selection ${mode} kills and reaps its owned runtime child`, async () => {
    const f = await fixture(
      `import { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[3] + "/pid", String(process.pid));\nsetInterval(() => {}, 1000);`
    );
    const controller = new AbortController();
    const result = selectNativeLogContainer({
      ...f.input,
      signal: controller.signal,
    }).then(
      () => null,
      (error: unknown) => error
    );
    try {
      let pid = 0;
      const deadline = Date.now() + 3000;
      while (!pid && Date.now() < deadline) {
        pid = Number(
          await readFile(join(f.root, "pid"), "utf8").catch(() => "0")
        );
        if (!pid) {
          await Bun.sleep(10);
        }
      }
      expect(pid).toBeGreaterThan(1);
      if (mode === "cancel") {
        controller.abort();
      }
      expect(await result).toBeInstanceOf(Error);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      controller.abort();
      await result;
      await f.dispose();
    }
  }, 10_000);
}
