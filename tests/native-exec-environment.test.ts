import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareNativeExecEnvironment } from "../src/backends/native-exec-environment.ts";
import type { NativeProjectRun } from "../src/backends/native-project-run.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function fixture() {
  const projectRoot = await mkdtemp(join(tmpdir(), "native-exec-env-"));
  roots.push(projectRoot);
  const projectDir = join(projectRoot, ".hack");
  await mkdir(projectDir);
  const composeFile = join(projectDir, "docker-compose.yml");
  await writeFile(
    composeFile,
    "services:\n  web:\n    image: fixture\n  other:\n    image: fixture\n"
  );
  await writeFile(
    join(projectDir, "hack.config.json"),
    JSON.stringify({ name: "fixture", env: { defaultOverlay: "other" } })
  );
  for (const [name, value] of [
    ["default", "base"],
    ["qa", "selected"],
    ["other", "wrong-default"],
  ]) {
    await writeFile(
      join(projectDir, `hack.env.${name}.yaml`),
      JSON.stringify({
        version: 1,
        environment: name,
        secretsprovider: "project_key",
        values: {
          global: { VALUE: value },
          other: { OTHER_ONLY: "not-selected" },
        },
      })
    );
  }
  const run: NativeProjectRun = {
    run: "a".repeat(32),
    owner: "b".repeat(32),
    namespace: "c".repeat(64),
    planId: "d".repeat(64),
    effectiveEnvName: "qa",
    aws: null,
  };
  return {
    scope: { projectRoot, projectDir, nativeHome: projectRoot, branch: null },
    composeFile,
    run,
    service: "web",
  };
}
test("fresh exec reads selected service overlay and ignores a changed default", async () => {
  const opts = await fixture();
  expect(await prepareNativeExecEnvironment(opts)).toEqual({
    VALUE: "selected",
  });
  expect(
    await prepareNativeExecEnvironment({
      ...opts,
      run: { ...opts.run, effectiveEnvName: null },
    })
  ).toEqual({ VALUE: "base" });
});
test("fresh exec refuses missing selectors or deleted overlays before AWS export", async () => {
  const opts = await fixture();
  let calls = 0;
  const adaptAws: NonNullable<
    Parameters<typeof prepareNativeExecEnvironment>[0]["adaptAws"]
  > = async () => {
    calls++;
    throw new Error("unexpected export");
  };
  const { aws: _aws, ...legacy } = opts.run;
  await expect(
    prepareNativeExecEnvironment({ ...opts, run: legacy, adaptAws })
  ).rejects.toThrow("recorded startup");
  await rm(join(opts.scope.projectDir, "hack.env.qa.yaml"));
  await expect(
    prepareNativeExecEnvironment({
      ...opts,
      run: { ...opts.run, aws: { profile: "qa" } },
      adaptAws,
    })
  ).rejects.toThrow("unavailable");
  expect(calls).toBe(0);
});
test("fresh exec uses only saved AWS selection and omits adapter failure details", async () => {
  const opts = await fixture();
  const run = {
    ...opts.run,
    aws: { profile: "saved-qa", region: "us-east-1" },
  };
  const values = await prepareNativeExecEnvironment({
    ...opts,
    run,
    adaptAws: async (request) => {
      expect(request.profile).toBe("saved-qa");
      expect(request.region).toBe("us-east-1");
      return {
        input: {
          ...request.input,
          managedEnvironment: {
            ...request.input.managedEnvironment,
            web: { VALUE: "selected", AWS_ACCESS_KEY_ID: "synthetic-fresh" },
          },
        },
        receipt: {
          profile: request.profile,
          expiry: "2099-01-01T00:00:00Z",
          services: ["web"],
        },
      };
    },
  });
  expect(values).toEqual({
    VALUE: "selected",
    AWS_ACCESS_KEY_ID: "synthetic-fresh",
  });
  await expect(
    prepareNativeExecEnvironment({
      ...opts,
      run,
      adaptAws: async () => {
        throw new Error("synthetic-private-detail");
      },
    })
  ).rejects.toThrow("Values omitted");
});
