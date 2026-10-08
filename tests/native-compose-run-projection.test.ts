import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type NativeComposeGeneration,
  NativeComposeGenerationError,
  type NativeComposeGenerationStore,
  type NativeComposeRunProjection,
  openNativeComposeGenerationStore,
} from "../src/lib/native-compose-generation.ts";
import { NativeComposeGenerationError as PrivateStateError } from "../src/lib/native-compose-private-state.ts";
import { renderNativeCompose } from "../src/lib/native-compose-renderer.ts";
import {
  assertNativeComposeOneOffUnexposed,
  nativeComposeRunSourceMatches,
  projectNativeComposeOneOff,
} from "../src/lib/native-compose-run-projection.ts";
import { composeFixture } from "./helpers/native-compose.ts";

const roots: string[] = [];
const stores: NativeComposeGenerationStore[] = [];
const REVISION = createHash("sha256").update("synthetic input").digest("hex");
const ID = "a".repeat(64);
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

function inputDocument() {
  return {
    name: "fixture",
    services: {
      web: {
        image: "fixture:1",
        entrypoint: ["synthetic"],
        command: ["original"],
        init: true,
        environment: { TOKEN: "private-synthetic-value" },
        depends_on: { db: { condition: "service_healthy" } },
        volumes: ["data:/state"],
        networks: ["default", "ingress"],
        labels: {
          caddy_0: "https://fixture.dev.test",
          "caddy_0.reverse_proxy": "{{upstreams http 3000}}",
          "caddy_0.tls": "internal",
          caddy_ingress_network: "hack-dev",
          "io.hack.native-config.owner": "b".repeat(32),
          "io.hack.native-config.generation": "c".repeat(32),
          "io.hack.native-config.workload": "service",
          "caddy-unrelated": "retained",
        },
      },
      db: { image: "fixture-db:1", labels: {}, networks: ["default"] },
    },
    volumes: { data: { name: "fixture-data" } },
    networks: { default: {}, ingress: { external: true, name: "hack-dev" } },
    "x-hack-native-routing": {
      version: 1,
      binding: {
        engineId: "fixture-engine:1",
        proxyId: "a".repeat(64),
        networkId: "b".repeat(64),
        proxyIp: "172.29.0.2",
      },
      hostnames: ["fixture.dev.test"],
      reference: {
        attemptId: "d".repeat(32),
        generationIdentity: "c".repeat(32),
        intent: { dev: 1, ino: 2, hash: "e".repeat(64) },
        reservation: { dev: 1, ino: 3, hash: "f".repeat(64) },
      },
      routes: [
        {
          service: "web",
          port: 3000,
          protocol: "http",
          hostnames: ["fixture.dev.test"],
          origins: ["https://fixture.dev.test"],
        },
      ],
      resolution: {
        domain: "dev.test",
        domain_origin: "project",
        project_origin: "https://fixture.dev.test",
        aliases: {},
        oauth_alias: null,
        open_preference: "auto",
        open_preference_origin: "default",
        open_origin: "https://fixture.dev.test",
        routes: {
          app: {
            service: "web",
            port: 3000,
            protocol: "http",
            origin: "https://fixture.dev.test",
            aliases: {},
          },
        },
      },
    },
  };
}

test("projection removes route keys only on the selected one-off and preserves all workload inputs", () => {
  const source = inputDocument();
  const before = JSON.stringify(source);
  const projected = projectNativeComposeOneOff({
    document: source,
    generationId: "c".repeat(32),
    service: "web",
  });
  const expected = structuredClone(source);
  const { "x-hack-native-routing": _metadata, ...withoutMetadata } = expected;
  const labels = Object.fromEntries(
    Object.entries(expected.services.web.labels).filter(
      ([key]) => !key.startsWith("caddy_")
    )
  );
  expect(projected).toEqual({
    ...withoutMetadata,
    services: {
      ...expected.services,
      web: { ...expected.services.web, labels },
    },
  });
  expect(JSON.stringify(source)).toBe(before);
  expect(Object.isFrozen(projected)).toBe(true);
  expect(
    Object.isFrozen(
      (projected.services as typeof source.services).web.environment
    )
  ).toBe(true);
  expect(() =>
    projectNativeComposeOneOff({
      document: source,
      generationId: "c".repeat(32),
      service: "constructor",
    })
  ).toThrow("values omitted");
});

test("source comparison rejects changed values, commands and source namespaces", () => {
  const saved = inputDocument();
  const options = { saved, generationId: "c".repeat(32) };
  expect(
    nativeComposeRunSourceMatches({
      ...options,
      rendered: Object.fromEntries(
        Object.entries(saved).filter(([key]) => key !== "x-hack-native-routing")
      ),
    })
  ).toBe(true);
  for (const modify of [
    (value: ReturnType<typeof inputDocument>) => {
      value.services.web.environment.TOKEN = "changed";
    },
    (value: ReturnType<typeof inputDocument>) => {
      value.services.web.command = ["changed"];
    },
    (value: ReturnType<typeof inputDocument>) => {
      value.services.db.image = "changed";
    },
    (value: ReturnType<typeof inputDocument>) => {
      value.services.web.labels.caddy_0 = "https://changed.test";
    },
  ]) {
    const rendered = structuredClone(saved);
    modify(rendered);
    const { "x-hack-native-routing": _metadata, ...withoutMetadata } = rendered;
    expect(
      nativeComposeRunSourceMatches({ ...options, rendered: withoutMetadata })
    ).toBe(false);
  }
});

test.each([
  { id: ID, routeLabels: [null], valid: true },
  { id: ID, routeLabels: ["caddy", null], valid: false },
  { id: ID, routeLabels: ["caddy.reverse_proxy", null], valid: false },
  { id: "b".repeat(64), routeLabels: [null], valid: false },
  { id: ID, routeLabels: [], valid: false },
])("actual one-off inspection is strict and rejects every surviving routing key ($valid)", async ({
  valid,
  ...reply
}) => {
  const probe = async (args: readonly string[]) => {
    expect(args.slice(0, 3)).toEqual(["container", "inspect", "--format"]);
    expect(args.at(-1)).toBe(ID);
    return JSON.stringify(reply);
  };
  const result = assertNativeComposeOneOffUnexposed({ id: ID, probe });
  if (valid) {
    await result;
  } else {
    await expect(result).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  }
});

test("one-off inspection refuses malformed replies without echoing private output", async () => {
  for (const reply of [
    "private-canary",
    JSON.stringify({ id: ID, routeLabels: [null], private: "private-canary" }),
  ]) {
    await expect(
      assertNativeComposeOneOffUnexposed({ id: ID, probe: async () => reply })
    ).rejects.toMatchObject({
      code: "E_CONFIG_INVALID",
      message: "Native Compose one-off projection is invalid; values omitted.",
    });
  }
});

async function generationFixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-run-projection-"))
  );
  roots.push(root);
  await mkdir(join(root, ".hack"));
  await writeFile(
    join(root, ".hack/hack.project.json"),
    JSON.stringify({ schema_version: 1, name: "fixture" })
  );
  const owner = await openNativeComposeGenerationStore({
    projectRoot: root,
    instance: null,
    mode: "prepare",
  });
  stores.push(owner);
  const generation = await owner.withMutation(async (mutation) => {
    const reservation = mutation.reserveGeneration();
    const rendered = renderNativeCompose({
      ...composeFixture(),
      projectRoot: root,
      runtimeIdentity: owner.identity.composeProject,
      generationIdentity: reservation.generationId,
      ownerToken: owner.identity.ownerToken,
    });
    const next = await mutation.publish({
      reservation,
      composeJson: JSON.stringify(rendered.document),
      profiles: [],
      inputRevision: REVISION,
      assertFresh: async () => {},
    });
    await mutation.runEffect({
      generation: next,
      operation: "up",
      assertFresh: async () => {},
      assertOwned: async () => {},
      effect: async () => ({ outcome: "complete", value: 0 }),
    });
    return next;
  });
  return { root, owner, generation };
}

function runOptions(
  generation: NativeComposeGeneration,
  projection: NativeComposeRunProjection
) {
  return {
    generation,
    projection,
    operation: "run" as const,
    assertFresh: async () => {},
    assertOwned: async () => {},
  };
}

test("projection publication is private and a known exit 17 preserves the original current generation", async () => {
  const { owner, generation } = await generationFixture();
  const original = await readFile(generation.composeFile, "utf8");
  await owner.withMutation(async (mutation) => {
    const projection = await mutation.publishRunProjection({
      generation,
      service: "web",
      assertFresh: async () => {},
    });
    expect((await lstat(projection.composeFile)).mode & 0o777).toBe(0o600);
    expect((await lstat(dirname(projection.composeFile))).mode & 0o777).toBe(
      0o700
    );
    const manifest = JSON.parse(
      await readFile(
        join(dirname(projection.composeFile), "manifest.json"),
        "utf8"
      )
    );
    expect(manifest).toMatchObject({
      generationId: generation.generationId,
      projectionId: projection.projectionId,
      service: "web",
      source: { generationId: generation.generationId },
    });
    const result = await mutation.runEffect({
      ...runOptions(generation, projection),
      effect: async () => ({ outcome: "complete", value: 17 }),
    });
    expect(result).toEqual({ outcome: "complete", value: 17 });
    expect(await readFile(generation.composeFile, "utf8")).toBe(original);
    expect((await owner.loadCurrent()).generation?.generationId).toBe(
      generation.generationId
    );
    expect((await owner.loadCurrent()).pending).toBeNull();
  });
});

test.each([
  "content",
  "replacement",
  "symlink",
  "hardlink",
  "permissions",
  "manifest",
] as const)("projection %s tampering refuses before engine effect or pending intent", async (kind) => {
  const { root, owner, generation } = await generationFixture();
  let effects = 0;
  await owner.withMutation(async (mutation) => {
    const projection = await mutation.publishRunProjection({
      generation,
      service: "web",
      assertFresh: async () => {},
    });
    const original = await readFile(projection.composeFile);
    if (kind === "content") {
      await writeFile(projection.composeFile, "{}");
    }
    if (kind === "permissions") {
      await chmod(projection.composeFile, 0o644);
    }
    if (kind === "manifest") {
      await writeFile(
        join(dirname(projection.composeFile), "manifest.json"),
        "{}"
      );
    }
    if (["replacement", "symlink", "hardlink"].includes(kind)) {
      const other = join(root, "replacement.json");
      await writeFile(other, original, { mode: 0o600 });
      await unlink(projection.composeFile);
      if (kind === "symlink") {
        await symlink(other, projection.composeFile);
      } else if (kind === "hardlink") {
        await link(other, projection.composeFile);
      } else {
        await writeFile(projection.composeFile, original, { mode: 0o600 });
      }
    }
    await expect(
      mutation.runEffect({
        ...runOptions(generation, projection),
        effect: async () => {
          effects++;
          return { outcome: "complete", value: 0 };
        },
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
  });
  expect(effects).toBe(0);
  expect((await owner.loadCurrent()).pending).toBeNull();
});

test("forged projection identity and wrong operation refuse without effects", async () => {
  const { owner, generation } = await generationFixture();
  await owner.withMutation(async (mutation) => {
    const projection = await mutation.publishRunProjection({
      generation,
      service: "web",
      assertFresh: async () => {},
    });
    const effect = async () => {
      throw new Error("must never execute");
    };
    await expect(
      mutation.runEffect({
        ...runOptions(generation, { ...projection }),
        effect,
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
    await expect(
      mutation.runEffect({
        ...runOptions(generation, projection),
        operation: "up",
        effect,
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
  });
  expect((await owner.loadCurrent()).pending).toBeNull();
});

test("read-only projection fence requires held mutation authority and exact known identity", async () => {
  const { owner, generation } = await generationFixture();
  const checks: (() => Promise<void>)[] = [];
  await owner.withMutation(async (mutation) => {
    const projection = await mutation.publishRunProjection({
      generation,
      service: "web",
      assertFresh: async () => {},
    });
    await mutation.assertRunProjection(projection);
    await expect(
      mutation.assertRunProjection({ ...projection })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
    checks.push(() => mutation.assertRunProjection(projection));
  });
  const expiredCheck = checks[0];
  if (!expiredCheck) {
    throw new Error("Held projection fence missing");
  }
  await expect(expiredCheck()).rejects.toMatchObject({
    code: "E_NATIVE_COMPOSE_STATE",
  });
  expect((await owner.loadCurrent()).pending).toBeNull();
});

test("delivery tampering during engine ownership observation refuses before intent and spawn", async () => {
  const { owner, generation } = await generationFixture();
  let effects = 0;
  await owner.withMutation(async (mutation) => {
    const projection = await mutation.publishRunProjection({
      generation,
      service: "web",
      assertFresh: async () => {},
    });
    await expect(
      mutation.runEffect({
        ...runOptions(generation, projection),
        assertOwned: async () => {
          await writeFile(projection.composeFile, "{}");
        },
        effect: async () => {
          effects++;
          return { outcome: "complete", value: 0 };
        },
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
  });
  expect(effects).toBe(0);
  expect((await owner.loadCurrent()).pending).toBeNull();
});

test("projection drift during execution retains private intent and owned stop uses the original generation", async () => {
  const { owner, generation } = await generationFixture();
  let projectionPath = "";
  await owner.withMutation(async (mutation) => {
    const projection = await mutation.publishRunProjection({
      generation,
      service: "web",
      assertFresh: async () => {},
    });
    projectionPath = projection.composeFile;
    await expect(
      mutation.runEffect({
        ...runOptions(generation, projection),
        effect: async () => {
          await writeFile(projection.composeFile, "{}");
          return { outcome: "complete", value: 0 };
        },
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_UNCERTAIN" });
  });
  const pending = (await owner.loadCurrent()).pending;
  expect(pending).toMatchObject({
    operation: "run",
    generationId: generation.generationId,
  });
  expect(JSON.stringify(pending)).not.toContain("manifestHash");
  await owner.withMutation(async (mutation) => {
    await mutation.runEffect({
      generation,
      operation: "down",
      recoverPending: true,
      assertOwned: async () => {},
      effect: async () => ({ outcome: "complete", value: 0 }),
    });
  });
  expect((await owner.loadCurrent()).stopped).toBe(true);
  expect((await owner.loadCurrent()).pending).toBeNull();
  expect(await readFile(projectionPath, "utf8")).toBe("{}");
  expect(await owner.readGenerationDocument(generation)).toHaveProperty(
    "volumes"
  );
});

test("stale projection publication runs no effect and leaves no uncertain intent", async () => {
  const { owner, generation } = await generationFixture();
  let freshness = 0;
  await owner.withMutation(async (mutation) => {
    await expect(
      mutation.publishRunProjection({
        generation,
        service: "web",
        assertFresh: async () => {
          if (++freshness > 1) {
            throw new Error("edited source");
          }
        },
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STALE" });
  });
  expect((await owner.loadCurrent()).pending).toBeNull();
});

test("saved document refusal preserves the shared private owner error class identity", async () => {
  const { owner, generation } = await generationFixture();
  expect(NativeComposeGenerationError).toBe(PrivateStateError);
  await chmod(generation.composeFile, 0o640);
  await expect(owner.readGenerationDocument(generation)).rejects.toBeInstanceOf(
    NativeComposeGenerationError
  );
});
