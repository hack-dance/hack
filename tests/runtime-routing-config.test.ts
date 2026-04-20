import { expect, test } from "bun:test";
import { YAML } from "bun";

type ComposeService = {
  readonly command?: string;
  readonly labels?: Record<string, string>;
  readonly networks?: readonly string[];
};

type ComposeConfig = {
  readonly name?: string;
  readonly services?: Record<string, ComposeService>;
};

async function readComposeConfig(): Promise<ComposeConfig> {
  const text = await Bun.file(
    new URL("../.hack/docker-compose.yml", import.meta.url)
  ).text();
  return YAML.parse(text) as ComposeConfig;
}

test("repo runtime compose only keeps the local dependency install helper", async () => {
  const compose = await readComposeConfig();

  expect(compose.name).toBe("hack-cli");
  expect(Object.keys(compose.services ?? {})).toEqual(["deps"]);

  const deps = compose.services?.deps;
  expect(deps?.command).toBe("bun install");
  expect(deps?.networks).toEqual(["default"]);
  expect(deps?.labels).toBeUndefined();
});
