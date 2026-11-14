import { expect, test } from "bun:test";
import { readProcessIdentities } from "../src/lib/process-tree.ts";
import {
  assertLifecycleProcessGroupRetired,
  terminateLifecycleProcessGroups,
} from "../src/lib/project-lifecycle-processes.ts";

const supported = process.platform === "linux" || process.platform === "darwin";
const python = supported ? Bun.which("python3") : null;

test.skipIf(!supported || python === null)(
  "a real zombie-only process group retires before its parent reaps it",
  async () => {
    // The pipe closes on child exit, without waitid/WNOWAIT (not portable to
    // macOS). The parent holds the zombie until finally, then reaps it itself.
    const source = `import json, os, sys
read_end, write_end = os.pipe()
pid = os.fork()
if pid == 0:
    os.close(read_end)
    os.setpgid(0, 0)
    os._exit(0)
os.close(write_end)
os.read(read_end, 1)
os.close(read_end)
print(json.dumps({"pid": pid}), flush=True)
sys.stdin.readline()
os.waitpid(pid, 0)
`;
    const parent = Bun.spawn([python ?? "python3", "-c", source], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const watchdog = setTimeout(() => parent.stdin.end(), 15_000);
    try {
      const reader = parent.stdout.getReader();
      let output = "";
      while (!output.includes("\n")) {
        const chunk = await reader.read();
        if (chunk.done) {
          throw new Error("Zombie fixture did not publish its child identity");
        }
        output += new TextDecoder().decode(chunk.value);
      }
      reader.releaseLock();
      const record: unknown = JSON.parse(output.trim());
      if (
        !record ||
        typeof record !== "object" ||
        !("pid" in record) ||
        typeof record.pid !== "number"
      ) {
        throw new Error("Zombie fixture returned an invalid child identity");
      }
      const group = record.pid;
      // macOS may report EPERM for this zombie-only group; Linux succeeds.
      try {
        expect(process.kill(-group, 0)).toBe(true);
      } catch (error) {
        expect(error).toHaveProperty("code", "EPERM");
      }
      let row = (await readProcessIdentities()).find(
        (item) => item.pid === group
      );
      const deadline = performance.now() + 3000;
      while (!row?.zombie && performance.now() < deadline) {
        await Bun.sleep(25);
        row = (await readProcessIdentities()).find(
          (item) => item.pid === group
        );
      }
      expect(row?.zombie).toBe(true);
      expect(row?.processGroupId).toBe(group);
      const started = performance.now();
      await terminateLifecycleProcessGroups({
        processGroupIds: [group],
        alreadySignalled: true,
      });
      await assertLifecycleProcessGroupRetired({ processGroupId: group });
      expect(performance.now() - started).toBeLessThan(3000);
      // Retirement did not require the zombie to be reaped; parent is still waiting.
      expect(parent.exitCode).toBeNull();
      expect(
        (await readProcessIdentities()).find((item) => item.pid === group)
          ?.zombie
      ).toBe(true);
      parent.stdin.end();
      expect(await parent.exited).toBe(0);
      expect(() => process.kill(-group, 0)).toThrow();
      try {
        process.kill(-group, 0);
      } catch (error) {
        expect(error).toHaveProperty("code", "ESRCH");
      }
    } finally {
      clearTimeout(watchdog);
      parent.stdin.end();
      expect(await parent.exited).toBe(0);
    }
  },
  20_000
);
