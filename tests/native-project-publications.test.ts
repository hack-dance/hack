import { expect, test } from "bun:test";
import {
  nativeDeclaredPorts,
  nativeObservedPorts,
  nativePublisherExitNotice,
} from "../src/backends/native-project-publications.ts";

const run = "a".repeat(32);
test("publisher notices bind the run and print only validated port intent", () => {
  const event = { kind: "graph_publisher_exit", run, port: 18_080 };
  expect(nativePublisherExitNotice(JSON.stringify(event), run)).toContain(
    "127.0.0.1:18080 is down"
  );
  expect(nativePublisherExitNotice(JSON.stringify(event), run)).toContain(
    "Run hack down"
  );
  for (const value of [
    { ...event, run: "b".repeat(32) },
    { ...event, port: "private-value" },
    { ...event, port: 0 },
    { kind: "other" },
  ]) {
    expect(nativePublisherExitNotice(JSON.stringify(value), run)).toBeNull();
  }
});
test("receipt port intent is unconfirmed until the current owner reports a complete selection", () => {
  const ports = nativeDeclaredPorts({
    web: {
      kind: "container",
      key: "web",
      loopback_ports: [{ host_port: 18_080, target: 8080 }],
    },
  });
  expect(ports).toEqual([
    { service: "web", port: 18_080, target: 8080, state: "unconfirmed" },
  ]);
  expect(
    nativeObservedPorts(ports, [{ port: 18_080, state: "down" }])[0]?.state
  ).toBe("down");
  expect(
    nativeObservedPorts(ports, [{ port: 18_080, state: "observed" }])[0]?.state
  ).toBe("observed");
  for (const value of [
    null,
    [],
    [{ port: 18_081, state: "observed" }],
    [{ port: 18_080, state: "ready" }],
    [
      { port: 18_080, state: "down" },
      { port: 18_080, state: "observed" },
    ],
  ]) {
    expect(nativeObservedPorts(ports, value)).toEqual(ports);
  }
});
