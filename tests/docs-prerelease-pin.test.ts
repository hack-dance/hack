import { expect, test } from "bun:test";
import {
  assertCurrentPrereleasePin,
  latestPublishedPrerelease,
} from "../scripts/docs/check-prerelease-pin";

function release(tag: string) {
  return {
    tag_name: tag,
    draft: false,
    prerelease: true,
    published_at: "2026-01-01T00:00:00Z",
  };
}

test("selects the highest numeric published v5 prerelease across API pages", () => {
  expect(
    latestPublishedPrerelease([
      [release("v5.0.0-next.9"), release("v5.0.0-next.15")],
      [release("v5.0.0-next.10")],
    ])
  ).toBe("v5.0.0-next.15");
});

test("ignores drafts, unpublished entries, stable releases and other channels", () => {
  expect(
    latestPublishedPrerelease([
      { ...release("v5.0.0-next.99"), draft: true },
      { ...release("v5.0.0-next.98"), published_at: null },
      { ...release("v5.0.0-next.97"), prerelease: false },
      release("v4.3.0"),
      release("v5.0.0-beta.99"),
      release("v5.0.0-next.15"),
    ])
  ).toBe("v5.0.0-next.15");
});

test("unknown, malformed or empty metadata cannot report a fresh pin", () => {
  for (const input of [null, {}, [], [release("v4.3.0")], [{}]]) {
    expect(() => latestPublishedPrerelease(input)).toThrow();
  }
  expect(() =>
    latestPublishedPrerelease([
      { ...release("v5.0.0-next.15"), published_at: "invalid" },
    ])
  ).toThrow("Invalid v5 prerelease metadata");
});

const current = {
  label: "v5 (next.15)",
  pinnedRevision: "a".repeat(40),
  publishedTag: "v5.0.0-next.15",
  publishedRevision: "a".repeat(40),
};

test("accepts a matching tag and commit; rejects lag, future pins and wrong commits", () => {
  expect(() => assertCurrentPrereleasePin(current)).not.toThrow();
  for (const label of ["v5 (next.14)", "v5 (next.16)"]) {
    expect(() => assertCurrentPrereleasePin({ ...current, label })).toThrow(
      "differs from published"
    );
  }
  expect(() =>
    assertCurrentPrereleasePin({
      ...current,
      pinnedRevision: "b".repeat(40),
    })
  ).toThrow("Site revision does not match");
});

test("rejects ambiguous labels, unsafe tags and unresolved commits", () => {
  for (const change of [
    { label: "v5" },
    { publishedTag: "next" },
    { publishedTag: "v5.0.0-next.15; command" },
    { publishedRevision: "next" },
  ]) {
    expect(() => assertCurrentPrereleasePin({ ...current, ...change })).toThrow(
      "Invalid v5 pin"
    );
  }
});
