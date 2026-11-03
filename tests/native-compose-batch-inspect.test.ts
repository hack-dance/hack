import { expect, test } from "bun:test";
import { inspectNativeComposeContainers } from "../src/lib/native-compose-batch-inspect.ts";
import { NativeComposeRoutingError } from "../src/lib/native-compose-routing.ts";

test("routing membership refusal preserves the routing error class", async () => {
  await expect(
    inspectNativeComposeContainers({
      resources: [{ id: "a".repeat(64) }],
      format: "projection",
      probe: async () => "{}",
      refuse: () => {
        throw new NativeComposeRoutingError();
      },
    })
  ).rejects.toBeInstanceOf(NativeComposeRoutingError);
});

const resources = Array.from({ length: 129 }, (_, index) => ({
  id: index.toString(16).padStart(64, "0"),
  service: `service-${index}`,
}));
test("fresh bounded batches preserve selected identity and order", async () => {
  const calls: (readonly string[])[] = [];
  const observed = await inspectNativeComposeContainers({
    resources,
    format: "projection",
    probe: async (args) => {
      calls.push(args);
      return args
        .slice(4)
        .toReversed()
        .map((id) => JSON.stringify({ id, policy: "checked-by-caller" }))
        .join("\n");
    },
  });
  expect(calls.map((args) => args.length - 4)).toEqual([64, 64, 1]);
  expect(observed.map(({ resource, row }) => [resource.id, row.id])).toEqual(
    resources.map(({ id }) => [id, id])
  );
});
for (const mode of [
  "missing",
  "duplicate",
  "foreign",
  "malformed",
  "nonrecord",
] as const) {
  test(`batch ${mode} rows cannot substitute for exact selected IDs`, async () => {
    const selected = resources.slice(0, 2);
    const rows = selected.map(({ id }) => JSON.stringify({ id }));
    if (mode === "missing") {
      rows.pop();
    }
    if (mode === "duplicate") {
      rows[1] = rows[0]!;
    }
    if (mode === "foreign") {
      rows[1] = JSON.stringify({ id: resources[2]!.id });
    }
    if (mode === "malformed") {
      rows[1] = "{";
    }
    if (mode === "nonrecord") {
      rows[1] = "null";
    }
    await expect(
      inspectNativeComposeContainers({
        resources: selected,
        format: "projection",
        probe: async () => rows.join("\n"),
      })
    ).rejects.toThrow();
  });
}
test("duplicate selection refuses before probing", async () => {
  let probes = 0;
  await expect(
    inspectNativeComposeContainers({
      resources: [resources[0]!, resources[0]!],
      format: "projection",
      probe: async () => {
        probes++;
        return "";
      },
    })
  ).rejects.toThrow();
  expect(probes).toBe(0);
});
