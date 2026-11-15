import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { inspectCaddyCaIdentity } from "./caddy-ca-identity.ts";

export const NON_REGULAR_EXPORT_MESSAGE =
  "Refusing to replace a non-regular Caddy CA export";

/**
 * Whether the export refresh may replace `certPath`, read-only: "replaceable"
 * for a regular file or a missing path, "refused" for a symlink or another
 * non-regular entry (the refresh never replaces those). An lstat error other
 * than ENOENT throws: the caller cannot know the answer.
 */
export async function caddyCaExportReplaceable(
  certPath: string
): Promise<"replaceable" | "refused"> {
  try {
    const existing = await lstat(certPath);
    return existing.isFile() && !existing.isSymbolicLink()
      ? "replaceable"
      : "refused";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return "replaceable";
    }
    throw error;
  }
}

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
  // Checked again here, after confirmation, right before the write.
  if ((await caddyCaExportReplaceable(opts.certPath)) === "refused") {
    return { changed: false, message: NON_REGULAR_EXPORT_MESSAGE };
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
