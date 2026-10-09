import { expect, test } from "bun:test";
import { isRecord } from "../src/lib/guards.ts";
import {
  nativeProtectedFileContainerInspectFormat,
  nativeProtectedFileRemovalMatches,
} from "./e2e/scenarios/native-config-protected-files.ts";
import {
  DOCKER_FORMAT_CONTAINER_ID,
  withDockerContainerFormatFixture,
} from "./helpers/docker-container-format.ts";

const bind = {
    type: "bind",
    name: "",
    source: "/synthetic/config",
    target: "/config",
    rw: false,
  },
  volume = {
    type: "volume",
    name: "synthetic_data",
    source: "/var/lib/docker/volumes/synthetic_data/_data",
    target: "/data",
    rw: true,
  },
  pin = {
    id: DOCKER_FORMAT_CONTAINER_ID,
    createdAt: "2026-01-01T00:00:00Z",
    image: `sha256:${"b".repeat(64)}`,
    labels: { "com.docker.compose.project": "synthetic" },
    command: ["synthetic"],
    entrypoint: null,
    running: true,
    status: "running",
    paused: false,
    ports: null,
    publishAll: false,
    runtimePorts: {},
    mounts: [bind, volume],
    networks: [],
  };

test("saved cleanup keeps exact empty bind name and literal volume name", () => {
  const stopped = { ...pin, running: false, status: "exited" };
  const { name: _volumeName, ...unnamedVolume } = volume;
  expect(
    nativeProtectedFileRemovalMatches({
      kind: "container",
      pin,
      current: stopped,
    })
  ).toBe(true);
  for (const mounts of [
    [{ ...bind, name: false }, volume],
    [{ ...bind, name: null }, volume],
    [{ ...bind, name: "foreign" }, volume],
    [bind, unnamedVolume],
    [bind, { ...volume, name: "" }],
    [bind, { ...volume, name: "foreign" }],
    [{ ...bind, rw: true }, volume],
    [{ ...bind, source: "/foreign" }, volume],
  ]) {
    expect(
      nativeProtectedFileRemovalMatches({
        kind: "container",
        pin,
        current: { ...stopped, mounts },
      })
    ).toBe(false);
  }
});
const binary = process.env.HACK_TEST_DOCKER_FORMAT_BINARY,
  sha256 = process.env.HACK_TEST_DOCKER_FORMAT_SHA256;
test.skipIf(binary === undefined && sha256 === undefined)(
  "maintained protected formatter accepts an omitted bind Name without changing strict saved mount identity",
  async () => {
    if (!(binary && sha256)) {
      throw new Error("Explicit pinned Docker format client is required");
    }
    const container = {
      Id: pin.id,
      Name: "/synthetic-db-1",
      Created: pin.createdAt,
      Image: pin.image,
      Config: {
        Labels: pin.labels,
        Cmd: pin.command,
        Entrypoint: pin.entrypoint,
      },
      State: { Running: true, Status: "running", Paused: false },
      HostConfig: { PortBindings: null, PublishAllPorts: false },
      NetworkSettings: { Ports: {}, Networks: {} },
      Mounts: [
        {
          Type: bind.type,
          Source: bind.source,
          Destination: bind.target,
          RW: bind.rw,
        },
        {
          Type: volume.type,
          Name: volume.name,
          Source: volume.source,
          Destination: volume.target,
          RW: volume.rw,
        },
      ],
    };
    await withDockerContainerFormatFixture({
      binary,
      sha256,
      container,
      observe: async (probe) => {
        const value: unknown = JSON.parse(
          await probe(nativeProtectedFileContainerInspectFormat)
        );
        if (!isRecord(value)) {
          throw new Error("Synthetic protected projection is malformed");
        }
        expect(value.mounts).toEqual(pin.mounts);
        expect(
          nativeProtectedFileRemovalMatches({
            kind: "container",
            pin: value,
            current: { ...value, running: false, status: "exited" },
          })
        ).toBe(true);
      },
    });
  },
  20_000
);
