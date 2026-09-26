import { expect, test } from "bun:test";
import { YAML } from "bun";

type ComposeService = {
  readonly command?: string;
  readonly profiles?: readonly string[];
  readonly volumes?: readonly string[];
  readonly privileged?: boolean;
  readonly ports?: readonly string[];
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

test("repo runtime keeps local dependencies and an opt-in isolated toolchain", async () => {
  const compose = await readComposeConfig();

  expect(compose.name).toBe("hack-cli");
  expect(Object.keys(compose.services ?? {})).toEqual(["deps", "toolchain"]);

  const deps = compose.services?.deps;
  expect(deps?.command).toBe("bun install");
  expect(deps?.networks).toEqual(["default"]);
  expect(deps?.labels).toBeUndefined();
  const toolchain = compose.services?.toolchain;
  expect(toolchain?.profiles).toEqual(["toolchain"]);
  expect(toolchain?.volumes).toContain(
    "toolchain_dependencies:/app/node_modules"
  );
  expect(toolchain?.volumes).toContain("toolchain_dist:/app/dist");
  expect(toolchain?.ports).toBeUndefined();
  expect(toolchain?.privileged).toBeUndefined();
  expect(
    toolchain?.volumes?.some((mount) => mount.includes("docker.sock"))
  ).toBe(false);
});
