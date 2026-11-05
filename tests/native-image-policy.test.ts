import { expect, test } from "bun:test";
import { nativeImagePolicyArgs } from "../src/backends/native-image-policy.ts";
import { admitNativeProjectImages } from "../src/backends/native-project-image-admission.ts";
import type { invokeNativeRuntime } from "../src/backends/native-runtime-client.ts";
import { NativeRuntimeRequestError } from "../src/backends/native-runtime-client.ts";
import { HackCliError } from "../src/lib/cli-result.ts";

const runtime = { binary: "/fixture/hack-native", home: "/fixture/home" };

test("image policy flags come only from the named settings and default to none", () => {
  expect(nativeImagePolicyArgs({})).toEqual([]);
  expect(
    nativeImagePolicyArgs({
      HACK_NATIVE_IMAGE_BUDGET_MIB: " 4096 ",
      HACK_NATIVE_IMAGE_CACHE_MIB: "65536",
      HACK_NATIVE_LOCAL_REGISTRIES:
        "http://localhost:5000, registry.local:8443,,",
      DOCKER_CONFIG: "/fixture/docker",
      UNRELATED: "ignored",
    })
  ).toEqual([
    "--image-budget-mib",
    "4096",
    "--image-cache-mib",
    "65536",
    "--allow-local-registry",
    "http://localhost:5000",
    "--allow-local-registry",
    "registry.local:8443",
    "--docker-config",
    "/fixture/docker",
  ]);
});

test("invalid image policy settings refuse with a value-free configuration error", () => {
  for (const env of [
    { HACK_NATIVE_IMAGE_BUDGET_MIB: "8193" },
    { HACK_NATIVE_IMAGE_BUDGET_MIB: "15" },
    { HACK_NATIVE_IMAGE_BUDGET_MIB: "2GiB" },
    { HACK_NATIVE_IMAGE_CACHE_MIB: "262145" },
    {
      HACK_NATIVE_IMAGE_BUDGET_MIB: "4096",
      HACK_NATIVE_IMAGE_CACHE_MIB: "1024",
    },
    { HACK_NATIVE_IMAGE_BUDGET_MIB: "32768" },
    { HACK_NATIVE_LOCAL_REGISTRIES: "https://localhost:5000" },
    { HACK_NATIVE_LOCAL_REGISTRIES: "user:PRIVATE_CANARY@localhost" },
    { HACK_NATIVE_LOCAL_REGISTRIES: "localhost,localhost" },
    { HACK_NATIVE_LOCAL_REGISTRIES: "localhost:5000/path" },
    { DOCKER_CONFIG: "relative/PRIVATE_CANARY" },
  ]) {
    let failure: unknown;
    try {
      nativeImagePolicyArgs(env);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(HackCliError);
    expect((failure as HackCliError).code).toBe("E_CONFIG_INVALID");
    expect(String(failure)).not.toContain("PRIVATE_CANARY");
  }
});

test("admission accepts any admitted registry kind and forwards the policy flags", async () => {
  const requests: string[][] = [];
  const invoke = (async (request) => {
    requests.push([...request.args]);
    const reference = String(request.args[3]);
    return {
      reference,
      kind: reference.startsWith("ghcr.io/") ? "registry" : "docker_hub",
    };
  }) as typeof invokeNativeRuntime;
  await admitNativeProjectImages({
    runtime,
    projectRoot: "/fixture/project",
    specs: {
      web: { image: "ghcr.io/org/app:1" },
      worker: { image: "alpine:3.21" },
      pinned: { image: `sha256:${"e".repeat(64)}` },
    },
    invoke,
    env: { HACK_NATIVE_LOCAL_REGISTRIES: "http://localhost:5000" },
  });
  expect(requests).toEqual([
    [
      "runtime",
      "admit-image",
      "--reference",
      "ghcr.io/org/app:1",
      "--json",
      "--allow-local-registry",
      "http://localhost:5000",
    ],
    [
      "runtime",
      "admit-image",
      "--reference",
      "alpine:3.21",
      "--json",
      "--allow-local-registry",
      "http://localhost:5000",
    ],
  ]);
});

test("a refused local registry names the opt-in setting without echoing the reference", async () => {
  const invoke = (async () => {
    throw new NativeRuntimeRequestError({
      message: "Local registries are refused unless explicitly allowed.",
      nativeCode: "registry_image",
    });
  }) as typeof invokeNativeRuntime;
  let failure: unknown;
  try {
    await admitNativeProjectImages({
      runtime,
      projectRoot: "/fixture/project",
      specs: { web: { image: "localhost:5000/private-canary:1" } },
      invoke,
      env: {},
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(HackCliError);
  expect((failure as HackCliError).code).toBe("E_NATIVE_PROJECT_UNSUPPORTED");
  expect(String(failure)).toContain("HACK_NATIVE_LOCAL_REGISTRIES");
  expect(String(failure)).not.toContain("private-canary");
});
