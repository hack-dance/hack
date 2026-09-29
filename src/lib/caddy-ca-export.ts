import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { inspectCaddyCaIdentity } from "./caddy-ca-identity.ts";

/** Refresh only the public export after explicit repair confirmation; never changes native trust. */
export async function repairCaddyCaExport(opts: {
  readonly composeFile: string;
  readonly certPath: string;
  readonly confirm: () => Promise<boolean>;
  readonly inspect?: typeof inspectCaddyCaIdentity;
}): Promise<{ readonly changed: boolean; readonly message: string }> {
  const inspect = opts.inspect ?? inspectCaddyCaIdentity;
  const initial = await inspect(opts);
  if (initial.state === "current" || !initial.currentPem) {
    return { changed: false, message: initial.message };
  }
  if (!(await opts.confirm())) {
    return { changed: false, message: "Caddy CA export refresh declined" };
  }
  // Confirmation may take time: obtain the current runtime identity again.
  const current = await inspect(opts);
  if (current.state === "current" || !current.currentPem) {
    return { changed: false, message: current.message };
  }
  try {
    const existing = await lstat(opts.certPath);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      return {
        changed: false,
        message: "Refusing to replace a non-regular Caddy CA export",
      };
    }
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
  }
  const directory = dirname(opts.certPath);
  await mkdir(directory, { recursive: true });
  const temporary = join(
    directory,
    `.${basename(opts.certPath)}.${crypto.randomUUID()}.tmp`
  );
  let created = false;
  try {
    await writeFile(temporary, current.currentPem, { flag: "wx", mode: 0o644 });
    created = true;
    await rename(temporary, opts.certPath);
  } finally {
    if (created) {
      await rm(temporary, { force: true });
    }
  }
  return {
    changed: true,
    message:
      "Exported current Caddy Local CA; host trust and application TLS must still be verified",
  };
}
