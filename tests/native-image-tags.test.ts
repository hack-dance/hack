import { expect, test } from "bun:test";
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
