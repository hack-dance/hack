import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveModernComposeEnvOverrides,
  resolveRuntimeHostMetadataOverride,
} from "../src/commands/project.ts";
import { PROJECT_ENV_KEY_FILENAME } from "../src/constants.ts";
import { renderManagedComposeEnvOverride } from "../src/lib/compose-managed-env.ts";
import {
  hasLegacyComposeGeneratedSources,
  LegacyComposeAdoptionProjection,
  readSavedLegacyComposeAdoptionProjection,
} from "../src/lib/native-compose-adoption-projection.ts";
import {
  compileNativeConfig,
  planNativeConfig,
} from "../src/lib/native-config-compiler.ts";
import { acquireNativeConfigImportInputs } from "../src/lib/native-config-import-inputs.ts";
import {
  defaultProjectSlugFromPath,
  findProjectContextAtRoot,
} from "../src/lib/project.ts";
import {
  resolveProjectEnvConfig,
  setProjectEnvValue,
} from "../src/lib/project-env-config.ts";
import { buildRuntimeHostMetadataOverride } from "../src/lib/runtime-host-metadata.ts";
import { restoreEnv } from "./helpers/env.ts";
import { managedEnvCompilerFixture } from "./helpers/managed-env-compiler.ts";

const CANARY = "synthetic-projection-private-value";
const KEYS = ["CI", "HACK_EXECUTION_MODE", "HACK_ENV_SECRET_KEY"] as const;
let root: string;
let saved: Record<string, string | undefined>;
let compose: string;
beforeEach(async () => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) {
    Reflect.deleteProperty(process.env, key);
  }
  root = await realpath(await mkdtemp(join(tmpdir(), "adoption-projection-")));
  await mkdir(join(root, ".hack/.internal"), { recursive: true });
  await writeFile(
    join(root, ".hack/hack.config.json"),
    JSON.stringify({ name: "fixture", env: { default_overlay: "qa" } })
  );
  compose = JSON.stringify({
    name: "fixture",
    services: {
      worker: {
        image: "alpine:3.22",
        environment: { HACK_SERVICE_NAME: "authored" },
        volumes: ["data:/data:ro"],
      },
      web: { image: "alpine:3.22", volumes: ["data:/data"] },
    },
    volumes: { data: {} },
  });
  await writeFile(join(root, ".hack/docker-compose.yml"), compose);
});
afterEach(async () => {
  for (const key of KEYS) {
    restoreEnv(key, saved[key]);
  }
  await rm(root, { force: true, recursive: true });
});
async function source() {
  return await acquireNativeConfigImportInputs({ projectRoot: root });
}
async function layer(value = CANARY) {
  await writeFile(
    join(root, ".hack/hack.env.default.yaml"),
    JSON.stringify({
      version: 1,
      environment: "default",
      secretsprovider: "project_key",
      values: { global: { PRIVATE: value, EMPTY: "" } },
    })
  );
}
/** Synthetic raw-input fixture uses the same pure projections as the real writer; it performs no engine effects. */
async function generated(value = CANARY) {
  const env = renderManagedComposeEnvOverride({
    targetServices: ["web", "worker"],
    globalEnv: { PRIVATE: value, EMPTY: "" },
    serviceEnv: {
      web: { PRIVATE: value, EMPTY: "" },
      worker: { PRIVATE: value, EMPTY: "" },
    },
  });
  const runtime = buildRuntimeHostMetadataOverride({
    composeYamls: [compose],
    branch: null,
    devHost: `${defaultProjectSlugFromPath(root)}.hack`,
    aliasHost: null,
    composeProject: "fixture",
  });
  if (!(env && runtime)) {
    throw new Error("Fixture projections unexpectedly missing");
  }
  await writeFile(
    join(root, ".hack/.internal/compose.runtime.override.yml"),
    runtime
  );
  await writeFile(join(root, ".hack/.internal/compose.env.override.yml"), env);
}
async function refuses(run: () => Promise<unknown>) {
  let error: unknown;
  try {
    await run();
  } catch (caught: unknown) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) {
    throw new Error("Expected projection refusal");
  }
  expect(error.message).toContain("values omitted");
  expect(error.message).not.toContain(CANARY);
  expect(error.message).not.toContain(root);
  expect(error.cause).toBeUndefined();
}

test("absent generated directory remains an ordinary static source, while a symlink refuses", async () => {
  const directory = join(root, ".hack/.internal");
  await rm(directory, { recursive: true });
  expect(await hasLegacyComposeGeneratedSources(root)).toBe(false);
  await symlink(root, directory);
  await expect(hasLegacyComposeGeneratedSources(root)).rejects.toThrow(
    "values omitted"
  );
});

test("real canonical legacy writers produce exactly the privately qualified fragments", async () => {
  await layer();
  await generated();
  const envPath = join(root, ".hack/.internal/compose.env.override.yml");
  const runtimePath = join(
    root,
    ".hack/.internal/compose.runtime.override.yml"
  );
  const expectedEnv = await readFile(envPath, "utf8");
  const expectedRuntime = await readFile(runtimePath, "utf8");
  await rm(envPath);
  await rm(runtimePath);
  const project = await findProjectContextAtRoot({
    projectRoot: root,
    projectDirName: ".hack",
  });
  if (!project) {
    throw new Error("Expected real canonical fixture context");
  }
  const runtime = await resolveRuntimeHostMetadataOverride({
    project,
    composeFiles: [project.composeFile],
    branch: null,
    devHost: `${defaultProjectSlugFromPath(root)}.hack`,
    aliasHost: null,
    composeProject: "fixture",
  });
  const env = await resolveModernComposeEnvOverrides({
    project,
    targetServices: ["web", "worker"],
    allServiceNames: ["web", "worker"],
  });
  expect(runtime).toBe(runtimePath);
  expect(env?.composeFiles).toEqual([envPath]);
  expect(await readFile(runtimePath, "utf8")).toBe(expectedRuntime);
  expect(await readFile(envPath, "utf8")).toBe(expectedEnv);
  const projection = await LegacyComposeAdoptionProjection.acquire({
    source: await source(),
  });
  expect(JSON.stringify(await projection.resolve())).toBe("{}");
});

test("projection binds exact ordered generated bytes and keeps managed values outside candidate/report", async () => {
  await layer();
  await generated();
  const projection = await LegacyComposeAdoptionProjection.acquire({
    source: await source(),
  });
  expect(JSON.stringify(projection)).toBe("{}");
  expect(JSON.stringify(projection.report)).not.toContain(CANARY);
  expect(JSON.stringify(projection.report)).not.toContain(root);
  expect(projection.report.files).toEqual([
    "docker-compose.yml",
    ".internal/compose.runtime.override.yml",
    ".internal/compose.env.override.yml",
  ]);
  const resolved = await projection.resolve();
  expect(JSON.stringify(resolved)).toBe("{}");
  expect(JSON.stringify(resolved.candidate)).not.toContain(CANARY);
  expect(resolved.globalEnv).toEqual({ PRIVATE: CANARY, EMPTY: "" });
  expect(resolved.composeFiles).toEqual([
    join(root, ".hack/docker-compose.yml"),
    join(root, ".hack/.internal/compose.runtime.override.yml"),
    join(root, ".hack/.internal/compose.env.override.yml"),
  ]);
  const legacy = await resolveProjectEnvConfig({
    projectRoot: root,
    projectDir: join(root, ".hack"),
    serviceNames: ["web", "worker"],
  });
  if (!legacy) {
    throw new Error("Expected synthetic legacy managed selection");
  }
  const legacyText = renderManagedComposeEnvOverride({
    targetServices: ["web", "worker"],
    globalEnv: legacy.globalEnv,
    serviceEnv: legacy.serviceEnv,
  });
  if (legacyText === null) {
    throw new Error("Expected synthetic legacy generated bytes");
  }
  expect(await readFile(resolved.composeFiles[2] ?? "", "utf8")).toBe(
    legacyText
  );
  const compiler = await managedEnvCompilerFixture(join(root, "compiler"));
  const input = new TextEncoder().encode(JSON.stringify(resolved.candidate));
  const compiled = await compileNativeConfig({ input, binary: compiler });
  expect(compiled.ok).toBe(true);
  const planned = await planNativeConfig({
    input,
    binary: compiler,
    envMetadata: {
      metadata_version: 1,
      overlay: resolved.metadata.overlay,
      overlay_exists: resolved.metadata.overlayExists,
      workloads: Object.fromEntries(
        ["worker", "web"].map((name) => [
          name,
          resolved.metadata.effectiveMetadata[name] ?? {},
        ])
      ),
      inactive_scopes: [],
    },
  });
  expect(planned.ok).toBe(true);
});

test.each([
  "added",
  "removed",
  "whitespace",
  "replaced",
  "symlink",
])("generated %s drift refuses before private delivery", async (kind) => {
  await layer();
  await generated();
  const path = join(root, ".hack/.internal/compose.env.override.yml");
  if (kind === "added") {
    await rm(path);
  }
  const projection = await LegacyComposeAdoptionProjection.acquire({
    source: await source(),
  });
  const original = kind === "added" ? "" : await readFile(path, "utf8");
  if (kind === "removed") {
    await rm(path);
  } else if (kind === "replaced") {
    await rm(path);
    await writeFile(path, original);
  } else if (kind === "symlink") {
    await rm(path);
    await symlink(join(root, ".hack/docker-compose.yml"), path);
  } else {
    await writeFile(path, `${original}\n`);
  }
  await refuses(() => projection.resolve());
});

test("missing or stale generated env provenance cannot silently drop managed values", async () => {
  await layer();
  const projection = await LegacyComposeAdoptionProjection.acquire({
    source: await source(),
  });
  await refuses(() => projection.resolve());
  await generated("unrelated-private-value");
  const stale = await LegacyComposeAdoptionProjection.acquire({
    source: await source(),
  });
  await refuses(() => stale.resolve());
});

test("metadata/freshness need no key and private secret fidelity uses the existing key owner", async () => {
  await writeFile(join(root, PROJECT_ENV_KEY_FILENAME), "synthetic-key");
  await setProjectEnvValue({
    projectRoot: root,
    projectDir: join(root, ".hack"),
    envName: null,
    scope: "global",
    key: "PRIVATE",
    value: CANARY,
    secret: true,
  });
  const text = renderManagedComposeEnvOverride({
    targetServices: ["web", "worker"],
    globalEnv: { PRIVATE: CANARY },
    serviceEnv: {
      web: { PRIVATE: CANARY },
      worker: { PRIVATE: CANARY },
    },
  });
  if (text === null) {
    throw new Error("Fixture projection missing");
  }
  await writeFile(join(root, ".hack/.internal/compose.env.override.yml"), text);
  await rm(join(root, PROJECT_ENV_KEY_FILENAME));
  await mkdir(join(root, PROJECT_ENV_KEY_FILENAME));
  const projection = await LegacyComposeAdoptionProjection.acquire({
    source: await source(),
  });
  await projection.assertFresh();
  expect(JSON.stringify(projection.report)).not.toContain(CANARY);
  await refuses(() => projection.resolve());
  await rm(join(root, PROJECT_ENV_KEY_FILENAME), { recursive: true });
  await writeFile(join(root, PROJECT_ENV_KEY_FILENAME), "synthetic-key");
  expect((await projection.resolve()).globalEnv.PRIVATE).toBe(CANARY);
});

test("generated interpolation remains an explicit refusal, never a guessed expansion source", async () => {
  await layer("$UNBOUND_PRIVATE_SOURCE");
  await generated("$UNBOUND_PRIVATE_SOURCE");
  const projection = await LegacyComposeAdoptionProjection.acquire({
    source: await source(),
  });
  await refuses(() => projection.resolve());
});

test("caller option mutation and replacement signals cannot alter captured source admission", async () => {
  await layer();
  await generated();
  const controller = new AbortController();
  const opts = { source: await source(), signal: controller.signal };
  const pending = LegacyComposeAdoptionProjection.acquire(opts);
  opts.source = { ok: false, code: "changed" };
  const projection = await pending;
  expect((await projection.resolve()).globalEnv.PRIVATE).toBe(CANARY);
  controller.abort(CANARY);
  await refuses(() =>
    projection.resolve({ signal: new AbortController().signal })
  );
});

test("saved raw proof preserves metadata and ordered files without authored or key delivery", async () => {
  await layer();
  await generated();
  const captured = await source();
  if (!captured.ok) {
    throw new Error("Expected synthetic source");
  }
  const projection = await LegacyComposeAdoptionProjection.acquire({
    source: captured,
  });
  const resolved = await projection.resolve();
  const proof = structuredClone(resolved.projectionProof);
  expect(JSON.stringify(resolved)).not.toContain(proof.managedRevision);
  await rm(join(root, ".hack/hack.config.json"));
  await rm(join(root, ".hack/docker-compose.yml"));
  await mkdir(join(root, PROJECT_ENV_KEY_FILENAME));
  const read = () =>
    readSavedLegacyComposeAdoptionProjection({
      projectRoot: root,
      configText: captured.configText,
      composeText: captured.composeText,
      proof,
      checkOwner: async () => {},
    });
  const savedInputs = await read();
  expect(JSON.stringify(savedInputs)).toBe("{}");
  expect(savedInputs.candidate).toEqual(resolved.candidate);
  expect(savedInputs.metadata).toEqual(resolved.metadata);
  expect(savedInputs.composeFiles).toEqual([...resolved.composeFiles]);
  const path = join(root, ".hack/hack.env.default.yaml");
  await writeFile(path, `${await readFile(path, "utf8")}\n`);
  await refuses(read);
});

test.each([
  "compose.override.yml",
  "compose.cache.override.yml",
  "branch",
])("unqualified generated %s authority refuses", async (name) => {
  await layer();
  await generated();
  if (name === "branch") {
    await mkdir(join(root, ".hack/.branch"));
  } else {
    await writeFile(join(root, ".hack/.internal", name), "services: {}\n");
  }
  await refuses(
    async () =>
      await LegacyComposeAdoptionProjection.acquire({ source: await source() })
  );
});
