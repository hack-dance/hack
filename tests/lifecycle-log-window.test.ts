import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dockerComposeLogsPlain,
  lifecycleRecordInWindow,
  lifecycleTimeWindow,
} from "../src/ui/docker-logs.ts";

/**
 * With logging off, `hack logs --since/--until` reads Compose and the
 * lifecycle companion. Compose filters its own lines; the companion's
 * records, read from a file with `tail`, are filtered by their timestamps.
 */
let root = "";
afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true });
    root = "";
  }
});

const record = (timestamp: string) => ({
  timestamp,
  service: "worker",
  stream: "stdout" as const,
  message: "m",
});

test("the window comes from the same since/until values Compose gets, including d units", () => {
  const now = new Date("2026-11-21T12:00:00Z");
  const window = lifecycleTimeWindow({ since: "2d", until: "10m" }, now);
  expect(window.sinceMs).toBe(Date.parse("2026-11-19T12:00:00Z"));
  expect(window.untilMs).toBe(Date.parse("2026-11-21T11:50:00Z"));
  expect(lifecycleRecordInWindow(record("2026-11-20T00:00:00Z"), window)).toBe(
    true
  );
  expect(lifecycleRecordInWindow(record("2026-11-18T00:00:00Z"), window)).toBe(
    false
  );
  expect(lifecycleRecordInWindow(record("2026-11-21T11:55:00Z"), window)).toBe(
    false
  );
  // Unknown time is kept; no bounds keeps everything.
  expect(lifecycleRecordInWindow(record("not a time"), window)).toBe(true);
  expect(
    lifecycleRecordInWindow(
      record("2000-01-01T00:00:00Z"),
      lifecycleTimeWindow({})
    )
  ).toBe(true);
});

test("a lifecycle-only service read with --since prints only records inside the range", async () => {
  root = await mkdtemp(join(tmpdir(), "hack-lifecycle-window-"));
  const logPath = join(root, "lifecycle.log");
  const old = new Date(Date.now() - 60 * 60_000).toISOString();
  const recent = new Date(Date.now() - 60_000).toISOString();
  await writeFile(
    logPath,
    [
      `${old}\tworker\tstdout\tfrom an hour ago`,
      `${recent}\tworker\tstdout\tfrom a minute ago`,
      "",
    ].join("\n")
  );
  const out: string[] = [];
  const write = spyOn(process.stdout, "write").mockImplementation(
    (chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    }
  );
  try {
    expect(
      await dockerComposeLogsPlain({
        composeFile: join(root, "unused-compose.yml"),
        cwd: root,
        follow: false,
        tail: 100,
        since: "10m",
        projectName: "demo",
        lifecycle: { logPath, composeDisabled: true },
      })
    ).toBe(0);
  } finally {
    write.mockRestore();
  }
  const text = out.join("");
  expect(text).toContain("from a minute ago");
  expect(text).not.toContain("from an hour ago");
});
