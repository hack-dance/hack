import { expect, test } from "bun:test";

import {
  normalizeTicketRef,
  normalizeTicketRefs,
} from "../src/control-plane/extensions/tickets/util.ts";

test("normalizeTicketRef preserves legacy numeric shorthand", () => {
  expect(normalizeTicketRef("7")).toBe("T-00007");
  expect(normalizeTicketRef("#42")).toBe("T-00042");
  expect(normalizeTicketRef("t-00009")).toBe("T-00009");
});

test("normalizeTicketRef canonicalizes new-style ids with a T- prefix", () => {
  expect(normalizeTicketRef("t-ab12cd34ef")).toBe("T-AB12CD34EF");
  expect(normalizeTicketRef("T-AB12CD34EF")).toBe("T-AB12CD34EF");
});

test("normalizeTicketRef rejects unprefixed non-legacy ids", () => {
  expect(normalizeTicketRef("ab12cd34ef")).toBeNull();
});

test("normalizeTicketRefs dedupes mixed legacy and new-style ids", () => {
  expect(
    normalizeTicketRefs(["7", "T-00007", "t-ab12cd34ef", "T-AB12CD34EF", "#7"])
  ).toEqual(["T-00007", "T-AB12CD34EF"]);
});
