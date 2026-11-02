import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const artifacts = [
  {
    role: "backend",
    executable: process.execPath,
    args: [join(import.meta.dir, "../scripts/run-mcp-socket-backend.ts")],
  },
  {
    role: "adapter",
    executable: process.env.HACK_MCP_ADAPTER_TEST_BINARY,
    args: [],
  },
  {
    role: "owner",
    executable: process.env.HACK_MCP_OWNER_TEST_BINARY,
    args: [],
  },
];

for (const artifact of artifacts) {
  test.skipIf(!artifact.executable)(
    `${artifact.role} reports capabilities without starting or touching a lease`,
    async () => {
      if (!artifact.executable) {
        throw new Error("Explicit artifact required");
      }
      const root = await mkdtemp("/tmp/hack-artifact-");
      const home = join(root, "home");
      const state = join(root, "state");
      await mkdir(home, { mode: 0o700 });
      await mkdir(state, { mode: 0o700 });
      const child = Bun.spawn(
        [artifact.executable, ...artifact.args, "--mcp-artifact-info"],
        {
          cwd: state,
          env: { HOME: home, HACK_MCP_STARTUP_FD: "invalid" },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(code).toBe(0);
        expect(stderr).toBe("");
        expect(JSON.parse(stdout)).toEqual({
          schemaVersion: 1,
          role: artifact.role,
          startupProtocol: 2,
          wireProtocol: 1,
          platform: process.platform,
          architecture: process.arch,
        });
        expect(await readdir(state)).toEqual([]);
      } finally {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
        await child.exited;
        await rm(root, { recursive: true, force: true });
      }
    }
  );
}
