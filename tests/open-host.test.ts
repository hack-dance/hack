import { describe, expect, test } from "bun:test";
import {
  parseOpenHostPreference,
  resolvePreferredOpenHost,
} from "../src/lib/open-host.ts";

describe("open host preference", () => {
  test("parses supported values case-insensitively", () => {
    expect(parseOpenHostPreference(" AUTO ")).toBe("auto");
    expect(parseOpenHostPreference("Alias")).toBe("alias");
    expect(parseOpenHostPreference("dev")).toBe("dev");
    expect(parseOpenHostPreference("primary")).toBeNull();
    expect(parseOpenHostPreference(true)).toBeNull();
  });

  test("auto prefers an available OAuth alias", () => {
    expect(
      resolvePreferredOpenHost({
        devHost: "demo.hack",
        aliasHost: "demo.hack.gy",
      })
    ).toEqual({
      ok: true,
      host: "demo.hack.gy",
      preference: "auto",
    });
  });

  test("auto falls back to the development host without OAuth", () => {
    expect(
      resolvePreferredOpenHost({
        devHost: "demo.hack",
        aliasHost: null,
      })
    ).toEqual({ ok: true, host: "demo.hack", preference: "auto" });
  });

  test("CLI preference overrides project config", () => {
    expect(
      resolvePreferredOpenHost({
        devHost: "demo.hack",
        aliasHost: "demo.hack.gy",
        configPreference: "alias",
        optionPreference: "dev",
      })
    ).toEqual({ ok: true, host: "demo.hack", preference: "dev" });
  });

  test("explicit alias preference fails when OAuth is unavailable", () => {
    expect(
      resolvePreferredOpenHost({
        devHost: "demo.hack",
        aliasHost: null,
        configPreference: "alias",
      })
    ).toEqual({
      ok: false,
      preference: "alias",
      reason: "alias-unavailable",
    });
  });
});
