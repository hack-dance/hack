import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LegacyComposeAdoptionProjection } from "../src/lib/native-compose-adoption-projection.ts";
import { acquireNativeConfigImportInputs } from "../src/lib/native-config-import-inputs.ts";
import {
  addLinkedWorktree,
  commitAll,
  createMonorepoFixture,
} from "./e2e/fixture.ts";
import {
  MANAGED_FIXTURE_VALUE,
  managedAdoptionFixtureComposeFiles,
  managedAdoptionFixtureEnvAssertion,
  managedAdoptionFixtureSourceSnapshot,
  prepareManagedAdoptionFixtureSources,
} from "./e2e/scenarios/native-compose-adoption-managed-inputs.ts";
import {
  nativeComposeAdoptionManagedWorktreesScenario,
  ownedAdoptionFixtureObservation,
} from "./e2e/scenarios/native-compose-adoption-worktrees.ts";
import { restoreEnv } from "./helpers/env.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const tempRoot = await realpath(
    await mkdtemp(join(tmpdir(), "managed-adoption-fixture-"))
  );
  roots.push(tempRoot);
  const hackHome = join(tempRoot, "isolated-hack-home");
  await mkdir(hackHome, { mode: 0o700 });
  const base = await createMonorepoFixture({
    parentDir: tempRoot,
    withHackConfig: false,
  });
  const primary = { root: base.root, name: `${base.name}-main` };
  const write = async (checkout: { root: string; name: string }) => {
    await mkdir(join(checkout.root, ".hack"), { recursive: true });
    await writeFile(
      join(checkout.root, ".hack/hack.config.json"),
      JSON.stringify({
        name: checkout.name,
        env: { default_overlay: "qa" },
        worktree: { auto_branch: false, inherit_local: true },
      })
    );
    await writeFile(
      join(checkout.root, ".hack/docker-compose.yml"),
      JSON.stringify({
        name: checkout.name,
        services: {
          db: { image: "alpine:3.22", volumes: ["data:/data"] },
          worker: { image: "alpine:3.22", volumes: ["data:/data:ro"] },
        },
        volumes: { data: {} },
      })
    );
    await commitAll({
      root: checkout.root,
      message: "fixture: canonical managed sources",
    });
  };
  await write(primary);
  const instances: { root: string; name: string }[] = [];
  for (const branch of ["alpha", "beta"]) {
    const checkout = {
      root: await addLinkedWorktree({ fixture: base, branch }),
      name: `${base.name}-${branch}`,
    };
    await write(checkout);
    instances.push(checkout);
  }
  return { tempRoot, hackHome, primary, instances };
}

test("managed fixture uses real writer owners with isolated home, exact private bytes and distinct linked values", async () => {
  const selected = await fixture();
  const keys = [
    "HOME",
    "HACK_HOME",
    "CI",
    "HACK_EXECUTION_MODE",
    "HACK_ENV_SECRET_KEY",
  ] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.CI = "1";
  process.env.HACK_EXECUTION_MODE = "codex";
  process.env.HACK_ENV_SECRET_KEY = "synthetic-foreign-environment-key";
  const expected = Object.fromEntries(
    keys.map((key) => [key, process.env[key]])
  );
  try {
    await prepareManagedAdoptionFixtureSources(selected);
    expect(
      Object.fromEntries(keys.map((key) => [key, process.env[key]]))
    ).toEqual(expected);
    Reflect.deleteProperty(process.env, "CI");
    Reflect.deleteProperty(process.env, "HACK_EXECUTION_MODE");
    Reflect.deleteProperty(process.env, "HACK_ENV_SECRET_KEY");
    const generated: string[] = [];
    for (const instance of selected.instances) {
      const source = await acquireNativeConfigImportInputs({
        projectRoot: instance.root,
        allowLinkedWorktree: true,
      });
      const projection = await LegacyComposeAdoptionProjection.acquire({
        source,
      });
      const resolved = await projection.resolve();
      expect(resolved.composeFiles).toEqual(
        managedAdoptionFixtureComposeFiles(instance.root)
      );
      expect(resolved.globalEnv.NC04_ORDER).toBe(`${instance.name}-qa`);
      expect(resolved.globalEnv.NC04_EMPTY).toBe("");
      expect(resolved.globalEnv.NC04_DROP).toBeUndefined();
      expect(JSON.stringify(projection.report)).not.toContain(
        MANAGED_FIXTURE_VALUE
      );
      expect(JSON.stringify(resolved)).toBe("{}");
      const path = resolved.composeFiles[2] ?? "";
      const text = await readFile(path, "utf8");
      expect(text).toContain(`${MANAGED_FIXTURE_VALUE}-${instance.name}`);
      generated.push(text);
      const before = await managedAdoptionFixtureSourceSnapshot({
        ...selected,
        instance,
      });
      const raw = join(instance.root, ".hack/hack.env.qa.local.yaml");
      const original = await readFile(raw);
      await writeFile(raw, Buffer.concat([original, Buffer.from("\n")]));
      expect(
        await managedAdoptionFixtureSourceSnapshot({ ...selected, instance })
      ).not.toBe(before);
      await writeFile(raw, original);
      expect(
        await managedAdoptionFixtureSourceSnapshot({ ...selected, instance })
      ).toBe(before);
    }
    expect(generated[0]).not.toBe(generated[1]);
  } finally {
    for (const key of keys) {
      restoreEnv(key, saved[key]);
    }
  }
}, 60_000);

test("managed cleanup admits only the original canonical ordered labels, never arbitrary overrides", () => {
  const instance = {
    root: "/synthetic/linked",
    name: "owned-instance",
    marker: "row",
    sourceMode: "canonical-generated" as const,
  };
  const row = {
    id: "a".repeat(64),
    name: "/owned-instance-db-1",
    project: instance.name,
    nativeNames: [],
    service: "db",
    workingDir: join(instance.root, ".hack"),
    configFiles: managedAdoptionFixtureComposeFiles(instance.root).join(","),
    mounts: [
      {
        type: "volume",
        name: "owned-instance_data",
        target: "/var/lib/postgresql/data",
        rw: true,
      },
    ],
  };
  expect(
    ownedAdoptionFixtureObservation({ instance, kind: "container", row })
  ).toEqual({ id: row.id, service: "db" });
  for (const configFiles of [
    row.configFiles.split(",").reverse().join(","),
    `${row.configFiles},/arbitrary.yml`,
    join(instance.root, ".hack/docker-compose.yml"),
  ]) {
    expect(() =>
      ownedAdoptionFixtureObservation({
        instance,
        kind: "container",
        row: { ...row, configFiles },
      })
    ).toThrow("values omitted");
  }
  expect(() =>
    managedAdoptionFixtureEnvAssertion(
      { ...instance, name: "unsafe; exit 0" },
      "db"
    )
  ).toThrow("values omitted");
});

test("managed maintained scenario refuses uncompiled invocation before probes or effects", async () => {
  const previous = process.env.HACK_E2E_CLI_BIN;
  Reflect.deleteProperty(process.env, "HACK_E2E_CLI_BIN");
  let effects = 0;
  try {
    await expect(
      nativeComposeAdoptionManagedWorktreesScenario.run({
        repoRoot: "/synthetic/repo",
        tempRoot: "/synthetic/temp",
        hackHome: "/synthetic/home",
        cli: async () => {
          effects++;
          throw new Error("Unexpected effect");
        },
        skip: () => {
          throw new Error("Unexpected skip");
        },
        log: () => {},
        retainFixtures: () => {},
      })
    ).rejects.toThrow(
      "requires the current compiled CLI and companion compiler"
    );
    expect(effects).toBe(0);
  } finally {
    restoreEnv("HACK_E2E_CLI_BIN", previous);
  }
});
