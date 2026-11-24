import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostDataBackupDocker } from "../src/lib/data-backup-docker.ts";
import { exportProjectData } from "../src/lib/data-backup-export.ts";

/**
 * The project's managed Compose env (here a managed DOCKER_HOST) reaches
 * every Docker subprocess of an export: Compose, `volume inspect`, `ps`,
 * `events` and both helper runs. A stub `docker` found through the managed
 * PATH records the DOCKER_HOST each call saw; the runner's own environment
 * is not changed.
 */

const MANAGED_HOST = "unix:///managed/engine.sock";

const STUB = `
const { appendFileSync, readFileSync, existsSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.DATA_STUB_LOG, JSON.stringify({ args, host: process.env.DOCKER_HOST ?? null }) + "\\n");
const feed = process.env.DATA_STUB_LOG + ".events";
const out = (value) => process.stdout.write(typeof value === "string" ? value : JSON.stringify(value) + "\\n");
if (args[0] === "events") {
  // A live subscription: replay what runs append, until SIGTERM.
  let offset = 0;
  process.on("SIGTERM", () => process.exit(0));
  const tick = () => {
    const text = existsSync(feed) ? readFileSync(feed, "utf8") : "";
    if (text.length > offset) { process.stdout.write(text.slice(offset)); offset = text.length; }
    setTimeout(tick, 10);
  };
  tick();
} else if (args[0] === "compose") {
  out({ name: "shop", services: {}, volumes: { db: { name: "shop_db" } } });
} else if (args[0] === "volume" && args[1] === "inspect") {
  out({ name: "shop_db", createdAt: "2026-11-24T00:00:00Z", driver: "local", mountpoint: "/var/lib/docker/volumes/shop_db/_data", options: null, labels: { "com.docker.compose.project": "shop", "com.docker.compose.volume": "db" } });
} else if (args[0] === "ps") {
  out("");
} else if (args[0] === "run" || args[0] === "start") {
  const name = args[0] === "run" ? args[args.indexOf("--name") + 1] : args.at(-1);
  appendFileSync(feed, JSON.stringify({ Type: "container", Action: "start", Actor: { ID: name, Attributes: { name } } }) + "\\n");
} else if (args[0] === "create") {
  out("c".repeat(64));
} else if (args[0] === "container" && args.includes("{{json .Mounts}}")) {
  out([{ Type: "bind", Source: "/var/lib/docker/volumes/shop_db/_data", Destination: "/v", RW: false }]);
} else if (args[0] === "container") {
  process.stderr.write("Error: No such container: " + args.at(-1) + "\\n");
  process.exit(1);
} else if (args[0] === "rm") {
  out(args.at(-1));
} else if (args[0] === "exec") {
  if (args.includes("tar")) out("tar bytes");
  else out({ algorithm: "hack.tree-digest.v1", entries: 2, excludedSockets: 0, digest: "a".repeat(64) });
} else {
  process.exit(97);
}
`;

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-data-docker-env-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("a managed DOCKER_HOST reaches every docker argv of an export", async () => {
  const bin = join(root, "bin");
  const log = join(root, "calls.ndjson");
  await Bun.write(join(bin, "docker"), `#!${process.execPath}\n${STUB}`);
  await chmod(join(bin, "docker"), 0o755);
  await writeFile(log, "");
  const inherited = process.env.DOCKER_HOST;

  const result = await exportProjectData({
    docker: createHostDataBackupDocker({
      env: {
        DOCKER_HOST: MANAGED_HOST,
        DATA_STUB_LOG: log,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
    }),
    composeArgs: ["docker", "compose", "-f", join(root, "compose.yml")],
    project: "shop",
    branch: null,
    hackHome: join(root, "home"),
    hackVersion: "9.9.9",
  });

  expect(result.manifest.volumes.map((volume) => volume.key)).toEqual(["db"]);
  const calls = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { args: string[]; host: string });
  const kinds = calls.map((call) => {
    if (call.args[0] === "exec") {
      const args = call.args.filter((arg) => arg !== "--interactive");
      return `exec ${args[2]}`;
    }
    return call.args
      .slice(0, ["volume", "container"].includes(call.args[0] ?? "") ? 2 : 1)
      .join(" ");
  });
  expect(new Set(kinds)).toEqual(
    new Set([
      "compose",
      "volume inspect",
      "ps",
      "events",
      "create",
      "start",
      "container inspect",
      "exec bun",
      "exec tar",
      "rm",
    ])
  );
  expect(calls.filter((call) => call.host !== MANAGED_HOST)).toEqual([]);
  expect(process.env.DOCKER_HOST).toBe(inherited);
});
