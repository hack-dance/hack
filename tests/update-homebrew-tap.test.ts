import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FORMULA_CONFIG_COMPILER,
  FORMULA_TEST_PROJECT,
  renderFormula,
} from "../scripts/update-homebrew-tap.ts";
import { resolveNativeConfigCompilerBinary } from "../src/lib/native-config-compiler.ts";

const formula = renderFormula({
  repo: "hack-dance/hack",
  tag: "v3.3.3",
  version: "3.3.3",
  darwinArm64: {
    name: "hack-3.3.3-darwin-arm64.tar.gz",
    sha256: "arm64-sha",
  },
  darwinX64: {
    name: "hack-3.3.3-darwin-x86_64.tar.gz",
    sha256: "x64-sha",
  },
  linuxX64: {
    name: "hack-3.3.3-linux-x86_64.tar.gz",
    sha256: "linux-sha",
  },
});

function block(name: string): string[] {
  const lines = formula.split("\n");
  const start = lines.indexOf(`  ${name}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = lines.indexOf("  end", start);
  expect(end).toBeGreaterThan(start);
  return lines.slice(start + 1, end).map((line) => line.trim());
}

describe("Homebrew formula", () => {
  test("installs the wrapper at bin/hack", () => {
    expect(formula).toContain(
      '(bin/"hack").write_env_script libexec/"hack", HACK_ASSETS_DIR: libexec/"assets"'
    );
    expect(formula).not.toContain(
      'bin.write_env_script libexec/"hack", HACK_ASSETS_DIR: libexec/"assets"'
    );
  });

  test("installs the config compiler beside the executable the wrapper runs", () => {
    const install = block("def install");
    expect(install).toContain('libexec.install "hack"');
    expect(install).toContain('libexec.install "hack-lifecycle-supervisor"');
    expect(install).toContain(`libexec.install "${FORMULA_CONFIG_COMPILER}"`);
    // The env script execs libexec/hack, so the CLI's execPath is libexec/hack;
    // the compiler must be exactly where the CLI resolves it, never on PATH.
    // Test runs may select a compiler through the environment; clear it so this
    // checks the installed-layout default the formula relies on.
    const override = process.env.HACK_CONFIG_COMPILER_BINARY;
    Reflect.deleteProperty(process.env, "HACK_CONFIG_COMPILER_BINARY");
    try {
      expect(
        resolveNativeConfigCompilerBinary({
          executablePath: "/brew/Cellar/hack/3.3.3/libexec/hack",
        })
      ).toBe(`/brew/Cellar/hack/3.3.3/libexec/${FORMULA_CONFIG_COMPILER}`);
    } finally {
      if (override !== undefined) {
        process.env.HACK_CONFIG_COMPILER_BINARY = override;
      }
    }
    expect(install.some((line) => line.startsWith("bin.install"))).toBe(false);
  });

  test("formula test exercises help, the compiler handshake and config validation", () => {
    const checks = block("test do");
    expect(checks).toContain(
      'assert_match "hack", shell_output("#{bin}/hack --help")'
    );
    expect(checks).toContain(
      `assert_match "transport_version", shell_output("#{libexec}/${FORMULA_CONFIG_COMPILER} --protocol")`
    );
    expect(checks).toContain(
      'validation = JSON.parse(shell_output("#{bin}/hack config validate --json"))'
    );
    expect(checks).toContain('assert_equal true, validation["ok"]');
    expect(checks).toContain(
      `assert_equal "${FORMULA_TEST_PROJECT}", validation["plan"]["name"]`
    );
    const authored = checks[checks.indexOf("JSON") - 1] ?? "";
    expect(JSON.parse(authored)).toEqual({
      schema_version: 1,
      name: FORMULA_TEST_PROJECT,
      services: { web: { image: "example/web:1" } },
    });
  });

  test.skipIf(Bun.which("ruby") === null)(
    "renders syntactically valid Ruby",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "hack-formula-"));
      try {
        const path = join(directory, "hack.rb");
        await writeFile(path, formula);
        const proc = Bun.spawn(["ruby", "-c", path], {
          stdout: "pipe",
          stderr: "pipe",
          env: { PATH: process.env.PATH ?? "" },
        });
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
        expect(stdout).toContain("Syntax OK");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );
});
