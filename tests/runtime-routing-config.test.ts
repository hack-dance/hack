import { expect, test } from "bun:test";
import { YAML } from "bun";

type ComposeService = {
  readonly command?: string | readonly string[];
  readonly build?: { readonly context?: string };
  readonly cpus?: number;
  readonly mem_limit?: string;
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
  expect(Object.keys(compose.services ?? {})).toEqual([
    "docs",
    "deps",
    "toolchain",
  ]);

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

test("repo docs preview is opt-in, bounded and routed without host ports", async () => {
  const docs = (await readComposeConfig()).services?.docs;

  expect(docs?.profiles).toEqual(["docs"]);
  expect(docs?.build?.context).toBe("./docs");
  expect(docs?.cpus).toBe(2);
  expect(docs?.mem_limit).toBe("6g");
  expect(docs?.ports).toBeUndefined();
  expect(docs?.privileged).toBeUndefined();
  expect(docs?.networks).toEqual(["hack-dev", "default"]);
  expect(docs?.labels).toEqual({
    caddy: "docs.hack-cli.hack",
    "caddy.reverse_proxy": "{{upstreams 3000}}",
    "caddy.tls": "internal",
  });
  expect(docs?.volumes).toEqual([
    "..:/app",
    "docs_dependencies:/app/site/node_modules",
    "docs_build:/app/site/.next",
  ]);
});
