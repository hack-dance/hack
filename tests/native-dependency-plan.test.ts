import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { emptyNativeDependencyPlanId } from "../src/backends/native-dependency-plan.ts";

/**
 * Golden vectors for the zero-binding host dependency plan ID. The expected
 * bytes are the compact serde_json encoding `graph dependency-plan` hashes
 * (`packages/runtime-core/src/graph_cli/relay.rs`, `Selection::capture`):
 * the tag, the selection with fields in struct order, and empty evidence.
 * The same vectors are proposed as a Rust unit test so both sides pin them.
 */
const VECTORS = [
  {
    plan: "a".repeat(64),
    artifact: "/opt/hack/bin/hack-relay-guest",
    artifactSha256: "b".repeat(64),
    id: "634b0e871c03bb29a6d7364c2410a7d48fc7ba3f49ed68122023cd70c28a249c",
    bytes: `["hack-graph-dependencies-v1",{"version":1,"plan":"${"a".repeat(64)}","artifact":"/opt/hack/bin/hack-relay-guest","artifact_sha256":"${"b".repeat(64)}","dependencies":[]},[]]`,
  },
  {
    // A path with a space, non-ASCII letters, a quote, a backslash and a
    // control character: serde_json and JSON.stringify escape them alike.
    plan: "0123456789abcdef".repeat(4),
    artifact: '/Users/a b/été "q"\\/\u0001/hack-relay-guest',
    artifactSha256: "c".repeat(64),
    id: "5ed5e8c2efe97563a8608a5829c4843de03271c5f1fd63a28889fc16a7ba53de",
    bytes: `["hack-graph-dependencies-v1",{"version":1,"plan":"${"0123456789abcdef".repeat(4)}","artifact":"/Users/a b/été \\"q\\"\\\\/\\u0001/hack-relay-guest","artifact_sha256":"${"c".repeat(64)}","dependencies":[]},[]]`,
  },
];

test.each(
  VECTORS
)("a graph without host dependencies gets the runtime's plan ID without a runtime call ($artifact)", (vector) => {
  expect(createHash("sha256").update(vector.bytes).digest("hex")).toBe(
    vector.id
  );
  expect(emptyNativeDependencyPlanId(vector)).toBe(vector.id);
});

test("the zero-binding plan ID binds the plan and the relay artifact", () => {
  const base = VECTORS[0];
  if (!base) {
    throw new Error("missing vector");
  }
  const id = emptyNativeDependencyPlanId(base);
  expect(
    emptyNativeDependencyPlanId({ ...base, plan: "d".repeat(64) })
  ).not.toBe(id);
  expect(
    emptyNativeDependencyPlanId({ ...base, artifactSha256: "e".repeat(64) })
  ).not.toBe(id);
  expect(
    emptyNativeDependencyPlanId({
      ...base,
      artifact: "/other/hack-relay-guest",
    })
  ).not.toBe(id);
});
