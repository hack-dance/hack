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

function expectRoutedService(opts: {
  readonly service: ComposeService | undefined;
  readonly expectedHosts: readonly string[];
  readonly expectedPort: number;
  readonly expectedCommandFragment: string;
}) {
  expect(opts.service).toBeDefined();
  expect(opts.service?.command).toContain(opts.expectedCommandFragment);
  expect(opts.service?.networks).toEqual(["hack-dev", "default"]);
  expect(opts.service?.labels).toEqual({
    caddy: opts.expectedHosts.join(", "),
    "caddy.reverse_proxy": `{{upstreams ${opts.expectedPort}}}`,
    "caddy.tls": "internal",
  });
}

test("project runtime compose declares routed web and broker services", async () => {
  const compose = await readComposeConfig();

  expect(compose.name).toBe("hack-cli");
  expect(Object.keys(compose.services ?? {})).toEqual([
    "deps",
    "web",
    "auth-broker",
  ]);

  expectRoutedService({
    service: compose.services?.web,
    expectedHosts: ["hack-cli.hack", "hack-cli.hack.gy"],
    expectedPort: 3000,
    expectedCommandFragment: "bun run --cwd apps/web dev",
  });

  expectRoutedService({
    service: compose.services?.["auth-broker"],
    expectedHosts: ["auth.hack-cli.hack", "auth.hack-cli.hack.gy"],
    expectedPort: 8080,
    expectedCommandFragment: "bun run --cwd services/auth-broker start",
  });
});

test("deps service stays unrouted and install-only", async () => {
  const compose = await readComposeConfig();
  const deps = compose.services?.deps;

  expect(deps).toBeDefined();
  expect(deps?.command).toBe("bun install");
  expect(deps?.networks).toEqual(["default"]);
  expect(deps?.labels).toBeUndefined();
});
