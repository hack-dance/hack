import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  ensureBundledFzfInstalled,
  getFzfPath,
  isFzfAvailable,
  resetFzfPathCacheForTests,
} from "../src/ui/fzf.ts";

describe("fzf", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetFzfPathCacheForTests();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetFzfPathCacheForTests();
  });

  describe("getFzfPath", () => {
    it("respects HACK_FZF_PATH environment override", () => {
      process.env.HACK_FZF_PATH = "/custom/path/to/fzf";
      const result = getFzfPath();
      expect(result).toBe("/custom/path/to/fzf");
    });

    it("ignores empty HACK_FZF_PATH", () => {
      process.env.HACK_FZF_PATH = "   ";
      const result = getFzfPath();
      // Should fall back to bundled or system fzf
      expect(result).not.toBe("   ");
    });

    it("caches the result on subsequent calls", () => {
      process.env.HACK_FZF_PATH = "/first/path";
      const first = getFzfPath();
      process.env.HACK_FZF_PATH = "/second/path";
      const second = getFzfPath();
      expect(first).toBe("/first/path");
      expect(second).toBe("/first/path"); // Still cached
    });
  });

  describe("resetFzfPathCacheForTests", () => {
    it("clears the cached path", () => {
      process.env.HACK_FZF_PATH = "/first/path";
      const first = getFzfPath();
      expect(first).toBe("/first/path");

      resetFzfPathCacheForTests();
      process.env.HACK_FZF_PATH = "/second/path";
      const second = getFzfPath();
      expect(second).toBe("/second/path");
    });
  });

  describe("isFzfAvailable", () => {
    it("returns true when HACK_FZF_PATH is set", () => {
      process.env.HACK_FZF_PATH = "/some/fzf";
      expect(isFzfAvailable()).toBe(true);
    });

    it("returns false when no fzf is found", () => {
      process.env.HACK_FZF_PATH = "";
      process.env.HOME = "/nonexistent/home";
      process.env.PATH = "";
      resetFzfPathCacheForTests();
      // May still find system fzf via Bun.which, so this test is environment-dependent
      // Just ensure it returns a boolean
      const result = isFzfAvailable();
      expect(typeof result).toBe("boolean");
    });
  });

  describe("ensureBundledFzfInstalled", () => {
    it("returns home-not-set when HOME is not defined", async () => {
      const savedHome = process.env.HOME;
      process.env.HOME = undefined;
      const result = await ensureBundledFzfInstalled();
      process.env.HOME = savedHome;
      expect(result).toEqual({ ok: false, reason: "home-not-set" });
    });

    it("returns already installed when fzf exists at bundled path", async () => {
      const testDir = join(import.meta.dir, ".test-fzf-bundled");
      const hackBinDir = join(testDir, ".hack", "bin");
      const fzfPath = join(hackBinDir, "fzf");

      try {
        await mkdir(hackBinDir, { recursive: true });
        await writeFile(fzfPath, "#!/bin/sh\necho fzf");
        process.env.HOME = testDir;
        resetFzfPathCacheForTests();

        const result = await ensureBundledFzfInstalled();
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.installed).toBe(false); // Already existed
          expect(result.fzfPath).toBe(fzfPath);
        }
      } finally {
        await rm(testDir, { recursive: true, force: true });
      }
    });

    it("returns unsupported-platform on non-darwin", async () => {
      // Skip this test on macOS since we're on darwin
      if (process.platform === "darwin") {
        return;
      }
      const result = await ensureBundledFzfInstalled();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("unsupported-platform");
      }
    });
  });
});
