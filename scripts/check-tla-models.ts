#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  verifyAdmissionModelResult,
  verifyBalloonReuseModelResult,
  verifyRestoreHistoryModelResult,
} from "./lib/tla-result.ts";

import { runtimeModels } from "./lib/tla-runtime-models.ts";

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
const models = [
  ...runtimeModels,
  {
    name: "restore-history",
    module: "RestoreHistory",
    verify: verifyRestoreHistoryModelResult,
  },
  {
    name: "graph-admission",
    module: "Admission",
    verify: verifyAdmissionModelResult,
  },
  {
    name: "balloon-reuse",
    module: "BalloonReuse",
    verify: verifyBalloonReuseModelResult,
  },
];
const scratch = await mkdtemp(resolve(tmpdir(), "hack-tla-"));
try {
  for (const model of models) {
    const source = resolve(import.meta.dir, "../tests/models/tla", model.name);
    const directory = resolve(scratch, model.name, "source");
    await cp(source, directory, { recursive: true });
    for (const negative of [false, true]) {
      const module =
        negative && "negativeModule" in model
          ? (model.negativeModule ?? model.module)
          : model.module;
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
          resolve(scratch, model.name, name),
          "-config",
          resolve(directory, `${name}.cfg`),
          resolve(directory, `${module}.tla`),
        ],
        {
          cwd: directory,
          encoding: "utf8",
          timeout: 120_000,
          maxBuffer: 1024 * 1024,
        }
      );
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      if (
        result.error ||
        !model.verify({ negative, exitCode: result.status, output })
      ) {
        process.stderr.write(output);
        throw new Error(
          `${model.name} ${name} control failed (${result.error?.message ?? result.status}).`
        );
      }
      process.stdout.write(`${model.name} ${name}: verified\n`);
    }
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
