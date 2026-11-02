import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NATIVE_STORAGE_DOCKER_ARTIFACT } from "../src/lib/native-compose-storage-witness-docker-artifact.ts";
import { NATIVE_STORAGE_WITNESS_HELPER } from "../src/lib/native-compose-storage-witness-helper-bundle.ts";
import { run } from "../src/lib/shell.ts";

/** Explicit maintenance build only; never execute the helper or update its approved
 * artifact pin automatically. Changed bytes require separate runtime qualification. */
const root = await mkdtemp(join(tmpdir(), "hack-storage-helper-build-"));
let group = 0,
  settled = false,
  started = false;
try {
  if (
    Bun.version !== "1.4.2" ||
    !["--check", "--write"].includes(process.argv[2] ?? "")
  ) {
    throw new Error("Pinned helper generation refused");
  }
  const output = join(root, "helper.mjs");
  started = true;
  const exit = await run(
    [
      process.execPath,
      "build",
      "scripts/native-storage-witness-helper.ts",
      "--target=bun",
      "--outfile",
      output,
    ],
    {
      stdin: "ignore",
      timeoutMs: 60_000,
      stdout: "ignore",
      stderr: "ignore",
      onSpawn: (event) => {
        group = event.ownsProcessGroup
          ? (event.processGroupId ?? event.pid)
          : 0;
        return Promise.resolve();
      },
    }
  );
  const deadline = Date.now() + 3000;
  while (group > 1 && Date.now() <= deadline) {
    try {
      process.kill(-group, 0);
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH"
      ) {
        settled = true;
        break;
      }
      throw new Error("Helper build disposition uncertain");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!settled) {
    throw new Error("Helper build disposition uncertain");
  }
  if (exit !== 0) {
    throw new Error("Pinned helper build refused");
  }
  const bytes = await readFile(output);
  if (
    bytes.length > 128 * 1024 ||
    createHash("sha256").update(bytes).digest("hex") !==
      NATIVE_STORAGE_DOCKER_ARTIFACT.helperHash
  ) {
    throw new Error("Helper artifact changed; separate qualification required");
  }
  const path = "src/lib/native-compose-storage-witness-helper-bundle.ts";
  const source = `// Generated from scripts/native-storage-witness-helper.ts. Do not edit the payload.\nexport const NATIVE_STORAGE_WITNESS_HELPER =\n  // biome-ignore lint/suspicious/noTemplateCurlyInString: Preserve qualified helper bytes without host interpolation.\n  ${JSON.stringify(bytes.toString("utf8"))};\n`;
  if (process.argv[2] === "--write") {
    await writeFile(path, source);
  } else if (NATIVE_STORAGE_WITNESS_HELPER !== bytes.toString("utf8")) {
    throw new Error("Generated helper source differs");
  }
} finally {
  if (settled || !started) {
    await rm(root, { recursive: true, force: true });
  }
}
