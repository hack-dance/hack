#!/usr/bin/env bun

import { resolve } from "node:path";
import { sanitizeCommittedMissionArtifactText } from "../src/lib/privacy-check.ts";

const repoRoot = resolve(import.meta.dir, "..");
const missionDir = process.env.HACK_MISSION_DIR?.trim() || undefined;
const inputPaths = process.argv.slice(2);

if (inputPaths.length === 0) {
  throw new Error(
    "Usage: bun scripts/sanitize-mission-artifacts.ts <tracked-artifact-path> [...more paths]"
  );
}

for (const inputPath of inputPaths) {
  const absolutePath = resolve(repoRoot, inputPath);
  const file = Bun.file(absolutePath);
  const original = await file.text();
  const sanitized = sanitizeCommittedMissionArtifactText({
    text: original,
    repoRoot,
    missionDir,
  });
  if (sanitized === original) {
    continue;
  }
  await Bun.write(absolutePath, sanitized);
}
