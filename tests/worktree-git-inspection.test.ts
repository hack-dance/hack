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
        beforeSpawn: () => controller.abort(),
      })
    ).rejects.toMatchObject({ code: "E_COMPILER_CANCELLED" });
    expect(child).not.toHaveBeenCalled();
  } finally {
    child.mockRestore();
  }
});
