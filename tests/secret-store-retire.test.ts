import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  buildDoctorRecoveryGuidance,
  buildRecoveryWorkflowLines,
} from "../src/commands/recovery-guidance.ts";
import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
  PROJECT_ENV_CONTRACT_FILENAME,
} from "../src/constants.ts";
import { inspectSecretIntegrity } from "../src/lib/doctor-secret-integrity.ts";
import { keychain } from "../src/lib/keychain.ts";
import { findProjectContext } from "../src/lib/project.ts";
import { upsertProjectRegistration } from "../src/lib/projects-registry.ts";
import { withProjectsRegistryLock } from "../src/lib/projects-registry-lock.ts";
import {
  resolveSecretStore,
  retireEncryptedStoreFile,
} from "../src/lib/secret-store.ts";
import {
  describeRetireTarget,
  planSecretStoreRetire,
  retireSecretStore,
} from "../src/lib/secret-store-retire.ts";
import { escapeTerminalControls } from "../src/lib/terminal-text.ts";
import { restoreEnv } from "./helpers/env.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * HACK-2177: a global encrypted secret store whose key file is gone. Every
 * case runs in a fake home (HOME, HACK_HOME and the global config inside a
 * temp root); no real store, key, keychain or registry is touched, and
 * nothing is deleted except the temp root itself. Values are synthetic.
 */

const ENTRYPOINT = resolve(import.meta.dir, "..", "index.ts");
const STORE_VALUE = ["synthetic", "store", "value", "6d1f"].join("-");
const STORE_KEY = ["synthetic", "store", "key", "92ab"].join("-");
const ISOLATED_ENV = [
  "HOME",
  "HACK_HOME",
  "HACK_GLOBAL_CONFIG_PATH",
  "HACK_SECRETS_FILE_KEY",
  "HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK",
  "HACK_ENV_SECRET_KEY",
] as const;
const saved = new Map<string, string | undefined>();
let root = "";

type Fixture = {
  readonly home: string;
  readonly hackHome: string;
  readonly storePath: string;
  readonly keyPath: string;
  readonly reader: {
    readonly projectRoot: string;
    readonly projectDir: string;
  };
  readonly bystander: {
    readonly projectRoot: string;
    readonly projectDir: string;
  };
};

beforeEach(async () => {
  for (const key of ISOLATED_ENV) {
    saved.set(key, process.env[key]);
  }
  root = await realpath(await mkdtemp(join(tmpdir(), "hack-retire-store-")));
});

afterEach(async () => {
  for (const key of ISOLATED_ENV) {
    restoreEnv(key, saved.get(key));
  }
  await rm(root, { recursive: true, force: true });
});

async function createProject(opts: {
  readonly name: string;
  readonly readsStore: boolean;
}) {
  const projectRoot = join(root, "repos", opts.name);
  const projectDir = join(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, PROJECT_COMPOSE_FILENAME),
    "services:\n  api:\n    image: alpine:3.20\n"
  );
  await writeFile(
    join(projectDir, PROJECT_CONFIG_FILENAME),
    `${JSON.stringify({ name: opts.name, dev_host: `${opts.name}.hack` })}\n`
  );
  if (opts.readsStore) {
    // A legacy env contract with a store-backed value: runtime reads the store.
    await writeFile(
      join(projectDir, PROJECT_ENV_CONTRACT_FILENAME),
      `${JSON.stringify({ version: 1, vars: [{ key: "TOKEN", source: "keychain" }] })}\n`
    );
  }
  const project = await findProjectContext(projectRoot);
  if (!project) {
    throw new Error(`fixture project ${opts.name} not found`);
  }
  await upsertProjectRegistration({ project });
  return { projectRoot, projectDir };
}

/** A fake home with a global store whose key file has been removed. */
async function setUp(): Promise<Fixture> {
  const home = join(root, "user-home");
  const hackHome = join(home, ".hack");
  await mkdir(hackHome, { recursive: true });
  const storePath = join(hackHome, "secrets.enc.json");
  const keyPath = join(hackHome, "secrets-file.key");
  process.env.HOME = home;
  process.env.HACK_HOME = hackHome;
  process.env.HACK_GLOBAL_CONFIG_PATH = join(hackHome, "hack.config.json");
  process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK = "1";
  Reflect.deleteProperty(process.env, "HACK_SECRETS_FILE_KEY");
  Reflect.deleteProperty(process.env, "HACK_ENV_SECRET_KEY");
  await writeFile(
    process.env.HACK_GLOBAL_CONFIG_PATH,
    `${JSON.stringify({
      controlPlane: {
        secrets: {
          backend: "encrypted_file",
          encryptedFile: { path: storePath, keyPath },
        },
      },
    })}\n`
  );
  const reader = await createProject({ name: "app-a", readsStore: true });
  const bystander = await createProject({ name: "app-b", readsStore: false });
  await writeFile(keyPath, `${STORE_KEY}\n`, { mode: 0o600 });
  await chmod(keyPath, 0o600);
  await (
    await resolveSecretStore({
      projectName: "app-a",
      projectDir: reader.projectDir,
    })
  ).set({ key: "TOKEN", value: STORE_VALUE });
  await rm(keyPath);
  return { home, hackHome, storePath, keyPath, reader, bystander };
}

async function inspect(
  project: Fixture["reader"],
  projectName: string
): Promise<Awaited<ReturnType<typeof inspectSecretIntegrity>>> {
  return await inspectSecretIntegrity({ ...project, projectName });
}

function expectValueFree(text: string) {
  expect(text).not.toContain(STORE_VALUE);
  expect(text).not.toContain(STORE_KEY);
}

async function runRetire(opts: {
  readonly fixture: Fixture;
  readonly path: string;
  readonly yes: boolean;
}) {
  const child = Bun.spawn(
    [
      process.execPath,
      ENTRYPOINT,
      "secrets",
      "retire-store",
      "--path",
      opts.path,
      ...(opts.yes ? ["--yes"] : []),
    ],
    {
      cwd: root,
      env: privateCliEnv({
        root,
        home: opts.fixture.home,
        env: {
          HACK_HOME: opts.fixture.hackHome,
          HACK_GLOBAL_CONFIG_PATH: join(
            opts.fixture.hackHome,
            "hack.config.json"
          ),
          HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK: "1",
          HACK_NO_INTERACTIVE: "1",
        },
      }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, output: `${stdout}\n${stderr}` };
}

test("a store whose key is missing is an error only for a project that reads it", async () => {
  const fixture = await setUp();
  const reader = await inspect(fixture.reader, "app-a");
  expect(reader).toHaveLength(1);
  expect(reader[0]?.status).toBe("error");
  expect(reader[0]?.message).toContain(
    "its key ~/.hack/secrets-file.key is missing"
  );
  expect(reader[0]?.message).toContain("This project's env contract reads it.");

  const bystander = await inspect(fixture.bystander, "app-b");
  expect(bystander).toHaveLength(1);
  expect(bystander[0]?.status).toBe("warn");
  const message = bystander[0]?.message ?? "";
  expect(message).toContain("This project does not read it.");
  expect(message).toContain("Registered projects that read it: app-a.");
  expect(message).toContain("cannot be counted or read without that key");
  expect(message).toContain("restore the key");
  expect(message).toContain("hack secrets retire-store");
  expect(message).toContain("Do not provision a new key");
  expectValueFree(message);

  // The recovery block names the two choices.
  const lines = buildRecoveryWorkflowLines({
    guidance: buildDoctorRecoveryGuidance({
      results: [{ name: "secret integrity", status: "warn", message }],
    }),
    projectRoot: null,
  }).join("\n");
  expect(lines).toContain("Choose one:");
  expect(lines).toContain("Restore the encrypted secret store's key");
  expect(lines).toContain(
    `\`hack secrets retire-store --path ${fixture.bystander.projectRoot}\``
  );
});

test("retire-store refuses without --yes when it cannot prompt, then retires, and moving the file back restores it", async () => {
  const fixture = await setUp();
  const before = await readFile(fixture.storePath);

  // Non-interactive and no --yes: refused, nothing moved.
  const refused = await runRetire({
    fixture,
    path: fixture.bystander.projectRoot,
    yes: false,
  });
  expect(refused.code).not.toBe(0);
  expect(refused.output).toContain("E_INTERACTIVE_REQUIRED");
  expect(refused.output).toContain("--yes");
  expect(await readFile(fixture.storePath)).toEqual(before);

  // With --yes: moved aside, never deleted or read.
  const retired = await runRetire({
    fixture,
    path: fixture.bystander.projectRoot,
    yes: true,
  });
  expect(retired.code).toBe(0);
  expectValueFree(retired.output);
  expect(await lstat(fixture.storePath).catch(() => null)).toBeNull();
  const kept = (await readdir(fixture.hackHome)).filter((name) =>
    name.startsWith("secrets.enc.json.retired-")
  );
  expect(kept).toHaveLength(1);
  // The archive is the store, under its own name, in a new directory.
  const retiredPath = join(fixture.hackHome, kept[0] ?? "", "secrets.enc.json");
  expect(await readFile(retiredPath)).toEqual(before);
  expect(retired.output).toContain(`to ${retiredPath}`);
  expect(retired.output).toContain(`mv ${retiredPath} ${fixture.storePath}`);
  expect(retired.output).toContain("Nothing was deleted");

  // doctor afterwards: the retired file is information, not a problem.
  for (const [project, name] of [
    [fixture.bystander, "app-b"],
    [fixture.reader, "app-a"],
  ] as const) {
    const after = await inspect(project, name);
    expect(after).toHaveLength(1);
    expect(after[0]?.status).toBe("info");
    expect(after[0]?.message).toContain(
      `Retired secret store kept at ~/.hack/${kept[0]}/secrets.enc.json`
    );
    expect(after[0]?.message).toContain(
      `mv ${retiredPath} ${fixture.storePath}`
    );
  }

  // Putting it back by moving the file restores the original state.
  await rename(retiredPath, fixture.storePath);
  expect(await readFile(fixture.storePath)).toEqual(before);
  const restored = await inspect(fixture.bystander, "app-b");
  expect(restored).toHaveLength(1);
  expect(restored[0]?.status).toBe("warn");
  expect(restored[0]?.message).toContain("is missing");
  // With the key back, the store opens again: nothing was lost.
  await writeFile(fixture.keyPath, `${STORE_KEY}\n`, { mode: 0o600 });
  await chmod(fixture.keyPath, 0o600);
  expect(await inspect(fixture.reader, "app-a")).toEqual([]);
  expect(
    await (
      await resolveSecretStore({
        projectName: "app-a",
        projectDir: fixture.reader.projectDir,
      })
    ).get({ key: "TOKEN" })
  ).toBe(STORE_VALUE);
}, 60_000);

test("retire-store refuses a store that opens, an absent store, and a key that is refused", async () => {
  const fixture = await setUp();
  const before = await readFile(fixture.storePath);
  await writeFile(fixture.keyPath, `${STORE_KEY}\n`, { mode: 0o600 });
  await chmod(fixture.keyPath, 0o600);
  const opens = await retireSecretStore({
    projectName: "app-b",
    projectDir: fixture.bystander.projectDir,
  });
  expect(opens).toMatchObject({ kind: "refused" });
  expect(opens.kind === "refused" ? opens.message : "").toContain(
    "opens with the key in use"
  );

  // A refused key (others can read it) is not a missing key: fix it instead.
  await chmod(fixture.keyPath, 0o644);
  const refusedKey = await retireSecretStore({
    projectName: "app-b",
    projectDir: fixture.bystander.projectDir,
  });
  expect(refusedKey.kind === "refused" ? refusedKey.message : "").toContain(
    "key refused"
  );
  expect(await readFile(fixture.storePath)).toEqual(before);

  // No store at all: nothing to move.
  await rm(fixture.keyPath);
  await rename(fixture.storePath, join(root, "elsewhere.enc.json"));
  const absent = await retireSecretStore({
    projectName: "app-b",
    projectDir: fixture.bystander.projectDir,
  });
  expect(absent.kind === "refused" ? absent.message : "").toContain(
    "There is no encrypted secret store with entries"
  );
  expect(await readFile(join(root, "elsewhere.enc.json"))).toEqual(before);
});

test("retire re-checks the store under its lock: a key restored meanwhile is not retired", async () => {
  // Codex review: eligibility was decided before the store's lock, so a
  // store whose key came back in between was still moved aside.
  const fixture = await setUp();
  const before = await readFile(fixture.storePath);
  let retire: ReturnType<typeof retireSecretStore> | undefined;
  await withProjectsRegistryLock({
    lockPath: `${fixture.storePath}.lock`,
    label: "test store holder",
    run: async () => {
      retire = retireSecretStore({
        projectName: "app-b",
        projectDir: fixture.bystander.projectDir,
      });
      await Bun.sleep(300);
      // Still waiting for the lock: the key comes back now.
      await writeFile(fixture.keyPath, `${STORE_KEY}\n`, { mode: 0o600 });
      await chmod(fixture.keyPath, 0o600);
    },
  });
  if (!retire) {
    throw new Error("retire not started");
  }
  const outcome = await retire;
  expect(outcome.kind).toBe("refused");
  expect(outcome.kind === "refused" ? outcome.message : "").toContain(
    "opens with the key in use"
  );
  expect(outcome.kind === "refused" ? outcome.message : "").toContain(
    "It changed while retiring"
  );
  expect(await readFile(fixture.storePath)).toEqual(before);
  const retired = (await readdir(fixture.hackHome)).filter((name) =>
    name.includes(".retired-")
  );
  expect(retired).toEqual([]);
});

test("the retire command doctor and the recovery block name targets the diagnosed project", async () => {
  // Codex review: an unscoped command acts on the current directory, not
  // the project doctor (or crash capture) diagnosed with --path.
  const fixture = await setUp();
  const finding = (await inspect(fixture.bystander, "app-b"))[0];
  const command = `hack secrets retire-store --path ${fixture.bystander.projectRoot}`;
  expect(finding?.message).toContain(command);
  const guidance = buildDoctorRecoveryGuidance({
    results: [
      {
        name: "secret integrity",
        status: "warn",
        message: finding?.message ?? "",
      },
    ],
  });
  expect(
    buildRecoveryWorkflowLines({ guidance, projectRoot: null }).join("\n")
  ).toContain(`\`${command}\``);
  // A finding without --path (an older wording) is scoped to the project.
  const unscoped = buildDoctorRecoveryGuidance({
    results: [
      {
        name: "secret integrity",
        status: "warn",
        message: "Run hack secrets retire-store to move it aside.",
      },
    ],
  });
  expect(
    buildRecoveryWorkflowLines({
      guidance: unscoped,
      projectRoot: "/srv/some project",
    }).join("\n")
  ).toContain("`hack secrets retire-store --path '/srv/some project'`");
});

test("printed restore commands quote a store path that holds a quote", async () => {
  // Codex security review: a configured store path is project input; a
  // quote in it must not end the shell literal of the printed mv command.
  const fixture = await setUp();
  const hostile = join(fixture.hackHome, "store'; touch PWNED; #'.enc.json");
  await rename(fixture.storePath, hostile);
  const configPath = join(fixture.hackHome, "hack.config.json");
  await writeFile(
    configPath,
    `${JSON.stringify({
      controlPlane: {
        secrets: {
          backend: "encrypted_file",
          encryptedFile: { path: hostile, keyPath: fixture.keyPath },
        },
      },
    })}\n`
  );
  const before = await readFile(hostile);
  const outcome = await retireSecretStore({
    projectName: "app-b",
    projectDir: fixture.bystander.projectDir,
  });
  expect(outcome.kind).toBe("retired");
  const info = (await inspect(fixture.bystander, "app-b")).find(
    (finding) => finding.status === "info"
  );
  const command = info?.message.split(": ").at(-1) ?? "";
  expect(command.startsWith("mv ")).toBe(true);
  // Run exactly what was printed, in the fixture root.
  const shell = Bun.spawn(["sh", "-c", command], {
    cwd: root,
    stdout: "ignore",
    stderr: "pipe",
  });
  expect(await shell.exited).toBe(0);
  expect(await readFile(hostile)).toEqual(before);
  expect(await lstat(join(root, "PWNED")).catch(() => null)).toBeNull();
  expect(
    await lstat(join(fixture.hackHome, "PWNED")).catch(() => null)
  ).toBeNull();
  // The guidance extracts the scoped retire command whole.
  const lines = buildRecoveryWorkflowLines({
    guidance: buildDoctorRecoveryGuidance({
      results: [
        {
          name: "secret integrity",
          status: "warn",
          message:
            "Run hack secrets retire-store --path '/srv/it'\\''s here' now.",
        },
      ],
    }),
    projectRoot: null,
  }).join("\n");
  expect(lines).toContain(
    "`hack secrets retire-store --path '/srv/it'\\''s here'`"
  );
});

test("a key file that exists but cannot be read is not missing: the store is not retired", async () => {
  // Codex review: an unreadable key file was classified as missing, so a
  // store that fixing the key's permissions would recover was retired.
  if (process.getuid?.() === 0) {
    return;
  }
  const fixture = await setUp();
  const before = await readFile(fixture.storePath);
  await writeFile(fixture.keyPath, `${STORE_KEY}\n`, { mode: 0o600 });
  await chmod(fixture.keyPath, 0o000);
  try {
    const findings = await inspect(fixture.bystander, "app-b");
    expect(findings).toHaveLength(1);
    // Machine-wide: a warning here, an error where the store is read.
    expect(findings[0]?.status).toBe("warn");
    expect(findings[0]?.message).toContain("exists but cannot be read");
    expect(findings[0]?.message).toContain("This project does not read it.");
    expect((await inspect(fixture.reader, "app-a"))[0]?.status).toBe("error");
    expect(findings[0]?.message).not.toContain("hack secrets retire-store");
    const outcome = await retireSecretStore({
      projectName: "app-b",
      projectDir: fixture.bystander.projectDir,
    });
    expect(outcome.kind).toBe("refused");
    expect(outcome.kind === "refused" ? outcome.message : "").toContain(
      "key unreadable"
    );
    expect(await readFile(fixture.storePath)).toEqual(before);
  } finally {
    await chmod(fixture.keyPath, 0o600);
  }
  // Readable again: the store opens; nothing was lost.
  expect(await inspect(fixture.bystander, "app-b")).toEqual([]);
});

test("a store replaced at the moment of the move is archived, never deleted, and an existing archive is never replaced", async () => {
  // Second-family review blocker: link then unlink removed a replacement a
  // writer outside the lock put at the store path between the two steps.
  const fixture = await setUp();
  const before = await readFile(fixture.storePath);
  const replacement = Buffer.from("synthetic-replacement-store-bytes\n");
  const outcome = await retireEncryptedStoreFile({
    storePath: fixture.storePath,
    keyPath: fixture.keyPath,
    now: new Date("2026-11-13T12:00:00Z"),
    beforeMove: async () => {
      // A writer that ignores the lock swaps in a new file (new inode).
      const staged = `${fixture.storePath}.staged`;
      await writeFile(staged, replacement);
      await rename(staged, fixture.storePath);
    },
  });
  const dir = `${fixture.storePath}.retired-20261113T120000Z`;
  expect(outcome.to).toBe(join(dir, "secrets.enc.json"));
  // Neither file is lost: the archive holds the store that was linked, and
  // the replacement put at the store path meanwhile is kept beside it.
  expect(await readFile(outcome.to)).toEqual(before);
  expect(outcome.replacement?.startsWith(join(dir, ".source-"))).toBe(true);
  expect(await readFile(outcome.replacement ?? "")).toEqual(replacement);
  expect(await lstat(fixture.storePath).catch(() => null)).toBeNull();

  // Without a replacement, the extra name is removed: only the archive.
  const plain = join(fixture.hackHome, "plain.enc.json");
  await writeFile(plain, "synthetic-plain-store\n");
  const plainOutcome = await retireEncryptedStoreFile({
    storePath: plain,
    now: new Date("2026-11-13T12:00:00Z"),
  });
  expect(plainOutcome.replacement).toBeNull();
  expect(await readdir(`${plain}.retired-20261113T120000Z`)).toEqual([
    "plain.enc.json",
  ]);

  // An archive name that already exists is never replaced.
  const second = join(fixture.hackHome, "secrets.enc.json");
  await writeFile(second, "synthetic-second-store\n");
  await expect(
    retireEncryptedStoreFile({
      storePath: second,
      now: new Date("2026-11-13T12:00:00Z"),
    })
  ).rejects.toThrow("already exists; nothing was moved");
  expect(await readFile(outcome.to)).toEqual(before);
  expect(await readFile(outcome.replacement ?? "")).toEqual(replacement);
  expect(await readFile(second, "utf8")).toBe("synthetic-second-store\n");

  // A file planted at the archive name, inside the new directory, before
  // the link: the link refuses, and nothing is removed or replaced.
  const third = join(fixture.hackHome, "third.enc.json");
  await writeFile(third, "synthetic-third-store\n");
  let planted = "";
  await expect(
    retireEncryptedStoreFile({
      storePath: third,
      now: new Date("2026-11-13T12:00:00Z"),
      afterDirectory: async (made) => {
        planted = join(made, "third.enc.json");
        await writeFile(planted, "synthetic-planted\n");
      },
    })
  ).rejects.toThrow("left as they are");
  expect(await readFile(planted, "utf8")).toBe("synthetic-planted\n");
  expect(await readFile(third, "utf8")).toBe("synthetic-third-store\n");
  // That refusal suggests no move that could overwrite the planted file.
  const collision = await retireEncryptedStoreFile({
    storePath: third,
    now: new Date("2026-11-13T12:00:01Z"),
    afterDirectory: async (made) => {
      await writeFile(join(made, "third.enc.json"), "synthetic-planted\n");
    },
  }).catch((error: unknown) => String(error));
  expect(collision).not.toContain("mv ");

  // Any other link failure: the empty directory is removed, and the manual
  // step makes a fresh one and moves without overwriting (mv -n).
  const fourth = join(fixture.hackHome, "fourth.enc.json");
  await writeFile(fourth, "synthetic-fourth-store\n");
  const fourthDir = `${fourth}.retired-20261113T120000Z`;
  const other = await retireEncryptedStoreFile({
    storePath: fourth,
    now: new Date("2026-11-13T12:00:00Z"),
    afterDirectory: async () => {
      // The store vanishes, so the link fails with ENOENT, not EEXIST.
      await rename(fourth, `${fourth}.away`);
    },
  }).catch((error: unknown) => String(error));
  expect(other).toContain(
    `mkdir ${fourthDir} && mv -n ${fourth} ${fourthDir}/`
  );
  expect(await lstat(fourthDir).catch(() => null)).toBeNull();
});

test("a store that is its own key file is not retired, through any spelling", async () => {
  // Second-family review: path and keyPath naming the same file (directly
  // or through a symlinked directory) made the key file retirable.
  const fixture = await setUp();
  await writeFile(fixture.keyPath, `${STORE_KEY}\n`, { mode: 0o600 });
  await chmod(fixture.keyPath, 0o600);
  const alias = join(fixture.home, "key-alias");
  await symlink(fixture.hackHome, alias);
  for (const path of [fixture.keyPath, join(alias, "secrets-file.key")]) {
    await expect(
      retireEncryptedStoreFile({ storePath: path, keyPath: fixture.keyPath })
    ).rejects.toThrow("is its own key file");
    expect(await readFile(fixture.keyPath, "utf8")).toBe(`${STORE_KEY}\n`);
  }
});

test("retire refuses when the config that selects the store cannot be read or does not parse", async () => {
  // Second-family review: an unreadable or malformed project config was
  // taken as absent, so the global store could be retired instead.
  const fixture = await setUp();
  const before = await readFile(fixture.storePath);
  const projectConfig = join(fixture.bystander.projectDir, "hack.config.json");
  if (process.getuid?.() !== 0) {
    await chmod(projectConfig, 0o000);
    try {
      const outcome = await retireSecretStore({
        projectName: "app-b",
        projectDir: fixture.bystander.projectDir,
      });
      expect(outcome.kind === "refused" ? outcome.message : "").toContain(
        "exists but cannot be read"
      );
    } finally {
      await chmod(projectConfig, 0o644);
    }
  }
  const projectText = await readFile(projectConfig, "utf8");
  await writeFile(projectConfig, "{ not json");
  const malformed = await retireSecretStore({
    projectName: "app-b",
    projectDir: fixture.bystander.projectDir,
  });
  expect(malformed.kind === "refused" ? malformed.message : "").toContain(
    "does not parse"
  );
  await writeFile(projectConfig, projectText);
  expect(await readFile(fixture.storePath)).toEqual(before);
});

test("doctor says when the reader scan is incomplete, and finds readers through an alias", async () => {
  // Second-family review: scan failures became "no registered project
  // reads it", and a reader reaching the store through a symlinked
  // directory was missed.
  const fixture = await setUp();
  // app-a reaches the store through a symlinked directory instead.
  const alias = join(fixture.home, "hack-alias");
  await symlink(fixture.hackHome, alias);
  await writeFile(
    join(fixture.reader.projectDir, "hack.config.json"),
    `${JSON.stringify({
      name: "app-a",
      dev_host: "app-a.hack",
      controlPlane: {
        secrets: {
          backend: "encrypted_file",
          encryptedFile: {
            path: join(alias, "secrets.enc.json"),
            keyPath: fixture.keyPath,
          },
        },
      },
    })}\n`
  );
  const aliased = await inspect(fixture.bystander, "app-b");
  expect(aliased[0]?.message).toContain(
    "Registered projects that read it: app-a."
  );

  // A registered project whose config cannot be parsed is not "does not read it".
  await writeFile(join(fixture.reader.projectDir, "hack.config.json"), "{ bad");
  const partial = await inspect(fixture.bystander, "app-b");
  expect(partial[0]?.message).toContain(
    "No checked registered project reads it, but 1 registered project(s) could not be checked"
  );
  expect(partial[0]?.message).not.toContain("No registered project reads it.");
});

test("a keychain that cannot be asked is not a missing key: the store is not retired", async () => {
  // Codex review: with no key file and the keychain locked, denied or
  // timed out, the key's existence is unknown, but it was classified as
  // missing and the store could be retired.
  const fixture = await setUp();
  const before = await readFile(fixture.storePath);
  process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK = "0";
  // The keychain answers "no such item": the key is missing (retirable).
  const empty = spyOn(keychain, "get").mockImplementation(async () => null);
  try {
    const missing = await inspect(fixture.bystander, "app-b");
    expect(missing[0]?.message).toContain("is missing");
    expect(missing[0]?.message).toContain("hack secrets retire-store");
  } finally {
    empty.mockRestore();
  }
  // The keychain cannot be asked: unknown, not retirable.
  const denied = spyOn(keychain, "get").mockImplementation(async () => {
    throw new Error("synthetic keychain access denied");
  });
  try {
    const unknown = await inspect(fixture.bystander, "app-b");
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.message).toContain("could not be looked up");
    expect(unknown[0]?.message).not.toContain("hack secrets retire-store");
    // The failure cooldown that follows is unknown too, never missing.
    const outcome = await retireSecretStore({
      projectName: "app-b",
      projectDir: fixture.bystander.projectDir,
    });
    expect(outcome.kind === "refused" ? outcome.message : "").toContain(
      "key access failed"
    );
    expect(await readFile(fixture.storePath)).toEqual(before);
  } finally {
    denied.mockRestore();
    // A successful resolution ends the module's failure cooldown, so no
    // later test inherits it.
    process.env.HACK_SECRETS_FILE_KEY = STORE_KEY;
    await resolveSecretStore({
      projectName: "app-b",
      projectDir: fixture.bystander.projectDir,
    });
    Reflect.deleteProperty(process.env, "HACK_SECRETS_FILE_KEY");
  }
});

test("a configured store path that is not a Hack store is never offered for retirement or retired", async () => {
  // Codex security review: the path is project input; any non-empty file
  // with no key counted as a keyless store, so a project could point it at
  // a host file (such as an authorized_keys file) and have it moved aside.
  const fixture = await setUp();
  const hostFile = join(fixture.home, ".ssh", "authorized_keys");
  await mkdir(join(fixture.home, ".ssh"), { recursive: true });
  await writeFile(hostFile, "synthetic-authorized-key-line\n");
  await writeFile(
    join(fixture.hackHome, "hack.config.json"),
    `${JSON.stringify({
      controlPlane: {
        secrets: {
          backend: "encrypted_file",
          encryptedFile: { path: hostFile, keyPath: fixture.keyPath },
        },
      },
    })}\n`
  );
  const findings = await inspect(fixture.bystander, "app-b");
  expect(findings).toHaveLength(1);
  expect(findings[0]?.message).toContain(
    "does not hold a Hack encrypted secret store"
  );
  expect(findings[0]?.message).not.toContain("hack secrets retire-store");
  const outcome = await retireSecretStore({
    projectName: "app-b",
    projectDir: fixture.bystander.projectDir,
  });
  expect(outcome.kind === "refused" ? outcome.message : "").toContain(
    "is not a Hack encrypted secret store"
  );
  expect(await readFile(hostFile, "utf8")).toBe(
    "synthetic-authorized-key-line\n"
  );
  expect(
    (await readdir(join(fixture.home, ".ssh"))).filter((name) =>
      name.includes(".retired-")
    )
  ).toEqual([]);
});

test("printed chmod and git rm guidance quotes a hostile key path", async () => {
  // Codex security review: the key path is project input; the new
  // key_unreadable guidance printed `chmod 600 <path>` unquoted.
  if (process.getuid?.() === 0) {
    return;
  }
  const fixture = await setUp();
  const hostileKey = join(fixture.hackHome, "key'; touch PWNED; #'");
  await writeFile(hostileKey, `${STORE_KEY}\n`, { mode: 0o600 });
  await writeFile(
    join(fixture.hackHome, "hack.config.json"),
    `${JSON.stringify({
      controlPlane: {
        secrets: {
          backend: "encrypted_file",
          encryptedFile: { path: fixture.storePath, keyPath: hostileKey },
        },
      },
    })}\n`
  );
  const quoted = `'${hostileKey.replaceAll("'", "'\\''")}'`;
  await chmod(hostileKey, 0o000);
  try {
    const unreadable = (await inspect(fixture.reader, "app-a"))[0];
    expect(unreadable?.message).toContain(`chmod 600 ${quoted}`);
  } finally {
    await chmod(hostileKey, 0o600);
  }
  // Open to others: refused, with quoted chmod and git rm.
  await chmod(hostileKey, 0o644);
  const refused = (await inspect(fixture.reader, "app-a"))[0];
  expect(refused?.message).toContain(`chmod 600 ${quoted}`);
  expect(refused?.message).toContain(`git rm --cached ${quoted}`);
});

test('a malformed registry, or a store identity that cannot be read, is never "no registered project reads it"', async () => {
  // Second-family review: an invalid registry read as empty, and an
  // identity lookup failure counted as "different", both produced the
  // definitive no-readers wording.
  const fixture = await setUp();
  const registry = join(fixture.hackHome, "projects.json");
  const text = await readFile(registry, "utf8");
  await writeFile(registry, "{ not a registry");
  try {
    const malformed = (await inspect(fixture.bystander, "app-b"))[0];
    expect(malformed?.message).toContain(
      "The projects registry could not be read or is not valid"
    );
    expect(malformed?.message).not.toContain("No registered project reads it.");
  } finally {
    await writeFile(registry, text);
  }
  if (process.getuid?.() === 0) {
    return;
  }
  // app-a reaches the store through an alias whose directory cannot be
  // searched: its identity is unknown, so it counts as unchecked.
  const hidden = join(fixture.home, "hidden");
  await mkdir(hidden);
  await symlink(fixture.hackHome, join(hidden, "alias"));
  await writeFile(
    join(fixture.reader.projectDir, "hack.config.json"),
    `${JSON.stringify({
      name: "app-a",
      dev_host: "app-a.hack",
      controlPlane: {
        secrets: {
          backend: "encrypted_file",
          encryptedFile: {
            path: join(hidden, "alias", "secrets.enc.json"),
            keyPath: fixture.keyPath,
          },
        },
      },
    })}\n`
  );
  await chmod(hidden, 0o000);
  try {
    const unknown = (await inspect(fixture.bystander, "app-b"))[0];
    expect(unknown?.message).toContain("could not be checked");
    expect(unknown?.message).not.toContain("No registered project reads it.");
  } finally {
    await chmod(hidden, 0o755);
  }
});

test("registry entries that are not valid projects make the reader scan incomplete", async () => {
  // Second-family review: the strict read still skipped invalid project
  // entries silently, so a filtered list read as complete.
  const fixture = await setUp();
  const registry = join(fixture.hackHome, "projects.json");
  const text = await readFile(registry, "utf8");
  const parsed = JSON.parse(text) as { projects: unknown[] };
  // Mixed: the valid entries plus one that is not a project.
  await writeFile(
    registry,
    JSON.stringify({ ...parsed, projects: [...parsed.projects, { id: 5 }] })
  );
  const mixed = (await inspect(fixture.bystander, "app-b"))[0];
  expect(mixed?.message).toContain("Registered projects that read it: app-a.");
  expect(mixed?.message).toContain(
    "1 registered project(s) could not be checked"
  );
  // Only an invalid entry: never "No registered project reads it."
  await writeFile(
    registry,
    JSON.stringify({ ...parsed, projects: [{ id: 5 }] })
  );
  const only = (await inspect(fixture.bystander, "app-b"))[0];
  expect(only?.message).toContain("could not be checked");
  expect(only?.message).not.toContain("No registered project reads it.");
  await writeFile(registry, text);
});

test("a store reached through a symlinked directory is named and retired by its real path", async () => {
  // Codex security review: lstat checked only the last component, so a
  // repo-controlled symlinked directory could lead to another store while
  // the prompt showed the alias.
  const fixture = await setUp();
  const before = await readFile(fixture.storePath);
  const alias = join(fixture.bystander.projectRoot, "linked");
  await symlink(fixture.hackHome, alias);
  const configured = join(alias, "secrets.enc.json");
  await writeFile(
    join(fixture.bystander.projectDir, "hack.config.json"),
    `${JSON.stringify({
      name: "app-b",
      dev_host: "app-b.hack",
      controlPlane: {
        secrets: {
          backend: "encrypted_file",
          encryptedFile: { path: configured, keyPath: fixture.keyPath },
        },
      },
    })}\n`
  );
  // The confirmation names the real file, and the configured alias.
  expect(
    await describeRetireTarget({ projectDir: fixture.bystander.projectDir })
  ).toBe(`${fixture.storePath} (configured as ${configured})`);
  const outcome = await retireSecretStore({
    projectName: "app-b",
    projectDir: fixture.bystander.projectDir,
    now: new Date("2026-11-13T12:00:00Z"),
  });
  expect(outcome.kind).toBe("retired");
  if (outcome.kind !== "retired") {
    return;
  }
  // It acted on the real path: the archive sits beside the real store.
  expect(outcome.from).toBe(fixture.storePath);
  expect(outcome.configured).toBe(configured);
  expect(outcome.to).toBe(
    join(`${fixture.storePath}.retired-20261113T120000Z`, "secrets.enc.json")
  );
  expect(await readFile(outcome.to)).toEqual(before);
});

/**
 * Two keyless stores, A (the global store) and B (a copy elsewhere), and
 * app-b configured through a repo-local symlinked directory that leads to
 * A. Returns how to retarget that directory to B.
 */
async function aliasedStores(fixture: Fixture) {
  const before = await readFile(fixture.storePath);
  const otherDir = join(root, "other-store-dir");
  await mkdir(otherDir);
  const storeB = join(otherDir, "secrets.enc.json");
  await writeFile(storeB, before);
  const alias = join(fixture.bystander.projectRoot, "linked");
  await symlink(fixture.hackHome, alias);
  await writeFile(
    join(fixture.bystander.projectDir, "hack.config.json"),
    `${JSON.stringify({
      name: "app-b",
      dev_host: "app-b.hack",
      controlPlane: {
        secrets: {
          backend: "encrypted_file",
          encryptedFile: {
            path: join(alias, "secrets.enc.json"),
            keyPath: fixture.keyPath,
          },
        },
      },
    })}\n`
  );
  return {
    before,
    storeB,
    retargetToB: async () => {
      await rm(alias);
      await symlink(otherDir, alias);
    },
  };
}

test("a target retargeted after confirmation is not retired", async () => {
  // Second-family review: the prompt resolved the real path for display,
  // and the retirement resolved it again; a symlink retargeted while the
  // prompt waited made it retire a store the user had not approved.
  const fixture = await setUp();
  const { before, storeB, retargetToB } = await aliasedStores(fixture);
  const planned = await planSecretStoreRetire({
    projectDir: fixture.bystander.projectDir,
  });
  expect(planned.kind).toBe("plan");
  if (planned.kind !== "plan") {
    return;
  }
  expect(planned.plan.canonical).toBe(fixture.storePath);
  // While the confirmation waits, the repo's symlink is pointed at B.
  await retargetToB();
  const outcome = await retireSecretStore({
    projectDir: fixture.bystander.projectDir,
    approved: planned.plan,
  });
  expect(outcome.kind === "refused" ? outcome.message : "").toContain(
    "changed after it was confirmed"
  );
  expect(await readFile(fixture.storePath)).toEqual(before);
  expect(await readFile(storeB)).toEqual(before);
});

test("the locked eligibility check reads the pinned store, not the alias", async () => {
  // Second-family review: under the lock, eligibility was read through the
  // alias after the path check; a retarget then validated B while A (whose
  // key had just come back) was moved.
  const fixture = await setUp();
  const { before, storeB, retargetToB } = await aliasedStores(fixture);
  const planned = await planSecretStoreRetire({
    projectDir: fixture.bystander.projectDir,
  });
  if (planned.kind !== "plan") {
    throw new Error("expected a plan");
  }
  const outcome = await retireSecretStore({
    projectDir: fixture.bystander.projectDir,
    approved: planned.plan,
    beforeEligibility: async () => {
      // After the path check: A's key comes back, and the alias moves to B.
      await writeFile(fixture.keyPath, `${STORE_KEY}\n`, { mode: 0o600 });
      await chmod(fixture.keyPath, 0o600);
      await retargetToB();
    },
  });
  expect(outcome.kind === "refused" ? outcome.message : "").toContain(
    "opens with the key in use"
  );
  // A, now recoverable, stays active; B is untouched.
  expect(await readFile(fixture.storePath)).toEqual(before);
  expect(await readFile(storeB)).toEqual(before);
  expect(
    (await readdir(fixture.hackHome)).filter((name) =>
      name.includes(".retired-")
    )
  ).toEqual([]);
});

test("control characters in a configured store path are shown, never sent to the terminal", async () => {
  // Codex security review: a symlinked directory named with CR and an
  // erase-line sequence could rewrite the confirmation on screen.
  expect(escapeTerminalControls("a\r\u001b[2Kb\nc\td\u009b")).toBe(
    "a\\x0d\\x1b[2Kb\\x0ac\\x09d\\x9b"
  );
  const fixture = await setUp();
  const alias = join(fixture.bystander.projectRoot, "lin\r\u001b[2Kked");
  await symlink(fixture.hackHome, alias);
  await writeFile(
    join(fixture.bystander.projectDir, "hack.config.json"),
    `${JSON.stringify({
      name: "app-b",
      dev_host: "app-b.hack",
      controlPlane: {
        secrets: {
          backend: "encrypted_file",
          encryptedFile: {
            path: join(alias, "secrets.enc.json"),
            keyPath: fixture.keyPath,
          },
        },
      },
    })}\n`
  );
  const raw = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
  // Doctor's finding names the path with its controls escaped.
  const findings = await inspect(fixture.bystander, "app-b");
  for (const finding of findings) {
    expect(raw.test(finding.message)).toBe(false);
  }
  // The real command's output (the moved paths) is escaped too.
  const retired = await runRetire({
    fixture,
    path: fixture.bystander.projectRoot,
    yes: true,
  });
  expect(retired.code).toBe(0);
  expect(retired.output).toContain("lin\\x0d\\x1b[2Kked");
  expect(raw.test(retired.output.replaceAll("\u001b[", "ESC["))).toBe(false);
});

test("a configured store path that is itself a symlink is not retired", async () => {
  // Codex review: resolving a final-component symlink moved its target
  // and left a dangling link at the configured path, which runtime and
  // doctor refuse as a store.
  const fixture = await setUp();
  const before = await readFile(fixture.storePath);
  const link = join(fixture.bystander.projectRoot, "store-link.enc.json");
  await symlink(fixture.storePath, link);
  await writeFile(
    join(fixture.bystander.projectDir, "hack.config.json"),
    `${JSON.stringify({
      name: "app-b",
      dev_host: "app-b.hack",
      controlPlane: {
        secrets: {
          backend: "encrypted_file",
          encryptedFile: { path: link, keyPath: fixture.keyPath },
        },
      },
    })}\n`
  );
  const planned = await planSecretStoreRetire({
    projectDir: fixture.bystander.projectDir,
  });
  expect(planned.kind === "refused" ? planned.message : "").toContain(
    "is itself a symlink"
  );
  const outcome = await retireSecretStore({
    projectDir: fixture.bystander.projectDir,
  });
  expect(outcome.kind).toBe("refused");
  expect(await readFile(fixture.storePath)).toEqual(before);
  expect((await lstat(link)).isSymbolicLink()).toBe(true);
});

test("a registered worktree that reads the store is named, even when its primary checkout does not", async () => {
  // Codex review: linked worktrees are registered under their project, not
  // as projects; the scan checked only the primary checkout.
  const fixture = await setUp();
  // A worktree of app-b whose env contract reads the store.
  const worktreeRoot = join(root, "repos", "app-b-feature");
  const worktreeDir = join(worktreeRoot, ".hack");
  await mkdir(worktreeDir, { recursive: true });
  await writeFile(
    join(worktreeDir, "hack.config.json"),
    `${JSON.stringify({ name: "app-b", dev_host: "app-b.hack" })}\n`
  );
  await writeFile(
    join(worktreeDir, "hack.env.json"),
    `${JSON.stringify({ version: 1, vars: [{ key: "TOKEN", source: "keychain" }] })}\n`
  );
  const registry = join(fixture.hackHome, "projects.json");
  const parsed = JSON.parse(await readFile(registry, "utf8")) as {
    projects: { name: string; worktrees?: unknown[] }[];
  };
  for (const project of parsed.projects) {
    if (project.name === "app-b") {
      project.worktrees = [
        {
          path: worktreeRoot,
          branch: "feature",
          lastSeenAt: "2026-11-13T12:00:00.000Z",
        },
      ];
    }
  }
  await writeFile(registry, JSON.stringify(parsed));
  // Only app-a's primary checkout and app-b's worktree read the store.
  const finding = (await inspect(fixture.bystander, "app-b"))[0];
  expect(finding?.message).toContain(
    "Registered projects that read it: app-a, app-b (worktree app-b-feature)."
  );
  // A worktree whose config cannot be read is unchecked, not "no reader".
  await writeFile(join(worktreeDir, "hack.config.json"), "{ bad");
  const partial = (await inspect(fixture.bystander, "app-b"))[0];
  expect(partial?.message).toContain(
    "1 registered project(s) could not be checked"
  );
});

test("a registered checkout that is not available counts as unchecked", async () => {
  // Codex review: a missing project directory (an unmounted volume) read
  // as a checkout with no config and no contract, so a non-reader.
  const fixture = await setUp();
  const registry = join(fixture.hackHome, "projects.json");
  const parsed = JSON.parse(await readFile(registry, "utf8")) as {
    projects: { name: string; worktrees?: unknown[] }[];
  };
  for (const project of parsed.projects) {
    if (project.name === "app-a") {
      project.worktrees = [
        {
          path: join(root, "unmounted", "app-a-feature"),
          branch: "feature",
          lastSeenAt: "2026-11-13T12:00:00.000Z",
        },
      ];
    }
  }
  await writeFile(registry, JSON.stringify(parsed));
  const finding = (await inspect(fixture.bystander, "app-b"))[0];
  expect(finding?.message).toContain(
    "Registered projects that read it: app-a."
  );
  expect(finding?.message).toContain(
    "1 registered project(s) could not be checked"
  );
});

test("a store another registered project's key still opens is not retired", async () => {
  // Codex security review: retire asked only whether this project's key
  // opens the store; another project with its own key still used it.
  const fixture = await setUp();
  const before = await readFile(fixture.storePath);
  const appAKey = join(fixture.reader.projectRoot, ".hack-store.key");
  await writeFile(appAKey, `${STORE_KEY}\n`, { mode: 0o600 });
  await chmod(appAKey, 0o600);
  await writeFile(
    join(fixture.reader.projectDir, "hack.config.json"),
    `${JSON.stringify({
      name: "app-a",
      dev_host: "app-a.hack",
      controlPlane: {
        secrets: {
          backend: "encrypted_file",
          encryptedFile: { path: fixture.storePath, keyPath: appAKey },
        },
      },
    })}\n`
  );
  const outcome = await retireSecretStore({
    projectDir: fixture.bystander.projectDir,
  });
  expect(outcome.kind === "refused" ? outcome.message : "").toContain(
    "still opens with a configured key file (app-a)"
  );
  expect(await readFile(fixture.storePath)).toEqual(before);

  // A wrong HACK_SECRETS_FILE_KEY in this shell does not hide app-a's key
  // file: key files are read directly, not through the override.
  process.env.HACK_SECRETS_FILE_KEY = "synthetic-wrong-override";
  try {
    const masked = await retireSecretStore({
      projectDir: fixture.bystander.projectDir,
    });
    expect(masked.kind === "refused" ? masked.message : "").toContain(
      "still opens with a configured key file (app-a)"
    );
  } finally {
    Reflect.deleteProperty(process.env, "HACK_SECRETS_FILE_KEY");
  }
  expect(await readFile(fixture.storePath)).toEqual(before);

  // app-a's key file cannot be read: not tested, so --allow-unchecked is
  // needed rather than taking it as "does not open".
  if (process.getuid?.() !== 0) {
    await chmod(appAKey, 0o000);
    try {
      const unknown = await retireSecretStore({
        projectDir: fixture.bystander.projectDir,
      });
      expect(unknown.kind === "refused" ? unknown.message : "").toContain(
        "configured key(s)"
      );
      expect(unknown.kind === "refused" ? unknown.message : "").toContain(
        "--allow-unchecked"
      );
    } finally {
      await chmod(appAKey, 0o600);
    }
    expect(await readFile(fixture.storePath)).toEqual(before);
  }
});

test("retire refuses when registered projects could not be checked, unless --allow-unchecked", async () => {
  // The store may be another checkout's that could not be checked.
  const fixture = await setUp();
  const before = await readFile(fixture.storePath);
  const registry = join(fixture.hackHome, "projects.json");
  const parsed = JSON.parse(await readFile(registry, "utf8")) as {
    projects: { name: string; worktrees?: unknown[] }[];
  };
  for (const project of parsed.projects) {
    if (project.name === "app-a") {
      project.worktrees = [
        {
          path: join(root, "unmounted", "app-a-feature"),
          branch: "feature",
          lastSeenAt: "2026-11-13T12:00:00.000Z",
        },
      ];
    }
  }
  await writeFile(registry, JSON.stringify(parsed));
  const refused = await retireSecretStore({
    projectDir: fixture.bystander.projectDir,
  });
  expect(refused.kind === "refused" ? refused.message : "").toContain(
    "--allow-unchecked"
  );
  expect(await readFile(fixture.storePath)).toEqual(before);
  const allowed = await retireSecretStore({
    projectDir: fixture.bystander.projectDir,
    allowUnchecked: true,
  });
  expect(allowed.kind).toBe("retired");
});

test("a store another project opens through the OS keychain is not retired", async () => {
  // Codex review: a project with no key file falls back to the keychain;
  // an absent key file was taken as "does not open".
  const fixture = await setUp();
  const before = await readFile(fixture.storePath);
  // app-b has its own, wrong key file; app-a has none (keychain fallback).
  const wrongKey = join(fixture.bystander.projectRoot, ".wrong.key");
  await writeFile(wrongKey, "synthetic-wrong-key\n", { mode: 0o600 });
  await chmod(wrongKey, 0o600);
  await writeFile(
    join(fixture.bystander.projectDir, "hack.config.json"),
    `${JSON.stringify({
      name: "app-b",
      dev_host: "app-b.hack",
      controlPlane: {
        secrets: {
          backend: "encrypted_file",
          encryptedFile: { path: fixture.storePath, keyPath: wrongKey },
        },
      },
    })}\n`
  );
  process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK = "0";
  const holds = spyOn(keychain, "get").mockImplementation(
    async () => STORE_KEY
  );
  try {
    const outcome = await retireSecretStore({
      projectDir: fixture.bystander.projectDir,
    });
    expect(outcome.kind === "refused" ? outcome.message : "").toContain(
      "app-a, through the OS keychain"
    );
  } finally {
    holds.mockRestore();
  }
  // A keychain that cannot be asked: unchecked, not "does not open".
  const locked = spyOn(keychain, "get").mockImplementation(async () => {
    throw new Error("synthetic keychain locked");
  });
  try {
    const outcome = await retireSecretStore({
      projectDir: fixture.bystander.projectDir,
    });
    expect(outcome.kind === "refused" ? outcome.message : "").toContain(
      "--allow-unchecked"
    );
  } finally {
    locked.mockRestore();
  }
  expect(await readFile(fixture.storePath)).toEqual(before);
});

test("an invalid worktree entry inside a valid project makes the reader scan incomplete", async () => {
  // Codex review: the strict read counted rejected project entries but not
  // rejected worktree entries, which were dropped silently.
  const fixture = await setUp();
  const registry = join(fixture.hackHome, "projects.json");
  const parsed = JSON.parse(await readFile(registry, "utf8")) as {
    projects: { name: string; worktrees?: unknown[] }[];
  };
  for (const project of parsed.projects) {
    if (project.name === "app-a") {
      // No lastSeenAt: the parser skips it.
      project.worktrees = [{ path: join(root, "repos", "app-a-feature") }];
    }
  }
  await writeFile(registry, JSON.stringify(parsed));
  const finding = (await inspect(fixture.bystander, "app-b"))[0];
  expect(finding?.message).toContain(
    "1 registered project(s) could not be checked"
  );
  const outcome = await retireSecretStore({
    projectDir: fixture.bystander.projectDir,
  });
  expect(outcome.kind === "refused" ? outcome.message : "").toContain(
    "--allow-unchecked"
  );
});
