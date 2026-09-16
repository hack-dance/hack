#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { verifyAdmissionModelResult } from "./lib/tla-result.ts";

const expectedSha =
  "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";
const jarPath = process.env.TLA2TOOLS_JAR;
if (!jarPath) {
  throw new Error(
    "Set TLA2TOOLS_JAR to the pinned TLA+ 1.7.4 jar; see tests/models/tla/README.md."
  );
}
const jar = resolve(jarPath);
const bytes = await Bun.file(jar).arrayBuffer();
if (
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== expectedSha
) {
  throw new Error("TLA+ jar checksum differs from the pinned tool.");
}
const directory = resolve(
  import.meta.dir,
  "../tests/models/tla/graph-admission"
);
const scratch = await mkdtemp(resolve(tmpdir(), "hack-tla-"));
try {
  for (const negative of [false, true]) {
    const name = negative ? "negative" : "positive";
    const result = spawnSync(
      process.env.JAVA_BIN ?? "java",
      [
        "-Xmx512m",
        "-cp",
        jar,
        "tlc2.TLC",
        "-workers",
        "2",
        "-metadir",
        resolve(scratch, name),
        "-config",
        resolve(directory, `${name}.cfg`),
        resolve(directory, "Admission.tla"),
      ],
      { encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024 }
    );
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (
      result.error ||
      !verifyAdmissionModelResult({ negative, exitCode: result.status, output })
    ) {
      process.stderr.write(output);
      throw new Error(
        `Admission ${name} control failed (${result.error?.message ?? result.status}).`
      );
    }
    process.stdout.write(`graph-admission ${name}: verified\n`);
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
