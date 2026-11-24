import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataComposeArgs } from "../src/commands/data.ts";
import {
  resolveComposeRuntimeModel,
  resolveRestartTarget,
  UNLISTABLE_LEGACY_ENV_REFUSAL,
  unrecordedEnvRefusalMessage,
} from "../src/commands/project.ts";
import { HackCliError } from "../src/lib/cli-result.ts";
import { createHostDataBackupDocker } from "../src/lib/data-backup-docker.ts";
import { parseJsonText } from "../src/lib/data-backup-helper.ts";
import { planDeclaredVolumes } from "../src/lib/data-backup-volumes.ts";
import { findProjectContextAtRoot } from "../src/lib/project.ts";
import { upsertProjectRuntimeStateEntry } from "../src/lib/project-runtime-state.ts";
import { spawnSyncBounded } from "./helpers/bounded-spawn-sync.ts";

/**
 * `hack data` reads the instance's model as `hack up` resolves it: every
 * Compose file of the stack, the managed env and all profiles. Runs the real
 * `docker compose config`, which needs the Compose plugin but no engine.
 */
const composeAvailable = (() => {
  try {
    return (
      spawnSyncBounded(["docker", "compose", "version", "--short"], {
        timeout: 20_000,
      }).exitCode === 0
    );
  } catch {
    return false;
  }
})();

let root: string;
let hackHome: string | undefined;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-data-model-"));
  hackHome = process.env.HACK_HOME;
  process.env.HACK_HOME = join(root, "hack-home");
});
afterEach(async () => {
  if (hackHome === undefined) {
    Reflect.deleteProperty(process.env, "HACK_HOME");
  } else {
    process.env.HACK_HOME = hackHome;
  }
  await rm(root, { recursive: true, force: true });
});

test("the argv carries every stack file in order and enables all profiles", () => {
  const argv = dataComposeArgs({
    composeFiles: [
      "/p/.hack/docker-compose.yml",
      "/h/internal.yml",
      "/p/env.yml",
    ],
    composeProject: "shop--feature",
    cwd: "/p/.hack",
    env: {},
  });
  expect(argv).toEqual([
    "docker",
    "compose",
    "-p",
    "shop--feature",
    "--project-directory",
    "/p/.hack",
    "-f",
    "/p/.hack/docker-compose.yml",
    "-f",
    "/h/internal.yml",
    "-f",
    "/p/env.yml",
    "--profile",
    "*",
  ]);
});

test.skipIf(!composeAvailable)(
  "an override's volume, a profile-gated service's volume and a managed-env name are all declared",
  async () => {
    const base = join(root, "docker-compose.yml");
    const override = join(root, "override.yml");
    await writeFile(
      base,
      [
        "name: shop",
        "services:",
        "  web:",
        "    image: busybox",
        "    volumes: [data:/data]",
        "  worker:",
        "    image: busybox",
        "    profiles: [jobs]",
        "    volumes: [jobs:/jobs]",
        "volumes:",
        "  data:",
        "    name: shop_data-${DATA_SUFFIX}",
        "  jobs: {}",
        "",
      ].join("\n")
    );
    await writeFile(
      override,
      [
        "services:",
        "  web:",
        "    volumes: [cache:/cache]",
        "volumes:",
        "  cache: {}",
        "",
      ].join("\n")
    );
    const model = {
      composeFiles: [base, override],
      composeProject: null,
      cwd: root,
      env: { DATA_SUFFIX: "managed" },
    };
    const docker = createHostDataBackupDocker({
      env: model.env,
      cwd: model.cwd,
    });
    const config = await docker.capture([
      ...dataComposeArgs(model),
      "config",
      "--format",
      "json",
    ]);
    expect(config.exitCode).toBe(0);
    const plan = planDeclaredVolumes(parseJsonText(config.stdout));
    expect(plan.declared.map((volume) => [volume.key, volume.name])).toEqual([
      ["cache", "shop_cache"],
      ["data", "shop_data-managed"],
      ["jobs", "shop_jobs"],
    ]);
  }
);

async function envProject(): Promise<string> {
  const projectRoot = join(root, "repo");
  const projectDir = join(projectRoot, ".hack");
  await mkdir(join(projectDir, ".internal"), { recursive: true });
  await writeFile(
    join(projectDir, "docker-compose.yml"),
    [
      "name: shop",
      "services:",
      "  db:",
      "    image: busybox",
      "    volumes: [data:/data]",
      "volumes:",
      "  data:",
      "    name: shop_data-${VOL_SUFFIX}",
      "",
    ].join("\n")
  );
  for (const [env, suffix] of [
    ["default", "base"],
    ["staging", "staging"],
  ] as const) {
    await writeFile(
      join(projectDir, `hack.env.${env}.yaml`),
      [
        "version: 1",
        `environment: ${env}`,
        "secretsprovider: project_key",
        "values:",
        "  global:",
        `    VOL_SUFFIX: "${suffix}"`,
        "",
      ].join("\n")
    );
  }
  return projectRoot;
}

test.skipIf(!composeAvailable)(
  "without --env, the model uses the selection the instance was started with",
  async () => {
    const projectRoot = await envProject();
    const project = await findProjectContextAtRoot({
      projectRoot,
      projectDirName: ".hack",
    });
    if (!project) {
      throw new Error("expected the fixture project");
    }
    await upsertProjectRuntimeStateEntry({
      projectDir: project.projectDir,
      entry: {
        composeProject: "shop",
        envName: "staging",
        updatedAt: "2026-11-24T00:00:00.000Z",
      },
    });
    const volumeName = async (envName: string | undefined) => {
      const model = await resolveComposeRuntimeModel({
        project,
        branch: null,
        envName,
      });
      const config = await createHostDataBackupDocker({
        env: model.env,
        cwd: model.cwd,
      }).capture([...dataComposeArgs(model), "config", "--format", "json"]);
      expect(config.exitCode).toBe(0);
      return planDeclaredVolumes(parseJsonText(config.stdout)).declared[0]
        ?.name;
    };
    // Recorded `staging`, as `hack down` would use it.
    expect(await volumeName(undefined)).toBe("shop_data-staging");
    // An explicit selection still wins.
    expect(await volumeName("default")).toBe("shop_data-base");
  }
);

async function fixtureProject(projectRoot: string) {
  const project = await findProjectContextAtRoot({
    projectRoot,
    projectDirName: ".hack",
  });
  if (!project) {
    throw new Error("expected the fixture project");
  }
  return project;
}

test("without --env or a recorded selection, a project with overlays refuses naming them", async () => {
  // `hack up --env staging` then a successful `hack down` leaves no record.
  const project = await fixtureProject(await envProject());
  const refusal = await resolveComposeRuntimeModel({
    project,
    branch: null,
    envName: undefined,
  }).then(
    () => null,
    (error: unknown) => error
  );
  expect(refusal).toBeInstanceOf(HackCliError);
  expect((refusal as HackCliError).code).toBe("E_USAGE");
  expect((refusal as HackCliError).message).toBe(
    unrecordedEnvRefusalMessage(["staging"])
  );
  expect((refusal as HackCliError).message).toBe(
    "This project has environment overlays (staging); the environment `hack up` used is no longer recorded. Pass --env <name> (or --env base for base layers only)."
  );
});

test("a recorded selection, base included, needs no --env", async () => {
  const project = await fixtureProject(await envProject());
  for (const envName of ["staging", null] as const) {
    await upsertProjectRuntimeStateEntry({
      projectDir: project.projectDir,
      entry: {
        composeProject: "shop",
        envName,
        updatedAt: "2026-11-24T00:00:00.000Z",
      },
    });
    const model = await resolveComposeRuntimeModel({
      project,
      branch: null,
      envName: undefined,
    });
    expect(model.env.VOL_SUFFIX).toBe(envName === null ? "base" : "staging");
  }
});

test("an explicit --env wins without a recorded selection", async () => {
  const project = await fixtureProject(await envProject());
  for (const [envName, suffix] of [
    ["staging", "staging"],
    [null, "base"],
  ] as const) {
    const model = await resolveComposeRuntimeModel({
      project,
      branch: null,
      envName,
    });
    expect(model.env.VOL_SUFFIX).toBe(suffix);
  }
});

test("a project without overlays uses its base layers when nothing is recorded", async () => {
  const projectRoot = await envProject();
  await rm(join(projectRoot, ".hack", "hack.env.staging.yaml"));
  const project = await fixtureProject(projectRoot);
  const model = await resolveComposeRuntimeModel({
    project,
    branch: null,
    envName: undefined,
  });
  expect(model.env.VOL_SUFFIX).toBe("base");
});

/**
 * A legacy dotenv project: no env layers, a contract, `.hack/.env` and the
 * overlay `.hack/.env.staging`, which `hack up --env staging` selects.
 */
async function dotenvOverlayProject(): Promise<string> {
  const projectRoot = join(root, "legacy");
  const projectDir = join(projectRoot, ".hack");
  await mkdir(join(projectDir, ".internal"), { recursive: true });
  await writeFile(
    join(projectDir, "docker-compose.yml"),
    [
      "name: shop",
      "services:",
      "  db:",
      "    image: busybox",
      "    volumes: [data:/data]",
      "volumes:",
      "  data:",
      "    name: shop_data-${VOL_SUFFIX}",
      "",
    ].join("\n")
  );
  await writeFile(
    join(projectDir, "hack.env.json"),
    `${JSON.stringify({
      version: 1,
      vars: [{ key: "VOL_SUFFIX", source: "plain_env", required: false }],
    })}\n`
  );
  await writeFile(join(projectDir, ".env"), "VOL_SUFFIX=base\n");
  await writeFile(join(projectDir, ".env.staging"), "VOL_SUFFIX=staging\n");
  return projectRoot;
}

test("a dotenv-overlay-only project after down refuses without --env, naming the overlay", async () => {
  const project = await fixtureProject(await dotenvOverlayProject());
  const refusal = await resolveComposeRuntimeModel({
    project,
    branch: null,
    envName: undefined,
  }).then(
    () => null,
    (error: unknown) => error
  );
  expect(refusal).toBeInstanceOf(HackCliError);
  expect((refusal as HackCliError).code).toBe("E_USAGE");
  expect((refusal as HackCliError).message).toBe(
    unrecordedEnvRefusalMessage(["staging"])
  );
});

test("a dotenv-overlay-only project with a recorded selection uses it", async () => {
  const project = await fixtureProject(await dotenvOverlayProject());
  for (const [envName, suffix] of [
    ["staging", "staging"],
    [null, "base"],
  ] as const) {
    await upsertProjectRuntimeStateEntry({
      projectDir: project.projectDir,
      entry: {
        composeProject: "shop",
        envName,
        updatedAt: "2026-11-24T00:00:00.000Z",
      },
    });
    const model = await resolveComposeRuntimeModel({
      project,
      branch: null,
      envName: undefined,
    });
    expect({ envName, suffix: model.env.VOL_SUFFIX }).toEqual({
      envName,
      suffix,
    });
  }
});

test("a dotenv project whose secret store cannot be listed refuses without --env", async () => {
  // Contract values kept in the backend: an overlay may exist only there.
  const projectRoot = await dotenvOverlayProject();
  const projectDir = join(projectRoot, ".hack");
  await rm(join(projectDir, ".env.staging"));
  await writeFile(
    join(projectDir, "hack.env.json"),
    `${JSON.stringify({
      version: 1,
      vars: [{ key: "VOL_SUFFIX", source: "keychain", required: false }],
    })}\n`
  );
  const project = await fixtureProject(projectRoot);
  const refusal = await resolveComposeRuntimeModel({
    project,
    branch: null,
    envName: undefined,
  }).then(
    () => null,
    (error: unknown) => error
  );
  expect((refusal as HackCliError).code).toBe("E_USAGE");
  expect((refusal as HackCliError).message).toBe(UNLISTABLE_LEGACY_ENV_REFUSAL);
});

test("a dotenv project with no overlay and no backend values uses its base without --env", async () => {
  const projectRoot = await dotenvOverlayProject();
  await rm(join(projectRoot, ".hack", ".env.staging"));
  const project = await fixtureProject(projectRoot);
  const model = await resolveComposeRuntimeModel({
    project,
    branch: null,
    envName: undefined,
  });
  expect(model.env.VOL_SUFFIX).toBe("base");
});

/**
 * A project whose Compose file has no `name:` and whose `.hack/` directory
 * name differs from its Hack config name: Compose names the project after
 * the directory (`hack`), as `hack up` launches it, not after the config
 * name (`envshop`). The volume is unnamed, so its Docker name is
 * `<Compose project>_data`.
 */
async function unnamedComposeProject(): Promise<string> {
  const projectRoot = join(root, "dirbased");
  const projectDir = join(projectRoot, ".hack");
  await mkdir(join(projectDir, ".internal"), { recursive: true });
  await writeFile(
    join(projectDir, "hack.config.json"),
    `${JSON.stringify({ name: "envshop", dev_host: "envshop.hack" })}\n`
  );
  await writeFile(
    join(projectDir, "docker-compose.yml"),
    [
      "services:",
      "  db:",
      "    image: busybox",
      "    environment:",
      "      SUFFIX: ${VOL_SUFFIX}",
      "    volumes: [data:/data]",
      "volumes:",
      "  data: {}",
      "",
    ].join("\n")
  );
  for (const [env, suffix] of [
    ["default", "base"],
    ["staging", "staging"],
  ] as const) {
    await writeFile(
      join(projectDir, `hack.env.${env}.yaml`),
      [
        "version: 1",
        `environment: ${env}`,
        "secretsprovider: project_key",
        "values:",
        "  global:",
        `    VOL_SUFFIX: "${suffix}"`,
        "",
      ].join("\n")
    );
  }
  return projectRoot;
}

/** The record `hack up --env staging` leaves, keyed as next's up keys it. */
async function recordLaunch(opts: {
  readonly projectDir: string;
  readonly base: string;
  readonly branch: string | null;
}): Promise<void> {
  const { lifecycleComposeProject } = resolveRestartTarget({
    baseProjectName: opts.base,
    branch: opts.branch,
  });
  await upsertProjectRuntimeStateEntry({
    projectDir: opts.projectDir,
    entry: {
      composeProject: lifecycleComposeProject,
      envName: "staging",
      launchComposeBase: opts.base,
      envProjectName: "envshop",
      updatedAt: "2026-11-24T00:00:00.000Z",
    },
  });
}

test.skipIf(!composeAvailable)(
  "an unnamed Compose project under a differently named directory: the model reads the recorded selection and targets the directory-based volumes",
  async () => {
    const project = await fixtureProject(await unnamedComposeProject());
    await recordLaunch({
      projectDir: project.projectDir,
      base: "hack",
      branch: null,
    });
    const model = await resolveComposeRuntimeModel({
      project,
      branch: null,
      envName: undefined,
    });
    // The recorded `staging` selection, found under the directory-based key.
    expect(model.envSelection).toBe("staging");
    expect(model.env.VOL_SUFFIX).toBe("staging");
    const config = await createHostDataBackupDocker({
      env: model.env,
      cwd: model.cwd,
    }).capture([...dataComposeArgs(model), "config", "--format", "json"]);
    expect(config.exitCode).toBe(0);
    const plan = planDeclaredVolumes(parseJsonText(config.stdout));
    expect(plan.composeProject).toBe("hack");
    expect(plan.declared.map((volume) => volume.name)).toEqual(["hack_data"]);
  }
);

test.skipIf(!composeAvailable)(
  "a branch instance of that project targets <configured base>--<branch> and its recorded selection",
  async () => {
    // A branch instance keeps the configured name as its base (next's
    // naming): `hack up --branch feature` launches `envshop--feature`.
    const project = await fixtureProject(await unnamedComposeProject());
    await recordLaunch({
      projectDir: project.projectDir,
      base: "envshop",
      branch: "feature",
    });
    const model = await resolveComposeRuntimeModel({
      project,
      branch: "feature",
      envName: undefined,
    });
    expect(model.envSelection).toBe("staging");
    expect(model.composeProject).toBe("envshop--feature");
    const config = await createHostDataBackupDocker({
      env: model.env,
      cwd: model.cwd,
    }).capture([...dataComposeArgs(model), "config", "--format", "json"]);
    expect(config.exitCode).toBe(0);
    const plan = planDeclaredVolumes(parseJsonText(config.stdout));
    expect(plan.composeProject).toBe("envshop--feature");
    expect(plan.declared.map((volume) => volume.name)).toEqual([
      "envshop--feature_data",
    ]);
  }
);
