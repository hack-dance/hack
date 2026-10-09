import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  chown,
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
import { createNativeComposeFileOwner } from "../src/lib/native-compose-file-owner.ts";
import {
  acquireNativeComposeFileSources,
  closeNativeComposeFileSources,
  type NativeComposeFileSources,
} from "../src/lib/native-compose-file-sources.ts";
import {
  type NativeComposeGenerationStore,
  type NativeComposeMutation,
  openNativeComposeGenerationStore,
} from "../src/lib/native-compose-generation.ts";

const compiler = resolve(
  process.env.HACK_CONFIG_COMPILER_BINARY ?? "dist/hack-config-compiler"
);
const bytes = Buffer.from([0, 255, 10, 3]);
let parent = "",
  checkout = "",
  home = "";
let store: NativeComposeGenerationStore;
let savedHome: string | undefined, savedCompiler: string | undefined;
const owners: ReturnType<typeof createNativeComposeFileOwner>[] = [];
const sources: NativeComposeFileSources[] = [];

beforeEach(async () => {
  savedHome = process.env.HACK_HOME;
  savedCompiler = process.env.HACK_CONFIG_COMPILER_BINARY;
  parent = await realpath(
    await mkdtemp(join(tmpdir(), "native-file-cold-home-"))
  );
  checkout = join(parent, "checkout");
  home = join(parent, "home");
  await mkdir(checkout, { mode: 0o700 });
  await mkdir(join(checkout, ".hack"), { mode: 0o700 });
  await writeFile(
    join(checkout, ".hack/hack.project.json"),
    JSON.stringify({
      schema_version: 1,
      name: "cold-files",
      configs: { settings: { file: "settings" } },
      services: {
        reader: {
          image: "synthetic/reader:1",
          mounts: [
            {
              config: "settings",
              target: "/etc/settings",
              access: "read-only",
            },
          ],
        },
      },
    }),
    { mode: 0o600 }
  );
  await writeFile(join(checkout, "settings"), bytes, { mode: 0o444 });
  await chmod(join(checkout, "settings"), 0o444);
  process.env.HACK_HOME = home;
  process.env.HACK_CONFIG_COMPILER_BINARY = compiler;
  store = await openNativeComposeGenerationStore({
    projectRoot: checkout,
    instance: null,
  });
});
afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.close()));
  await Promise.all(sources.splice(0).map(closeNativeComposeFileSources));
  await store?.close();
  if (savedHome === undefined) {
    Reflect.deleteProperty(process.env, "HACK_HOME");
  } else {
    process.env.HACK_HOME = savedHome;
  }
  if (savedCompiler === undefined) {
    Reflect.deleteProperty(process.env, "HACK_CONFIG_COMPILER_BINARY");
  } else {
    process.env.HACK_CONFIG_COMPILER_BINARY = savedCompiler;
  }
  await rm(parent, { recursive: true, force: true });
});
async function selected(
  mutation: NativeComposeMutation,
  selectedRoot = join(home, "compose-files")
) {
  const reservation = mutation.reserveGeneration();
  const acquired = await acquireNativeComposeFileSources({
    authority: mutation.materialAuthority,
    reservation,
  });
  sources.push(acquired);
  const owner = createNativeComposeFileOwner({
    root: selectedRoot,
    authority: mutation.materialAuthority,
  });
  owners.push(owner);
  return { owner, reservation, sources: acquired };
}
async function noGeneration() {
  expect((await store.loadCurrent()).generation).toBeNull();
  expect(await store.loadPending()).toBeNull();
  const base = join(checkout, ".hack/.internal/native-compose");
  const instances = (await readdir(base)).filter((name) =>
    /^[a-f0-9]{64}$/.test(name)
  );
  expect(instances).toHaveLength(1);
  const instance = instances[0];
  if (!instance) {
    throw new Error("Missing owned generation directory");
  }
  expect(await readdir(join(base, instance, "generations"))).toEqual([]);
}

test("cold global home is created by the real file owner before private material preparation", async () => {
  await expect(lstat(home)).rejects.toMatchObject({ code: "ENOENT" });
  await store.withMutation(async (mutation) => {
    const input = await selected(mutation);
    // Acquisition alone has no reason to create global state for a local config.
    await expect(lstat(home)).rejects.toMatchObject({ code: "ENOENT" });
    const attempt = await input.owner.prepare(input);
    const projection = await input.owner.projection(attempt);
    expect((await lstat(home)).mode & 0o777).toBe(0o700);
    const uid = process.getuid?.();
    if (uid === undefined) {
      throw new Error("Missing native ownership identity");
    }
    expect((await lstat(home)).uid).toBe(uid);
    const grants = projection.workloads.reader;
    expect(grants).toHaveLength(1);
    const grant = grants?.[0];
    if (!grant) {
      throw new Error("Missing owned material grant");
    }
    expect(await readFile(grant.source)).toEqual(bytes);
    expect((await lstat(grant.source)).mode & 0o777).toBe(0o444);
    await input.owner.rollback(attempt);
  });
  await noGeneration();
});

test("an existing safe home retains its original mode", async () => {
  await mkdir(home, { mode: 0o755 });
  await chmod(home, 0o755);
  await store.withMutation(async (mutation) => {
    const input = await selected(mutation);
    const attempt = await input.owner.prepare(input);
    await input.owner.projection(attempt);
    await input.owner.rollback(attempt);
  });
  expect((await lstat(home)).mode & 0o777).toBe(0o755);
  await noGeneration();
});

test.each([
  "symlink",
  "unsafe",
  "file",
] as const)("%s global home refuses before private material or generation publication", async (kind) => {
  const foreign = join(parent, "untouched");
  await mkdir(foreign, { mode: 0o700 });
  if (kind === "symlink") {
    await symlink(foreign, home);
  } else if (kind === "unsafe") {
    await mkdir(home, { mode: 0o770 });
    await chmod(home, 0o770);
  } else {
    await writeFile(home, "owned non-directory", { mode: 0o600 });
  }
  await store.withMutation(async (mutation) => {
    const input = await selected(mutation);
    await expect(input.owner.prepare(input)).rejects.toMatchObject({
      code: "E_NATIVE_COMPOSE_STATE",
    });
  });
  expect(await readdir(foreign)).toEqual([]);
  await expect(lstat(join(home, "compose-files"))).rejects.toMatchObject({
    code: kind === "file" ? "ENOTDIR" : "ENOENT",
  });
  await noGeneration();
});

test("a symlink ancestor refuses before creating the missing home", async () => {
  const ancestor = join(parent, "alias"),
    foreign = join(parent, "untouched");
  await mkdir(foreign, { mode: 0o700 });
  await symlink(foreign, ancestor);
  await store.withMutation(async (mutation) => {
    const input = await selected(
      mutation,
      join(ancestor, "home/compose-files")
    );
    await expect(input.owner.prepare(input)).rejects.toMatchObject({
      code: "E_NATIVE_COMPOSE_STATE",
    });
  });
  expect(await readdir(foreign)).toEqual([]);
  await noGeneration();
});

test("a foreign-owned existing parent refuses without creating private material", async () => {
  let foreign = await realpath("/");
  if (process.getuid?.() === 0) {
    foreign = join(parent, "foreign-owned");
    await mkdir(foreign, { mode: 0o700 });
    await chown(foreign, 1, 1);
  }
  expect((await lstat(foreign)).uid).not.toBe(process.getuid?.());
  const path = join(
    foreign,
    `uncreated-file-material-${parent.split("/").at(-1)}`
  );
  await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  await store.withMutation(async (mutation) => {
    const input = await selected(mutation, path);
    await expect(input.owner.prepare(input)).rejects.toMatchObject({
      code: "E_NATIVE_COMPOSE_STATE",
    });
  });
  await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  await noGeneration();
});

test("replacement after preparation refuses projection before generation publication", async () => {
  await store.withMutation(async (mutation) => {
    const input = await selected(mutation);
    const attempt = await input.owner.prepare(input);
    await rename(home, `${home}-original`);
    await mkdir(home, { mode: 0o700 });
    await expect(input.owner.projection(attempt)).rejects.toMatchObject({
      code: "E_NATIVE_COMPOSE_STATE",
    });
    expect(await readdir(home)).toEqual([]);
  });
  await noGeneration();
});
