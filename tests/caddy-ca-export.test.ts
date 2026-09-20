import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repairCaddyCaExport } from "../src/lib/caddy-ca-export.ts";
import { CURRENT_CA_PEM, OLD_CA_PEM } from "./helpers/ca-certificates.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "hack-ca-export-"));
  directories.push(directory);
  const certPath = join(directory, "root.crt");
  await Bun.write(certPath, OLD_CA_PEM);
  return { directory, certPath, composeFile: join(directory, "compose.yml") };
}
const stale = async () => ({
  state: "stale" as const,
  message: "Rotated",
  currentPem: CURRENT_CA_PEM,
});

test("confirmed stale CA refresh rechecks runtime then atomically replaces only public export", async () => {
  const f = await fixture();
  const calls: string[] = [];
  const result = await repairCaddyCaExport({
    ...f,
    inspect: async () => {
      calls.push("inspect");
      return await stale();
    },
    confirm: async () => {
      calls.push("confirm");
      return true;
    },
  });
  expect(result.changed).toBe(true);
  expect(calls).toEqual(["inspect", "confirm", "inspect"]);
  expect(await Bun.file(f.certPath).text()).toBe(CURRENT_CA_PEM);
  expect(await readdir(f.directory)).toEqual(["root.crt"]);
});

test("declined refresh preserves old export", async () => {
  const f = await fixture();
  const result = await repairCaddyCaExport({
    ...f,
    inspect: stale,
    confirm: async () => false,
  });
  expect(result.changed).toBe(false);
  expect(await Bun.file(f.certPath).text()).toBe(OLD_CA_PEM);
});

test("runtime becomes unavailable during confirmation: preserve old export", async () => {
  const f = await fixture();
  let inspections = 0;
  const result = await repairCaddyCaExport({
    ...f,
    inspect: async () =>
      ++inspections === 1
        ? await stale()
        : { state: "unavailable", message: "Unavailable" },
    confirm: async () => true,
  });
  expect(result.changed).toBe(false);
  expect(await Bun.file(f.certPath).text()).toBe(OLD_CA_PEM);
});

test("current or invalid runtime needs no confirmation or write", async () => {
  const f = await fixture();
  for (const state of ["current", "invalid", "unavailable"] as const) {
    const result = await repairCaddyCaExport({
      ...f,
      inspect: async () => ({ state, message: state }),
      confirm: () => {
        throw new Error("must not prompt");
      },
    });
    expect(result.changed).toBe(false);
  }
  expect(await Bun.file(f.certPath).text()).toBe(OLD_CA_PEM);
});

test("repair refuses symlink exports and preserves their targets", async () => {
  const f = await fixture();
  const link = join(f.directory, "link.crt");
  await symlink(f.certPath, link);
  const result = await repairCaddyCaExport({
    ...f,
    certPath: link,
    inspect: stale,
    confirm: async () => true,
  });
  expect(result.changed).toBe(false);
  expect(result.message).toContain("non-regular");
  expect(await Bun.file(f.certPath).text()).toBe(OLD_CA_PEM);
});
