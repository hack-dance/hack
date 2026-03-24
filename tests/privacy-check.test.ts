import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  collectPrivacyFindings,
  shouldSkipPrivacyCheckFile,
} from "../src/lib/privacy-check.ts";

const repoRoot = resolve(import.meta.dir, "..");

test("collectPrivacyFindings flags mission artifact temp paths", () => {
  const findings = collectPrivacyFindings({
    filePath: ".factory/validation/demo.json",
    content:
      '{"command":"HOME=/tmp/demo/home HACK_GLOBAL_CONFIG_PATH=/tmp/demo/config.json ./dist/hack linear status --json"}',
  });

  expect(findings.some((finding) => finding.kind === "local-temp-path")).toBe(
    true
  );
});

test("collectPrivacyFindings ignores temp paths outside mission artifacts", () => {
  expect(
    collectPrivacyFindings({
      filePath: "docs/example.md",
      content: "Use /tmp/demo for a temporary working directory in examples.",
    })
  ).toEqual([]);
});

test("tracked mission artifacts stay free of raw local absolute paths", () => {
  const trackedFiles = execFileSync(
    "git",
    ["ls-files", "-z", ".factory/library", ".factory/validation"],
    {
      cwd: repoRoot,
      encoding: "utf8",
    }
  )
    .split("\u0000")
    .filter((filePath) => filePath.length > 0);

  const findings = trackedFiles.flatMap((filePath) => {
    if (shouldSkipPrivacyCheckFile({ filePath })) {
      return [];
    }
    const content = readFileSync(resolve(repoRoot, filePath), "utf8");
    return collectPrivacyFindings({ filePath, content });
  });

  expect(findings.map(formatFinding)).toEqual([]);
});

function formatFinding(input: {
  readonly filePath: string;
  readonly lineNumber: number;
  readonly kind: string;
  readonly snippet: string;
}): string {
  return `${input.filePath}:${input.lineNumber} [${input.kind}] ${input.snippet}`;
}
