import { expect, test } from "bun:test";
import {
  parseNativeAllowedHosts,
  validateNativeAllowedHosts,
} from "../src/backends/native-project-network.ts";

test("CSV selection is explicit, canonical, bounded and immutable", () => {
  expect(parseNativeAllowedHosts(undefined)).toEqual([]);
  expect(parseNativeAllowedHosts("z.example.com,a.example.com")).toEqual([
    "a.example.com",
    "z.example.com",
  ]);
  const hosts = Object.freeze(["z.example.com", "a.example.com"]);
  expect(validateNativeAllowedHosts(hosts)).toEqual([
    "a.example.com",
    "z.example.com",
  ]);
  expect(hosts[0]).toBe("z.example.com");
  expect(
    parseNativeAllowedHosts(
      Array.from({ length: 32 }, (_, i) => `h${i}.example.com`).join(",")
    )
  ).toHaveLength(32);
  for (const value of [
    "",
    ",example.com",
    "example.com,",
    "a.example.com,,b.example.com",
    " example.com",
    "example.com, example.org",
    "localhost",
    "x.localhost",
    "x.local",
    "127.0.0.1",
    "::1",
    "*.example.com",
    "Example.com",
    "example.com.",
    "a.example.com,a.example.com",
    `${"x".repeat(64)}.com`,
    "x".repeat(8128),
  ]) {
    expect(() => parseNativeAllowedHosts(value)).toThrow(
      "HACK_NATIVE_ALLOW_HOSTS"
    );
  }
});
