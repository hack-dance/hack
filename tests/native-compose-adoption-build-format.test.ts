import { expect, test } from "bun:test";
import { isRecord } from "../src/lib/guards.ts";
import { nativeComposeProbeFailure } from "../src/lib/native-compose-ownership.ts";
import {
  RETAINED_BUILD_OBJECT_FORMAT,
  retainedBuildFixtureImage,
  retainedBuildFixtureObjectGraph,
} from "./e2e/scenarios/native-compose-adoption-build-inputs.ts";
import {
  DOCKER_FORMAT_IMAGE_ID,
  withDockerImageFormatFixture,
} from "./helpers/docker-image-format.ts";

const binary = process.env.HACK_TEST_DOCKER_FORMAT_BINARY,
  sha256 = process.env.HACK_TEST_DOCKER_FORMAT_SHA256;
const baseImage = `sha256:${"a".repeat(64)}`;
const composeVersion = "2.40.3";
const image = {
  Id: DOCKER_FORMAT_IMAGE_ID,
  Created: "2026-10-08T20:00:00.123456789Z",
  Size: 1000,
  RepoTags: ["fixture-db:latest"],
  RepoDigests: [`fixture-db@${DOCKER_FORMAT_IMAGE_ID}`],
  Config: {
    Labels: {
      "hack.e2e.retained-build.owner": "fixture",
      "hack.e2e.retained-build.stage": "retained",
      "com.docker.compose.project": "fixture",
      "com.docker.compose.service": "db",
      "com.docker.compose.version": composeVersion,
    },
  },
  RootFS: { Type: "layers", Layers: [`sha256:${"d".repeat(64)}`] },
};
const selected = retainedBuildFixtureImage({
  value: {
    id: image.Id,
    created: image.Created,
    owner: "fixture",
    stage: "retained",
    tags: image.RepoTags,
    digests: image.RepoDigests,
  },
  reference: "fixture-db",
  owner: "fixture",
  originalImageIds: [baseImage],
});
function capture(value: unknown) {
  return retainedBuildFixtureObjectGraph({
    values: [value],
    selected,
    originalImageIds: [baseImage],
    baseImage,
    composeVersion,
  });
}

test.skipIf(binary === undefined && sha256 === undefined)(
  "real pinned Docker client qualifies only absent image Parent with exact Compose labels",
  async () => {
    if (!(binary && sha256)) {
      throw new Error("Explicit pinned Docker format client is required");
    }
    await withDockerImageFormatFixture({
      binary,
      sha256,
      image,
      observe: async (probe) => {
        const old = RETAINED_BUILD_OBJECT_FORMAT.replace(
          '{{$parent := ""}}{{range $key, $value := .}}{{if eq $key "Parent"}}{{$parent = $value}}{{end}}{{end}}{{json $parent}}',
          "{{json .Parent}}"
        );
        expect(old).not.toBe(RETAINED_BUILD_OBJECT_FORMAT);
        let failure: unknown;
        try {
          await probe(old);
        } catch (error: unknown) {
          failure = error;
        }
        expect(nativeComposeProbeFailure(failure)).toBe("child");
        const value: unknown = JSON.parse(
          await probe(RETAINED_BUILD_OBJECT_FORMAT)
        );
        expect(capture(value)).toEqual([
          {
            id: image.Id,
            parent: "",
            created: image.Created,
            size: image.Size,
            owner: "fixture",
            stage: "retained",
            tags: image.RepoTags,
            digests: image.RepoDigests,
            labelNames: Object.keys(image.Config.Labels).sort(),
            composeProject: "fixture",
            composeService: "db",
            composeVersion,
          },
        ]);
      },
    });
  },
  20_000
);

test
  .skipIf(binary === undefined && sha256 === undefined)
  .each([
    { parent: null },
    { parent: false },
    { parent: 0 },
    { parent: [] },
    { parent: {} },
  ])(
  "real client preserves or refuses malformed present Parent without empty normalization: %j",
  async ({ parent }) => {
    if (!(binary && sha256)) {
      throw new Error("Explicit pinned Docker format client is required");
    }
    await withDockerImageFormatFixture({
      binary,
      sha256,
      image: { ...image, Parent: parent },
      observe: async (probe) => {
        let text: string;
        try {
          text = await probe(RETAINED_BUILD_OBJECT_FORMAT);
        } catch (error: unknown) {
          if (parent === null) {
            throw error;
          }
          expect(nativeComposeProbeFailure(error)).toBe("child");
          return;
        }
        const value: unknown = JSON.parse(text);
        if (!isRecord(value)) {
          throw new Error("Synthetic image projection is malformed");
        }
        expect(value.parent).toEqual(parent);
        expect(value.parent).not.toBe("");
        expect(() => capture(value)).toThrow("values omitted");
      },
    });
  },
  20_000
);

test.skipIf(binary === undefined && sha256 === undefined)(
  "real client keeps an explicit empty image Parent and exact birth, tag and digest",
  async () => {
    if (!(binary && sha256)) {
      throw new Error("Explicit pinned Docker format client is required");
    }
    await withDockerImageFormatFixture({
      binary,
      sha256,
      image: { ...image, Parent: "" },
      observe: async (probe) => {
        expect(
          capture(JSON.parse(await probe(RETAINED_BUILD_OBJECT_FORMAT)))[0]
        ).toMatchObject({
          id: selected.id,
          parent: "",
          created: selected.created,
          owner: selected.owner,
          tags: image.RepoTags,
          digests: image.RepoDigests,
        });
      },
    });
  },
  20_000
);
