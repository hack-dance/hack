import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseExecSessions } from "../src/commands/exec-sessions.ts";

const record = {
  session: "00000000-0000-4000-8000-000000000001",
  run: "a".repeat(32),
  service: "web",
  has_exec: true,
};
test("session listing accepts current incomplete and empty reconciliation snapshots", () => {
  for (const reconciled of [null, true, false]) {
    expect(
      parseExecSessions({ version: 1, sessions: [record], reconciled })
    ).toEqual({
      version: 1,
      sessions: [record],
      reconciled,
    });
    expect(
      parseExecSessions({ version: 1, sessions: [], reconciled }).sessions
    ).toEqual([]);
  }
});
test("session listing rejects values, duplicate identities and malformed reports", () => {
  for (const value of [
    { version: 1, sessions: [record, record], reconciled: null },
    {
      version: 1,
      sessions: [{ ...record, argv: ["private-canary"] }],
      reconciled: null,
    },
    {
      version: 1,
      sessions: [{ ...record, service: "private\ncanary" }],
      reconciled: null,
    },
    {
      version: 1,
      sessions: [{ ...record, has_exec: "yes" }],
      reconciled: null,
    },
    { version: 1, sessions: [record], reconciled: "yes" },
  ]) {
    expect(() => parseExecSessions(value)).toThrow();
  }
});
test("guest shared sources remain independent of the host provider", async () => {
  const root = resolve("packages/relay-guest/src");
  const entry = await readFile(resolve(root, "main.rs"), "utf8");
  const paths = [...entry.matchAll(/#\[path = "([^"]+)"\]/g)].map(
    (match) => match[1]
  );
  expect(paths.length).toBeGreaterThanOrEqual(7);
  for (const path of paths) {
    const source = await readFile(resolve(root, path ?? ""), "utf8");
    expect(source).not.toMatch(/crate::provider\b/);
  }
  const ci = await readFile(".github/workflows/ci.yml", "utf8");
  expect(ci).toContain("sh scripts/check-native-guest.sh");
  const build = await readFile("scripts/check-native-guest.sh", "utf8");
  expect(build).toContain("--target aarch64-unknown-linux-musl");
  expect(build).toContain("--bin hack-relay-guest");
});
