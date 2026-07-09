import { expect, test } from "bun:test";

import { renderFormula } from "../scripts/update-homebrew-tap.ts";

test("renderFormula installs the wrapper at bin/hack", () => {
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

  expect(formula).toContain(
    '(bin/"hack").write_env_script libexec/"hack", HACK_ASSETS_DIR: libexec/"assets"'
  );
  expect(formula).not.toContain(
    'bin.write_env_script libexec/"hack", HACK_ASSETS_DIR: libexec/"assets"'
  );
  expect(formula).toContain(
    'assert_match "hack", shell_output("#{bin}/hack --help")'
  );
});
