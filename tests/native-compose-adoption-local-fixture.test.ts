import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LegacyComposeAdoptionProjection } from "../src/lib/native-compose-adoption-projection.ts";
import { acquireLegacyAdoptionSourceInputs } from "../src/lib/native-config-import-inputs.ts";
import {
  addLinkedWorktree,
  commitAll,
  createMonorepoFixture,
} from "./e2e/fixture.ts";
import {
  prepareTypedLocalAdoptionFixtureSources,
  typedLocalAdoptionFixtureSourceSnapshot,
} from "./e2e/scenarios/native-compose-adoption-local-inputs.ts";
import {
  managedAdoptionFixtureSourceSnapshot,
  prepareManagedAdoptionFixtureSources,
} from "./e2e/scenarios/native-compose-adoption-managed-inputs.ts";
import { nativeComposeAdoptionLocalWorktreesScenario } from "./e2e/scenarios/native-compose-adoption-worktrees.ts";
import { restoreEnv } from "./helpers/env.ts";
import { managedEnvCompilerFixture } from "./helpers/managed-env-compiler.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const tempRoot = await realpath(
    await mkdtemp(join(tmpdir(), "typed-local-adoption-fixture-"))
  );
  roots.push(tempRoot);
  const hackHome = join(tempRoot, "home");
  await mkdir(hackHome, { mode: 0o700 });
  const base = await createMonorepoFixture({
    parentDir: tempRoot,
    withHackConfig: false,
  });
  const primary = { root: base.root, name: `${base.name}-main` };
  async function write(checkout: { root: string; name: string }) {
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
      message: "fixture: exact typed local original sources",
    });
  }
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

test("typed-local fixture preserves real legacy generated writer bytes and both privately qualified selections", async () => {
  const selected = await fixture();
  const keys = [
    "HOME",
    "HACK_HOME",
    "CI",
    "HACK_EXECUTION_MODE",
    "HACK_ENV_SECRET_KEY",
  ] as const;
  const previous = Object.fromEntries(
    keys.map((key) => [key, process.env[key]])
  );
  process.env.HOME = join(selected.tempRoot, "private-outer-home");
  process.env.HACK_HOME = selected.hackHome;
  Reflect.deleteProperty(process.env, "CI");
  Reflect.deleteProperty(process.env, "HACK_EXECUTION_MODE");
  Reflect.deleteProperty(process.env, "HACK_ENV_SECRET_KEY");
  try {
    await prepareManagedAdoptionFixtureSources(selected);
    const before = await Promise.all(
      selected.instances.map((instance) =>
        managedAdoptionFixtureSourceSnapshot({
          primary: selected.primary,
          instance,
        })
      )
    );
    await prepareTypedLocalAdoptionFixtureSources(selected);
    expect(
      await Promise.all(
        selected.instances.map((instance) =>
          managedAdoptionFixtureSourceSnapshot({
            primary: selected.primary,
            instance,
          })
        )
      )
    ).toEqual(before);
    const binary = await managedEnvCompilerFixture(
      join(selected.tempRoot, "compiler")
    );
    const locals: string[] = [];
    for (const instance of selected.instances) {
      locals.push(
        await typedLocalAdoptionFixtureSourceSnapshot({
          primary: selected.primary,
          instance,
        })
      );
      const source = await acquireLegacyAdoptionSourceInputs({
        projectRoot: instance.root,
        allowLinkedWorktree: true,
      });
      const projection = await LegacyComposeAdoptionProjection.acquire({
        source,
        binary,
      });
      const resolved = await projection.resolve();
      expect(resolved.projectionProof.projection_version).toBe(2);
      expect(resolved.metadata.overlay).toBe("qa");
      expect(
        new Set(projection.report.local_fields?.map((field) => field.document))
      ).toEqual(new Set(["primary_local", "checkout_local"]));
      expect(JSON.stringify(projection.report)).not.toContain("shadowed");
      expect(JSON.stringify(projection.report)).not.toContain(
        resolved.projectionProof.localInputs?.primary?.hash ?? "missing"
      );
      expect(JSON.stringify(resolved)).toBe("{}");
    }
    expect(
      await Promise.all(
        selected.instances.map((instance) =>
          typedLocalAdoptionFixtureSourceSnapshot({
            primary: selected.primary,
            instance,
          })
        )
      )
    ).toEqual(locals);
    expect(
      await Promise.all(
        selected.instances.map((instance) =>
          managedAdoptionFixtureSourceSnapshot({
            primary: selected.primary,
            instance,
          })
        )
      )
    ).toEqual(before);
  } finally {
    for (const key of keys) {
      restoreEnv(key, previous[key]);
    }
  }
}, 60_000);

test("typed-local fixture oracle detects raw edits, inode replacement and unsafe ownership modes", async () => {
  const selected = await fixture();
  await prepareTypedLocalAdoptionFixtureSources(selected);
  const instance = selected.instances[0];
  if (!instance) {
    throw new Error("Expected fixture checkout");
  }
  const opts = { primary: selected.primary, instance };
  const original = await typedLocalAdoptionFixtureSourceSnapshot(opts);
  const path = join(selected.primary.root, ".hack/hack.local.json");
  const bytes = await readFile(path);
  await writeFile(path, Buffer.concat([bytes, Buffer.from("\n")]));
  expect(await typedLocalAdoptionFixtureSourceSnapshot(opts)).not.toBe(
    original
  );
  await writeFile(path, bytes);
  expect(await typedLocalAdoptionFixtureSourceSnapshot(opts)).toBe(original);
  await chmod(path, 0o666);
  await expect(typedLocalAdoptionFixtureSourceSnapshot(opts)).rejects.toThrow(
    "values omitted"
  );
  await chmod(path, 0o600);
  await rename(path, `${path}.retained-original`);
  await writeFile(path, bytes, { mode: 0o600 });
  expect(await typedLocalAdoptionFixtureSourceSnapshot(opts)).not.toBe(
    original
  );
});

test("registered typed-local maintained scenario refuses source invocation before probes or effects", async () => {
  const previous = process.env.HACK_E2E_CLI_BIN;
  Reflect.deleteProperty(process.env, "HACK_E2E_CLI_BIN");
  let effects = 0;
  try {
    await expect(
      nativeComposeAdoptionLocalWorktreesScenario.run({
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
    expect(nativeComposeAdoptionLocalWorktreesScenario.name).toBe(
      "native-compose-adoption-local-worktrees"
    );
    expect(
      nativeComposeAdoptionLocalWorktreesScenario.preserveFixtureOnFailure
    ).toBe(true);
  } finally {
    restoreEnv("HACK_E2E_CLI_BIN", previous);
  }
});
