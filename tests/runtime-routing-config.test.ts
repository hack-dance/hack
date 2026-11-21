import { expect, test } from "bun:test";
import { YAML } from "bun";

type ComposeService = {
  readonly user?: string;
  readonly image?: string;
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
  expect(deps?.command).toBe("bun install --frozen-lockfile");
  expect(deps?.image).toBe("oven/bun:1.4.4");
  expect(deps?.user).toBe("${HACK_DEPS_USER:-65534:65534}");
  expect(deps?.volumes).toEqual(["..:/app"]);
  expect(deps?.profiles).toEqual(["deps"]);
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

test("repo docs preview starts by default, bounded and routed without host ports", async () => {
  const docs = (await readComposeConfig()).services?.docs;

  expect(docs?.profiles).toBeUndefined();
  expect(docs?.command).toEqual(["bash", "/app/dev.sh"]);
  expect(docs?.build?.context).toBe("../site");
  expect(docs?.cpus).toBe(2);
  expect(docs?.mem_limit).toBe("6g");
  expect(docs?.ports).toBeUndefined();
  expect(docs?.privileged).toBeUndefined();
  expect(docs?.networks).toEqual(["hack-dev", "default"]);
  expect(docs?.labels).toEqual({
    caddy: "docs.hack-cli.hack.local",
    "caddy.reverse_proxy": "{{upstreams 3000}}",
    "caddy.tls": "internal",
  });
  expect(docs?.volumes).toEqual([
    "../docs:/app/docs:ro",
    "../scripts/docs:/app/scripts/docs:ro",
    "../site/app:/app/site/app:ro",
    "../site/components:/app/site/components:ro",
    "../site/lib:/app/site/lib:ro",
    "./docs/dev.sh:/app/dev.sh:ro",
    "docs_dependencies:/app/site/node_modules",
    "docs_build:/app/site/.next",
  ]);
});
