import { expect, test } from "bun:test";
import {
  NATIVE_HOT_RELOAD_FORCED_COST,
  nativeHotReloadNoticeFromPool,
  parseNativeHotReloadNotice,
  renderNativeHotReloadNotice,
} from "../src/backends/native-hot-reload-notice.ts";

test("HACK-2409: the pool's plain default yields no hot-reload notice", () => {
  expect(
    nativeHotReloadNoticeFromPool({ hot_reload: { state: "on" } })
  ).toBeNull();
  expect(nativeHotReloadNoticeFromPool({ hot_reload: null })).toBeNull();
  expect(nativeHotReloadNoticeFromPool({ phase: "running" })).toBeNull();
  expect(nativeHotReloadNoticeFromPool(null)).toBeNull();
});

test("HACK-2409: a notice is two known names and a bounded number, and the runtime's text is never printed", () => {
  const pool = {
    hot_reload: {
      state: "off",
      reason: "large_share",
      limit: 20_000,
      message: "synthetic-private-value",
    },
  };
  const notice = nativeHotReloadNoticeFromPool(pool);
  expect(notice).toEqual({
    state: "off",
    reason: "large_share",
    limit: 20_000,
  });
  const line = renderNativeHotReloadNotice(notice!);
  expect(line).not.toContain("synthetic-private-value");
  expect(line).toContain("more than 20,000 files and folders");
  expect(line).toContain("HACK_NATIVE_HOT_RELOAD=on");
  expect(line).toContain("localDirectories");
  expect(line).not.toContain("\n");

  for (const refused of [
    { state: "off", reason: "large_share", limit: 0 },
    { state: "off", reason: "large_share", limit: 1.5 },
    { state: "off", reason: "large_share", limit: "20000" },
    { state: "off", reason: "large_share", limit: 100_000_001 },
    { state: "off", reason: "other", limit: 1 },
    { state: "paused", reason: "setting", limit: 1 },
    // On without a setting is the default the runtime does not report.
    { state: "on", reason: "large_share", limit: 1 },
    { state: "off", reason: "setting", limit: 1, extra: true },
    { state: "off", reason: "setting" },
    "off",
    null,
  ]) {
    expect(parseNativeHotReloadNotice(refused)).toBeNull();
  }
});

test("HACK-2409: off by setting and forced on each say what was chosen", () => {
  expect(
    renderNativeHotReloadNotice({
      state: "off",
      reason: "setting",
      limit: 20_000,
    })
  ).toContain("HACK_NATIVE_HOT_RELOAD=off");
  const forced = renderNativeHotReloadNotice({
    state: "on",
    reason: "setting",
    limit: 20_000,
  });
  expect(forced).toContain("forced on (HACK_NATIVE_HOT_RELOAD=on)");
  expect(forced).toContain("more than 20,000 files and folders");
  // The user who forces it is told the cost of the choice.
  expect(forced).toContain(NATIVE_HOT_RELOAD_FORCED_COST);
  expect(forced).toContain("30 seconds");
});
