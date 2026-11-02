import { expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkNativeAuthoredArtifact } from "../scripts/check-native-authored-artifact.ts";

test("candidate host manifest retains every capability and checks the packaged authored planner", async () => {
  const script = await Bun.file("scripts/build-native-candidate.sh").text();
  const hostFeatures = script.match(
    /--features ([a-z0-9,-]+) \\\n\s+--manifest-path packages\/runtime-core\/Cargo\.toml/
  );
  expect(hostFeatures?.[1]?.split(",").sort()).toEqual(
    [
      "installed-candidate",
      "native-config-plan",
      "native-http-probe",
      "native-stream-relay",
      "environment-launcher",
      "shared-mcp",
    ].sort()
  );
  expect(script).toContain(
    'bun scripts/check-native-authored-artifact.ts "$out/hack-native"'
  );
});

test.each([
  "valid",
  "missing-feature",
  "foreign-namespace",
  "foreign-run",
  "stateful-plan",
  "malformed",
] as const)("actual executable capability checker handles %s without retaining private fixtures", async (mode) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-artifact-test-"))
  );
  try {
    const binary = join(root, "hack-native");
    await Bun.write(
      binary,
      `#!${process.execPath}
import {createHash} from "node:crypto";
const args=process.argv.slice(2),home=args[1],mode=${JSON.stringify(mode)};
if(args.length!==8 || args[0]!=="--candidate-root" || args.slice(2,6).join(",")!=="graph,native,plan,--source-file" || args[7]!=="--json") process.exit(91);
const source=JSON.parse(await Bun.file(args[6]).text());
await Bun.write(${JSON.stringify(join(root, "fixture"))},JSON.stringify({home,project:source.project,source:args[6]}));
if(mode==="missing-feature") {console.error("private-artifact-canary");process.exit(1)}
if(mode==="malformed") {console.log("private-artifact-canary");process.exit(0)}
const provenance={version:1,kind:"native",namespace:createHash("sha256").update(source.project).digest("hex"),run:source.run,input:{semantic_hash:"c".repeat(64),local_resolution_hash:"d".repeat(64),environment_policy_hash:"e".repeat(64),selected_profiles:[]}};
if(mode==="foreign-namespace") provenance.namespace="f".repeat(64);
if(mode==="foreign-run") provenance.run="a".repeat(32);
if(mode==="stateful-plan") await Bun.write(home+"/provider-state","unexpected");
const review_id=createHash("sha256").update("hack.native-graph-review/v1\\0").update(JSON.stringify(provenance)).digest("hex");
console.log(JSON.stringify({provenance,review_id}));
`
    );
    await chmod(binary, 0o700);
    if (mode === "valid") {
      await checkNativeAuthoredArtifact({ binary });
    } else {
      await expect(checkNativeAuthoredArtifact({ binary })).rejects.toThrow(
        "Native artifact authored planning verification failed; values omitted."
      );
    }
    const fixture = await Bun.file(join(root, "fixture")).json();
    for (const path of [fixture.home, fixture.project, fixture.source]) {
      await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
