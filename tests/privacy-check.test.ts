import { expect, test } from "bun:test";
import { collectPrivacyFindings } from "../src/lib/privacy-check.ts";

test("a nested home directory in the release inventory is a relative Git path", () => {
  const absolute = ["", "home", "fixture-account", "note"].join("/");
  const findings = collectPrivacyFindings({
    filePath: "scripts/docs/versions.json",
    content: [
      '    "site/screenshots/home/home-desktop-dark.png",',
      `    "${absolute}",`,
      `    "source": "${absolute}"`,
      `    "site/screenshots/home/example.png", "${absolute}"`,
    ].join("\n"),
  });
  expect(findings.map(({ lineNumber, kind }) => [lineNumber, kind])).toEqual([
    [2, "linux-home-path"],
    [3, "linux-home-path"],
    [4, "linux-home-path"],
  ]);
});
