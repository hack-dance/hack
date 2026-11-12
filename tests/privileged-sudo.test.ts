import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FileFacts,
  PRIVILEGED_CHILD_PATH,
  resolveTrustedSudo,
  runTrustedSudo,
  SUDO_UNAVAILABLE_EXIT,
  type SudoFs,
} from "../src/lib/privileged-sudo.ts";
import { restoreEnv } from "./helpers/env.ts";

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
  test("runs the vetted absolute path with only the vetted environment", async () => {
    const injected = ["LD_PRELOAD", "LD_LIBRARY_PATH", "BASH_ENV", "TMPDIR"];
    const saved = new Map(injected.map((key) => [key, process.env[key]]));
    for (const key of injected) {
      process.env[key] = "/home/user/evil";
    }
    const calls: { argv: readonly string[]; opts: unknown }[] = [];
    try {
      const exit = await runTrustedSudo(["update-ca-certificates"], {
        fs: fakeFs({ facts: goodTree }),
        runner: (async (argv: readonly string[], opts: unknown) => {
          calls.push({ argv, opts });
          return 0;
        }) as never,
      });
      expect(exit).toBe(0);
    } finally {
      for (const [key, value] of saved) {
        restoreEnv(key, value);
      }
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]?.argv).toEqual([
      "/usr/bin/sudo",
      "/usr/bin/env",
      "-i",
      `PATH=${PRIVILEGED_CHILD_PATH}`,
      "LANG=C",
      "LC_ALL=C",
      "update-ca-certificates",
    ]);
    const opts = calls[0]?.opts as {
      stdin: string;
      env: Record<string, string>;
      unsetEnvKeys: readonly string[];
    };
    expect(opts.stdin).toBe("inherit");
    expect(opts.env.PATH).toBe(PRIVILEGED_CHILD_PATH);
    expect(opts.unsetEnvKeys).toEqual(expect.arrayContaining(injected));
    for (const key of injected) {
      expect(opts.env[key]).toBeUndefined();
    }
  });

  test("input goes to the child's stdin with the same vetted environment", async () => {
    const calls: {
      argv: readonly string[];
      input: Uint8Array;
      env: unknown;
    }[] = [];
    const exit = await runTrustedSudo(["sh", "-c", "cat"], {
      fs: fakeFs({ facts: goodTree }),
      input: new TextEncoder().encode("bytes"),
      inputRunner: async (argv, opts) => {
        calls.push({ argv, input: opts.input, env: opts.env });
        return 0;
      },
      runner: (async () => {
        throw new Error("input must use the input runner");
      }) as never,
    });
    expect(exit).toBe(0);
    expect(calls[0]?.argv).toEqual([
      "/usr/bin/sudo",
      "/usr/bin/env",
      "-i",
      `PATH=${PRIVILEGED_CHILD_PATH}`,
      "LANG=C",
      "LC_ALL=C",
      "sh",
      "-c",
      "cat",
    ]);
    expect(new TextDecoder().decode(calls[0]?.input)).toBe("bytes");
    expect(calls[0]?.env).toMatchObject({
      PATH: PRIVILEGED_CHILD_PATH,
      LC_ALL: "C",
    });
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

  test.each([
    false,
    true,
  ])("sudo secure_path cannot select a root helper (stdin: %s)", async (withInput) => {
    const dir = await mkdtemp(join(tmpdir(), "hack-sudo-path-"));
    try {
      const poison = join(dir, "poison");
      await mkdir(poison);
      await writeFile(join(poison, "dirname"), "#!/bin/sh\nexit 99\n", {
        mode: 0o755,
      });
      let output = "";
      const simulateSudo = async (argv: readonly string[]) => {
        // This is sudo's effect: overwrite PATH before exec of its child.
        const child = Bun.spawn([...argv.slice(1)], {
          env: { PATH: `${poison}:/usr/bin:/bin`, NODE_OPTIONS: "untrusted" },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        output = await new Response(child.stdout).text();
        return await child.exited;
      };
      expect(
        await runTrustedSudo(
          ["/bin/sh", "-c", 'dirname /a/b; [ -z "${NODE_OPTIONS+x}" ]'],
          {
            fs: fakeFs({ facts: goodTree }),
            input: withInput ? new Uint8Array([1]) : undefined,
            inputRunner: async (argv) => await simulateSudo(argv),
            runner: async (argv) => await simulateSudo(argv),
          }
        )
      ).toBe(0);
      expect(output).toBe("/a\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
