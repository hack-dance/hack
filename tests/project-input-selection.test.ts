import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  updateProjectConfig,
  updateProjectConfigBatch,
} from "../src/lib/config.ts";
import {
  findProjectContext,
  findProjectContextAtRoot,
  findRepoRootForInit,
  readProjectConfig,
} from "../src/lib/project.ts";
import {
  discoverProjectInputs,
  inspectProjectInputsAtRoot,
  NATIVE_PROJECT_FILENAME,
} from "../src/lib/project-input-selection.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hack-input-selection-"));
  roots.push(root);
  return root;
}

async function file(
  root: string,
  relative: string,
  text = "services: {}\n"
): Promise<string> {
  const path = join(root, relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  return path;
}

async function native(
  root: string,
  text = '{"schema_version":1,"name":"test"}'
): Promise<string> {
  return await file(root, `.hack/${NATIVE_PROJECT_FILENAME}`, text);
}

test("native nested discovery refuses ancestor Compose without registration or writes", async () => {
  const outer = await fixture();
  await file(outer, ".hack/docker-compose.yml");
  const inner = join(outer, "native");
  const marker = await native(inner);
  const nested = join(inner, "src/deep");
  await mkdir(nested, { recursive: true });
  expect((await discoverProjectInputs({ startDir: nested }))?.projectRoot).toBe(
    inner
  );
  await expect(findProjectContext(nested)).rejects.toThrow(
    "E_NATIVE_PROJECT_UNSUPPORTED"
  );
  expect(await readFile(marker, "utf8")).toBe(
    '{"schema_version":1,"name":"test"}'
  );
  expect(await Bun.file(join(inner, ".hack/hack.config.json")).exists()).toBe(
    false
  );
});

for (const directory of [".hack", ".dev"]) {
  for (const filename of [
    "docker-compose.yml",
    "hack.config.json",
    "hack.toml",
  ]) {
    test(`native plus active ${directory}/${filename} conflicts before parsing`, async () => {
      const root = await fixture();
      await native(root);
      await file(root, `${directory}/${filename}`, "not parseable input");
      expect(
        (await inspectProjectInputsAtRoot({ projectRoot: root })).kind
      ).toBe("conflict");
      await expect(findProjectContext(root)).rejects.toThrow(
        "E_NATIVE_PROJECT_CONFLICT"
      );
    });
  }
}

test("generated backend files, backups and root Compose are not authored legacy inputs", async () => {
  const root = await fixture();
  await native(root);
  for (const name of [
    "docker-compose.yml",
    ".hack/.internal/docker-compose.yml",
    ".hack/.branch/dev/docker-compose.yml",
    ".hack/hack.config.json.backup",
    ".hack/docker-compose.yml.old",
  ]) {
    await file(root, name);
  }
  expect((await inspectProjectInputsAtRoot({ projectRoot: root })).kind).toBe(
    "native"
  );
});

for (const text of ["{broken", '{"schema_version":999}', "null"]) {
  test(`native presence stops discovery independently of parsed contents ${text}`, async () => {
    const outer = await fixture();
    await file(outer, ".dev/docker-compose.yml");
    const inner = join(outer, "child");
    await native(inner, text);
    await expect(findProjectContext(inner)).rejects.toThrow(
      "E_NATIVE_PROJECT_UNSUPPORTED"
    );
  });
}

test("directory and dangling-link native markers never disappear into absence", async () => {
  const outer = await fixture();
  await file(outer, ".hack/docker-compose.yml");
  const directoryRoot = join(outer, "directory");
  await mkdir(join(directoryRoot, ".hack", NATIVE_PROJECT_FILENAME), {
    recursive: true,
  });
  await expect(findProjectContext(directoryRoot)).rejects.toThrow(
    "E_NATIVE_PROJECT_UNSUPPORTED"
  );
  const linkRoot = join(outer, "link");
  await mkdir(join(linkRoot, ".hack"), { recursive: true });
  await symlink(
    join(outer, "missing"),
    join(linkRoot, ".hack", NATIVE_PROJECT_FILENAME)
  );
  await expect(findProjectContext(linkRoot)).rejects.toThrow(
    "E_NATIVE_PROJECT_UNSUPPORTED"
  );
});

test("unreadable native input remains a boundary without reading its values", async () => {
  const root = await fixture();
  const marker = await native(root);
  await chmod(marker, 0);
  try {
    await expect(findProjectContext(root)).rejects.toThrow(
      "E_NATIVE_PROJECT_UNSUPPORTED"
    );
  } finally {
    await chmod(marker, 0o600);
  }
});

test.each([
  ".hack",
  ".hack/.internal",
])("invalid project directory %s refuses rather than selecting ancestor Compose", async (path) => {
  const outer = await fixture();
  await file(outer, ".hack/docker-compose.yml");
  const inner = join(outer, "child");
  await file(inner, path, "not a directory");
  await expect(findProjectContext(inner)).rejects.toThrow(
    "Cannot inspect Hack project inputs"
  );
});

test("supported legacy discovery keeps primary-before-legacy precedence", async () => {
  const outer = await fixture();
  await file(outer, ".hack/docker-compose.yml");
  const child = join(outer, "child");
  await file(child, ".dev/docker-compose.yml");
  expect((await findProjectContext(child))?.projectRoot).toBe(outer);
});

test("dangling legacy Compose is not a discovery candidate but still conflicts with native", async () => {
  const outer = await fixture();
  await file(outer, ".hack/docker-compose.yml");
  const child = join(outer, "child");
  await mkdir(join(child, ".hack"), { recursive: true });
  await symlink(
    join(child, "missing"),
    join(child, ".hack/docker-compose.yml")
  );
  expect((await findProjectContext(child))?.projectRoot).toBe(outer);
  await native(child);
  await expect(findProjectContext(child)).rejects.toThrow(
    "E_NATIVE_PROJECT_CONFLICT"
  );
});

test("a nested legacy project can run below a native ancestor without crossing it", async () => {
  const outer = await fixture();
  await native(outer);
  const child = join(outer, "child");
  await file(child, ".dev/docker-compose.yml");
  expect((await findProjectContext(child))?.projectRoot).toBe(child);
});

test("exact-root lookup never adopts an ancestor project", async () => {
  const outer = await fixture();
  await file(outer, ".hack/docker-compose.yml");
  const child = join(outer, "child");
  await mkdir(child);
  expect(await findProjectContextAtRoot({ projectRoot: child })).toBeNull();
  await native(child);
  await expect(
    findProjectContextAtRoot({ projectRoot: child })
  ).rejects.toThrow("E_NATIVE_PROJECT_UNSUPPORTED");
});

test("init cannot cross an intervening native root to an ancestor package", async () => {
  const outer = await fixture();
  await file(outer, "package.json", "{}");
  const inner = join(outer, "native");
  await native(inner);
  const child = join(inner, "child");
  await file(child, ".dev/docker-compose.yml");
  await expect(findRepoRootForInit(child)).rejects.toThrow(
    "E_NATIVE_PROJECT_UNSUPPORTED"
  );
  await file(child, ".git", "gitdir: unused");
  expect(await findRepoRootForInit(child)).toBe(child);
  await file(child, "package.json", "{}");
  expect(await findRepoRootForInit(child)).toBe(child);
});

test("constructed-context read and both project update helpers refuse without changing bytes", async () => {
  const root = await fixture();
  await native(root);
  const configFile = await file(
    root,
    ".hack/hack.config.json",
    '{"name":"keep"}'
  );
  const projectDir = join(root, ".hack");
  const context = {
    projectRoot: root,
    projectDirName: ".hack" as const,
    projectDir,
    configFile,
    composeFile: join(projectDir, "docker-compose.yml"),
    envFile: join(projectDir, ".env"),
  };
  await expect(readProjectConfig(context)).rejects.toThrow(
    "E_NATIVE_PROJECT_CONFLICT"
  );
  await expect(
    updateProjectConfig({ projectDir, path: "name", value: "overwrite" })
  ).rejects.toThrow("E_NATIVE_PROJECT_CONFLICT");
  await expect(
    updateProjectConfigBatch({
      projectDir,
      values: [{ path: "name", value: "overwrite" }],
    })
  ).rejects.toThrow("E_NATIVE_PROJECT_CONFLICT");
  expect(await readFile(configFile, "utf8")).toBe('{"name":"keep"}');
});

test("native-only project update cannot create a competing legacy definition", async () => {
  const root = await fixture();
  await native(root);
  const projectDir = join(root, ".hack");
  await expect(
    updateProjectConfig({ projectDir, path: "name", value: "legacy" })
  ).rejects.toThrow("E_NATIVE_PROJECT_UNSUPPORTED");
  expect(await Bun.file(join(projectDir, "hack.config.json")).exists()).toBe(
    false
  );
});
