import { createCipheriv, createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { runFixtureGit } from "./fixture-git.ts";
import { privateCliEnv } from "./private-cli-env.ts";

const fixtureValue = (name: string) =>
  ["synthetic", "upgrade", name, "sentinel"].join("-");
const projectKey = Buffer.alloc(32, 11).toString("base64");
const globalKey = fixtureValue("global-key");
const sha = (text: string | Buffer) =>
  createHash("sha256").update(text).digest("hex");

/** Encode historical v1 store bytes independently of today's store writer. Test keys only. */
function legacyStore(
  scope: string,
  values: Readonly<Record<string, string>>,
  key: string
) {
  const cipher = createCipheriv(
    "aes-256-gcm",
    createHash("sha256").update(key).digest(),
    Buffer.alloc(12, 7)
  );
  const entries = Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      `${encodeURIComponent(scope)}::${encodeURIComponent(name)}`,
      value,
    ])
  );
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ version: 1, entries })),
    cipher.final(),
  ]);
  return JSON.stringify({
    version: 1,
    algorithm: "aes-256-gcm",
    iv: Buffer.alloc(12, 7).toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  });
}

export type UpgradeProject = {
  readonly name: string;
  readonly path: string;
  readonly values: Readonly<Record<string, string>>;
};

/**
 * Historical bytes, real Git tracking/worktrees, private HOME and no runtime services.
 * The generic run/snapshot interface also supports future check/apply/finish/rollback argv.
 * No current migration/secret-store writer is used to manufacture legacy inputs.
 */
export async function createV4UpgradeFixture(opts: {
  readonly binary: string;
  readonly globalKeyPresent: boolean;
}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "hack-v4-upgrade-"))
  );
  try {
    const home = join(root, "home");
    const hackHome = join(home, ".hack");
    const tools = join(root, "tools");
    const temp = join(root, "tmp");
    for (const path of [hackHome, tools, temp]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
    }
    const globalConfig = join(hackHome, "hack.config.json");
    const globalStore = join(hackHome, "secrets.enc.json");
    const globalKeyPath = join(hackHome, "secrets-file.key");
    await writeFile(
      globalConfig,
      JSON.stringify({
        controlPlane: {
          secrets: {
            backend: "encrypted_file",
            encryptedFile: { path: globalStore, keyPath: globalKeyPath },
          },
        },
      }),
      { mode: 0o600 }
    );
    const tracked: UpgradeProject = {
      name: "legacy-tracked",
      path: join(root, "tracked"),
      values: {
        TOKEN: fixtureValue("tracked-token"),
        PLAIN: fixtureValue("tracked-plain"),
      },
    };
    const untracked: UpgradeProject = {
      name: "legacy-untracked",
      path: join(root, "untracked"),
      values: {
        ...(opts.globalKeyPresent
          ? { TOKEN: fixtureValue("global-token") }
          : {}),
        PLAIN: fixtureValue("untracked-plain"),
      },
    };
    const keyPath = join(tracked.path, ".hack.secret.key");
    const storePath = join(tracked.path, "legacy-store.json");
    const git = async (cwd: string, args: readonly string[]) => {
      const result = await runFixtureGit({ cwd, args });
      if (result.exitCode !== 0) {
        throw new Error("Upgrade fixture Git setup failed (values omitted).");
      }
      return result.stdout;
    };
    for (const project of [tracked, untracked]) {
      const config = {
        name: project.name,
        dev_host: `${project.name}.hack`,
        ...(project === tracked
          ? {
              controlPlane: {
                secrets: {
                  backend: "encrypted_file",
                  encryptedFile: { path: storePath, keyPath },
                },
              },
            }
          : {}),
      };
      await mkdir(join(project.path, ".hack"), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(
        join(project.path, ".hack/hack.config.json"),
        JSON.stringify(config)
      );
      await writeFile(
        join(project.path, ".hack/docker-compose.yml"),
        "services:\n  app:\n    image: alpine:3.22\n    env_file: .env\n"
      );
      await writeFile(
        join(project.path, ".hack/hack.env.json"),
        JSON.stringify({
          version: 1,
          vars: [
            ...(project.values.TOKEN
              ? [{ key: "TOKEN", source: "keychain", required: true }]
              : []),
            { key: "PLAIN", source: "plain_env", required: true },
          ],
        })
      );
      await writeFile(
        join(project.path, ".hack/.env"),
        `PLAIN=${project.values.PLAIN}\n`,
        { mode: 0o600 }
      );
      await git(project.path, ["init", "--quiet"]);
      await writeFile(
        join(project.path, "fixture-anchor"),
        "historical repository\n"
      );
      await git(project.path, [
        "add",
        "fixture-anchor",
        ...(project === tracked
          ? [
              ".hack/hack.config.json",
              ".hack/docker-compose.yml",
              ".hack/hack.env.json",
              ".hack/.env",
            ]
          : []),
      ]);
      await git(project.path, [
        "commit",
        "--quiet",
        "-m",
        "historical fixture bytes",
      ]);
    }
    await writeFile(keyPath, `${projectKey}\n`, { mode: 0o600 });
    await writeFile(
      storePath,
      legacyStore(
        tracked.name,
        { TOKEN: tracked.values.TOKEN ?? "" },
        projectKey
      ),
      { mode: 0o600 }
    );
    await writeFile(
      globalStore,
      legacyStore(
        untracked.name,
        { TOKEN: fixtureValue("global-token") },
        globalKey
      ),
      { mode: 0o600 }
    );
    if (opts.globalKeyPresent) {
      await writeFile(globalKeyPath, `${globalKey}\n`, { mode: 0o600 });
    }
    const worktree: UpgradeProject = {
      ...tracked,
      path: join(root, "linked"),
      values: { PLAIN: tracked.values.PLAIN ?? "" },
    };
    await git(tracked.path, [
      "worktree",
      "add",
      "--quiet",
      "-b",
      "upgrade-linked",
      worktree.path,
    ]);
    // This historical branch declares only its tracked plaintext setting. A
    // machine-local secret in the primary checkout is not a worktree input.
    await writeFile(
      join(worktree.path, ".hack/hack.env.json"),
      JSON.stringify({
        version: 1,
        vars: [{ key: "PLAIN", source: "plain_env", required: true }],
      })
    );
    const now = new Date().toISOString();
    const registry = join(hackHome, "projects.json");
    const deadPath = join(root, "deleted-project");
    await writeFile(
      registry,
      JSON.stringify({
        version: 1,
        projects: [
          ...[tracked, untracked].map((project, index) => ({
            id: `legacy-${index}`,
            name: project.name,
            repoRoot: project.path,
            projectDirName: ".hack",
            projectDir: join(project.path, ".hack"),
            createdAt: now,
            lastSeenAt: now,
            ...(project === tracked
              ? {
                  worktrees: [
                    {
                      path: worktree.path,
                      branch: "upgrade-linked",
                      lastSeenAt: now,
                    },
                  ],
                }
              : {}),
          })),
          {
            id: "legacy-dead",
            name: "deleted-project",
            repoRoot: deadPath,
            projectDirName: ".hack",
            projectDir: join(deadPath, ".hack"),
            createdAt: now,
          },
        ],
      }),
      { mode: 0o600 }
    );
    // Tool tripwires never contact Docker, the daemon, system services or the network.
    for (const tool of ["docker", "launchctl", "systemctl", "security"]) {
      await writeFile(join(tools, tool), "#!/bin/sh\nexit 97\n", {
        mode: 0o700,
      });
    }
    await writeFile(join(tools, "mutagen"), "#!/bin/sh\nexit 0\n", {
      mode: 0o700,
    });
    const env = privateCliEnv({
      root,
      home,
      env: {
        PATH: `${tools}:/usr/bin:/bin`,
        TMPDIR: temp,
        HACK_HOME: hackHome,
        HACK_GLOBAL_CONFIG_PATH: globalConfig,
        HACK_RUNTIME_BACKEND: "compose",
        HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK: "1",
        HACK_MUTAGEN_PATH: join(tools, "mutagen"),
        HACK_NO_INTERACTIVE: "1",
        HACK_LOGGER: "console",
        NO_COLOR: "1",
      },
    });
    const sentinels = [
      projectKey,
      globalKey,
      ...Object.values(tracked.values),
      ...Object.values(untracked.values),
    ];
    const active = new Set<Bun.Subprocess>();
    const run = async (args: readonly string[], cwd = tracked.path) => {
      const child = Bun.spawn([opts.binary, ...args], {
        cwd,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 30_000,
      });
      active.add(child);
      try {
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        const output = `${stdout}\n${stderr}`;
        if (sentinels.some((value) => output.includes(value))) {
          throw new Error(
            "Upgrade command leaked a sentinel (values omitted)."
          );
        }
        return { code, output };
      } finally {
        active.delete(child);
      }
    };
    const resolveValues = async (project: UpgradeProject) => {
      const witness = join(root, `witness-${project.name}.ts`);
      const expected = Object.entries(project.values).map(([name, value]) => [
        name,
        sha(value),
      ]);
      await writeFile(
        witness,
        `import {createHash} from "node:crypto";const expected=${JSON.stringify(expected)};const mismatches=expected.filter(([key,hash])=>createHash("sha256").update(process.env[key]??"").digest("hex")!==hash).map(([key])=>key);if(mismatches.length)console.error("Unresolved fixture names: "+mismatches.join(","));process.exitCode=mismatches.length?41:0;`
      );
      return await run(
        [
          "env",
          "exec",
          "--path",
          project.path,
          "--target",
          "host",
          "--",
          process.execPath,
          witness,
        ],
        project.path
      );
    };
    const snapshot = async () => {
      const files: Record<string, string> = {};
      const walk = async (path: string) => {
        for (const entry of await readdir(path, { withFileTypes: true })) {
          if (entry.name === ".git") {
            continue;
          }
          const item = join(path, entry.name);
          if (entry.isDirectory()) {
            await walk(item);
          } else if (entry.isFile()) {
            files[relative(root, item)] = sha(await readFile(item));
          }
        }
      };
      for (const path of [
        tracked.path,
        untracked.path,
        worktree.path,
        hackHome,
      ]) {
        await walk(path);
      }
      return Object.fromEntries(
        Object.entries(files).sort(([a], [b]) => a.localeCompare(b))
      );
    };
    return {
      root,
      home,
      hackHome,
      globalConfig,
      globalStore,
      globalKeyPath,
      keyPath,
      storePath,
      registry,
      tracked,
      untracked,
      worktree,
      sentinels,
      run,
      resolveValues,
      snapshot,
      git,
      dispose: async () => {
        for (const child of active) {
          child.kill("SIGKILL");
        }
        await Promise.all([...active].map((child) => child.exited));
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
