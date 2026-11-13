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
 * `env list --json`, and decrypt it with an explicit `env get` read.
 */
export const envSecretsScenario: Scenario = {
  name: "env-secrets",
  tier: "local",
  summary: "secret add is encrypted at rest and decrypts via env get",
  run: async (ctx) => {
    const fixture = await createMonorepoFixture({
      parentDir: ctx.tempRoot,
      withHackConfig: true,
    });

    const add = await ctx.cli({
      args: [
        "env",
        "add",
        SECRET_KEY,
        SECRET_VALUE,
        "--secret",
        "--allow-secret-argv",
      ],
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
      that: maskedVar !== undefined && !("value" in maskedVar),
      message: "env list --json without --show-secrets must mask the value",
      result: masked,
    });

    const revealed = await ctx.cli({
      args: ["env", "get", SECRET_KEY],
      cwd: fixture.root,
    });
    expectExit({
      result: revealed,
      codes: [0],
      message: "explicit env get should succeed",
    });
    expect({
      that: revealed.stdout === SECRET_VALUE,
      message: "explicit env get decrypts the secret",
      result: revealed,
    });
    const plain = await ctx.cli({
      args: ["env", "get", "E2E_PLAIN"],
      cwd: fixture.root,
    });
    expect({
      that: plain.stdout === "plain-value",
      message: "pre-seeded plaintext value resolves unchanged",
      result: plain,
    });
  },
};
