import { expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeRetainedBuildFixtureCli } from "./e2e/scenarios/native-compose-adoption-build-diagnostics.ts";

const CANARY = "private-build-cli-diagnostic-canary";
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "retained-build-cli-diagnostic-"))
  );
  await chmod(root, 0o700);
  const messages: string[] = [];
  const context = {
    tempRoot: root,
    log: (message: string) => messages.push(message),
  };
  return {
    root,
    messages,
    context,
    close: () => rm(root, { recursive: true, force: true }),
  };
}
function observation<
  T extends {
    exitCode: number;
    timedOut: boolean;
    stdout: string;
    stderr: string;
  },
>(context: { tempRoot: string; log?: (message: string) => void }, value: T) {
  return observeRetainedBuildFixtureCli({
    context,
    mode: "root-specific",
    args: ["down", "--recover", "--json"],
    driftAfterStart: false,
    run: async () => value,
  });
}
const refused = {
  exitCode: 94,
  timedOut: false,
  stdout: JSON.stringify({
    ok: false,
    error: { code: "E_STATE", message: CANARY },
    private: CANARY,
  }),
  stderr: "retained-build-refused stage=mutation-admission code=94\n",
};

test("retained build CLI captures a nonzero result before caller assertions and preserves result identity", async () => {
  const h = await fixture();
  try {
    expect(await observation(h.context, refused)).toBe(refused);
    const directory = join(h.root, "retained-build-cli");
    const files = (await readdir(directory)).sort();
    expect(files).toEqual(["0001.json", "0002.json", "0003.json"]);
    const rows = await Promise.all(
      files.map(async (file) => {
        const path = join(directory, file);
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        return JSON.parse(await readFile(path, "utf8"));
      })
    );
    expect(rows.map((row) => row.stage)).toEqual([
      "begin",
      "result",
      "settled",
    ]);
    expect(rows[1]).toMatchObject({
      invocation: 1,
      mode: "root-specific",
      operation: "recover-stop",
      exitCode: 94,
      timedOut: false,
      code: "E_STATE",
      readGuardRefused: false,
      mutationGuardRefused: true,
    });
    expect(
      rows.every(
        (row) => Number.isSafeInteger(row.elapsedMs) && row.elapsedMs >= 0
      )
    ).toBe(true);
    expect(rows[2].elapsedMs).toBeGreaterThanOrEqual(rows[0].elapsedMs);
    expect(JSON.stringify(rows)).not.toContain(CANARY);
    expect(h.messages.join("\n")).not.toContain(CANARY);
    expect(h.messages.join("\n")).not.toContain(h.root);
    expect(h.messages.join("\n")).not.toContain("--recover");
  } finally {
    await h.close();
  }
});

test("retained build CLI preserves the original thrown error and records its failing invocation without its contents", async () => {
  const h = await fixture();
  try {
    await observation(h.context, {
      ...refused,
      exitCode: 0,
      stdout: '{"ok":true}',
      stderr: "",
    });
    const original = new Error(CANARY);
    let observed: unknown;
    try {
      await observeRetainedBuildFixtureCli({
        context: h.context,
        mode: "hack-default",
        args: ["up", "--detach", "--json"],
        driftAfterStart: true,
        run: async () => {
          throw original;
        },
      });
    } catch (error) {
      observed = error;
    }
    expect(observed).toBe(original);
    const row = JSON.parse(
      await readFile(join(h.root, "retained-build-cli/0005.json"), "utf8")
    );
    expect(row).toMatchObject({
      invocation: 2,
      operation: "start-with-context-drift",
      mode: "hack-default",
      stage: "thrown",
    });
    expect(h.messages.join("\n")).toContain('"code":"none"');
    expect(h.messages.join("\n")).not.toContain(CANARY);
    expect(h.messages.join("\n")).not.toContain(original.stack ?? CANARY);
  } finally {
    await h.close();
  }
});

test("retained build CLI omits unknown labels, codes, malformed replies and oversized private replies", async () => {
  const h = await fixture();
  try {
    for (const stdout of [
      CANARY,
      JSON.stringify({ ok: false, error: { code: CANARY } }),
      CANARY.repeat(5000),
    ]) {
      const result = { ...refused, stdout, stderr: CANARY };
      expect(
        await observeRetainedBuildFixtureCli({
          context: h.context,
          mode: CANARY,
          args: [CANARY],
          driftAfterStart: false,
          run: async () => result,
        })
      ).toBe(result);
    }
    const results = h.messages
      .map((message) => JSON.parse(message.slice("retained-build-cli ".length)))
      .filter((row) => row.stage === "result");
    expect(results).toHaveLength(3);
    for (const row of results)
      expect(row).toMatchObject({
        mode: "unavailable",
        operation: "unavailable",
        code: "unavailable",
        readGuardRefused: false,
        mutationGuardRefused: false,
      });
    expect(h.messages.join("\n")).not.toContain(CANARY);
  } finally {
    await h.close();
  }
});

test("retained build CLI treats unreadable result fields as unavailable without replacing the result", async () => {
  const h = await fixture();
  try {
    const result = { ...refused };
    Object.defineProperty(result, "stdout", {
      get: () => {
        throw new Error(CANARY);
      },
    });
    expect(await observation(h.context, result)).toBe(result);
    const row = JSON.parse(
      await readFile(join(h.root, "retained-build-cli/0002.json"), "utf8")
    );
    expect(row).toMatchObject({
      exitCode: "unavailable",
      timedOut: "unavailable",
      code: "unavailable",
      readGuardRefused: "unavailable",
      mutationGuardRefused: "unavailable",
    });
    expect(h.messages.join("\n")).not.toContain(CANARY);
  } finally {
    await h.close();
  }
});

test("retained build CLI capture and logger failures preserve success and the original thrown error", async () => {
  const h = await fixture();
  try {
    const blocked = join(h.root, "not-a-directory");
    await writeFile(blocked, CANARY, { mode: 0o600 });
    const context = {
      tempRoot: blocked,
      log: () => {
        throw new Error(CANARY);
      },
    };
    expect(await observation(context, refused)).toBe(refused);
    const original = new Error(CANARY);
    let observed: unknown;
    try {
      await observeRetainedBuildFixtureCli({
        context,
        mode: "root-specific",
        args: ["down", "--json"],
        driftAfterStart: false,
        run: async () => {
          throw original;
        },
      });
    } catch (error) {
      observed = error;
    }
    expect(observed).toBe(original);
    expect(await readFile(blocked, "utf8")).toBe(CANARY);
  } finally {
    await h.close();
  }
});
