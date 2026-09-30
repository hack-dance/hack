import { expect, test } from "bun:test";
import { parseNativeRunMappingRecoveryOptions as parse } from "../src/backends/native-project-mapping-command.ts";

const selected = "a".repeat(64);

test("ordinary Doctor does not select a mapping migration", () => {
  expect(parse({ otherOptions: false })).toBeNull();
});

test("inspection refuses every mutation selector", () => {
  expect(
    parse({ action: "inspect", branch: "feature-api", otherOptions: false })
  ).toEqual({ action: "inspect" });
  for (const options of [
    { expectSelection: selected },
    { acceptLegacyDeviceRebind: true },
  ]) {
    expect(() =>
      parse({ action: "inspect", ...options, otherOptions: false })
    ).toThrow("read-only");
  }
});

test("repair requires both an exact inspection selection and explicit legacy acceptance", () => {
  expect(
    parse({
      action: "repair",
      expectSelection: selected,
      acceptLegacyDeviceRebind: true,
      otherOptions: false,
    })
  ).toEqual({ action: "repair", expectSelection: selected });
  for (const options of [
    {},
    { expectSelection: selected },
    { acceptLegacyDeviceRebind: true },
    { expectSelection: "a".repeat(63), acceptLegacyDeviceRebind: true },
    { expectSelection: "A".repeat(64), acceptLegacyDeviceRebind: true },
    { expectSelection: `${selected}\n`, acceptLegacyDeviceRebind: true },
  ]) {
    expect(() =>
      parse({ action: "repair", ...options, otherOptions: false })
    ).toThrow("requires");
  }
});

test("unknown actions and orphaned selectors refuse before project lookup", () => {
  expect(() => parse({ action: "force", otherOptions: false })).toThrow(
    "requires"
  );
  for (const options of [
    { expectSelection: selected },
    { acceptLegacyDeviceRebind: true },
    { branch: "feature-api" },
  ]) {
    expect(() => parse({ ...options, otherOptions: false })).toThrow(
      "require --native-run-mapping"
    );
  }
});

test("mapping migration cannot combine with ordinary repair, domain or browser flows", () => {
  for (const action of ["inspect", "repair"]) {
    expect(() =>
      parse({
        action,
        expectSelection: selected,
        acceptLegacyDeviceRebind: true,
        otherOptions: true,
      })
    ).toThrow("cannot be combined");
  }
});
