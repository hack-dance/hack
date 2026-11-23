import { expect, test } from "bun:test";
import {
  batchImageFailure,
  pendingImageProofReason,
} from "../src/backends/native-image-policy.ts";
import { nativeImageBlocker } from "../src/backends/native-image-tags.ts";

const runtime = { binary: "/fixture/hack-native", home: "/fixture/home" };
const projectRoot = "/fixture/project";

test("an unavailable tag names the missing image and the locally observed images", async () => {
  const missing = "docker.io/fixture/image:missing";
  const present = "docker.io/fixture/image:loaded";
  const refusal = await nativeImageBlocker({
    runtime,
    projectRoot,
    missing,
    references: [missing, present],
    confirmed: new Set(),
    invoke: async (request) => {
      expect(request.args).toEqual([
        "runtime",
        "image-tag-status",
        "--present",
        "--json",
        missing,
        present,
      ]);
      return [present];
    },
  });
  expect(refusal.message.split("\n")).toEqual([
    `Image unavailable: ${missing} has no usable recorded resolution in the running guest.`,
    `Already present: ${present}.`,
    "Run hack pull when the registry is reachable, then retry hack up.",
  ]);
});

test("an unsafe pending proof names only the admitted relative file", () => {
  const path = `artifacts/image-proofs/${"a".repeat(64)}.pending`;
  const value = {
    code: "image_proof_pending",
    state_component: { version: 1, path },
  };
  expect(pendingImageProofReason(value)).toContain(path);
  expect(batchImageFailure("example/image:stable", value, []).reason).toContain(
    path
  );
  expect(
    pendingImageProofReason({
      ...value,
      state_component: { path: "/untrusted/pending" },
    })
  ).toBeUndefined();
});
