import { join } from "node:path";

import { createMonorepoFixture } from "../fixture.ts";
import {
  expect,
  expectExit,
  extractJsonObject,
  type Scenario,
} from "../harness.ts";

type EnvListPayload = {
  readonly vars?: readonly {
    readonly key: string;
    readonly value: string;
    readonly storage?: { readonly kind?: string };
  }[];
};

const SECRET_KEY = "E2E_SECRET";
const SECRET_VALUE = "s3cret-roundtrip-value";

/**
 * `hack env add <key> <value> --secret` must store the value encrypted in
 * .hack/hack.env.default.yaml (v1: prefix, no plaintext), mask it in
 * `env list --json`, and decrypt it with `--show-secrets`.
 */
export const envSecretsScenario: Scenario = {
  name: "env-secrets",
  tier: "local",
  summary: "secret add is encrypted at rest and decrypts via env list --json",
  run: async (ctx) => {
    const fixture = await createMonorepoFixture({
      parentDir: ctx.tempRoot,
      withHackConfig: true,
    });

    const add = await ctx.cli({
      args: ["env", "add", SECRET_KEY, SECRET_VALUE, "--secret"],
      cwd: fixture.root,
    });
    expectExit({
      result: add,
      codes: [0],
      message: "hack env add --secret should succeed non-interactively",
    });

    const yamlPath = join(fixture.hackDir, "hack.env.default.yaml");
    const yamlText = await Bun.file(yamlPath).text();
    expect({
      that: yamlText.includes(SECRET_KEY),
      message: `secret key ${SECRET_KEY} should be present in ${yamlPath}`,
      result: add,
    });
    expect({
      that: yamlText.includes("v1:"),
      message:
        "secret value should be stored with the v1: encrypted prefix in the env yaml",
      result: add,
    });
    expect({
      that: !yamlText.includes(SECRET_VALUE),
      message: "plaintext secret value must NOT appear in the env yaml",
      result: add,
    });

    const masked = await ctx.cli({
      args: ["env", "list", "--json"],
      cwd: fixture.root,
    });
    expectExit({
      result: masked,
      codes: [0],
      message: "hack env list --json should succeed",
    });
    const maskedPayload = extractJsonObject<EnvListPayload>({
      text: masked.stdout,
    });
    expect({
      that: maskedPayload !== null,
      message: "env list --json should emit parseable JSON on stdout",
      result: masked,
    });
    const maskedVar = maskedPayload?.vars?.find(
      (entry) => entry.key === SECRET_KEY
    );
    expect({
      that: maskedVar !== undefined,
      message: `env list --json should include ${SECRET_KEY}`,
      result: masked,
    });
    expect({
      that: maskedVar?.storage?.kind === "secret",
      message: `env list --json should classify ${SECRET_KEY} storage.kind=secret`,
      result: masked,
    });
    expect({
      that: maskedVar !== undefined && maskedVar.value !== SECRET_VALUE,
      message: "env list --json without --show-secrets must mask the value",
      result: masked,
    });

    const revealed = await ctx.cli({
      args: ["env", "list", "--json", "--show-secrets"],
      cwd: fixture.root,
    });
    expectExit({
      result: revealed,
      codes: [0],
      message: "hack env list --json --show-secrets should succeed",
    });
    const revealedPayload = extractJsonObject<EnvListPayload>({
      text: revealed.stdout,
    });
    const revealedVar = revealedPayload?.vars?.find(
      (entry) => entry.key === SECRET_KEY
    );
    expect({
      that: revealedVar?.value === SECRET_VALUE,
      message:
        "env list --json --show-secrets should decrypt the secret back to the original value",
      result: revealed,
    });

    const plainVar = revealedPayload?.vars?.find(
      (entry) => entry.key === "E2E_PLAIN"
    );
    expect({
      that: plainVar?.value === "plain-value",
      message: "pre-seeded plaintext env value should resolve unchanged",
      result: revealed,
    });
  },
};
