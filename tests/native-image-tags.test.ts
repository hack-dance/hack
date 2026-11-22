import { expect, test } from "bun:test";
import {
  nativeImageBlocker,
  retainCurrentImageTags,
} from "../src/backends/native-image-tags.ts";

const image = `sha256:${"a".repeat(64)}`;
const other = `sha256:${"b".repeat(64)}`;
const runtime = { binary: "/fixture/hack-native", home: "/fixture/home" };
const projectRoot = "/fixture/project";
const specs = { web: { image: "fixture/image:stable" }, db: { image } };
const retained = new Map([
  ["web", image],
  ["db", image],
]);

test("retained graphs reuse only the same fresh tag selection", async () => {
  const now = Math.floor(Date.now() / 1000);
  for (const [digest, timestamp, use] of [
    [image, now, true],
    [other, now, false],
    [image, now - 86_401, false],
    [image, now + 3600, false],
  ] as const) {
    const response = await retainCurrentImageTags({
      runtime,
      projectRoot,
      retained,
      specs,
      invoke: async (request) => {
        expect(request.args).toEqual([
          "runtime",
          "image-tag-status",
          "--json",
          "fixture/image:stable",
        ]);
        return [
          {
            aliases: ["fixture/image:stable"],
            reference: "docker.io/fixture/image:stable",
            registry: "docker.io",
            source_digest: other,
            resolved_at_unix_seconds: timestamp,
            selections: [
              { policy: "native", platform: "linux/arm64", image_id: digest },
            ],
          },
        ];
      },
    });
    expect(response.get("web")).toBe(use ? image : undefined);
    expect(response.get("db")).toBe(image);
  }
});

test("refresh and explicit offline go through runtime selection for retained tags", async () => {
  for (const mode of ["refresh", "offline"] as const) {
    const response = await retainCurrentImageTags({
      runtime,
      projectRoot,
      retained,
      specs,
      mode,
      invoke: async () => {
        throw new Error("must defer tag selection to ensure");
      },
    });
    expect(response.has("web")).toBe(false);
    expect(response.get("db")).toBe(image);
  }
});

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
