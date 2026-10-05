import { join } from "node:path";
import { createMonorepoFixture } from "../fixture.ts";
import { expect, expectExit, runCommand, type Scenario } from "../harness.ts";

const OWNER = "hack.e2e.portable-multiservice-owner";
const PROJECT = "com.docker.compose.project";
const TIMEOUT = 180_000;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const APP = [
  'import { SQL } from "bun";',
  'const sql = new SQL("postgres://postgres@db:5432/portable", { max: 1 });',
  "await sql`CREATE TABLE IF NOT EXISTS marker (id INTEGER PRIMARY KEY, value TEXT NOT NULL)`;",
  "const boot = crypto.randomUUID();",
  'Bun.serve({ hostname: "0.0.0.0", port: 3000, async fetch(request) {',
  "  try {",
  '    if (request.method === "POST") {',
  "      const value = await request.text();",
  '      if (value.length > 128) return new Response("too large", { status: 400 });',
  "      await sql`INSERT INTO marker VALUES (1, ${value}) ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value`;",
  '      console.log("portable marker written");',
  "    }",
  "    const rows = await sql`SELECT value FROM marker WHERE id = 1`;",
  "    return Response.json({ owner: process.env.PORTABLE_OWNER, boot, marker: rows[0]?.value ?? null });",
  '  } catch { return new Response("database unavailable", { status: 503 }); }',
  "} });",
  'console.log("portable app ready");',
].join("\n");

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected an object from the fixture or Docker");
  }
  return value as Record<string, unknown>;
}

/** No ingress, published ports, package installation, or credential dependencies. */
export const portableMultiserviceScenario: Scenario = {
  name: "portable-multiservice",
  tier: "docker",
  summary:
    "slim app/PostgreSQL HTTP, exec/run/logs, retained data and owned cleanup",
  run: async (ctx) => {
    const docker = async (args: readonly string[]) => {
      const result = await runCommand({
        argv: ["docker", ...args],
        cwd: ctx.tempRoot,
        timeoutMs: TIMEOUT,
      });
      expectExit({
        result,
        codes: [0],
        message: `Docker ${args[0]} must succeed`,
      });
      return result.stdout.trim();
    };
    expect({
      that: (await docker(["info", "--format", "{{.OSType}}"])) === "linux",
      message: "A Linux Docker daemon is required",
    });
    await docker(["compose", "version"]);
    const image = async (tag: string) => {
      const id = await docker(["image", "inspect", tag, "--format", "{{.Id}}"]);
      expect({
        that: IMAGE_ID.test(id),
        message: `${tag} must already be cached with an immutable ID`,
      });
      ctx.log(`${tag}: ${id}`);
      return id;
    };
    const bunImage = await image("oven/bun:1.4.2-slim");
    const postgresImage = await image("postgres:17.6-alpine");
    const fixture = await createMonorepoFixture({
      parentDir: ctx.tempRoot,
      withHackConfig: true,
      lifecycle: { disableInternal: true },
    });
    const name = fixture.name;
    const canary = `${name}-canary`;
    const labels = { [OWNER]: name };
    await Bun.write(
      join(fixture.hackDir, "hack.config.json"),
      JSON.stringify({
        name,
        internal: { dns: false, tls: false },
        logs: {
          follow_backend: "compose",
          snapshot_backend: "compose",
          clear_on_down: false,
        },
      })
    );
    await Bun.write(
      join(fixture.hackDir, "docker-compose.yml"),
      JSON.stringify({
        name,
        services: {
          app: {
            image: bunImage,
            pull_policy: "never",
            labels,
            // Compose must pass SQL interpolation to Bun without expanding it.
            command: ["bun", "-e", APP.replaceAll("$", () => "$$")],
            environment: { PORTABLE_OWNER: name },
            depends_on: { db: { condition: "service_healthy" } },
            healthcheck: {
              test: [
                "CMD",
                "bun",
                "-e",
                'const r = await fetch("http://127.0.0.1:3000/"); process.exit(r.status === 200 ? 0 : 1)',
              ],
              interval: "1s",
              timeout: "5s",
              retries: 30,
            },
          },
          db: {
            image: postgresImage,
            pull_policy: "never",
            labels,
            environment: {
              POSTGRES_DB: "portable",
              POSTGRES_HOST_AUTH_METHOD: "trust",
            },
            volumes: ["data:/var/lib/postgresql/data"],
            healthcheck: {
              test: ["CMD", "pg_isready", "-U", "postgres", "-d", "portable"],
              interval: "1s",
              timeout: "5s",
              retries: 30,
            },
          },
        },
        volumes: { data: { labels } },
        networks: { default: { internal: true, labels } },
      })
    );
    const cli = async (args: readonly string[]) => {
      const result = await ctx.cli({
        args,
        cwd: fixture.root,
        timeoutMs: TIMEOUT,
        env: {
          HACK_EXECUTION_MODE: "slim",
          HACK_DAEMON_DISABLE_DOCKER_EVENTS: "1",
        },
      });
      expectExit({
        result,
        codes: [0],
        message: `hack ${args[0]} must succeed in slim mode`,
      });
      return result;
    };
    const list = async (
      kind: "container" | "network" | "volume",
      owner: string
    ) => {
      const args = kind === "container" ? ["ps", "-aq"] : [kind, "ls", "-q"];
      return (await docker([...args, "--filter", `label=${OWNER}=${owner}`]))
        .split(/\s+/)
        .filter(Boolean);
    };
    const owned = async (
      kind: "container" | "network" | "volume",
      id: string,
      owner: string
    ) => {
      const expression =
        kind === "container" ? "{{json .Config.Labels}}" : "{{json .Labels}}";
      const actual = object(
        JSON.parse(await docker([kind, "inspect", id, "--format", expression]))
      );
      expect({
        that: actual[OWNER] === owner && actual[PROJECT] === owner,
        message: `Refuse ${kind} mutation outside exact fixture ownership`,
      });
    };
    const clean = async (owner: string) => {
      for (const kind of ["container", "network", "volume"] as const) {
        for (const id of await list(kind, owner)) {
          await owned(kind, id, owner);
          await docker([
            kind,
            "rm",
            ...(kind === "container" ? ["--force"] : []),
            id,
          ]);
        }
        expect({
          that: (await list(kind, owner)).length === 0,
          message: `Owned ${kind} cleanup must leave no resources`,
        });
      }
    };
    const snapshot = async () => {
      const containers: string[] = [];
      for (const service of ["app", "db"]) {
        const ids = (
          await docker([
            "ps",
            "-aq",
            "--filter",
            `label=${OWNER}=${name}`,
            "--filter",
            `label=com.docker.compose.service=${service}`,
          ])
        )
          .split(/\s+/)
          .filter(Boolean);
        const id = ids[0];
        if (ids.length !== 1 || !id) {
          throw new Error(`Expected one owned ${service} container`);
        }
        await owned("container", id, name);
        const deadline = Date.now() + 60_000;
        let state = "";
        while (Date.now() < deadline) {
          state = await docker([
            "inspect",
            id,
            "--format",
            "{{.State.Running}} {{.State.Health.Status}} {{len .HostConfig.PortBindings}}",
          ]);
          if (state === "true healthy 0") {
            break;
          }
          await Bun.sleep(250);
        }
        expect({
          that: state === "true healthy 0",
          message: `${service} must be healthy with no published ports`,
        });
        containers.push(id);
      }
      const volume = `${name}_data`;
      await owned("volume", volume, name);
      const db = containers[1];
      if (!db) {
        throw new Error("Database container missing");
      }
      expect({
        that:
          (await docker([
            "inspect",
            db,
            "--format",
            '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}',
          ])) === volume,
        message: "Database must use the exact owned data volume",
      });
      const createdAt = await docker([
        "volume",
        "inspect",
        volume,
        "--format",
        "{{.CreatedAt}}",
      ]);
      return { containers, volume, createdAt };
    };
    const probe = async (
      operation: "exec" | "run",
      expected: string | null,
      write = false
    ) => {
      const script = `const r = await fetch("http://app:3000/", { method: ${JSON.stringify(write ? "POST" : "GET")}, ${write ? `body: ${JSON.stringify(expected)},` : ""} signal: AbortSignal.timeout(5000) }); if (!r.ok) process.exit(17); process.stdout.write(await r.text());`;
      const result = await cli([operation, "app", "--", "bun", "-e", script]);
      const response = object(JSON.parse(result.stdout));
      expect({
        that:
          response.owner === name &&
          response.marker === expected &&
          typeof response.boot === "string",
        message: `${operation} HTTP must return the exact persisted database value`,
        result,
      });
      return response.boot;
    };
    const canaryLabels = [
      "--label",
      `${OWNER}=${canary}`,
      "--label",
      `${PROJECT}=${canary}`,
    ];
    try {
      await docker(["volume", "create", ...canaryLabels, canary]);
      await docker([
        "network",
        "create",
        "--internal",
        ...canaryLabels,
        canary,
      ]);
      await docker([
        "run",
        "--detach",
        "--pull=never",
        "--name",
        canary,
        ...canaryLabels,
        "--network",
        canary,
        "--volume",
        `${canary}:/canary`,
        bunImage,
        "bun",
        "-e",
        'await Bun.write("/canary/marker", "untouched"); setInterval(() => {}, 60000)',
      ]);
      await cli(["up", "--detach"]);
      const first = await snapshot();
      const boot = await probe("exec", null);
      const marker = crypto.randomUUID();
      await probe("exec", marker, true);
      await probe("run", marker);
      const database = await cli([
        "exec",
        "db",
        "--",
        "psql",
        "-U",
        "postgres",
        "-d",
        "portable",
        "-tA",
        "-c",
        "SELECT value FROM marker WHERE id = 1",
      ]);
      expect({
        that: database.stdout.trim() === marker,
        message: "Independent SQL read must confirm the HTTP write",
        result: database,
      });
      const logs = await cli([
        "logs",
        "app",
        "--no-follow",
        "--compose",
        "--tail",
        "20",
      ]);
      expect({
        that:
          logs.combined.includes("portable app ready") &&
          logs.combined.includes("portable marker written"),
        message:
          "Compose logs must include actual app startup and database-write events",
        result: logs,
      });
      await cli(["down"]);
      expect({
        that: (await list("container", name)).length === 0,
        message: "hack down must remove all fixture containers",
      });
      await owned("volume", first.volume, name);
      await cli(["up", "--detach"]);
      const second = await snapshot();
      expect({
        that:
          second.containers.every((id) => !first.containers.includes(id)) &&
          second.volume === first.volume &&
          second.createdAt === first.createdAt,
        message:
          "down/up must create new containers and retain the same database volume",
      });
      expect({
        that: (await probe("exec", marker)) !== boot,
        message: "A new app process must read the original database marker",
      });
      await probe("run", marker);
      await cli(["down"]);
      expect({
        that:
          (await list("container", name)).length === 0 &&
          (await list("network", name)).length === 0,
        message: "hack down must remove owned containers and network",
      });
      await clean(name);
      for (const kind of ["container", "network", "volume"] as const) {
        await owned(kind, canary, canary);
      }
      expect({
        that:
          (await docker([
            "exec",
            canary,
            "bun",
            "-e",
            'process.stdout.write(await Bun.file("/canary/marker").text())',
          ])) === "untouched",
        message:
          "Adjacent canary container and volume data must survive cleanup",
      });
      ctx.log(
        "slim HTTP/PostgreSQL, exec/run/logs, down/up retention, exact cleanup and adjacent canary verified"
      );
    } finally {
      try {
        await clean(name);
      } finally {
        await clean(canary);
      }
    }
  },
};
