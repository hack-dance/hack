import { expect, test } from "bun:test";
import { chmod, copyFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("candidate launcher selects its adjacent executor and preserves arguments and exit", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hack candidate ")));
  try {
    await copyFile("scripts/hack-v5.sh", join(root, "hack-v5"));
    await Bun.write(join(root, "hack-native"), "#!/bin/sh\nexit 0\n");
    await chmod(join(root, "hack-native"), 0o755);
    await Bun.write(
      join(root, "hack-cli"),
      '#!/bin/sh\nprintf "%s\\n" "$HACK_RUNTIME_BACKEND" "$HACK_NATIVE_BINARY" "$HACK_NATIVE_HOME" "$@"\nexit 7\n'
    );
    await chmod(join(root, "hack-cli"), 0o755);
    const env = {
      ...process.env,
      HACK_NATIVE_HOME: join(root, "private home"),
      HACK_RUNTIME_BACKEND: "compose",
      HACK_NATIVE_BINARY: "/wrong/executor",
    };
    const child = Bun.spawn(
      ["sh", join(root, "hack-v5"), "exec", "a b", "--", "$literal"],
      {
        env,
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    expect(await new Response(child.stdout).text()).toBe(
      `native\n${root}/hack-native\n${root}/private home\nexec\na b\n--\n$literal\n`
    );
    expect(await child.exited).toBe(7);
    for (const home of ["", "relative"]) {
      const refused = Bun.spawn(["sh", join(root, "hack-v5"), "up"], {
        env: { ...env, HACK_NATIVE_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await refused.exited).toBe(64);
      expect(await new Response(refused.stdout).text()).toBe("");
    }
    await rm(join(root, "hack-native"));
    const incomplete = Bun.spawn(["sh", join(root, "hack-v5"), "up"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await incomplete.exited).toBe(69);
    expect(await new Response(incomplete.stdout).text()).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
