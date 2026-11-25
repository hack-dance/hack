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
const PATHS = {
  directory: ".hack-local/providers/builder-1.0.0",
  record: ".hack-local/providers/builder.json",
};
/** A managed candidate install: its launcher is not on PATH and lives under the home. */
const HOME = "/home-fixture";
const managed = {
  kind: "hack-next",
  command: `${HOME}/.hack-next/bin/hack-next`,
  bundle: `${HOME}/.hack-next/versions/5.0.0-next.1/bundle/hack-v5`,
} as const;
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
function inspecting(
  state: string | undefined,
  paths: { readonly directory?: string; readonly record?: string } = PATHS
) {
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
        : { builder: { state, file: "builder.bin", ...paths } }),
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
  expect(check.message).toEndWith(nativeBuilderRemedy({ launcher }));
  // The one request is the read-only inspection: nothing is set up or downloaded.
  expect(requests).toEqual([["runtime", "setup", "inspect", "--json"]]);

  const one = nativeBuilderCheckResult({
    buildServices: 1,
    builder: "not_prepared",
    launcher: { kind: "bundle", command: "/opt/bundle/hack-v5" },
  });
  // A launcher outside the home keeps its path, which runs as pasted.
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

test("with HACK_NATIVE_BUILDS=0 a project that builds images does not need the builder and asks the runtime nothing", async () => {
  const { requests, invoke } = inspecting("not_prepared");
  const check = await checkNativeImageBuilder({
    runtime,
    cwd: "/project",
    compose: built,
    invoke,
    launcher,
    buildsEnabled: false,
  });
  expect(check).toEqual({
    name: NATIVE_BUILDER_CHECK,
    status: "ok",
    message:
      "2 services build an image, but HACK_NATIVE_BUILDS=0 turns native builds off, so this project does not need the native image builder.",
    nativeBuilder: { buildServices: 2, builder: "not_checked" },
  });
  expect(requests).toEqual([]);

  // The default reads the same switch native up reads.
  const previous = process.env.HACK_NATIVE_BUILDS;
  process.env.HACK_NATIVE_BUILDS = "0";
  try {
    const fromEnv = await checkNativeImageBuilder({
      runtime,
      cwd: "/project",
      compose: built,
      invoke,
      launcher,
    });
    expect(fromEnv).toEqual(check);
    expect(requests).toEqual([]);
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, "HACK_NATIVE_BUILDS");
    } else {
      process.env.HACK_NATIVE_BUILDS = previous;
    }
  }
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
  // The same words and the same remedy `hack native setup` prints for it.
  expect(changed).toEqual({
    name: NATIVE_BUILDER_CHECK,
    status: "warn",
    message:
      "2 services build an image, but the image builder in this native home does not match the pinned release, so native up refuses to build with it. Remove .hack-local/providers/builder-1.0.0 and .hack-local/providers/builder.json from the native home, then run hack native setup --accept-downloads.",
    nativeBuilder: { buildServices: 2, builder: "changed" },
  });
  // A runtime that reports the builder's state without its paths (or with one
  // of them) is not an unknown builder: the state is kept, the missing-builder
  // remedy is unchanged, and the changed remedy says where the two paths are.
  for (const paths of [{}, { record: PATHS.record }]) {
    const missing = await checkNativeImageBuilder({
      runtime,
      cwd: "/project",
      compose: built,
      invoke: inspecting("not_prepared", paths).invoke,
      launcher,
    });
    expect(missing).toMatchObject({
      status: "warn",
      message: `2 services build an image, but the image builder is not installed in this native home, so native up cannot build them. ${REMEDY}`,
      nativeBuilder: { buildServices: 2, builder: "not_prepared" },
    });
    const withoutPaths = await checkNativeImageBuilder({
      runtime,
      cwd: "/project",
      compose: built,
      invoke: inspecting("changed", paths).invoke,
      launcher,
    });
    expect(withoutPaths).toMatchObject({
      status: "warn",
      message:
        "2 services build an image, but the image builder in this native home does not match the pinned release, so native up refuses to build with it. Remove the image builder's directory and record from .hack-local/providers in the native home, then run hack native setup --accept-downloads.",
      nativeBuilder: { buildServices: 2, builder: "changed" },
    });
    expect(
      (
        await checkNativeImageBuilder({
          runtime,
          cwd: "/project",
          compose: built,
          invoke: inspecting("prepared", paths).invoke,
        })
      ).nativeBuilder
    ).toEqual({ buildServices: 2, builder: "prepared" });
  }
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

test("doctor prints the home-relative setup command for a launcher under the home", async () => {
  // Doctor's message is also its JSON `detail`, which is stored and passed on:
  // `~/...` runs as pasted and carries no home path and no user name.
  for (const state of ["not_prepared", "changed"]) {
    const check = await checkNativeImageBuilder({
      runtime,
      cwd: "/project",
      compose: built,
      invoke: inspecting(state).invoke,
      launcher: managed,
      homeDir: HOME,
    });
    expect(check.status).toBe("warn");
    expect(check.message).toContain(
      " ~/.hack-next/bin/hack-next native setup --accept-downloads"
    );
    expect(check.message).not.toContain(HOME);
    const data = buildDoctorJsonData({
      results: [{ ...check, durationMs: 1 }],
    });
    expect(JSON.stringify(data)).not.toContain(HOME);
    expect(data.checks[0]?.detail).toBe(check.message);
  }
});
