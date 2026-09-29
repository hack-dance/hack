import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const args of [
  ["mcp", "serve", "--help"],
  ["--help", "mcp", "serve"],
  ["mcp", "serve", "--version"],
]) {
  test(`MCP entrypoint preserves parser behavior for ${args.join(" ")}`, async () => {
    const proc = Bun.spawn(
      [process.execPath, resolve(import.meta.dir, "..", "index.ts"), ...args],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain(
      args.includes("--version") ? "hack v" : "hack mcp serve"
    );
  });
}

test("MCP entrypoint rejects unknown options through the normal JSON error path", async () => {
  const proc = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "..", "index.ts"),
      "mcp",
      "serve",
      "--json",
      "--bogus-option",
    ],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(code).toBe(1);
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toMatchObject({ error: { code: "E_USAGE" } });
});
