import { expect, test } from "bun:test";
import {
  captureNativeFrontendBirth,
  nativeFrontendGone,
} from "../src/backends/native-frontend-identity.ts";

const birth = "Wed Nov 11 17:23:26 2026";
const other = "Thu Nov 12 17:23:26 2026";
const identity = { pid: process.pid, birth };
const row = { uid: process.getuid?.() ?? 0, birth, zombie: false };

test("macOS frontend exit proof distinguishes PID reuse, zombies and unreadable rows", async () => {
  const io = { platform: "darwin" as const, absent: () => false };
  expect(
    await nativeFrontendGone(identity, { ...io, observe: async () => row })
  ).toBe(false);
  expect(
    await nativeFrontendGone(identity, {
      ...io,
      observe: async () => ({ ...row, birth: other }),
    })
  ).toBe(true);
  expect(
    await nativeFrontendGone(identity, {
      ...io,
      observe: async () => ({ ...row, zombie: true }),
    })
  ).toBe(true);
  expect(
    await nativeFrontendGone(identity, { ...io, observe: async () => null })
  ).toBe(false);
  expect(
    await nativeFrontendGone(identity, {
      ...io,
      observe: async () => ({ ...row, uid: row.uid + 1 }),
    })
  ).toBe(false);
});

test("Linux clock drift and legacy PID-only records never turn a live process into exit proof", async () => {
  for (const [platform, recorded] of [
    ["linux", identity],
    ["darwin", { pid: identity.pid }],
  ] as const) {
    const observe = async () => {
      throw new Error("must not read birth");
    };
    expect(
      await nativeFrontendGone(recorded, {
        platform,
        absent: () => false,
        observe,
      })
    ).toBe(false);
    expect(
      await nativeFrontendGone(recorded, {
        platform,
        absent: () => true,
        observe,
      })
    ).toBe(true);
  }
});

test("native self observation never declares the current frontend gone", async () => {
  expect(await nativeFrontendGone({ pid: process.pid })).toBe(false);
  const currentBirth = await captureNativeFrontendBirth();
  expect(
    await nativeFrontendGone({ pid: process.pid, birth: currentBirth })
  ).toBe(false);
});
