import { expect, test } from "bun:test";
import { isRecord } from "../src/lib/guards.ts";
import { nativeComposeProbeFailure } from "../src/lib/native-compose-ownership.ts";
import { decodeNativeComposeVmFileImage } from "../src/lib/native-compose-vm-file-owner.ts";
import {
  resolveVmFileOwnership,
  VM_FILE_IMAGE_FORMAT,
} from "../src/lib/native-compose-vm-file-protocol.ts";
import {
  DOCKER_FORMAT_IMAGE_ID,
  withDockerImageFormatFixture,
} from "./helpers/docker-image-format.ts";

const binary = process.env.HACK_TEST_DOCKER_FORMAT_BINARY,
  sha256 = process.env.HACK_TEST_DOCKER_FORMAT_SHA256;
const image = { Id: DOCKER_FORMAT_IMAGE_ID, Config: {} };
function decode(value: unknown) {
  return decodeNativeComposeVmFileImage({
    value,
    workload: "reader",
    reference: "synthetic/reader:1",
  });
}

test.skipIf(binary === undefined && sha256 === undefined)(
  "real Docker formatter defaults only absent image User, Volumes and Labels",
  async () => {
    if (!(binary && sha256)) {
      throw new Error("Explicit pinned Docker format client is required");
    }
    await withDockerImageFormatFixture({
      binary,
      sha256,
      image,
      observe: async (probe) => {
        let failure: unknown;
        try {
          await probe(
            '{"id":{{json .Id}},"user":{{json .Config.User}},"volumes":{{json .Config.Volumes}}}'
          );
        } catch (error: unknown) {
          failure = error;
        }
        expect(nativeComposeProbeFailure(failure)).toBe("child");
        const projected: unknown = JSON.parse(
          await probe(VM_FILE_IMAGE_FORMAT)
        );
        expect(projected).toEqual({
          id: image.Id,
          user: "",
          volumes: null,
          labels: null,
        });
        const selected = decode(projected);
        expect(selected).toEqual({
          workload: "reader",
          reference: "synthetic/reader:1",
          id: image.Id,
          user: "",
          labels: {},
        });
        expect(resolveVmFileOwnership({ imageUser: selected.user })).toEqual({
          uid: 0,
          gid: 0,
        });
      },
    });
  },
  20_000
);

test.skipIf(binary === undefined && sha256 === undefined)(
  "real Docker formatter preserves explicit empty fields and inherited image labels",
  async () => {
    if (!(binary && sha256)) {
      throw new Error("Explicit pinned Docker format client is required");
    }
    const labels = { "org.opencontainers.image.title": "synthetic" };
    await withDockerImageFormatFixture({
      binary,
      sha256,
      image: { ...image, Config: { User: "", Volumes: {}, Labels: labels } },
      observe: async (probe) => {
        const projected: unknown = JSON.parse(
          await probe(VM_FILE_IMAGE_FORMAT)
        );
        expect(projected).toEqual({
          id: image.Id,
          user: "",
          volumes: {},
          labels,
        });
        expect(decode(projected).labels).toEqual(labels);
      },
    });
  },
  20_000
);

test.skipIf(binary === undefined && sha256 === undefined)(
  "real Docker formatter preserves nullable image fields and numeric user intent",
  async () => {
    if (!(binary && sha256)) {
      throw new Error("Explicit pinned Docker format client is required");
    }
    await withDockerImageFormatFixture({
      binary,
      sha256,
      image: {
        ...image,
        Config: { User: "10001:10002", Volumes: null, Labels: null },
      },
      observe: async (probe) => {
        const projected: unknown = JSON.parse(
          await probe(VM_FILE_IMAGE_FORMAT)
        );
        expect(projected).toEqual({
          id: image.Id,
          user: "10001:10002",
          volumes: null,
          labels: null,
        });
        expect(decode(projected).user).toBe("10001:10002");
      },
    });
  },
  20_000
);

const malformed = [
  { key: "User", field: "user", value: null },
  { key: "User", field: "user", value: false },
  { key: "User", field: "user", value: 0 },
  { key: "User", field: "user", value: [] },
  { key: "User", field: "user", value: {} },
  { key: "Volumes", field: "volumes", value: false },
  { key: "Volumes", field: "volumes", value: [] },
  { key: "Volumes", field: "volumes", value: { "/foreign": {} } },
  { key: "Labels", field: "labels", value: false },
  { key: "Labels", field: "labels", value: [] },
  { key: "Labels", field: "labels", value: { owner: null } },
] as const;
test.skipIf(binary === undefined && sha256 === undefined).each([...malformed])(
  "real Docker formatter never defaults a malformed present image field: %j",
  async ({ key, field, value }) => {
    if (!(binary && sha256)) {
      throw new Error("Explicit pinned Docker format client is required");
    }
    await withDockerImageFormatFixture({
      binary,
      sha256,
      image: { ...image, Config: { [key]: value } },
      observe: async (probe) => {
        let text: string;
        try {
          text = await probe(VM_FILE_IMAGE_FORMAT);
        } catch (error: unknown) {
          if (value === null) {
            throw error;
          }
          expect(nativeComposeProbeFailure(error)).toBe("child");
          return;
        }
        const projected: unknown = JSON.parse(text);
        expect(isRecord(projected)).toBe(true);
        if (!isRecord(projected)) {
          throw new Error("Synthetic image projection is malformed");
        }
        expect(projected[field]).toEqual(value);
        expect(() => decode(projected)).toThrow("unsafe or changed");
      },
    });
  },
  20_000
);
