import { expect, test } from "bun:test";
import type { NativeEndpointBinding } from "../src/lib/native-endpoint-plan-protocol.ts";
import type { NativeEnvironmentPlan } from "../src/lib/native-env-plan-protocol.ts";
import {
  assertNativeHostLifecycleBindings,
  nativeHostEndpointValue,
  resolveNativeHostInvocationEnvironment,
  selectNativeHostLifecycle,
} from "../src/lib/native-host-lifecycle-contract.ts";

const invocation = {
  command: { exec: ["echo", "$EXACT"] },
  env_target: { kind: "host" },
  environment: {
    ENDPOINT: { endpoint: { kind: "host_binding", name: "api" } },
  },
} as const;
const lifecycle = () =>
  selectNativeHostLifecycle({ host: { processes: { tunnel: invocation } } });
function report(
  target: NativeEndpointBinding["target"]
): NativeEnvironmentPlan {
  return {
    plan_version: 1,
    overlay: null,
    overlay_exists: false,
    complete: true,
    workloads: {},
    warnings: [],
    diagnostics: [],
    host: {
      tunnel: {
        env_target: { kind: "host" },
        bindings: {
          ENDPOINT: {
            kind: "endpoint",
            reference: { kind: "host_binding", name: "api" },
            target,
          },
        },
      },
    },
  };
}
test("host and external endpoint delivery follows the verified host reference without changing exec bytes", () => {
  const selected = lifecycle();
  for (const [target, expected] of [
    [
      { kind: "host", context: "host", protocol: "http", port: 4321 },
      "http://127.0.0.1:4321",
    ],
    [
      {
        kind: "external",
        protocol: "https",
        hostname: "example.test",
        port: 443,
      },
      "https://example.test:443",
    ],
  ] as const) {
    const metadata = report(target);
    assertNativeHostLifecycleBindings(selected, metadata);
    expect(
      resolveNativeHostInvocationEnvironment({
        invocation: selected.processes[0]!,
        report: metadata,
      })
    ).toEqual({ ENDPOINT: expected });
    expect(selected.processes[0]!.command).toEqual({
      exec: ["echo", "$EXACT"],
    });
  }
});
test("guest, TCP, routed and workload endpoints refuse before process values or effects", () => {
  for (const target of [
    { kind: "host", context: "workload", protocol: "http", port: 4321 },
    { kind: "host", context: "host", protocol: "tcp", port: 4321 },
    { kind: "external", protocol: "tcp", hostname: "example.test", port: 1234 },
    { kind: "route", origin: "https://example.test" },
    { kind: "service", name: "api", protocol: "http", port: 80 },
  ] as const) {
    expect(() =>
      assertNativeHostLifecycleBindings(lifecycle(), report(target))
    ).toThrow("values omitted");
  }
  expect(() =>
    nativeHostEndpointValue({
      kind: "endpoint",
      reference: { kind: "route", name: "api" },
      target: {
        kind: "external",
        protocol: "https",
        hostname: "example.test",
        port: 443,
      },
    })
  ).toThrow();
});
test("host invocation name, target and directive bindings remain exact", () => {
  const selected = lifecycle();
  const metadata = report({
    kind: "host",
    context: "host",
    protocol: "https",
    port: 4321,
  });
  const bad: NativeEnvironmentPlan = {
    ...metadata,
    host: {
      tunnel: {
        ...metadata.host!.tunnel!,
        env_target: { kind: "workload", name: "web" },
      },
    },
  };
  expect(() => assertNativeHostLifecycleBindings(selected, bad)).toThrow();
  expect(() =>
    selectNativeHostLifecycle({
      host: { processes: { tunnel: { ...invocation, exit: "keep_running" } } },
    })
  ).toThrow();
  expect(() =>
    selectNativeHostLifecycle({
      host: {
        up: { before: [{ name: "tunnel", ...invocation }] },
        processes: { tunnel: invocation },
      },
    })
  ).toThrow();
});
