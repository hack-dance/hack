import { expect, test } from "bun:test";
import { isRecord } from "../src/lib/guards.ts";
import { legacyComposeAdoptionContainerInspectFormat } from "../src/lib/native-compose-adoption-binding.ts";
import { nativeComposeProbeFailure } from "../src/lib/native-compose-ownership.ts";
import { adoptionDependencyReadAllowed } from "./e2e/scenarios/native-compose-adoption-dependency-inputs.ts";
import {
  DOCKER_FORMAT_CONTAINER_ID,
  withDockerContainerFormatFixture,
} from "./helpers/docker-container-format.ts";

const SYNTHETIC_CONTAINER = {
  Id: DOCKER_FORMAT_CONTAINER_ID,
  Name: "/synthetic-db-1",
  Config: {
    Labels: {
      "com.docker.compose.project": "synthetic",
      "com.docker.compose.service": "db",
      "com.docker.compose.container-number": "1",
      "com.docker.compose.oneoff": "False",
      "com.docker.compose.project.working_dir": "/synthetic/.hack",
      "com.docker.compose.project.config_files":
        "/synthetic/.hack/docker-compose.yml",
    },
  },
  State: { Running: true },
  Mounts: [
    {
      Type: "bind",
      Source: "/synthetic/config",
      Destination: "/config",
      RW: false,
    },
    {
      Type: "volume",
      Name: "synthetic_data",
      Source: "/var/lib/docker/volumes/synthetic_data/_data",
      Destination: "/data",
      RW: true,
    },
  ],
  NetworkSettings: {
    Networks: { synthetic_default: { NetworkID: "b".repeat(64) } },
  },
};
const binary = process.env.HACK_TEST_DOCKER_FORMAT_BINARY,
  sha256 = process.env.HACK_TEST_DOCKER_FORMAT_SHA256;
function forwardingAllowed(format: string): boolean {
  return adoptionDependencyReadAllowed({
    projectRoot: "/synthetic",
    project: "synthetic",
    containerIds: [DOCKER_FORMAT_CONTAINER_ID],
    networkId: "b".repeat(64),
    volumeName: "synthetic_data",
    args: [
      "container",
      "inspect",
      "--format",
      format,
      DOCKER_FORMAT_CONTAINER_ID,
    ],
  });
}
test.skipIf(binary === undefined && sha256 === undefined)(
  "real pinned Docker formatter accepts omitted bind Name while preserving volume name",
  async () => {
    if (!(binary && sha256)) {
      throw new Error("Explicit pinned Docker format client is required");
    }
    await withDockerContainerFormatFixture({
      binary,
      sha256,
      container: SYNTHETIC_CONTAINER,
      observe: async (probe) => {
        const old = legacyComposeAdoptionContainerInspectFormat.replace(
          '{{$name := ""}}{{range $key, $value := $m}}{{if eq $key "Name"}}{{$name = $value}}{{end}}{{end}}{{json $name}}',
          "{{json $m.Name}}"
        );
        expect(old).not.toBe(legacyComposeAdoptionContainerInspectFormat);
        expect(forwardingAllowed(old)).toBe(false);
        expect(
          forwardingAllowed(legacyComposeAdoptionContainerInspectFormat)
        ).toBe(true);
        let failure: unknown;
        try {
          await probe(old);
        } catch (error: unknown) {
          failure = error;
        }
        expect(nativeComposeProbeFailure(failure)).toBe("child");
        const value: unknown = JSON.parse(
          await probe(legacyComposeAdoptionContainerInspectFormat)
        );
        if (!isRecord(value)) {
          throw new Error("Synthetic container projection is malformed");
        }
        expect(value.id).toBe(DOCKER_FORMAT_CONTAINER_ID);
        expect(value.mounts).toEqual([
          {
            type: "bind",
            name: "",
            source: "/synthetic/config",
            target: "/config",
            rw: false,
          },
          {
            type: "volume",
            name: "synthetic_data",
            source: "/var/lib/docker/volumes/synthetic_data/_data",
            target: "/data",
            rw: true,
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
    { name: false },
    { name: 0 },
    { name: null },
    { name: [] },
    { name: {} },
  ])(
  "real client preserves or refuses malformed bind Name without empty normalization: %j",
  async ({ name }) => {
    if (!(binary && sha256)) {
      throw new Error("Explicit pinned Docker format client is required");
    }
    const container = {
      ...SYNTHETIC_CONTAINER,
      Mounts: [{ ...SYNTHETIC_CONTAINER.Mounts[0], Name: name }],
    };
    await withDockerContainerFormatFixture({
      binary,
      sha256,
      container,
      observe: async (probe) => {
        expect(
          forwardingAllowed(legacyComposeAdoptionContainerInspectFormat)
        ).toBe(true);
        let text: string;
        try {
          text = await probe(legacyComposeAdoptionContainerInspectFormat);
        } catch (error: unknown) {
          // Null must reach the presence-specific template. Other malformed
          // types may be refused by the client before returning a projection.
          if (name === null) {
            throw error;
          }
          expect(nativeComposeProbeFailure(error)).toBe("child");
          return;
        }
        const value: unknown = JSON.parse(text);
        if (
          !(
            isRecord(value) &&
            Array.isArray(value.mounts) &&
            isRecord(value.mounts[0])
          )
        ) {
          throw new Error("Synthetic container projection is malformed");
        }
        expect(value.mounts[0].name).toEqual(name);
        expect(value.mounts[0].name).not.toBe("");
      },
    });
  },
  20_000
);
test.skipIf(binary === undefined && sha256 === undefined)(
  "closed dependency forwarder preserves an explicit empty bind Name through the real formatter",
  async () => {
    if (!(binary && sha256)) {
      throw new Error("Explicit pinned Docker format client is required");
    }
    await withDockerContainerFormatFixture({
      binary,
      sha256,
      container: {
        ...SYNTHETIC_CONTAINER,
        Mounts: [
          { ...SYNTHETIC_CONTAINER.Mounts[0], Name: "" },
          SYNTHETIC_CONTAINER.Mounts[1],
        ],
      },
      observe: async (probe) => {
        expect(
          forwardingAllowed(legacyComposeAdoptionContainerInspectFormat)
        ).toBe(true);
        const value: unknown = JSON.parse(
          await probe(legacyComposeAdoptionContainerInspectFormat)
        );
        if (
          !(
            isRecord(value) &&
            Array.isArray(value.mounts) &&
            isRecord(value.mounts[0]) &&
            isRecord(value.mounts[1])
          )
        ) {
          throw new Error("Synthetic container projection is malformed");
        }
        expect(value.mounts[0].name).toBe("");
        expect(value.mounts[1].name).toBe("synthetic_data");
      },
    });
  },
  20_000
);
