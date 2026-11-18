import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isHackRenderedProxyCompose,
  writeManagedProxyCompose,
} from "../src/lib/managed-proxy-compose.ts";
import { renderGlobalCaddyCompose } from "../src/templates.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hack-managed-proxy-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test.each([
  { bindAddress: null, useStatic: false },
  { bindAddress: null, useStatic: true },
  { bindAddress: "127.0.0.1", useStatic: true },
  { bindAddress: "::1", useStatic: false },
])("recognizes Hack's own rendering ($bindAddress, static=$useStatic)", ({
  bindAddress,
  useStatic,
}) => {
  const text = renderGlobalCaddyCompose({
    useStaticCoreDnsIp: useStatic,
    useStaticCaddyIp: useStatic,
    bindAddress,
  });
  expect(isHackRenderedProxyCompose(text)).toBe(true);
  expect(isHackRenderedProxyCompose(`${text}# my note\n`)).toBe(false);
});

test("writes a missing file and reports unchanged content", async () => {
  const path = join(dir, "docker-compose.yml");
  const content = renderGlobalCaddyCompose({ bindAddress: "127.0.0.1" });
  expect(await writeManagedProxyCompose({ path, content })).toEqual({
    kind: "written",
  });
  expect(await writeManagedProxyCompose({ path, content })).toEqual({
    kind: "unchanged",
  });
  expect(await readdir(dir)).toEqual(["docker-compose.yml"]);
});

test("replaces a Hack rendering for other settings without a backup", async () => {
  const path = join(dir, "docker-compose.yml");
  await writeFile(path, renderGlobalCaddyCompose({}));
  const content = renderGlobalCaddyCompose({ bindAddress: "127.0.0.1" });
  expect(await writeManagedProxyCompose({ path, content })).toEqual({
    kind: "written",
  });
  expect(await Bun.file(path).text()).toBe(content);
  expect(await readdir(dir)).toEqual(["docker-compose.yml"]);
});

test("backs up a hand-edited file before replacing it", async () => {
  const path = join(dir, "docker-compose.yml");
  const edited = `${renderGlobalCaddyCompose({})}# hand edit\n`;
  await writeFile(path, edited);
  const content = renderGlobalCaddyCompose({ bindAddress: "127.0.0.1" });
  const result = await writeManagedProxyCompose({
    path,
    content,
    now: new Date("2026-11-18T03:04:05.678Z"),
  });
  expect(result).toEqual({
    kind: "replaced-hand-edit",
    backupPath: `${path}.bak-2026-11-18T030405Z`,
  });
  expect(await Bun.file(`${path}.bak-2026-11-18T030405Z`).text()).toBe(edited);
  expect(await Bun.file(path).text()).toBe(content);
});

test("never overwrites an earlier backup taken in the same second", async () => {
  const path = join(dir, "docker-compose.yml");
  const now = new Date("2026-11-18T03:04:05.000Z");
  const content = renderGlobalCaddyCompose({ bindAddress: "127.0.0.1" });
  await writeFile(path, "first hand edit\n");
  const first = await writeManagedProxyCompose({ path, content, now });
  await writeFile(path, "second hand edit\n");
  const second = await writeManagedProxyCompose({ path, content, now });
  expect(first).toEqual({
    kind: "replaced-hand-edit",
    backupPath: `${path}.bak-2026-11-18T030405Z`,
  });
  expect(second).toEqual({
    kind: "replaced-hand-edit",
    backupPath: `${path}.bak-2026-11-18T030405Z-1`,
  });
  expect(await Bun.file(`${path}.bak-2026-11-18T030405Z`).text()).toBe(
    "first hand edit\n"
  );
  expect(await Bun.file(`${path}.bak-2026-11-18T030405Z-1`).text()).toBe(
    "second hand edit\n"
  );
});
