import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { YAML } from "bun";
import { PROJECT_ENV_KEY_FILENAME } from "../src/constants.ts";
import { isRecord } from "../src/lib/guards.ts";
import {
  acquireNativeComposeFileDeliveryInputs,
  acquireNativeComposeFileSources,
  assertNativeComposeFileSources,
  closeNativeComposeFileSources,
  type NativeComposeFileSources,
  withNativeComposeFileBytes,
} from "../src/lib/native-compose-file-sources.ts";
import {
  type NativeComposeGenerationStore,
  openNativeComposeGenerationStore,
} from "../src/lib/native-compose-generation.ts";
import {
  acquireNativeComposeFilePlanningInputs,
  type NativeComposeExecutionInputs,
} from "../src/lib/native-compose-inputs.ts";
import { setProjectEnvValue } from "../src/lib/project-env-config.ts";
import { resolveVerifiedPrimaryWorktreeRoot } from "../src/lib/worktree-local-config.ts";
import { restoreEnv } from "./helpers/env.ts";

const KEYS = [
  "CI",
  "HACK_EXECUTION_MODE",
  "HACK_HOME",
  "HACK_GLOBAL_CONFIG_PATH",
  "HACK_CONFIG_COMPILER_BINARY",
  "HACK_ENV_SECRET_KEY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
] as const;
const compiler = resolve(
  process.env.HACK_CONFIG_COMPILER_BINARY ?? "dist/hack-config-compiler"
);
const CANARY = "synthetic-private-file-value-$-no-newline";
const binary = Buffer.from([0, 255, 4, 10]);
let parent = "";
let root = "";
let store: NativeComposeGenerationStore;
const sources: NativeComposeFileSources[] = [];
let saved: Record<string, string | undefined> = {};
const SOURCE = {
  schema_version: 1,
  name: "fixture",
  worktree: { auto_branch: false, inherit_local: true },
  configs: { settings: { file: "inputs/settings.bin" } },
  secrets: {
    token: { env_ref: "TOKEN" },
    empty: { env_ref: "EMPTY" },
    file: { file: "inputs/secret" },
  },
  services: {
    reader: {
      image: "fixture:1",
      environment: { TOKEN: { unset: true } },
      mounts: [
        { config: "settings", target: "/etc/settings", access: "read-only" },
        { secret: "token", target: "/run/token", access: "read-only" },
        { secret: "empty", target: "/run/empty", access: "read-only" },
        { secret: "file", target: "/run/file", access: "read-only" },
      ],
    },
  },
};
beforeEach(async () => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) {
    Reflect.deleteProperty(process.env, key);
  }
  parent = await realpath(
    await mkdtemp(join(tmpdir(), "native-file-sources-"))
  );
  root = join(parent, "checkout");
  await mkdir(join(root, ".hack"), { recursive: true });
  await mkdir(join(root, "inputs"));
  await writeFile(
    join(root, ".hack/hack.project.json"),
    JSON.stringify(SOURCE)
  );
  await writeFile(
    join(root, ".hack/hack.env.default.yaml"),
    `version: 1\nenvironment: default\nsecretsprovider: project_key\nvalues:\n  global:\n    TOKEN: ${CANARY}\n    EMPTY: ""\n`
  );
  await writeFile(join(root, "inputs/settings.bin"), binary);
  await writeFile(join(root, "inputs/secret"), Buffer.from([8, 0, 9]), {
    mode: 0o600,
  });
  process.env.HACK_HOME = join(parent, "home");
  process.env.HACK_CONFIG_COMPILER_BINARY = compiler;
  store = await openNativeComposeGenerationStore({
    projectRoot: root,
    instance: null,
  });
});
afterEach(async () => {
  await Promise.all(sources.splice(0).map(closeNativeComposeFileSources));
  await store.close();
  for (const key of KEYS) {
    restoreEnv(key, saved[key]);
  }
  await rm(parent, { recursive: true, force: true });
});
async function acquired(
  opts: Parameters<typeof acquireNativeComposeFileSources>[0]
) {
  const result = await acquireNativeComposeFileSources(opts);
  sources.push(result);
  return result;
}
test("actual compiler plus managed owner acquires exact binary/empty bytes and separate unset baseline without public values", async () => {
  const previousToken = process.env.TOKEN;
  process.env.TOKEN = "caller-env-must-not-authorize";
  try {
    await store.withMutation(async (mutation) => {
      const reservation = mutation.reserveGeneration();
      const sources = await acquired({
        authority: mutation.materialAuthority,
        reservation,
      });
      expect(
        sources.result.environment_plan.workloads.reader
      ).not.toHaveProperty("TOKEN");
      expect(sources.result.file_plan?.workloads.reader?.[1]?.source).toEqual({
        kind: "managed",
        key: "TOKEN",
        scope: "global",
        secret: false,
      });
      const serialized = JSON.stringify(sources);
      expect(serialized).not.toContain(CANARY);
      expect(serialized).not.toContain(parent);
      let delivered: Uint8Array | undefined;
      await withNativeComposeFileBytes({
        sources,
        authority: mutation.materialAuthority,
        reservation,
        run: async (members) => {
          expect(members.map((member) => Buffer.from(member.bytes))).toEqual([
            binary,
            Buffer.from(CANARY),
            Buffer.alloc(0),
            Buffer.from([8, 0, 9]),
          ]);
          delivered = members[0]?.bytes;
        },
      });
      expect(delivered).toEqual(Buffer.alloc(binary.length));
      await expect(
        withNativeComposeFileBytes({
          sources: { ...sources },
          authority: mutation.materialAuthority,
          reservation,
          run: async () => {},
        })
      ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
    });
  } finally {
    restoreEnv("TOKEN", previousToken);
  }
});
test("selection options and the profiles array are captured before async authority admission", async () => {
  await writeFile(
    join(root, ".hack/hack.project.json"),
    JSON.stringify({ ...SOURCE, profiles: ["debug", "other"] })
  );
  await writeFile(
    join(root, ".hack/hack.env.qa.yaml"),
    JSON.stringify({
      version: 1,
      environment: "qa",
      secretsprovider: "project_key",
      values: {},
    })
  );
  await store.withMutation(async (mutation) => {
    const profiles = ["debug"];
    const options = {
      authority: mutation.materialAuthority,
      reservation: mutation.reserveGeneration(),
      profiles,
      explicitOverlay: "qa",
      explicitDomain: "selected.test",
    };
    const pending = acquired(options);
    profiles[0] = "other";
    options.profiles = ["other"];
    options.explicitOverlay = "default";
    options.explicitDomain = "changed.test";
    const selected = await pending;
    expect(selected.result.plan.selected_profiles).toEqual(["debug"]);
    expect(selected.result.local_resolution.overlay).toBe("qa");
    expect(selected.result.routing_resolution?.domain).toBe("selected.test");
    await assertNativeComposeFileSources({
      sources: selected,
      authority: options.authority,
      reservation: options.reservation,
    });
  });
});
test("symbolic file planning reads no file bytes; actual file and env delivery share the acquired owner and revoke together", async () => {
  let delivery: NativeComposeExecutionInputs | undefined;
  await store.withMutation(async (mutation) => {
    const reservation = mutation.reserveGeneration();
    const selected = await acquired({
      authority: mutation.materialAuthority,
      reservation,
    });
    delivery = await acquireNativeComposeFileDeliveryInputs({
      sources: selected,
      authority: mutation.materialAuthority,
      reservation,
    });
    expect(Object.keys(delivery)).toEqual(["result"]);
    expect(JSON.stringify(delivery)).not.toContain(CANARY);
    expect(JSON.stringify(delivery)).not.toContain(parent);
    expect((await delivery.resolveManagedValues()).reader?.TOKEN).toBe(CANARY);
    expect(
      delivery.result.environment_plan.workloads.reader
    ).not.toHaveProperty("TOKEN");
    await expect(
      acquireNativeComposeFileDeliveryInputs({
        sources: { ...selected },
        authority: mutation.materialAuthority,
        reservation,
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
  });
  if (!delivery) {
    throw new Error("missing private delivery fixture");
  }
  await expect(delivery.resolveManagedValues()).rejects.toMatchObject({
    code: "E_NATIVE_COMPOSE_STATE",
  });
  await unlink(join(root, "inputs/settings.bin"));
  await unlink(join(root, "inputs/secret"));
  const symbolic = await acquireNativeComposeFilePlanningInputs({
    projectRoot: root,
  });
  expect(symbolic.result.file_plan?.complete).toBe(true);
  await symbolic.assertFresh();
});
test.each([
  "leaf",
  "parent",
  "content",
  "mode",
  "authored",
  "env",
] as const)("%s drift invalidates existing private acquisition", async (kind) => {
  await store.withMutation(async (mutation) => {
    const reservation = mutation.reserveGeneration();
    const sources = await acquired({
      authority: mutation.materialAuthority,
      reservation,
    });
    if (kind === "leaf") {
      await rename(
        join(root, "inputs/settings.bin"),
        join(root, "inputs/original")
      );
      await writeFile(join(root, "inputs/settings.bin"), binary);
    } else if (kind === "parent") {
      await rename(join(root, "inputs"), join(root, "original-inputs"));
      await mkdir(join(root, "inputs"));
      await writeFile(join(root, "inputs/settings.bin"), binary);
    } else if (kind === "content") {
      await writeFile(
        join(root, "inputs/settings.bin"),
        Buffer.from([4, 3, 2, 1])
      );
    } else if (kind === "mode") {
      await chmod(join(root, "inputs/secret"), 0o644);
    } else if (kind === "authored") {
      await writeFile(
        join(root, ".hack/hack.project.json"),
        `${JSON.stringify(SOURCE)}\n`
      );
    } else {
      await writeFile(
        join(root, ".hack/hack.env.default.yaml"),
        "version: 1\nvalues: {}\n"
      );
    }
    await expect(
      assertNativeComposeFileSources({
        sources,
        authority: mutation.materialAuthority,
        reservation,
      })
    ).rejects.toThrow();
  });
});
test.each([
  "symlink-leaf",
  "symlink-parent",
  "hardlink",
  "world-write",
  "missing",
  "oversized",
] as const)("%s refuses without creating source material", async (kind) => {
  if (kind === "symlink-parent") {
    await rename(join(root, "inputs"), join(root, "original"));
    await symlink(join(root, "original"), join(root, "inputs"));
  } else if (kind === "world-write") {
    await chmod(join(root, "inputs/settings.bin"), 0o666);
  } else if (kind === "oversized") {
    await writeFile(
      join(root, "inputs/settings.bin"),
      Buffer.alloc(1024 * 1024 + 1)
    );
  } else {
    await unlink(join(root, "inputs/settings.bin"));
    if (kind === "symlink-leaf") {
      await symlink(
        join(root, "inputs/secret"),
        join(root, "inputs/settings.bin")
      );
    } else if (kind === "hardlink") {
      await link(
        join(root, "inputs/secret"),
        join(root, "inputs/settings.bin")
      );
    }
  }
  await store.withMutation(async (mutation) => {
    await expect(
      acquired({
        authority: mutation.materialAuthority,
        reservation: mutation.reserveGeneration(),
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
  });
});
test.each([
  "uid",
  "mode",
  "access",
  "inactive-build",
] as const)("unsupported %s refuses before managed store read or file read", async (kind) => {
  const source = structuredClone(SOURCE);
  const mount = source.services.reader.mounts[0];
  if (!mount) {
    throw new Error("missing fixture grant");
  }
  const raw = JSON.parse(JSON.stringify(source));
  if (kind === "inactive-build") {
    raw.profiles = ["inactive"];
    raw.services.off = { build: { context: "." }, profiles: ["inactive"] };
  } else {
    raw.services.reader.mounts[0][kind] =
      kind === "uid" ? 0xff_ff_ff_ff : kind === "mode" ? "0640" : "read-write";
  }
  await writeFile(join(root, ".hack/hack.project.json"), JSON.stringify(raw));
  await writeFile(join(root, ".hack/hack.env.json"), CANARY);
  await unlink(join(root, "inputs/settings.bin"));
  await store.withMutation(async (mutation) => {
    const error = await acquired({
      authority: mutation.materialAuthority,
      reservation: mutation.reserveGeneration(),
    }).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "E_NATIVE_PROJECT_UNSUPPORTED" });
    expect(String(error)).not.toContain(CANARY);
  });
});
test.each([
  { uid: 0, gid: 0, mode: "0400" },
  { uid: 10_001, gid: 10_002, mode: "0600" },
] as const)("numeric ownership with protected $mode acquires through the current material lease", async (policy) => {
  const source = structuredClone(SOURCE);
  const mount = source.services.reader.mounts[0];
  if (!mount) {
    throw new Error("missing fixture grant");
  }
  Object.assign(mount, policy);
  await writeFile(
    join(root, ".hack/hack.project.json"),
    JSON.stringify(source)
  );
  await store.withMutation(async (mutation) => {
    const reservation = mutation.reserveGeneration();
    const sources = await acquired({
      authority: mutation.materialAuthority,
      reservation,
    });
    expect(sources.result.file_plan?.workloads.reader?.[0]).toMatchObject(
      policy
    );
    await withNativeComposeFileBytes({
      sources,
      authority: mutation.materialAuthority,
      reservation,
      run: async (members) => {
        expect(members[0]?.binding).toMatchObject(policy);
        expect(Buffer.from(members[0]?.bytes ?? [])).toEqual(binary);
      },
    });
  });
});
test("closed mutation and revoked acquisition cannot deliver previously acquired bytes", async () => {
  let selected: Parameters<typeof withNativeComposeFileBytes>[0] | undefined;
  await store.withMutation(async (mutation) => {
    const reservation = mutation.reserveGeneration();
    const sources = await acquired({
      authority: mutation.materialAuthority,
      reservation,
    });
    selected = {
      sources,
      authority: mutation.materialAuthority,
      reservation,
      run: async () => {
        throw new Error("must not deliver");
      },
    };
  });
  if (!selected) {
    throw new Error("missing fixture capability");
  }
  await expect(withNativeComposeFileBytes(selected)).rejects.toMatchObject({
    code: "E_NATIVE_COMPOSE_STATE",
  });
});

test("managed secret file decrypts only through the existing project key owner, with overlay scope and tombstone refusal", async () => {
  const key = "synthetic-private-file-key-never-real-credentials";
  const fixture = join(parent, "cipher-fixture");
  await mkdir(join(fixture, ".hack"), { recursive: true });
  await writeFile(join(fixture, PROJECT_ENV_KEY_FILENAME), key, {
    mode: 0o600,
  });
  await setProjectEnvValue({
    projectRoot: fixture,
    projectDir: join(fixture, ".hack"),
    envName: null,
    scope: "global",
    key: "TOKEN",
    value: CANARY,
    secret: true,
  });
  const encrypted: unknown = YAML.parse(
    await readFile(join(fixture, ".hack/hack.env.default.yaml"), "utf8")
  );
  if (
    !(
      isRecord(encrypted) &&
      isRecord(encrypted.values) &&
      isRecord(encrypted.values.global) &&
      isRecord(encrypted.values.global.TOKEN)
    )
  ) {
    throw new Error("invalid synthetic cipher fixture");
  }
  await writeFile(join(root, PROJECT_ENV_KEY_FILENAME), key, { mode: 0o600 });
  const header = {
    version: 1,
    environment: "qa",
    secretsprovider: "project_key",
  };
  await writeFile(
    join(root, ".hack/hack.env.qa.yaml"),
    JSON.stringify({
      ...header,
      values: { reader: { TOKEN: encrypted.values.global.TOKEN } },
    })
  );
  await store.withMutation(async (mutation) => {
    const reservation = mutation.reserveGeneration();
    const sources = await acquired({
      authority: mutation.materialAuthority,
      reservation,
      explicitOverlay: "qa",
    });
    expect(sources.result.file_plan?.workloads.reader?.[1]?.source).toEqual({
      kind: "managed",
      key: "TOKEN",
      scope: "reader",
      secret: true,
    });
    expect(JSON.stringify(sources)).not.toContain(CANARY);
    await withNativeComposeFileBytes({
      sources,
      authority: mutation.materialAuthority,
      reservation,
      run: async (members) => {
        expect(Buffer.from(members[1]?.bytes ?? []).toString("utf8")).toBe(
          CANARY
        );
      },
    });
  });
  await writeFile(
    join(root, ".hack/hack.env.qa.yaml"),
    JSON.stringify({ ...header, values: { global: { TOKEN: null } } })
  );
  await store.withMutation(async (mutation) => {
    await expect(
      acquired({
        authority: mutation.materialAuthority,
        reservation: mutation.reserveGeneration(),
        explicitOverlay: "qa",
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
  });
});
async function git(args: readonly string[]): Promise<void> {
  const child = Bun.spawn(["git", "-C", root, ...args], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    expect(await child.exited).toBe(0);
  } finally {
    clearTimeout(timer);
  }
}
test("linked worktree selects its own source and current local managed layer while verified primary local inheritance remains explicit", async () => {
  await store.close();
  await git(["init", "--quiet", "-b", "main"]);
  await git(["add", ".hack/hack.project.json"]);
  await git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  const linked = join(parent, "linked");
  await git(["worktree", "add", "--quiet", "-b", "fixture", linked]);
  expect(
    await resolveVerifiedPrimaryWorktreeRoot({ projectRoot: linked })
  ).toBe(root);
  await mkdir(join(linked, "inputs"));
  await writeFile(join(linked, "inputs/settings.bin"), Buffer.from([33]));
  await writeFile(join(linked, "inputs/secret"), Buffer.alloc(0), {
    mode: 0o600,
  });
  await writeFile(
    join(linked, ".hack/hack.env.default.yaml"),
    await readFile(join(root, ".hack/hack.env.default.yaml"))
  );
  const layer = {
    version: 1,
    environment: "default",
    secretsprovider: "project_key",
  };
  await writeFile(
    join(root, ".hack/hack.env.local.yaml"),
    JSON.stringify({
      ...layer,
      values: { global: { TOKEN: "synthetic-primary-local" } },
    })
  );
  await writeFile(
    join(linked, ".hack/hack.env.local.yaml"),
    JSON.stringify({
      ...layer,
      values: { reader: { TOKEN: "synthetic-current-local" } },
    })
  );
  store = await openNativeComposeGenerationStore({
    projectRoot: linked,
    instance: null,
  });
  await store.withMutation(async (mutation) => {
    const reservation = mutation.reserveGeneration();
    const sources = await acquired({
      authority: mutation.materialAuthority,
      reservation,
    });
    await withNativeComposeFileBytes({
      sources,
      authority: mutation.materialAuthority,
      reservation,
      run: async (members) => {
        expect(Buffer.from(members[0]?.bytes ?? [])).toEqual(Buffer.from([33]));
        expect(Buffer.from(members[1]?.bytes ?? []).toString("utf8")).toBe(
          "synthetic-current-local"
        );
      },
    });
  });
  await unlink(join(linked, ".hack/hack.env.local.yaml"));
  await store.withMutation(async (mutation) => {
    const reservation = mutation.reserveGeneration();
    const sources = await acquired({
      authority: mutation.materialAuthority,
      reservation,
    });
    await withNativeComposeFileBytes({
      sources,
      authority: mutation.materialAuthority,
      reservation,
      run: async (members) => {
        expect(Buffer.from(members[1]?.bytes ?? []).toString("utf8")).toBe(
          "synthetic-primary-local"
        );
      },
    });
  });
  for (const exclusion of ["ci-1", "ci-true", "slim", "codex"]) {
    Reflect.deleteProperty(process.env, "CI");
    Reflect.deleteProperty(process.env, "HACK_EXECUTION_MODE");
    if (exclusion.startsWith("ci-")) {
      process.env.CI = exclusion === "ci-true" ? "true" : "1";
    } else {
      process.env.HACK_EXECUTION_MODE = exclusion;
    }
    await store.withMutation(async (mutation) => {
      const reservation = mutation.reserveGeneration();
      const sources = await acquired({
        authority: mutation.materialAuthority,
        reservation,
      });
      await withNativeComposeFileBytes({
        sources,
        authority: mutation.materialAuthority,
        reservation,
        run: async (members) => {
          expect(Buffer.from(members[1]?.bytes ?? []).toString("utf8")).toBe(
            CANARY
          );
        },
      });
    });
  }
}, 30_000);
