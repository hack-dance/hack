import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("hack linear alias forwards extension options like --json", async () => {
  const proc = Bun.spawn(
    [
      "bun",
      resolve(import.meta.dir, "../index.ts"),
      "linear",
      "status",
      "--json",
    ],
    {
      cwd: resolve(import.meta.dir, ".."),
      env: process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const payload = JSON.parse(stdout) as {
    readonly extensionId?: string;
    readonly ok?: boolean;
  };
  expect(exitCode).toBe(payload.ok ? 0 : 1);
  expect(stderr).not.toContain('Option(s) not valid for "linear": --json');
  expect(payload.extensionId).toBe("dance.hack.linear");
});
