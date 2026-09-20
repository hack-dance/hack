import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

for (const contract of [
  { prefix: "--startup-supervised-v1", channel: true },
  { prefix: "--startup-supervised-v3", channel: true },
  { prefix: "--startup-supervised-v2", channel: false },
  { prefix: "", channel: true },
]) {
  test(`runner refuses mismatched startup contract ${contract.prefix || "missing"}/${contract.channel}`, async () => {
    const root = await mkdtemp("/tmp/hack-contract-");
    await chmod(root, 0o700);
    const backendRoot = join(root, "backend");
    await mkdir(backendRoot, { mode: 0o700 });
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../scripts/run-mcp-socket-backend.ts"),
        ...(contract.prefix ? [contract.prefix, "--"] : []),
        backendRoot,
        "contract-fixture",
      ],
      {
        cwd: root,
        env: {
          HOME: root,
          HACK_HOME: root,
          ...(contract.channel ? { HACK_MCP_STARTUP_FD: "999" } : {}),
        },
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
      expect(code).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("MCP startup mode and channel must agree");
      expect(await readdir(backendRoot)).toEqual([]);
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      await child.exited;
      await rm(root, { recursive: true, force: true });
    }
  });
}
