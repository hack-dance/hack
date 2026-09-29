import { expect, test } from "bun:test";

async function invoke(args: string[]) {
  const child = Bun.spawn([process.execPath, "index.ts", ...args], {
    env: {
      ...process.env,
      HACK_RUNTIME_BACKEND: "native",
      HACK_NATIVE_BINARY: "/nonexistent/hack-native",
      HACK_NATIVE_HOME: "/nonexistent/native-home",
      HACK_NO_INTERACTIVE: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5000,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

test("native Doctor reports unknown owner without consulting Docker-era CA state", async () => {
  const result = await invoke(["doctor", "--json"]);
  expect(result.code).toBe(0);
  const envelope: unknown = JSON.parse(result.stdout);
  expect(envelope).toMatchObject({
    ok: true,
    data: {
      checks: [
        { id: "native https owner", status: "warn" },
        { id: "native root trust", status: "warn" },
      ],
    },
  });
  expect(result.stdout).not.toContain("caddy local ca");
  expect(result.stdout).not.toContain("docker daemon");
});

test("native global trust refuses the stale Docker export path", async () => {
  const result = await invoke(["global", "trust"]);
  expect(result.code).toBe(1);
  expect(result.stdout + result.stderr).toContain(
    "hack doctor --fix --browser-url"
  );
  expect(result.stdout + result.stderr).toContain(
    "No Docker-era CA was installed"
  );
});
