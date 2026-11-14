import { expect, test } from "bun:test";
import {
  type MuxCommandSample,
  MuxCommandTimeoutError,
  observeMuxCommands,
  runMuxCommand,
} from "../src/mux/mux-backend.ts";

const CANARY = "synthetic-private-mux-observation";

test("mux timing observations are scoped and omit arguments and output", async () => {
  const first: MuxCommandSample[] = [];
  const second: MuxCommandSample[] = [];
  const results = await Promise.all(
    [first, second].map((samples, index) =>
      observeMuxCommands({
        onSample: (sample) => {
          samples.push(sample);
        },
        action: () =>
          runMuxCommand([
            "/bin/sh",
            "-c",
            `printf '%s' '${CANARY}'; exit ${index + 6}`,
          ]),
      })
    )
  );
  for (const [index, samples] of [first, second].entries()) {
    expect(results[index]).toMatchObject({
      stdout: CANARY,
      exitCode: index + 6,
    });
    expect(samples.map((sample) => sample.phase)).toEqual([
      "started",
      "finished",
    ]);
    expect(samples[1]).toMatchObject({
      backend: "other",
      operation: "other",
      timedOut: false,
      exitCode: index + 6,
    });
    expect(samples[1]?.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(samples)).not.toContain(CANARY);
    expect(Object.isFrozen(samples[1])).toBe(true);
  }
  await runMuxCommand(["/bin/sh", "-c", "exit 0"]);
  expect(first).toHaveLength(2);
  expect(second).toHaveLength(2);
});

test("mux timing distinguishes a fired timeout from a command that exits 124", async () => {
  for (const [script, timedOut] of [
    ["sleep 10", true],
    ["exit 124", false],
  ] as const) {
    const samples: MuxCommandSample[] = [];
    await expect(
      observeMuxCommands({
        onSample: (sample) => {
          samples.push(sample);
        },
        action: () =>
          runMuxCommand(["/bin/sh", "-c", script], {
            timeoutMs: timedOut ? 80 : 5000,
          }),
      })
    ).rejects.toBeInstanceOf(MuxCommandTimeoutError);
    expect(samples[1]?.phase).toBe("finished");
    expect(samples[1]?.timedOut).toBe(timedOut);
  }
});

test("throwing or rejecting timing observers cannot replace a mux result or timeout", async () => {
  for (const onSample of [
    () => {
      throw new Error(CANARY);
    },
    () => Promise.reject(new Error(CANARY)),
  ]) {
    await expect(
      observeMuxCommands({
        onSample,
        action: () => runMuxCommand(["/bin/sh", "-c", "exit 7"]),
      })
    ).resolves.toMatchObject({ exitCode: 7 });
    await expect(
      observeMuxCommands({
        onSample,
        action: () =>
          runMuxCommand(["/bin/sh", "-c", "sleep 10"], { timeoutMs: 80 }),
      })
    ).rejects.toBeInstanceOf(MuxCommandTimeoutError);
  }
  await expect(
    runMuxCommand(["/bin/sh", "-c", "exit 7"], {
      onTiming: () => Promise.reject(new Error(CANARY)),
    })
  ).resolves.toMatchObject({ exitCode: 7 });
});
