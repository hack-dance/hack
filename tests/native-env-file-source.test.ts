import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  link,
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
import { readNativeEnvFileSource } from "../src/backends/native-env-file-source.ts";

const roots: string[] = [];
const SENTINEL = "synthetic-private-file-source-canary";
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const projectRoot = await realpath(
    await mkdtemp(join(tmpdir(), "native-env-source-"))
  );
  roots.push(projectRoot);
  await mkdir(join(projectRoot, ".hack"), { mode: 0o700 });
  return {
    projectRoot,
    composeFile: join(projectRoot, ".hack/docker-compose.yml"),
    path: "service.env",
    required: true,
    service: "app",
  };
}
test("reads exact text privately, including empty files, without changing modes or bytes", async () => {
  const opts = await fixture();
  const path = join(opts.projectRoot, ".hack/service.env");
  for (const mode of [0o644, 0o600, 0o400]) {
    await writeFile(path, `  KEY=${SENTINEL} \n`);
    await chmod(path, mode);
    const result = await readNativeEnvFileSource(opts);
    expect(result?.text).toBe(`  KEY=${SENTINEL} \n`);
    expect(await readFile(path, "utf8")).toBe(result?.text ?? "");
  }
  await chmod(path, 0o600);
  await writeFile(path, "");
  expect((await readNativeEnvFileSource(opts))?.text).toBe("");
});
test("only absent optional sources are ignored, including a missing parent", async () => {
  const opts = await fixture();
  expect(
    await readNativeEnvFileSource({ ...opts, required: false })
  ).toBeNull();
  expect(
    await readNativeEnvFileSource({
      ...opts,
      path: "missing/optional.env",
      required: false,
    })
  ).toBeNull();
  await expect(readNativeEnvFileSource(opts)).rejects.toThrow(
    "required source is missing"
  );
});
test.each([
  "symlink",
  "dangling",
  "hardlink",
  "directory",
  "unreadable",
  "writable",
  "oversize",
  "invalid-utf8",
])("optional %s source refuses without reading or echoing its contents", async (kind) => {
  const opts = await fixture();
  const path = join(opts.projectRoot, ".hack/service.env");
  const target = join(opts.projectRoot, "target");
  await writeFile(target, SENTINEL, { mode: 0o600 });
  switch (kind) {
    case "symlink":
      await symlink(target, path);
      break;
    case "dangling":
      await symlink(join(opts.projectRoot, "absent"), path);
      break;
    case "hardlink":
      await link(target, path);
      break;
    case "directory":
      await mkdir(path);
      break;
    default: {
      const content =
        kind === "oversize"
          ? Buffer.alloc(256 * 1024 + 1)
          : Buffer.from(SENTINEL);
      await writeFile(
        path,
        kind === "invalid-utf8" ? new Uint8Array([255]) : content,
        { mode: 0o600 }
      );
      if (kind === "unreadable") {
        await chmod(path, 0);
      }
      if (kind === "writable") {
        await chmod(path, 0o666);
      }
    }
  }
  const error: unknown = await readNativeEnvFileSource({
    ...opts,
    required: false,
  }).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain("values omitted");
  expect(String(error)).toContain("service.env");
  expect(String(error)).not.toContain(SENTINEL);
  expect(await readFile(target, "utf8")).toBe(SENTINEL);
});
test("rejects a symlinked parent and a writable directory, even for an absent optional source", async () => {
  const opts = await fixture();
  await mkdir(join(opts.projectRoot, "actual"));
  await symlink(
    join(opts.projectRoot, "actual"),
    join(opts.projectRoot, ".hack/alias")
  );
  await expect(
    readNativeEnvFileSource({ ...opts, path: "alias/file", required: false })
  ).rejects.toThrow("source directories must be real");
  await chmod(join(opts.projectRoot, ".hack"), 0o777);
  try {
    await expect(
      readNativeEnvFileSource({ ...opts, required: false })
    ).rejects.toThrow("source directories must be real");
  } finally {
    await chmod(join(opts.projectRoot, ".hack"), 0o700);
  }
});
test.each([
  "../../external",
  "${SOURCE}",
  "~/file",
  "bad\0path",
])("refuses unsupported paths before reading", async (path) => {
  await expect(
    readNativeEnvFileSource({ ...(await fixture()), path })
  ).rejects.toThrow("refused");
});
