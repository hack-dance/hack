import { expect, test } from "bun:test";
import { connect } from "node:net";
import {
  requestNativeHookStop,
  serveNativeHookStop,
} from "../src/backends/native-authored-hook-stop.ts";

const run = "a".repeat(32);
test("authenticated concurrent stop requests share one owner operation", async () => {
  let calls = 0;
  const owner = await serveNativeHookStop({
    run,
    assertFresh: async () => undefined,
    stop: async () => {
      calls++;
      await Bun.sleep(25);
      return true;
    },
  });
  try {
    await Promise.all([
      requestNativeHookStop({ ...owner, run, timeoutMs: 1000 }),
      requestNativeHookStop({ ...owner, run, timeoutMs: 1000 }),
    ]);
    expect(calls).toBe(1);
  } finally {
    await owner.close(true);
  }
});
test("wrong capability and non-ASCII request cannot enter the stop operation", async () => {
  let calls = 0;
  const owner = await serveNativeHookStop({
    run,
    assertFresh: async () => undefined,
    stop: async () => {
      calls++;
      return true;
    },
  });
  try {
    await expect(
      requestNativeHookStop({
        ...owner,
        run,
        token: "b".repeat(64),
        timeoutMs: 100,
      })
    ).rejects.toThrow("unavailable");
    await new Promise<void>((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port: owner.port });
      socket.once("error", reject);
      socket.once("close", () => resolve());
      socket.once("connect", () => socket.end(Buffer.from([255, 10])));
    });
    expect(calls).toBe(0);
  } finally {
    await owner.close(true);
  }
});
test("client timeout retains a single running operation and a late client observes its result", async () => {
  let calls = 0;
  let finish: (removed: boolean) => void = () => undefined;
  const result = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  const owner = await serveNativeHookStop({
    run,
    assertFresh: async () => undefined,
    stop: () => {
      calls++;
      return result;
    },
  });
  try {
    await expect(
      requestNativeHookStop({ ...owner, run, timeoutMs: 30 })
    ).rejects.toThrow();
    expect(calls).toBe(1);
    finish(true);
    await requestNativeHookStop({ ...owner, run, timeoutMs: 1000 });
    expect(calls).toBe(1);
  } finally {
    finish(false);
    await owner.close(true);
  }
});
test("changed private owner refuses before a valid client can stop", async () => {
  let calls = 0;
  const owner = await serveNativeHookStop({
    run,
    assertFresh: async () => {
      throw new Error("private-canary");
    },
    stop: async () => {
      calls++;
      return true;
    },
  });
  try {
    await expect(
      requestNativeHookStop({ ...owner, run, timeoutMs: 100 })
    ).rejects.toThrow("unavailable");
    expect(calls).toBe(0);
  } finally {
    await owner.close(true);
  }
});
