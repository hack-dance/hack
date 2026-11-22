import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runningComposeDirectAccess } from "../src/lib/compose-direct-access.ts";
import {
  checkRootOwnedCheckout,
  findCheckoutFilesOwnedBy,
} from "../src/lib/doctor-root-owned.ts";
import type { RuntimeContainer } from "../src/lib/runtime-projects.ts";

test("live published ports win over Linux container addresses", () => {
  const container: RuntimeContainer = {
    id: "fixture-id",
    project: "site",
    service: "web",
    state: "running",
    status: "Up",
    name: "site-web-1",
    ports: "0.0.0.0:8081->80/tcp, [::]:8081->80/tcp",
    workingDir: "/checkout/.hack",
    image: null,
    labels: null,
    mounts: [],
    networks: [
      { name: "default", ipAddress: "172.20.0.2", gateway: null, aliases: [] },
    ],
  };
  const opts = { linux: true, project: "site", checkout: "/checkout/.hack" };
  expect(runningComposeDirectAccess([container], opts)).toBe(
    "Reach web directly at 127.0.0.1:8081, [::1]:8081."
  );
  const exposed = { ...container, ports: "80/tcp" };
  expect(runningComposeDirectAccess([exposed], opts)).toBe(
    "Container address for web: 172.20.0.2:80 (if reachable from this host)."
  );
  expect(
    runningComposeDirectAccess([exposed], { ...opts, linux: false })
  ).toBeNull();
  expect(
    runningComposeDirectAccess([{ ...exposed, state: "exited" }], opts)
  ).toBeNull();
  expect(
    runningComposeDirectAccess(
      [
        { ...container, project: "site--other", ports: "0.0.0.0:9001->80/tcp" },
        {
          ...container,
          workingDir: "/other/.hack",
          ports: "0.0.0.0:9002->80/tcp",
        },
        { ...exposed, service: "db" },
        container,
      ],
      opts
    )
  ).toBe("Reach web directly at 127.0.0.1:8081, [::1]:8081.");
});

test.skipIf(process.platform !== "linux")(
  "owner scan includes ignored directories without following symlinks",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "checkout-owner-"));
    try {
      const checkout = join(root, "checkout");
      const ignored = join(checkout, "node_modules");
      const outside = join(root, "outside");
      await mkdir(ignored, { recursive: true });
      await mkdir(outside);
      const owned = join(ignored, "dependency");
      await writeFile(owned, "");
      await writeFile(join(outside, "outside-file"), "");
      await symlink(outside, join(checkout, "alias"));
      expect(
        await findCheckoutFilesOwnedBy({
          root: checkout,
          uid: process.getuid?.() ?? -1,
        })
      ).toEqual({ paths: [ignored, owned], incomplete: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);

test.skipIf(process.platform !== "linux")(
  "ownership warning attributes writable binds and prints a safe partial repair",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "checkout-owner-text-"));
    try {
      const compose = join(root, "compose.yml");
      const files = [
        "a'file",
        "bad\u001bfile",
        ...Array.from({ length: 16 }, (_, i) => `file-${i}`),
      ];
      for (const file of files) {
        await writeFile(join(root, file), "");
      }
      await writeFile(
        compose,
        [
          "services:",
          '  writer: {volumes: ["./:/app"]}',
          '  reader: {volumes: ["./:/app:ro"]}',
          '  named: {volumes: ["data:/app"]}',
          '  override: {user: "1000", volumes: ["./:/app"]}',
        ].join("\n")
      );
      const result = await checkRootOwnedCheckout(
        { projectRoot: root, composeFile: compose },
        process.getuid?.() ?? -1
      );
      expect(result.status).toBe("warn");
      expect(result.message).toContain("(possible services: writer)");
      expect(result.message).not.toContain("(possible services: reader");
      expect(result.message).not.toContain("services: override");
      expect(result.message).toContain("only changes the listed paths");
      expect(result.message).toContain('sudo chown -h -- "$(id -u):$(id -g)"');
      expect(result.message).not.toContain("\u001b");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);
