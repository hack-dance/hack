/**
 * Worktree-specific generation step. It runs only after the shared dependency
 * initializer succeeds and writes only to this instance's `generated` volume.
 */
import { rename, writeFile } from "node:fs/promises";

const target = "/generated/build-info.json";
const pending = `${target}.pending`;
const payload = `${JSON.stringify({ generatedAt: new Date().toISOString() })}\n`;

// Publish by rename so readers see a complete old or complete new file.
await writeFile(pending, payload);
await rename(pending, target);
