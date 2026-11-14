import {
  lstat,
  open,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { isRecord } from "./guards.ts";

const STAGE = /^\.hack-update-stage-[A-Za-z0-9]{6}$/;
const ENTRIES = new Set([
  "stage.json",
  "hack",
  "hack-config-compiler",
  "hack-lifecycle-supervisor",
  "rollback-supervisor",
  "rollback",
  "rollback-compiler",
]);
const SCHEMA = "hack.update-stage/v1";
/** Mark only a newly created directory containing regenerable executables. */
export async function markReleaseStage(stage: string, binary: string) {
  const info = await lstat(stage);
  await writeFile(
    join(stage, "stage.json"),
    JSON.stringify({
      schema: SCHEMA,
      binary,
      device: info.dev,
      inode: info.ino,
      uid: process.getuid?.(),
    }),
    { mode: 0o600, flag: "wx" }
  );
  const file = await open(join(stage, "stage.json"), "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
/** Under the update lock, reclaim only recorded private executable stages.
 * Complete backup manifests and unrecognised directories are never adopted/deleted. */
export async function reclaimReleaseStages(binary: string) {
  const parent = dirname(binary);
  for (const name of await readdir(parent)) {
    if (!STAGE.test(name)) {
      continue;
    }
    const stage = join(parent, name);
    const info = await lstat(stage);
    if (
      !info.isDirectory() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o7777) !== 0o700
    ) {
      continue;
    }
    const path = join(stage, "stage.json");
    const receipt = await lstat(path).catch(() => null);
    if (
      !receipt?.isFile() ||
      receipt.uid !== info.uid ||
      (receipt.mode & 0o7777) !== 0o600 ||
      receipt.size > 4096
    ) {
      continue;
    }
    const raw: unknown = await readFile(path, "utf8").then((text) => {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return null;
      }
    });
    if (
      !isRecord(raw) ||
      raw.schema !== SCHEMA ||
      raw.binary !== binary ||
      raw.device !== info.dev ||
      raw.inode !== info.ino ||
      raw.uid !== info.uid
    ) {
      continue;
    }
    let recognized = true;
    for (const entry of await readdir(stage)) {
      const file = await lstat(join(stage, entry));
      if (!(ENTRIES.has(entry) && file.isFile()) || file.uid !== info.uid) {
        recognized = false;
      }
    }
    if (!recognized) {
      continue;
    }
    const current = await lstat(stage);
    if (current.dev !== info.dev || current.ino !== info.ino) {
      throw new Error("Update stage identity changed; cleanup refused.");
    }
    await rm(stage, { recursive: true });
  }
}
