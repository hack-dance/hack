#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parseNativeAuthoredReview } from "../src/backends/native-authored-graph-protocol.ts";
import { invokeNativeRuntime } from "../src/backends/native-runtime-client.ts";

/** Verify the actual packaged executor's pure authored planner without provider state. */
export async function checkNativeAuthoredArtifact(opts: {
  readonly binary: string;
}): Promise<void> {
  if (!isAbsolute(opts.binary)) {
    throw new Error(
      "Native artifact verification requires an absolute executable."
    );
  }
  const binary = opts.binary;
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "hack-native-artifact-"))
  );
  try {
    await chmod(root, 0o700);
    const home = join(root, "candidate");
    const project = join(root, "project");
    await mkdir(home, { mode: 0o700 });
    await mkdir(join(project, ".hack"), { recursive: true, mode: 0o700 });
    await Bun.write(
      join(project, ".hack/hack.project.json"),
      JSON.stringify({
        schema_version: 1,
        name: "artifact-fixture",
        services: { web: { image: `sha256:${"d".repeat(64)}` } },
      })
    );
    const run = "b".repeat(32);
    const source = join(root, "source.json");
    await Bun.write(
      source,
      JSON.stringify({
        version: 2,
        kind: "native-graph-source",
        project,
        branch: null,
        run,
        profiles: [],
        overlay: "inherit",
        env_metadata: {
          metadata_version: 1,
          overlay: null,
          overlay_exists: false,
          workloads: { web: {} },
          inactive_scopes: [],
        },
      })
    );
    const review = parseNativeAuthoredReview(
      await invokeNativeRuntime({
        runtime: { binary, home },
        args: ["graph", "native", "plan", "--source-file", source, "--json"],
        cwd: project,
        timeoutMs: 10_000,
        boundNativeAuthoredReadDrain: true,
      })
    );
    const namespace = createHash("sha256").update(project).digest("hex");
    if (
      review.provenance.run !== run ||
      review.provenance.namespace !== namespace ||
      review.provenance.input.selected_profiles.length !== 0 ||
      (await readdir(home)).length !== 0
    ) {
      throw new Error("Native artifact planning capability is invalid.");
    }
  } catch {
    throw new Error(
      "Native artifact authored planning verification failed; values omitted."
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const binary = Bun.argv[2];
  if (!binary || Bun.argv.length !== 3) {
    throw new Error(
      "Usage: check-native-authored-artifact.ts /absolute/hack-native"
    );
  }
  await checkNativeAuthoredArtifact({ binary });
  process.stdout.write("Native artifact pure authored planner verified.\n");
}
