import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { isRecord } from "../lib/guards.ts";
import { createMcpOutputBudget } from "./output-budget.ts";

const filenames = {
  adapter: "hack-mcp-adapter",
  owner: "hack-mcp-owner",
  backend: "hack-mcp-backend",
} as const;
const roles = ["adapter", "owner", "backend"] as const;
type Role = (typeof roles)[number];
const MAX_ASSET_BYTES = 256 * 1024 * 1024;
const fingerprint = z
  .object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().positive().max(MAX_ASSET_BYTES),
  })
  .strict();
const common = {
  schemaVersion: z.literal(1),
  startupProtocol: z.literal(2),
  wireProtocol: z.literal(1),
  platform: z.enum(["darwin", "linux"]),
  architecture: z.enum(["arm64", "x64"]),
};
const metadataSchema = z.object({ ...common, role: z.enum(roles) }).strict();
const manifestSchema = z
  .object({
    ...common,
    bundleId: z.string().regex(/^[a-f0-9]{64}$/),
    files: z
      .object({
        adapter: fingerprint,
        owner: fingerprint,
        backend: fingerprint,
      })
      .strict(),
  })
  .strict();
export type McpBundleManifest = z.infer<typeof manifestSchema>;
type Inputs = Readonly<Record<Role, string>>;

function identity(value: Omit<McpBundleManifest, "bundleId">): string {
  const {
    schemaVersion,
    startupProtocol,
    wireProtocol,
    platform,
    architecture,
    files,
  } = value;
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion,
        startupProtocol,
        wireProtocol,
        platform,
        architecture,
        files,
      })
    )
    .digest("hex");
}

async function privateDirectory(path: string) {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new Error(
      "MCP bundle directory must be private and owned by this user"
    );
  }
  return stat;
}

/** Read an owned immutable snapshot without following a final-path symlink. */
async function readAsset(opts: {
  path: string;
  manifest?: boolean;
}): Promise<{ sha256: string; bytes: number; text: string }> {
  const { path, manifest = false } = opts;
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const before = await file.stat({ bigint: true });
    const mode = manifest ? 0o400n : 0o500n;
    if (
      !before.isFile() ||
      before.uid !== BigInt(process.getuid?.() ?? -1) ||
      before.nlink !== 1n ||
      (before.mode & 0o777n) !== mode ||
      before.size < 1n ||
      before.size > BigInt(manifest ? 8192 : MAX_ASSET_BYTES)
    ) {
      throw new Error("Invalid MCP bundle file type, ownership, mode or size");
    }
    const hash = createHash("sha256");
    let text = "";
    let bytesRead = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      bytesRead += chunk.byteLength;
      if (bytesRead > Number(before.size)) {
        throw new Error("MCP bundle file grew while being verified");
      }
      hash.update(chunk);
      if (manifest) {
        text += chunk.toString();
      }
    }
    const after = await file.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    if (
      bytesRead !== Number(before.size) ||
      after.ctimeNs !== before.ctimeNs ||
      after.mtimeNs !== before.mtimeNs ||
      after.size !== before.size ||
      named.dev !== before.dev ||
      named.ino !== before.ino ||
      !named.isFile()
    ) {
      throw new Error("MCP bundle file changed while being verified");
    }
    return { sha256: hash.digest("hex"), bytes: Number(before.size), text };
  } finally {
    await file.close();
  }
}

function parseManifest(text: string): McpBundleManifest {
  try {
    return manifestSchema.parse(JSON.parse(text));
  } catch {
    throw new Error("Invalid MCP bundle manifest");
  }
}

/** Integrity and host check, not a signature or protection against a hostile
 * same-user writer. Do not validate once and later mutate a published bundle.
 */
export async function verifyMcpBundle(opts: { readonly directory: string }) {
  const supplied = resolve(opts.directory);
  const initial = await privateDirectory(supplied);
  const directory = await realpath(supplied);
  const manifest = parseManifest(
    (
      await readAsset({
        path: join(directory, "manifest.json"),
        manifest: true,
      })
    ).text
  );
  if (
    manifest.platform !== process.platform ||
    manifest.architecture !== process.arch
  ) {
    throw new Error(
      "MCP bundle does not match this host platform and architecture"
    );
  }
  if (identity(manifest) !== manifest.bundleId) {
    throw new Error("MCP bundle identity mismatch");
  }
  const expected = ["manifest.json", ...Object.values(filenames)].sort();
  if (
    JSON.stringify((await readdir(directory)).sort()) !==
    JSON.stringify(expected)
  ) {
    throw new Error("MCP bundle contains missing or unexpected files");
  }
  const executables = {
    adapter: join(directory, filenames.adapter),
    owner: join(directory, filenames.owner),
    backend: join(directory, filenames.backend),
  };
  for (const role of roles) {
    const actual = await readAsset({ path: executables[role] });
    if (
      actual.sha256 !== manifest.files[role].sha256 ||
      actual.bytes !== manifest.files[role].bytes
    ) {
      throw new Error(`MCP bundle ${role} integrity check failed`);
    }
  }
  const final = await privateDirectory(supplied);
  if (initial.dev !== final.dev || initial.ino !== final.ino) {
    throw new Error("MCP bundle directory changed during verification");
  }
  return { directory, manifest, executables };
}

async function probe(opts: { path: string; role: Role; home: string }) {
  const child = Bun.spawn([opts.path, "--mcp-artifact-info"], {
    cwd: opts.home,
    env: { HOME: opts.home, TMPDIR: opts.home },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stop = () => {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
  };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, 5000);
  const budget = createMcpOutputBudget({ maxBytes: 8192, onLimit: stop });
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(budget.wrap(child.stdout)).text(),
      new Response(budget.wrap(child.stderr)).text(),
    ]);
    if (code !== 0 || timedOut || budget.exceeded() || stderr.length > 0) {
      throw new Error("MCP artifact capability probe failed");
    }
    let value: z.infer<typeof metadataSchema>;
    try {
      value = metadataSchema.parse(JSON.parse(stdout));
    } catch {
      throw new Error("Invalid MCP artifact capability report");
    }
    if (
      value.role !== opts.role ||
      value.platform !== process.platform ||
      value.architecture !== process.arch
    ) {
      throw new Error("MCP artifact role or host does not match");
    }
    return value;
  } finally {
    clearTimeout(timer);
  }
}

/** Package explicitly selected, trusted local executables. Metadata queries run
 * only during assembly, with private HOME and no inherited credentials. Publish
 * by directory rename; concurrent identical writers reuse a verified winner.
 */
export async function packageMcpBundle(opts: {
  readonly outputRoot: string;
  readonly inputs: Inputs;
}) {
  const requestedRoot = resolve(opts.outputRoot);
  await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
  await privateDirectory(requestedRoot);
  const outputRoot = await realpath(requestedRoot);
  const stage = await mkdtemp(join(outputRoot, ".build-"));
  const owned = await lstat(stage);
  try {
    const home = join(stage, ".probe-home");
    await mkdir(home, { mode: 0o700 });
    const files = {} as Record<Role, z.infer<typeof fingerprint>>;
    let metadata: z.infer<typeof metadataSchema> | undefined;
    for (const role of roles) {
      const input = resolve(opts.inputs[role]);
      const stat = await lstat(input);
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_ASSET_BYTES) {
        throw new Error("Invalid MCP artifact input");
      }
      const path = join(stage, filenames[role]);
      await copyFile(
        input,
        path,
        constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE
      );
      await chmod(path, 0o500);
      metadata = await probe({ path, role, home });
      const { sha256, bytes } = await readAsset({ path });
      files[role] = { sha256, bytes };
    }
    if (!metadata) {
      throw new Error("Missing MCP artifacts");
    }
    await rm(home, { recursive: true });
    const { role: _role, ...host } = metadata;
    const body = { ...host, files };
    const manifest = { ...body, bundleId: identity(body) };
    await writeFile(
      join(stage, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx", mode: 0o400 }
    );
    await verifyMcpBundle({ directory: stage });
    const directory = join(outputRoot, manifest.bundleId);
    const existing = await lstat(directory).catch((error: unknown) => {
      if (isRecord(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (!existing) {
      try {
        await rename(stage, directory);
      } catch (error: unknown) {
        if (
          !isRecord(error) ||
          (error.code !== "EEXIST" && error.code !== "ENOTEMPTY")
        ) {
          throw error;
        }
      }
    }
    const result = await verifyMcpBundle({ directory });
    if (result.manifest.bundleId !== manifest.bundleId) {
      throw new Error("Existing MCP bundle has a different identity");
    }
    return result;
  } finally {
    const current = await lstat(stage).catch(() => null);
    if (
      current?.dev === owned.dev &&
      current.ino === owned.ino &&
      current.isDirectory()
    ) {
      await chmod(stage, 0o700);
      await rm(stage, { recursive: true });
    }
  }
}
