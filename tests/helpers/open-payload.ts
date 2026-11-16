import { expect } from "bun:test";

/**
 * Asserts a `hack open --json` payload printed by a real CLI run.
 *
 * The payload is `{ url }`, plus the documented DNS notice (`dns` and `hint`
 * together, see `OpenDnsNotice` in `src/lib/proxy-loopback.ts`) when the
 * machine running the test has no address for the host or, on macOS, no
 * resolver file for a Hack-managed suffix. Whether the notice appears depends
 * on that machine's resolver, so both shapes pass. The URL must match exactly,
 * and any other key fails.
 */
export function expectOpenPayload(stdout: string, url: string): void {
  const payload = JSON.parse(stdout) as Record<string, unknown>;
  expect(payload.url).toBe(url);
  const extra = Object.keys(payload)
    .filter((key) => key !== "url")
    .sort();
  if (extra.length > 0) {
    expect(extra).toEqual(["dns", "hint"]);
    expect(["unresolved", "unconfigured"]).toContain(payload.dns as string);
    expect(typeof payload.hint).toBe("string");
  }
}
