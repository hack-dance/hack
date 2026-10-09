import { expect, test } from "bun:test";
import { parseLegacyComposeAdoptionReceipt } from "../src/lib/native-compose-adoption-receipt.ts";

const checkout = {
  root: { dev: 1, ino: 2 },
  project: { dev: 1, ino: 3 },
  git: { dev: 1, ino: 4 },
};
const generation = {
  id: "a".repeat(32),
  manifest: { dev: 1, ino: 5, hash: "b".repeat(64) },
};
const reference = {
  attemptId: "c".repeat(32),
  generationIdentity: generation.id,
  intent: { dev: 1, ino: 6, hash: "d".repeat(64) },
  reservation: { dev: 1, ino: 7, hash: "e".repeat(64) },
};
function fixture() {
  return {
    adoption_receipt_version: 14,
    kind: "legacy-compose-adopted",
    checkout,
    prepared: generation,
    publication: {
      generation,
      phase: "active",
      native: { dev: 1, ino: 8, hash: "f".repeat(64) },
    },
    pendingOperation: {
      generation,
      operation: "start",
      services: ["db", "web"],
    },
    routingOperation: {
      generation,
      token: "1".repeat(32),
      reference,
      disposition: "prospective" as const,
      code: null,
    },
    routingHandoff: "held",
  };
}
test("required v14 child disposition binds the exact generation, token and route reference", () => {
  const value = fixture(),
    parsed = parseLegacyComposeAdoptionReceipt(value, checkout);
  expect(parsed.adoption_receipt_version).toBe(14);
  expect(parsed.routingOperation).toEqual(value.routingOperation);
  expect(parsed.routingHandoff).toBe("held");
  expect(Object.isFrozen(parsed.routingOperation?.reference)).toBe(true);
  expect(
    parseLegacyComposeAdoptionReceipt(
      {
        ...value,
        routingOperation: {
          ...value.routingOperation,
          disposition: "settled",
          code: 17,
        },
      },
      checkout
    ).routingOperation?.code
  ).toBe(17);
});
for (const change of [
  { routingOperation: undefined },
  { routingHandoff: undefined },
  { prepared: null },
  { pendingOperation: null },
  { routingOperation: null },
  { routingHandoff: "releasing" },
]) {
  test(`v14 cannot discard required pending authority ${Object.keys(change).join()}`, () => {
    expect(() =>
      parseLegacyComposeAdoptionReceipt({ ...fixture(), ...change }, checkout)
    ).toThrow();
  });
}
test("foreign reference, malformed disposition and uncertain code cannot become settlement", () => {
  const value = fixture();
  for (const change of [
    { reference: { ...reference, generationIdentity: "0".repeat(32) } },
    { reference: { ...reference, reservation: undefined } },
    { token: "private" },
    { token: 1 },
    { code: 0 },
    { disposition: "settled", code: null },
    { disposition: "settled", code: 256 },
    { disposition: "settled", code: -1 },
    { disposition: "other" },
  ]) {
    expect(() =>
      parseLegacyComposeAdoptionReceipt(
        {
          ...value,
          routingOperation: { ...value.routingOperation, ...change },
        },
        checkout
      )
    ).toThrow();
  }
});
test("rollback handoff is allowed only after pending clearance in rollback phases", () => {
  const value = fixture();
  for (const phase of ["rolling-back", "rolled-back"]) {
    const parsed = parseLegacyComposeAdoptionReceipt(
      {
        ...value,
        pendingOperation: null,
        routingOperation: {
          ...value.routingOperation,
          disposition: "settled",
          code: 0,
        },
        routingHandoff: "releasing",
        publication: { ...value.publication, phase },
      },
      checkout
    );
    expect(parsed.routingHandoff).toBe("releasing");
  }
  for (const phase of ["switching", "active"]) {
    expect(() =>
      parseLegacyComposeAdoptionReceipt(
        {
          ...value,
          pendingOperation: null,
          routingOperation: null,
          routingHandoff: "releasing",
          publication: { ...value.publication, phase },
        },
        checkout
      )
    ).toThrow();
  }
});
test("older receipts do not silently ignore required v14 routing state", () => {
  const value = fixture();
  for (const version of [1, 2, 3, 4, 5, 6, 7, 9, 10, 11]) {
    expect(() =>
      parseLegacyComposeAdoptionReceipt(
        { ...value, adoption_receipt_version: version },
        checkout
      )
    ).toThrow();
  }
  const {
    routingOperation: _operation,
    routingHandoff: _handoff,
    ...older
  } = value;
  expect(
    parseLegacyComposeAdoptionReceipt(
      { ...older, adoption_receipt_version: 1 },
      checkout
    ).adoption_receipt_version
  ).toBe(1);
});
