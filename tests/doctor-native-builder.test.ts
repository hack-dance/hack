import { expect, test } from "bun:test";
import { buildDoctorJsonData } from "../src/commands/doctor.ts";
import { doctorMetadata } from "../src/lib/doctor-metadata.ts";
import {
  checkNativeImageBuilder,
  countNativeBuildServices,
  NATIVE_BUILDER_CHECK,
  nativeBuilderCheckResult,
} from "../src/lib/doctor-native-builder.ts";
import { nativeBuilderRemedy } from "../src/lib/native-image-builder.ts";
import { nativeSetupInspection } from "./helpers/native-setup-inspection.ts";

const runtime = {
  binary: "/opt/hack/hack-native",
  home: "/opt/hack/native-home",
};
const launcher = { kind: "stable", command: "hack" } as const;
const REMEDY =
  "Run hack native setup --accept-downloads to add it; offline, add --builder <pinned builder file> to the offline setup inputs.";

const built = {
  services: {
    web: { build: { context: "." } },
    worker: { build: "worker" },
    cache: { image: "redis:7" },
  },
};
const imagesOnly = { services: { web: { image: "nginx:1" }, db: {} } };

/** A runtime whose setup inspection reports this builder state, and what it was asked. */
function inspecting(state: string | undefined) {
  const requests: (readonly string[])[] = [];
  const invoke = (opts: { readonly args: readonly string[] }) => {
    requests.push(opts.args);
    return Promise.resolve({
      ...nativeSetupInspection(),
      pins: [
        ...nativeSetupInspection().pins,
        {
          url: "https://example.invalid/builder.bin",
          size_bytes: 7,
          archive_sha256: "b".repeat(64),
        },
      ],
      ...(state === undefined
        ? {}
        : { builder: { state, file: "builder.bin" } }),
    });
  };
  return { requests, invoke: invoke as never };
}

test("a project that builds images on a home without the builder is a warning with the setup remedy", async () => {
  const { requests, invoke } = inspecting("not_prepared");
  const check = await checkNativeImageBuilder({
    runtime,
    cwd: "/project",
    compose: built,
    invoke,
    launcher,
  });
  // A finding, never a failure of doctor itself.
  expect(check).toEqual({
    name: "native image builder",
    status: "warn",
    message: `2 services build an image, but the image builder is not installed in this native home, so native up cannot build them. ${REMEDY}`,
    nativeBuilder: { buildServices: 2, builder: "not_prepared" },
  });
  // The same remedy the build-time refusal gives.
  expect(check.message).toEndWith(nativeBuilderRemedy(launcher));
  // The one request is the read-only inspection: nothing is set up or downloaded.
  expect(requests).toEqual([["runtime", "setup", "inspect", "--json"]]);

  const one = nativeBuilderCheckResult({
    buildServices: 1,
    builder: "not_prepared",
    launcher: { kind: "bundle", command: "/opt/bundle/hack-v5" },
  });
  expect(one.message).toBe(
    "1 service builds an image, but the image builder is not installed in this native home, so native up cannot build it. Run /opt/bundle/hack-v5 native setup --accept-downloads to add it; offline, add --builder <pinned builder file> to the offline setup inputs."
  );
});

test("a project without build services is ok and asks the runtime nothing", async () => {
  for (const compose of [imagesOnly, { services: {} }, {}, undefined, "x"]) {
    const { requests, invoke } = inspecting("not_prepared");
    const check = await checkNativeImageBuilder({
      runtime,
      cwd: "/project",
      compose,
      invoke,
    });
    expect(check).toEqual({
      name: NATIVE_BUILDER_CHECK,
      status: "ok",
      message:
        "No service builds an image, so this project does not need the native image builder.",
      nativeBuilder: { buildServices: 0, builder: "not_checked" },
    });
    expect(requests).toEqual([]);
  }
  expect(countNativeBuildServices(built)).toBe(2);
  expect(
    countNativeBuildServices({ services: { web: { build: null }, x: 1 } })
  ).toBe(0);
});

test("a prepared builder is ok", async () => {
  const { requests, invoke } = inspecting("prepared");
  const check = await checkNativeImageBuilder({
    runtime,
    cwd: "/project",
    compose: built,
    invoke,
  });
  expect(check).toEqual({
    name: NATIVE_BUILDER_CHECK,
    status: "ok",
    message:
      "2 services build an image; the image builder is installed in this native home.",
    nativeBuilder: { buildServices: 2, builder: "prepared" },
  });
  expect(requests).toEqual([["runtime", "setup", "inspect", "--json"]]);
});

test("a changed builder, a silent runtime and a failed inspection warn without claiming either state", async () => {
  const changed = await checkNativeImageBuilder({
    runtime,
    cwd: "/project",
    compose: built,
    invoke: inspecting("changed").invoke,
  });
  expect(changed).toMatchObject({
    status: "warn",
    nativeBuilder: { buildServices: 2, builder: "changed" },
  });
  expect(changed.message).toContain("is not the one its record describes");
  expect(changed.message).not.toContain("--accept-downloads");
  // An older runtime does not report the builder; a failing one reports nothing.
  const failing = () => Promise.reject(new Error("runtime unavailable"));
  for (const invoke of [inspecting(undefined).invoke, failing as never]) {
    const check = await checkNativeImageBuilder({
      runtime,
      cwd: "/project",
      compose: built,
      invoke,
    });
    expect(check).toMatchObject({
      status: "warn",
      nativeBuilder: { buildServices: 2, builder: "unknown" },
    });
    expect(check.message).toContain("could not be checked");
    expect(check.message).not.toContain("runtime unavailable");
  }
});

test("doctor JSON carries the builder report on a native project check with no runnable fix", () => {
  const check = nativeBuilderCheckResult({
    buildServices: 2,
    builder: "not_prepared",
    launcher,
  });
  const data = buildDoctorJsonData({
    results: [{ ...check, durationMs: 3 }],
  });
  expect(data.checks[0]).toMatchObject({
    id: "native image builder",
    status: "warn",
    area: "native",
    scope: "project",
    // Adding the builder needs download consent: doctor offers no command to run.
    fix: { kind: "manual", args: [] },
    nativeBuilder: { buildServices: 2, builder: "not_prepared" },
  });
  expect(data.counts).toEqual({ ok: 0, warn: 1, error: 0 });
  expect(doctorMetadata({ id: NATIVE_BUILDER_CHECK }).fix.args).toEqual([]);
});

test("doctor has no path to setup: neither it nor this check can start a download", async () => {
  for (const file of [
    "src/commands/doctor.ts",
    "src/lib/doctor-native-builder.ts",
  ]) {
    const source = await Bun.file(file).text();
    expect(source).not.toContain("runNativeSetupChild");
    expect(source).not.toContain("requireNativeSetup");
  }
  // The check's own signature has no fix switch to forward.
  expect(checkNativeImageBuilder.length).toBe(1);
});
