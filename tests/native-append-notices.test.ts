import { expect, test } from "bun:test";
import { nativeAppendNotices } from "../src/lib/native-append-notices.ts";

const FALLBACK = /Native recorded its own review of the combined services/;

test("an owner fallback from the offered full review is surfaced", () => {
  const notices = nativeAppendNotices({
    changed: ["web"],
    response: { ok: true, combined_review: "owner_fallback" },
    combinedOffered: true,
  });
  expect(notices).toHaveLength(2);
  expect(notices[0]).toStartWith("Service web is running with its previous");
  expect(notices[1]).toMatch(FALLBACK);
  expect(notices[1]).toContain(
    "refuses for live source, a carried source cache scope or a pending initializer cache release"
  );
  expect(notices[1]).not.toContain("during the add");
});

test("no notice when the owner used the CLI review or an earlier runtime replied", () => {
  for (const response of [
    { ok: true },
    { ok: true, combined_review: "cli" },
    { ok: true, combined_review: null },
    undefined,
  ]) {
    expect(
      nativeAppendNotices({ changed: [], response, combinedOffered: true })
    ).toEqual([]);
  }
});

test("no fallback notice when the CLI offered no full review", () => {
  expect(
    nativeAppendNotices({
      changed: [],
      response: { ok: true, combined_review: "owner_fallback" },
      combinedOffered: false,
    })
  ).toEqual([]);
});
