import { expect, test } from "bun:test";
import { readProcessIdentities } from "../src/lib/process-tree.ts";
import {
  assertLifecycleProcessGroupRetired,
  terminateLifecycleProcessGroups,
} from "../src/lib/project-lifecycle-processes.ts";

test.skipIf(process.platform !== "linux")(
  "a real zombie-only process group retires before its parent reaps it",
  async () => {
    const python = Bun.which("python3");
    if (!python) {
      throw new Error("Zombie retirement regression requires working python3");
    }
    // WNOWAIT deliberately keeps the exited child observable to kill(0). The
    // parent stays alive to reap it in finally, without relying on PID 1.
    const source = `import json, os, sys
pid = os.fork()
if pid == 0:
    os.setpgid(0, 0)
    os._exit(0)
os.waitid(os.P_PID, pid, os.WEXITED | os.WNOWAIT)
print(json.dumps({"pid": pid}), flush=True)
sys.stdin.readline()
os.waitpid(pid, 0)
`;
    const parent = Bun.spawn([python, "-c", source], {
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
      expect(process.kill(-group, 0)).toBe(true);
      const row = (await readProcessIdentities()).find(
        (item) => item.pid === group
      );
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
    } finally {
      clearTimeout(watchdog);
      parent.stdin.end();
      expect(await parent.exited).toBe(0);
    }
  },
  20_000
);
