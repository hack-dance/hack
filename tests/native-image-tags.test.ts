import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  batchImageFailure,
  pendingImageProofReason,
} from "../src/backends/native-image-policy.ts";
import {
  nativeImageBlocker,
  pullNativeProjectImages,
} from "../src/backends/native-image-tags.ts";

import { PROJECT_ENV_KEY_FILENAME } from "../src/constants.ts";
import { setProjectEnvValue } from "../src/lib/project-env-config.ts";

const runtime = { binary: "/fixture/hack-native", home: "/fixture/home" };
const projectRoot = "/fixture/project";

test("an unavailable tag names the missing image and the locally observed images", async () => {
  const missing = "docker.io/fixture/image:missing";
  const present = "docker.io/fixture/image:loaded";
  const refusal = await nativeImageBlocker({
    runtime,
    projectRoot,
    missing,
    references: [missing, present],
    confirmed: new Set(),
    invoke: async (request) => {
      expect(request.args).toEqual([
        "runtime",
        "image-tag-status",
        "--present",
        "--json",
        missing,
        present,
      ]);
      return [present];
    },
  });
  expect(refusal.message.split("\n")).toEqual([
    `Image unavailable: ${missing} has no usable recorded resolution in the running guest.`,
    `Already present: ${present}.`,
    "Run hack pull when the registry is reachable, then retry hack up.",
  ]);
});

test("an unsafe pending proof names only the admitted relative file", () => {
  const path = `artifacts/image-proofs/${"a".repeat(64)}.pending`;
  const value = {
    code: "image_proof_pending",
    state_component: { version: 1, path },
  };
  expect(pendingImageProofReason(value)).toContain(path);
  expect(batchImageFailure("example/image:stable", value, []).reason).toContain(
    path
  );
  expect(
    pendingImageProofReason({
      ...value,
      state_component: { path: "/untrusted/pending" },
    })
  ).toBeUndefined();
});

test.each([
  "supported",
  "unsupported field",
  "unsupported base",
  "managed argument",
])("native pull acquires service images first: %s", async (scenario) => {
  const root = await mkdtemp(join(tmpdir(), "native-pull-build-"));
  try {
    const projectDir = join(root, ".hack");
    await mkdir(projectDir);
    const composeFile = join(projectDir, "compose.yaml");
    const id = `sha256:${"a".repeat(64)}`;
    const base = "docker.io/library/alpine:3.20";
    const fixtureValue = "synthetic-managed-fixture";
    if (scenario === "managed argument") {
      await writeFile(join(root, PROJECT_ENV_KEY_FILENAME), "synthetic-key");
      await setProjectEnvValue({
        projectRoot: root,
        projectDir,
        envName: null,
        scope: "global",
        key: "FIXTURE_KEY",
        value: fixtureValue,
        secret: true,
      });
    }
    await writeFile(
      composeFile,
      `services:
  service:
    image: ${id}
  app:
    build:
      context: ..
${scenario === "unsupported field" ? "      ssh: [default]\n" : ""}${scenario === "managed argument" ? `      args: { BASE: ${fixtureValue} }\n` : ""}`
    );
    const confirmed: string[] = [];
    const pull = pullNativeProjectImages({
      project: { projectDir, projectRoot: root, composeFile },
      runtime,
      profiles: [],
      invoke: async ({ args }) => {
        if (args[1] === "build-image") {
          expect(confirmed).toEqual([id]);
          expect(scenario).not.toBe("managed argument");
          if (scenario === "unsupported base") {
            throw new Error("Use public Docker Hub images.");
          }
          return [base];
        }
        expect(args[1]).toBe("ensure-image");
        expect(args).toContain("refresh");
        confirmed.push(args[3] ?? "");
        return {
          phase: "content-id-verified",
          image_id: id,
          pinned_reference: `docker.io/library/alpine@${id}`,
        };
      },
    });
    if (scenario === "supported") {
      expect(await pull).toHaveLength(2);
      expect(confirmed).toEqual([id, base]);
    } else {
      const error = await pull.catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain(
        "Native pull could not confirm build bases"
      );
      expect(String(error)).not.toContain("foreground up");
      if (scenario === "managed argument") {
        expect(String(error)).toContain("build arg BASE");
        expect(String(error)).not.toContain(fixtureValue);
      }
      expect(confirmed).toEqual([id]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
