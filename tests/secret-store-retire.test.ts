import { afterEach, beforeEach, expect, test } from "bun:test";
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
import { findProjectContext } from "../src/lib/project.ts";
import { upsertProjectRegistration } from "../src/lib/projects-registry.ts";
import { withProjectsRegistryLock } from "../src/lib/projects-registry-lock.ts";
import { resolveSecretStore } from "../src/lib/secret-store.ts";
import { retireSecretStore } from "../src/lib/secret-store-retire.ts";
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
  const retiredPath = join(fixture.hackHome, kept[0] ?? "");
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
      `Retired secret store kept at ~/.hack/${kept[0]}`
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
