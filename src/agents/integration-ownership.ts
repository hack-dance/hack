import { createHash } from "node:crypto";
import { lstat, rmdir, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { ensureDir, writeTextFileIfChanged } from "../lib/fs.ts";
import { normalizeInstructionText } from "./instruction-source.ts";

/**
 * Ownership classification for standalone agent integration files that Hack
 * writes outside its own state directories: the `hack-cli` skill (Codex and
 * the shared `~/.ai/skills` root), the `/hack-init` skill (Claude and Codex),
 * and the Cursor `hack.mdc` rules file.
 *
 * Invariant: install and remove paths act only on files classified as
 * `hack-owned-current` or `hack-owned-prior`. Anything else is reported as
 * `preserved` with a closed, value-free reason and is left byte-identical.
 * Removal deletes only the owned file and removes its skill directory only
 * when that directory is then empty; it never deletes a directory tree.
 *
 * Classification and the following write or unlink are not atomic. A file
 * edited between the two steps can still be replaced; the window is one
 * read-then-write and matches the previous write-if-changed behavior.
 */

/** A standalone integration surface with a known render history. */
export type IntegrationSurface =
  | "hack-cli-skill"
  | "hack-init-skill"
  | "cursor-rules";

/** Why Hack left an existing file unchanged. Closed and value-free. */
export type IntegrationPreservedReason =
  | "customized-content"
  | "missing-ownership-marker"
  | "not-a-regular-file"
  | "unreadable";

export type IntegrationOwnership =
  | { readonly kind: "absent" }
  | { readonly kind: "hack-owned-current" }
  | { readonly kind: "hack-owned-prior" }
  | {
      readonly kind: "customized" | "unknown";
      readonly reason: IntegrationPreservedReason;
    };

/** Outcome of an ownership-gated install. */
export type OwnedInstallOutcome =
  | { readonly status: "created" | "updated" | "noop" }
  | {
      readonly status: "preserved";
      readonly reason: IntegrationPreservedReason;
      readonly message: string;
    };

/** Outcome of an ownership-gated remove. */
export type OwnedRemoveOutcome =
  | {
      readonly status: "removed";
      readonly retainedDirectory: boolean;
      readonly message?: string;
    }
  | { readonly status: "missing" }
  | {
      readonly status: "preserved";
      readonly reason: IntegrationPreservedReason;
      readonly message: string;
    };

/**
 * Fingerprints of every render Hack has shipped for each surface, from
 * v1.1.0 through the current `next` head. Computed with
 * {@link fingerprintIntegrationRender} over each release tag's own render
 * function. The CLI version line is normalized, so a version bump alone does
 * not need a new entry.
 *
 * Maintenance: when a guidance or template change alters a render, append
 * the new fingerprint here (the ownership test names it). Never remove an
 * entry; installed files from that release would become `customized`.
 */
const KNOWN_RENDER_FINGERPRINTS: Readonly<
  Record<IntegrationSurface, ReadonlySet<string>>
> = {
  "hack-cli-skill": new Set([
    "e79ed97ec0c1b8aab7a056dc", // v1.1.0
    "36c2ec948d3520d4f6bb9ef0", // v1.2.0..v1.10.2
    "f84ce8e3b30fb7ae4365c479", // v1.11.0
    "91d31bd53d7f32d2bbf039ee", // v1.12.0..v1.16.0
    "25dbc500c3e20d5f4f98a3f7", // v1.17.0..v1.17.1
    "a1494003445cb2663a09e271", // v1.18.0..v2.5.1
    "6e017e271ad25e6c71e945d2", // v3.0.0
    "f70e7c96ca0dd893a6a52bfa", // v3.1.0..v3.1.1
    "a8749bf2bb52b89265b92110", // v3.2.0..v3.3.1
    "ac27749acbeae164fa3a20eb", // v3.3.2
    "3a03bc195b5345310fdf896c", // v3.3.3..v3.3.4
    "6d56150fcd10ba1e0f5d186a", // v3.3.5
    "bc4b6c008ad35768e185557c", // v3.3.6
    "a8f34c60fcd22f9aca894acd", // v3.3.7
    "d644241f4fb227bf3bd9278b", // v3.4.0..v3.4.1
    "17c610e5d070ae55cb63070f", // v3.5.0
    "8765fbf95fa6fe48b35e0222", // v3.5.1..v3.5.2
    "9d5224d684b357b261c6a488", // v4.0.0..v4.0.2
    "4d58c2a166cdf6c14e32dc40", // v4.0.3
    "ac48ce815ba7efccc3f40e80", // v4.1.0..v4.2.1
    "b6465c18c6d4f41b30a600b8", // v5.0.0-next.1..v5.0.0-next.2
    "121d8f26374d24f2a09890a3", // v5.0.0-next.3..next
    "6449442a8f230412d4e5f9e7", // v5.0.0-next.4..next
    "e620e980660f0443df7732fe", // next: focused plugin skills (HACK-1131)
  ]),
  "hack-init-skill": new Set([
    "cd15fb6d8ed8e25071d05e75", // v3.1.0..v4.0.3
    "f8e3018bcb8546e802dfa19c", // v4.1.0..next
  ]),
  "cursor-rules": new Set([
    "6acabe0f41a9785374970d6c", // v1.1.0..v1.10.2
    "dd64dc0276b4d3d00dc834a1", // v1.11.0
    "3826578c171d37c14adbc009", // v1.12.0..v1.16.0
    "e4ec7279929a0b16b828e214", // v1.17.0..v2.5.1
    "d4f97375b9c53413ca03b280", // v3.0.0
    "aff2e807c6aba2edc9e36437", // v3.1.0..v3.3.1
    "5c6fd69638d0c05722b46ee3", // v3.3.2
    "902a8925af8025b36fc93d16", // v3.3.3..v3.3.4
    "b9f485c49dfdb9e888219f5f", // v3.3.5
    "5a3b17bf3e047a9006bb9865", // v3.3.6
    "44421716c31da9a073cbfd68", // v3.3.7
    "2dbd1bad4b98a0563774f744", // v3.4.0..v3.4.1
    "766c0879ffcd99a36a3520f9", // v3.5.0
    "af92b06b8c05405029e83e88", // v3.5.1..v3.5.2
    "868c6a1f6c0d9487fd8390cc", // v4.0.0..v4.0.2
    "592f8677dcb0ba2ea2ee0476", // v4.0.3
    "8e610ffc85d7e24490195be5", // v4.1.0..v4.2.1
    "01d7431b9a5caaba3ffd3463", // v5.0.0-next.1..v5.0.0-next.2
    "06cf6d0920afc1780b9946ba", // v5.0.0-next.3..next
    "cf0a31e197f9034485413674", // v5.0.0-next.4..next
    "ea46c0d85989de79dba95fd4", // next: focused plugin skills (HACK-1131)
  ]),
};

/** Hack ownership markers that every render of a surface carries. */
const OWNERSHIP_MARKERS: Readonly<
  Record<IntegrationSurface, readonly RegExp[]>
> = {
  "hack-cli-skill": [/name:\s*hack-cli\b/i],
  "hack-init-skill": [/name:\s*hack-init\b/i],
  "cursor-rules": [/# BEGIN HACK INTEGRATION/, /# END HACK INTEGRATION/],
};

const CLI_VERSION_LINE = /(generated by hack CLI )v\S+?(;|\s)/g;

/**
 * Stable fingerprint of a render: normalized whitespace and a placeholder for
 * the generating CLI version.
 */
export function fingerprintIntegrationRender({
  text,
}: {
  readonly text: string;
}): string {
  return createHash("sha256")
    .update(normalizeForOwnership(text))
    .digest("hex")
    .slice(0, 24);
}

/** Whether a render fingerprint is in the known history for a surface. */
export function isKnownIntegrationRender({
  surface,
  text,
}: {
  readonly surface: IntegrationSurface;
  readonly text: string;
}): boolean {
  return KNOWN_RENDER_FINGERPRINTS[surface].has(
    fingerprintIntegrationRender({ text })
  );
}

/** Classify file content against the current render and known history. */
export function classifyIntegrationContent({
  surface,
  content,
  currentRender,
}: {
  readonly surface: IntegrationSurface;
  readonly content: string;
  readonly currentRender: string;
}): IntegrationOwnership {
  if (normalizeForOwnership(content) === normalizeForOwnership(currentRender)) {
    return { kind: "hack-owned-current" };
  }
  if (isKnownIntegrationRender({ surface, text: content })) {
    return { kind: "hack-owned-prior" };
  }
  const marked = OWNERSHIP_MARKERS[surface].every((marker) =>
    marker.test(content)
  );
  if (marked) {
    return { kind: "customized", reason: "customized-content" };
  }
  return { kind: "unknown", reason: "missing-ownership-marker" };
}

/** Classify the file at `path`. Symlinked files are judged by their target. */
export async function classifyIntegrationFile({
  surface,
  path,
  currentRender,
}: {
  readonly surface: IntegrationSurface;
  readonly path: string;
  readonly currentRender: string;
}): Promise<IntegrationOwnership> {
  const entry = await inspectPath({ path });
  if (entry === "absent") {
    return { kind: "absent" };
  }
  if (entry !== "file") {
    return { kind: "unknown", reason: "not-a-regular-file" };
  }
  let content: string;
  try {
    content = await Bun.file(path).text();
  } catch {
    return { kind: "unknown", reason: "unreadable" };
  }
  return classifyIntegrationContent({ surface, content, currentRender });
}

/** Fixed operator guidance for a preserved file. Contains no file content. */
export function describePreservedReason({
  reason,
  action,
}: {
  readonly reason: IntegrationPreservedReason;
  readonly action: "install" | "remove";
}): string {
  const cause: Readonly<Record<IntegrationPreservedReason, string>> = {
    "customized-content":
      "it was edited after Hack wrote it or does not match a known Hack render",
    "missing-ownership-marker": "it has no Hack ownership marker",
    "not-a-regular-file": "it is not a regular file",
    unreadable: "it could not be read",
  };
  const next =
    action === "install"
      ? "Move or delete it, then rerun setup to install the current version."
      : "Delete it yourself if it is no longer needed.";
  return `Hack left this path unchanged because ${cause[reason]}. ${next}`;
}

/**
 * Write `render` to `path` only when the path is absent or Hack-owned.
 * Customized or unknown content is preserved byte-identical.
 */
export async function installOwnedIntegrationFile({
  surface,
  path,
  render,
}: {
  readonly surface: IntegrationSurface;
  readonly path: string;
  readonly render: string;
}): Promise<OwnedInstallOutcome> {
  const ownership = await classifyIntegrationFile({
    surface,
    path,
    currentRender: render,
  });
  if (ownership.kind === "customized" || ownership.kind === "unknown") {
    return {
      status: "preserved",
      reason: ownership.reason,
      message: describePreservedReason({
        reason: ownership.reason,
        action: "install",
      }),
    };
  }

  await ensureDir(dirname(path));
  const result = await writeTextFileIfChanged(path, render);
  if (ownership.kind === "absent") {
    return { status: "created" };
  }
  return { status: result.changed ? "updated" : "noop" };
}

/**
 * Remove a Hack-owned file. With `removeEmptyDirectory`, the containing
 * directory is removed only when it is empty afterwards; a symlinked
 * directory is unlinked as a link and its target is left untouched.
 */
export async function removeOwnedIntegrationFile({
  surface,
  path,
  currentRender,
  removeEmptyDirectory,
}: {
  readonly surface: IntegrationSurface;
  readonly path: string;
  readonly currentRender: string;
  readonly removeEmptyDirectory: boolean;
}): Promise<OwnedRemoveOutcome> {
  const ownership = await classifyIntegrationFile({
    surface,
    path,
    currentRender,
  });
  if (ownership.kind === "absent") {
    return { status: "missing" };
  }
  if (ownership.kind === "customized" || ownership.kind === "unknown") {
    return {
      status: "preserved",
      reason: ownership.reason,
      message: describePreservedReason({
        reason: ownership.reason,
        action: "remove",
      }),
    };
  }

  const directory = dirname(path);
  if (removeEmptyDirectory && (await isSymlink({ path: directory }))) {
    await unlink(directory);
    return { status: "removed", retainedDirectory: false };
  }

  await unlink(path);
  if (!removeEmptyDirectory) {
    return { status: "removed", retainedDirectory: false };
  }
  const removedDirectory = await removeDirectoryIfEmpty({ path: directory });
  if (removedDirectory) {
    return { status: "removed", retainedDirectory: false };
  }
  return {
    status: "removed",
    retainedDirectory: true,
    message:
      "Removed the Hack-owned SKILL.md and kept its directory because it holds other files.",
  };
}

function normalizeForOwnership(text: string): string {
  return normalizeInstructionText({ text }).replace(
    CLI_VERSION_LINE,
    "$1v<version>$2"
  );
}

async function inspectPath({
  path,
}: {
  readonly path: string;
}): Promise<"absent" | "file" | "other"> {
  try {
    const link = await lstat(path);
    if (!link.isSymbolicLink()) {
      return link.isFile() ? "file" : "other";
    }
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return "absent";
    }
    return "other";
  }
  try {
    const target = await stat(path);
    return target.isFile() ? "file" : "other";
  } catch {
    // Dangling symlink: never write or unlink through it.
    return "other";
  }
}

async function isSymlink({
  path,
}: {
  readonly path: string;
}): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

async function removeDirectoryIfEmpty({
  path,
}: {
  readonly path: string;
}): Promise<boolean> {
  try {
    await rmdir(path);
    return true;
  } catch (error: unknown) {
    const code = errorCode(error);
    if (code === "ENOTEMPTY" || code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return;
  }
  const { code } = error;
  return typeof code === "string" ? code : undefined;
}
