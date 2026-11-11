import { describe, expect, test } from "bun:test";

import {
  type FileFacts,
  PRIVILEGED_CHILD_PATH,
  resolveTrustedSudo,
  runTrustedSudo,
  SUDO_UNAVAILABLE_EXIT,
  type SudoFs,
} from "../src/lib/privileged-sudo.ts";

const SUDO_FILE: FileFacts = {
  uid: 0,
  mode: 0o10_4755,
  isFile: true,
  isDirectory: false,
};
const ROOT_DIR: FileFacts = {
  uid: 0,
  mode: 0o4_0755,
  isFile: false,
  isDirectory: true,
};

function fakeFs(opts: {
  readonly links?: Record<string, string>;
  readonly facts: Record<string, FileFacts>;
}): SudoFs {
  return {
    realpath: async (path) => {
      const target = opts.links?.[path] ?? path;
      if (!opts.facts[target]) {
        throw new Error("ENOENT");
      }
      return target;
    },
    stat: async (path) => {
      const facts = opts.facts[path];
      if (!facts) {
        throw new Error("ENOENT");
      }
      return facts;
    },
  };
}

const goodTree = {
  "/": ROOT_DIR,
  "/usr": ROOT_DIR,
  "/usr/bin": ROOT_DIR,
  "/usr/bin/sudo": SUDO_FILE,
};

describe("resolveTrustedSudo", () => {
  test("accepts a root-owned setuid sudo in root-owned directories", async () => {
    expect(await resolveTrustedSudo(fakeFs({ facts: goodTree }))).toBe(
      "/usr/bin/sudo"
    );
  });

  test("follows a symlink to the real file (usrmerge /bin -> /usr/bin)", async () => {
    expect(
      await resolveTrustedSudo(
        fakeFs({
          facts: { ...goodTree, "/usr/bin/sudo": { ...SUDO_FILE, uid: 1000 } },
        })
      )
    ).toBeNull();
    expect(
      await resolveTrustedSudo(
        fakeFs({
          links: { "/bin/sudo": "/usr/local/libexec/sudo" },
          facts: {
            "/": ROOT_DIR,
            "/usr": ROOT_DIR,
            "/usr/local": ROOT_DIR,
            "/usr/local/libexec": ROOT_DIR,
            "/usr/local/libexec/sudo": SUDO_FILE,
          },
        })
      )
    ).toBe("/usr/local/libexec/sudo");
  });

  test.each([
    ["not owned by root", { ...SUDO_FILE, uid: 1000 }, {}],
    ["group-writable", { ...SUDO_FILE, mode: 0o10_4775 }, {}],
    ["not setuid", { ...SUDO_FILE, mode: 0o10_0755 }, {}],
    [
      "in a user-writable directory",
      SUDO_FILE,
      { "/usr/bin": { ...ROOT_DIR, uid: 1000 } },
    ],
    [
      "in a world-writable directory",
      SUDO_FILE,
      { "/usr": { ...ROOT_DIR, mode: 0o4_0777 } },
    ],
  ])("refuses a sudo %s", async (_label, sudo, dirs) => {
    expect(
      await resolveTrustedSudo(
        fakeFs({ facts: { ...goodTree, ...dirs, "/usr/bin/sudo": sudo } })
      )
    ).toBeNull();
  });
});

describe("runTrustedSudo", () => {
  test("runs the vetted absolute path with a fixed PATH and no loader variables", async () => {
    const calls: { argv: readonly string[]; opts: unknown }[] = [];
    const exit = await runTrustedSudo(["update-ca-certificates"], {
      fs: fakeFs({ facts: goodTree }),
      runner: (async (argv: readonly string[], opts: unknown) => {
        calls.push({ argv, opts });
        return 0;
      }) as never,
    });
    expect(exit).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.argv).toEqual(["/usr/bin/sudo", "update-ca-certificates"]);
    expect(calls[0]?.opts).toMatchObject({
      stdin: "inherit",
      env: { PATH: PRIVILEGED_CHILD_PATH },
    });
    expect(
      (calls[0]?.opts as { unsetEnvKeys: readonly string[] }).unsetEnvKeys
    ).toEqual(
      expect.arrayContaining([
        "LD_PRELOAD",
        "LD_LIBRARY_PATH",
        "BASH_ENV",
        "TMPDIR",
      ])
    );
  });

  test("no trustworthy sudo: nothing runs", async () => {
    let ran = false;
    const exit = await runTrustedSudo(["true"], {
      fs: fakeFs({ facts: {} }),
      runner: (async () => {
        ran = true;
        return 0;
      }) as never,
    });
    expect(exit).toBe(SUDO_UNAVAILABLE_EXIT);
    expect(ran).toBe(false);
  });

  test("a spawn failure is an exit code, not a throw", async () => {
    const exit = await runTrustedSudo(["true"], {
      fs: fakeFs({ facts: goodTree }),
      runner: (async () => {
        throw new Error("spawn failed");
      }) as never,
    });
    expect(exit).toBe(SUDO_UNAVAILABLE_EXIT);
  });
});
