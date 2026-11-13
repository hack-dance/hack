import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { withProjectsRegistryLock } from "./projects-registry-lock.ts";
import { markReleaseStage, reclaimReleaseStages } from "./release-staging.ts";
import { verifyStagedReleaseVersion } from "./release-version.ts";

async function present(path: string) {
  return await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
}
async function assertTree(path: string) {
  const info = await lstat(path);
  if (info.isDirectory()) {
    for (const name of await readdir(path)) {
      await assertTree(join(path, name));
    }
  } else if (!info.isFile()) {
    throw new Error(
      `Install tree contains a link or special file at ${path}; installation unchanged.`
    );
  }
}
async function syncDirectory(path: string) {
  const file = await open(path, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
async function syncTree(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isDirectory()) {
    for (const name of await readdir(path)) {
      await syncTree(join(path, name));
    }
  }
  await syncDirectory(path);
}
async function assertIdentity(path: string, expected: Stats | null) {
  const current = await present(path);
  if (current?.dev !== expected?.dev || current?.ino !== expected?.ino) {
    throw new Error(
      "Installation identity changed; refusing to replace or remove it."
    );
  }
}

/** Stage whole asset trees, publish the binary last, and retain a value-free backup manifest. */
export async function publishRelease(opts: {
  readonly version: string;
  readonly extractedReleaseDir: string;
  readonly binaryPath: string;
  readonly assetsDir: string;
  /** Fault injection only; never selected by environment or CLI input. */
  readonly checkpoint?: (phase: string) => void;
}) {
  await mkdir(dirname(opts.binaryPath), { recursive: true });
  await mkdir(dirname(opts.assetsDir), { recursive: true });
  return await withProjectsRegistryLock({
    lockPath: `${opts.binaryPath}.update.lock`,
    label: "CLI update",
    run: async () => {
      await reclaimReleaseStages(opts.binaryPath);
      const oldBinary = await present(opts.binaryPath);
      const oldAssets = await present(opts.assetsDir);
      const compilerPath = join(
        dirname(opts.binaryPath),
        "hack-config-compiler"
      );
      const oldCompiler = await present(compilerPath);
      const compilerSource = join(
        opts.extractedReleaseDir,
        "hack-config-compiler"
      );
      const hasCompiler = Boolean(await present(compilerSource));
      if (
        (oldBinary && !oldBinary.isFile()) ||
        (oldCompiler && !oldCompiler.isFile()) ||
        (oldAssets && !oldAssets.isDirectory())
      ) {
        throw new Error(
          "Refused non-regular installation target; installation unchanged."
        );
      }
      if (oldAssets) {
        await assertTree(opts.assetsDir);
      }
      await assertTree(opts.extractedReleaseDir);
      const backup = await mkdtemp(
        join(dirname(opts.assetsDir), ".hack-update-backup-")
      );
      await chmod(backup, 0o700);
      const assetsStage = join(backup, "new-assets");
      const oldAssetsPath = join(backup, "assets");
      const previousBinary = join(backup, "hack");
      const binaryStage = await mkdtemp(
        join(dirname(opts.binaryPath), ".hack-update-stage-")
      );
      await chmod(binaryStage, 0o700);
      let assetsMoved = false;
      let assetsPublished = false;
      let binaryPublished = false;
      let compilerPublished = false;
      let complete = false;
      let assetsIdentity: Stats | null = null;
      let binaryIdentity: Stats | null = null;
      let compilerIdentity: Stats | null = null;
      try {
        await markReleaseStage(binaryStage, opts.binaryPath);
        await mkdir(assetsStage, { mode: 0o700 });
        if (oldAssets) {
          await cp(opts.assetsDir, assetsStage, { recursive: true });
        }
        for (const name of ["assets", "binaries"]) {
          const source = join(opts.extractedReleaseDir, name);
          if (await present(source)) {
            await cp(
              source,
              name === "assets" ? assetsStage : join(assetsStage, "binaries"),
              { recursive: true }
            );
          }
        }
        if (oldBinary) {
          await copyFile(opts.binaryPath, previousBinary);
        }
        if (oldCompiler) {
          await copyFile(compilerPath, join(backup, "hack-config-compiler"));
        }
        if (hasCompiler) {
          await copyFile(
            compilerSource,
            join(binaryStage, "hack-config-compiler")
          );
          await chmod(join(binaryStage, "hack-config-compiler"), 0o755);
        }
        const next = join(binaryStage, "hack");
        await copyFile(join(opts.extractedReleaseDir, "hack"), next);
        await chmod(next, 0o755);
        const file = await open(next, "r");
        try {
          await file.sync();
        } finally {
          await file.close();
        }
        const hash = (bytes: Buffer) =>
          createHash("sha256").update(bytes).digest("hex");
        const manifest = {
          schema: "hack.update-backup/v1",
          binary: opts.binaryPath,
          assets: opts.assetsDir,
          previousBinary: oldBinary ? previousBinary : null,
          previousAssets: oldAssets ? oldAssetsPath : null,
          previousSha256: oldBinary
            ? hash(await readFile(previousBinary))
            : null,
          installedSha256: hash(await readFile(next)),
          compiler: hasCompiler ? compilerPath : null,
          previousCompiler: oldCompiler
            ? join(backup, "hack-config-compiler")
            : null,
          previousCompilerSha256: oldCompiler
            ? hash(await readFile(join(backup, "hack-config-compiler")))
            : null,
        };
        await writeFile(
          join(backup, "manifest.json"),
          `${JSON.stringify(manifest, null, 2)}\n`,
          { mode: 0o600 }
        );
        await syncTree(backup);
        await syncTree(binaryStage);
        await verifyStagedReleaseVersion(next, opts.version);
        opts.checkpoint?.("staged");
        assetsIdentity = await lstat(assetsStage);
        binaryIdentity = await lstat(next);
        if (hasCompiler) {
          compilerIdentity = await lstat(
            join(binaryStage, "hack-config-compiler")
          );
        }
        await assertIdentity(opts.assetsDir, oldAssets);
        if (oldAssets) {
          await rename(opts.assetsDir, oldAssetsPath);
          assetsMoved = true;
        }
        await rename(assetsStage, opts.assetsDir);
        assetsPublished = true;
        opts.checkpoint?.("assets-published");
        if (hasCompiler) {
          await assertIdentity(compilerPath, oldCompiler);
          await rename(join(binaryStage, "hack-config-compiler"), compilerPath);
          compilerPublished = true;
        }
        opts.checkpoint?.("compiler-published");
        await assertIdentity(opts.binaryPath, oldBinary);
        await rename(next, opts.binaryPath);
        binaryPublished = true;
        await syncDirectory(dirname(opts.binaryPath));
        await syncDirectory(dirname(opts.assetsDir));
        opts.checkpoint?.("binary-published");
        complete = true;
        return { backupManifest: join(backup, "manifest.json") };
      } catch (error) {
        try {
          if (binaryPublished) {
            await assertIdentity(opts.binaryPath, binaryIdentity);
            if (oldBinary) {
              const rollback = join(binaryStage, "rollback");
              await copyFile(previousBinary, rollback);
              await chmod(rollback, oldBinary.mode & 0o777);
              await rename(rollback, opts.binaryPath);
            } else {
              await rm(opts.binaryPath);
            }
          }
          if (compilerPublished) {
            await assertIdentity(compilerPath, compilerIdentity);
            if (oldCompiler) {
              const rollback = join(binaryStage, "rollback-compiler");
              await copyFile(join(backup, "hack-config-compiler"), rollback);
              await chmod(rollback, oldCompiler.mode & 0o777);
              await rename(rollback, compilerPath);
            } else {
              await rm(compilerPath);
            }
          }
          if (assetsPublished) {
            await assertIdentity(opts.assetsDir, assetsIdentity);
            await rm(opts.assetsDir, { recursive: true });
          }
          if (assetsMoved) {
            await assertIdentity(opts.assetsDir, null);
            await rename(oldAssetsPath, opts.assetsDir);
          }
          await syncDirectory(dirname(opts.binaryPath));
          await syncDirectory(dirname(opts.assetsDir));
        } catch {
          // Keep the complete old copies and manifest if rollback itself is uncertain.
          complete = true;
          throw new Error(
            `Update rollback could not be confirmed. Keep the backup manifest at ${join(backup, "manifest.json")} and inspect before retrying.`
          );
        }
        throw error;
      } finally {
        await rm(binaryStage, { recursive: true, force: true });
        if (!complete) {
          await rm(backup, { recursive: true, force: true });
        }
      }
    },
  });
}
