import { expect, spyOn, test } from "bun:test";
import { readGitInspection } from "../src/lib/worktree-local-config.ts";

test("Git inspection refuses changed final source admission before spawning", async () => {
  const child = spyOn(Bun, "spawn").mockImplementation(() => {
    throw new Error("Unexpected child");
  });
  try {
    const output = await readGitInspection({
      projectRoot: "/synthetic-owned-source",
      args: ["rev-parse", "HEAD"],
      beforeSpawn: () => {
        throw new Error("Source changed");
      },
    });
    expect(output).toBeNull();
    expect(child).not.toHaveBeenCalled();
  } finally {
    child.mockRestore();
  }
});

test("Git inspection observes cancellation at the final source admission", async () => {
  const controller = new AbortController();
  const child = spyOn(Bun, "spawn").mockImplementation(() => {
    throw new Error("Unexpected child");
  });
  try {
    await expect(
      readGitInspection({
        projectRoot: "/synthetic-owned-source",
        args: ["rev-parse", "HEAD"],
        signal: controller.signal,
        beforeSpawn: () => {
          controller.abort();
        },
      })
    ).rejects.toMatchObject({ code: "E_COMPILER_CANCELLED" });
    expect(child).not.toHaveBeenCalled();
  } finally {
    child.mockRestore();
  }
});

test("Git inspection drains peer-held stdout after its spawn observer throws", async () => {
  let readerAcquired = false;
  let eofObserved = false;
  let released = false;
  let readCount = 0;
  let releasePeer: () => void = () => {};
  const peerClosed = new Promise<void>((resolve) => {
    releasePeer = resolve;
  });
  const stdout = {
    getReader: () => {
      readerAcquired = true;
      return {
        read: async () => {
          readCount++;
          if (readCount === 1) {
            return {
              done: false,
              value: new TextEncoder().encode("owned-head"),
            };
          }
          await peerClosed;
          eofObserved = true;
          return { done: true, value: undefined };
        },
        releaseLock: () => {
          released = true;
        },
      };
    },
  };
  const child = spyOn(Bun, "spawn").mockReturnValue({
    pid: 123,
    stdout,
    exitCode: 0,
    exited: Promise.resolve(0),
  } as unknown as ReturnType<typeof Bun.spawn>);
  try {
    const output = await readGitInspection({
      projectRoot: "/synthetic-owned-source",
      args: ["rev-parse", "HEAD"],
      onSpawn: () => {
        expect(readerAcquired).toBe(true);
        queueMicrotask(releasePeer);
        throw new Error("Observation refused");
      },
    });
    expect(output).toBeNull();
    expect(eofObserved).toBe(true);
    expect(released).toBe(true);
    expect(child).toHaveBeenCalledTimes(1);
  } finally {
    child.mockRestore();
  }
});

test("Git inspection refuses a Promise from final admission before spawning", async () => {
  const child = spyOn(Bun, "spawn").mockImplementation(() => {
    throw new Error("Unexpected child");
  });
  try {
    const output = await readGitInspection({
      projectRoot: "/synthetic-owned-source",
      args: ["rev-parse", "HEAD"],
      beforeSpawn: (() => Promise.resolve()) as unknown as () => undefined,
    });
    expect(output).toBeNull();
    expect(child).not.toHaveBeenCalled();
  } finally {
    child.mockRestore();
  }
});
