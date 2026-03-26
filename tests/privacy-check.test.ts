import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  collectPrivacyFindings,
  sanitizeCommittedMissionArtifactText,
  shouldSkipPrivacyCheckFile,
} from "../src/lib/privacy-check.ts";

const repoRoot = resolve(import.meta.dir, "..");
const missionDir =
  "/Users/test-user/.factory/missions/a9640cd9-9c31-4920-b6d6-c9ce332fa599";

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

test("sanitizeCommittedMissionArtifactText keeps admin evidence while removing local roots", () => {
  const sanitized = sanitizeCommittedMissionArtifactText({
    text: JSON.stringify(
      {
        addressesFailureFrom: `${repoRoot}/.factory/validation/admin-control-plane/scrutiny/reviews/account-shell-context-parity.json`,
        commands: [
          `HOME=/tmp/admin-shell/home HACK_GLOBAL_CONFIG_PATH=/tmp/admin-shell/global-config.json ${repoRoot}/dist/hack auth status --json`,
          "python3 /tmp/ut-admin-resources-43ecf94098e7/admin_flow.py stage1",
          `${missionDir}/evidence/admin-control-plane/admin-resources/account-before-revoke.annotated.png`,
        ],
      },
      null,
      2
    ),
    repoRoot,
    missionDir,
  });

  expect(sanitized).toContain(
    '"addressesFailureFrom": "<repo>/.factory/validation/admin-control-plane/scrutiny/reviews/account-shell-context-parity.json"'
  );
  expect(sanitized).toContain(
    '"HOME=<tmp-home> HACK_GLOBAL_CONFIG_PATH=<tmp>/admin-shell/global-config.json <repo>/dist/hack auth status --json"'
  );
  expect(sanitized).toContain(
    '"python3 <tmp>/ut-admin-resources-43ecf94098e7/admin_flow.py stage1"'
  );
  expect(sanitized).toContain(
    '"<mission-dir>/evidence/admin-control-plane/admin-resources/account-before-revoke.annotated.png"'
  );
  expect(
    collectPrivacyFindings({
      filePath: ".factory/validation/admin-control-plane/demo.json",
      content: sanitized,
    })
  ).toEqual([]);
  expect(
    sanitizeCommittedMissionArtifactText({
      text: sanitized,
      repoRoot,
      missionDir,
    })
  ).toBe(sanitized);
});

test("sanitizeCommittedMissionArtifactText normalizes daemon temp-home placeholders", () => {
  const rawTempHome = "/private/var/folders/zz/abc123/T/home";
  const sanitized = sanitizeCommittedMissionArtifactText({
    text: JSON.stringify(
      {
        isolation: {
          tempHome: rawTempHome,
          daemonSocket: `${rawTempHome}/.hack/daemon/hackd.sock`,
        },
        command: `HOME=${rawTempHome} HACK_GLOBAL_CONFIG_PATH=/tmp/daemon-check/global-config.json bun <repo>/index.ts daemon start --foreground`,
      },
      null,
      2
    ),
    repoRoot,
    missionDir,
  });

  expect(sanitized).toContain('"tempHome": "<tmp-home>"');
  expect(sanitized).toContain('"daemonSocket": "<tmp-daemon-sock>"');
  expect(sanitized).toContain(
    '"HOME=<tmp-home> HACK_GLOBAL_CONFIG_PATH=<tmp>/daemon-check/global-config.json bun <repo>/index.ts daemon start --foreground"'
  );
  expect(
    collectPrivacyFindings({
      filePath: ".factory/validation/misc-env-followups-1/demo.json",
      content: sanitized,
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
