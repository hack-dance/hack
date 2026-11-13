import { expect, test } from "bun:test";
import { readProcessIdentities } from "../src/lib/process-tree.ts";
import {
  createLifecycleSessionRetirement,
  readProcessSnapshot,
} from "../src/lib/project-lifecycle-processes.ts";

for (const reusedAt of ["capture", "signal"] as const) {
  test(`retirement refuses reused pane identity at ${reusedAt} without signalling the unrelated child`, async () => {
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", "-e", "setInterval(() => {}, 1000)"],
      { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" }
    );
    try {
      const birth = (await readProcessIdentities()).find(
        (row) => row.pid === child.pid
      )?.birth;
      expect(birth).toBeDefined();
      let reads = 0;
      const retire = createLifecycleSessionRetirement({
        readSnapshot: () => readProcessSnapshot({ timeoutMs: 1000 }),
        readIdentities: async () => {
          reads++;
          const rows = await readProcessIdentities();
          return reusedAt === "signal" && reads > 1
            ? rows.map((row) =>
                row.pid === child.pid
                  ? { ...row, birth: "synthetic-reused-identity" }
                  : row
              )
            : rows;
        },
      });
      const pending = retire({
        processes: [
          {
            panePid: child.pid,
            paneBirth:
              reusedAt === "capture" ? "synthetic-old-identity" : birth,
          },
        ],
        stopSession: () => Promise.resolve(true),
      });
      if (reusedAt === "capture") {
        expect(await pending).toBe(true);
      } else {
        await expect(pending).rejects.toThrow(
          "no longer has a verified owned member; no signal sent"
        );
      }
      expect(child.exitCode).toBeNull();
      expect(process.kill(-child.pid, 0)).toBe(true);
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      await child.exited;
    }
  }, 20_000);
}
