import { homedir } from "node:os";
import { join } from "node:path";
import { createMonorepoFixture } from "../fixture.ts";
import { expect, expectExit, runCommand, type Scenario } from "../harness.ts";

const OWNER = "hack.e2e.domain-owner";
const BRANCH = "domain-proof";
const IMAGE = "node:24.11.0-bookworm-slim";
const TIMEOUT = 60_000;

/** Explicit opt-in: uses existing ingress, never installs DNS or trust. Native DNS qualification is separate. */
export const domainMigrationScenario: Scenario = {
  name: "domain-migration",
  tier: "docker",
  summary:
    "retained legacy/new/branch routes with verified TLS and exact container response",
  run: async (ctx) => {
    if (process.env.HACK_E2E_DOMAIN_ROUTING !== "1") {
      ctx.skip(
        "Set HACK_E2E_DOMAIN_ROUTING=1 to use the existing shared Caddy ingress"
      );
    }
    const command = (argv: readonly string[]) =>
      runCommand({ argv, cwd: ctx.tempRoot, timeoutMs: TIMEOUT });
    const checked = async (argv: readonly string[]) => {
      const result = await command(argv);
      expectExit({
        result,
        codes: [0],
        message: `domain fixture ${argv[0]} ${argv[1]}`,
      });
      return result;
    };
    const image = (
      await checked([
        "docker",
        "image",
        "inspect",
        IMAGE,
        "--format",
        "{{.Id}}",
      ])
    ).stdout.trim();
    expect({
      that: /^sha256:[a-f0-9]{64}$/.test(image),
      message: "local image must have immutable ID; no pulls",
    });
    await checked(["docker", "network", "inspect", "hack-dev"]);
    const ca =
      process.env.HACK_E2E_DOMAIN_CA ??
      join(homedir(), ".hack/caddy/pki/caddy-local-authority.crt");
    expect({
      that: await Bun.file(ca).exists(),
      message: "existing exported public Caddy root required; no trust writes",
    });
    const nativeDns = process.env.HACK_E2E_DOMAIN_DNS === "1";
    const ingress = process.env.HACK_E2E_DOMAIN_INGRESS ?? "127.0.0.1";
    expect({
      that: /^[0-9.]+$/.test(ingress),
      message: "explicit IPv4 ingress required",
    });
    const fixture = await createMonorepoFixture({
      parentDir: ctx.tempRoot,
      withHackConfig: true,
      lifecycle: { disableInternal: true },
      oauthEnabled: true,
    });
    const projects = [fixture.name, `${fixture.name}--${BRANCH}`];
    const oldHosts = [
      fixture.devHost,
      `${fixture.devHost}.gy`,
      `api.${fixture.devHost}`,
      `api.${fixture.devHost}.gy`,
    ];
    const token = `domain-${crypto.randomUUID()}`;
    const server = `require('node:http').createServer((req,res)=>{res.end('${token}:'+process.env.HOSTNAME)}).listen(3000,'0.0.0.0')`;
    const composePath = join(fixture.hackDir, "docker-compose.yml");
    const original = [
      `name: ${fixture.name}`,
      "services:",
      "  web:",
      `    image: ${image}`,
      "    pull_policy: never",
      `    command: ${JSON.stringify(["node", "-e", server])}`,
      "    labels:",
      `      ${OWNER}: ${fixture.name}`,
      `      caddy: ${JSON.stringify(oldHosts.join(", "))}`,
      '      caddy.reverse_proxy: "{{upstreams 3000}}"',
      "      caddy.tls: internal",
      "    networks: [hack-dev, default]",
      "networks:",
      "  hack-dev:",
      "    external: true",
      "",
    ].join("\n");
    await Bun.write(composePath, original);
    const cli = async (args: readonly string[]) => {
      const result = await ctx.cli({
        args,
        cwd: fixture.root,
        timeoutMs: TIMEOUT,
        env: { HACK_COMPOSE_STARTUP_TIMEOUT_MS: "45000" },
      });
      expectExit({ result, codes: [0], message: `hack ${args.join(" ")}` });
      return result;
    };
    const containerHostname = async (project: string) => {
      const ids = (
        await checked([
          "docker",
          "ps",
          "-q",
          "--filter",
          `label=com.docker.compose.project=${project}`,
          "--filter",
          `label=${OWNER}=${fixture.name}`,
        ])
      ).stdout
        .trim()
        .split("\n")
        .filter(Boolean);
      expect({
        that: ids.length === 1,
        message: "exact owned project must have one running fixture container",
      });
      const id = ids[0];
      if (!id) {
        throw new Error("Owned fixture container missing");
      }
      return (
        await checked([
          "docker",
          "inspect",
          "--format",
          "{{.Config.Hostname}}",
          id,
        ])
      ).stdout.trim();
    };
    const probe = async (hosts: readonly string[], project: string) => {
      const expected = `${token}:${await containerHostname(project)}`;
      for (const host of hosts) {
        const resolveArgs = nativeDns
          ? []
          : ["--resolve", `${host}:443:${ingress}`];
        let success = false;
        for (let attempt = 0; attempt < 12; attempt += 1) {
          const result = await command([
            "/usr/bin/curl",
            "--disable",
            "--silent",
            "--show-error",
            "--fail",
            "--noproxy",
            "*",
            "--connect-timeout",
            "2",
            "--max-time",
            "4",
            "--cacert",
            ca,
            ...resolveArgs,
            `https://${host}/`,
          ]);
          if (result.exitCode === 0 && result.stdout === expected) {
            success = true;
            break;
          }
          await Bun.sleep(500);
        }
        expect({
          that: success,
          message: `TLS route ${host} must return this exact owned container token`,
        });
        const native = await command([
          "/usr/bin/env",
          "-u",
          "SSL_CERT_FILE",
          "-u",
          "SSL_CERT_DIR",
          "-u",
          "CURL_CA_BUNDLE",
          "/usr/bin/curl",
          "--disable",
          "--silent",
          "--show-error",
          "--fail",
          "--noproxy",
          "*",
          "--connect-timeout",
          "2",
          "--max-time",
          "4",
          ...resolveArgs,
          `https://${host}/`,
        ]);
        expect({
          that: native.exitCode === 0 && native.stdout === expected,
          message: `native host trust and exact container token: ${host} (curl exit ${native.exitCode})`,
        });
        ctx.log(
          `verified ${nativeDns ? "native DNS, " : ""}explicit-CA TLS plus native trust and container identity: ${host}`
        );
      }
    };
    try {
      await cli(["up", "--detach"]);
      await probe(oldHosts, fixture.name);
      await cli(["doctor", "--domain-migration", "preview", "--json"]);
      expect({
        that: (await Bun.file(composePath).text()) === original,
        message: "preview must preserve original Compose bytes",
      });
      const applied = await cli([
        "doctor",
        "--domain-migration",
        "apply",
        "--json",
      ]);
      const result = JSON.parse(applied.stdout) as {
        status: string;
        toHost: string;
      };
      expect({
        that:
          result.status === "applied" &&
          result.toHost === `${fixture.name}.hack.local`,
        message: "actual CLI migration applied",
      });
      await cli(["restart"]);
      const allHosts = [
        ...oldHosts,
        `${fixture.name}.hack.local`,
        `api.${fixture.name}.hack.local`,
      ];
      await probe(allHosts, fixture.name);
      await cli(["up", "--detach", "--branch", BRANCH]);
      const branchHosts = allHosts.map((host) =>
        host.replace(fixture.name, `${BRANCH}.${fixture.name}`)
      );
      await probe(branchHosts, projects[1] ?? "");
      ctx.log(
        nativeDns
          ? "Native host DNS, explicit CA, and separate native trust probes passed; browser permission untested"
          : "--resolve bypassed host DNS; explicit CA and separate native trust probes passed; browser permission untested"
      );
    } finally {
      const failures: string[] = [];
      for (const branch of [BRANCH, null]) {
        const result = await ctx.cli({
          args: ["down", ...(branch ? ["--branch", branch] : [])],
          cwd: fixture.root,
          timeoutMs: TIMEOUT,
        });
        if (result.exitCode !== 0) {
          failures.push(`hack down ${branch ?? "base"} failed`);
        }
      }
      for (const project of projects) {
        const remaining = await checked([
          "docker",
          "ps",
          "-aq",
          "--filter",
          `label=com.docker.compose.project=${project}`,
        ]);
        if (remaining.stdout.trim()) {
          failures.push(`project ${project} containers remain`);
        }
        const networks = await checked([
          "docker",
          "network",
          "ls",
          "-q",
          "--filter",
          `label=com.docker.compose.project=${project}`,
        ]);
        if (networks.stdout.trim()) {
          failures.push(`project ${project} networks remain`);
        }
      }
      expect({
        that: failures.length === 0,
        message: failures.join("; ") || "owned fixture cleanup verified",
      });
      ctx.log(
        "cleanup verified: both exact Compose projects have zero containers and zero owned networks; no volumes created"
      );
    }
  },
};
