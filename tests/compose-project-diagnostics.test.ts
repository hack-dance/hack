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
      ).toEqual({
        paths: [{ path: ignored, directory: true }],
        incomplete: false,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);

test.skipIf(process.platform !== "linux")(
  "ownership warning attributes writable binds and gives manual repair guidance",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "checkout-owner-text-"));
    try {
      const compose = join(root, "compose.yml");
      const files = Array.from({ length: 16 }, (_, i) => `file-${i}`);
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
      expect(result.message).toContain("on writer in the Compose file.");
      expect(result.message).not.toContain("(possible services: reader");
      expect(result.message).not.toContain("services: override");
      expect(result.message).toContain("This list may be partial");
      expect(result.message).toContain(
        "stop all containers and other processes"
      );
      expect(result.message).toContain(
        "any component of its full path is a symlink"
      );
      expect(result.message).not.toContain("chown");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);

test.skipIf(process.platform !== "linux")(
  "control characters are escaped in the ownership report",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "checkout-owner-quote-"));
    try {
      const composeFile = join(root, "compose.yml");
      for (const path of [
        composeFile,
        join(root, "a'file"),
        join(root, "bad\u001bfile"),
      ]) {
        await writeFile(path, "");
      }
      const { message } = await checkRootOwnedCheckout(
        { projectRoot: root, composeFile },
        process.getuid?.() ?? -1
      );
      expect(message).not.toContain("Set user:");
      expect(message).toContain("bad\\u001bfile");
      expect(message).toContain("a'file");
      expect(message).not.toContain("chown");
      expect(message).not.toContain("\u001b");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);

test.skipIf(process.platform !== "linux")(
  "scan checks shallow paths first, skips Git internals and prunes owned subtrees",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "checkout-owner-breadth-"));
    try {
      await mkdir(join(root, "src", "deep"), { recursive: true });
      await mkdir(join(root, ".git", "objects"), { recursive: true });
      const build = join(root, "dist");
      await mkdir(build);
      const files = Array.from({ length: 16 }, (_, index) =>
        join(build, `entry-${index}`)
      );
      const deep = join(root, "src", "deep", "artifact");
      for (const file of [
        ...files,
        deep,
        join(root, ".git", "objects", "object"),
      ]) {
        await writeFile(file, "");
      }
      const observed = await findCheckoutFilesOwnedBy({
        root,
        uid: -1,
        owns: (path) =>
          path !== join(root, "src") && path !== join(root, "src", "deep"),
      });
      expect(observed).toEqual({
        paths: [
          { path: build, directory: true },
          { path: deep, directory: false },
        ],
        incomplete: false,
      });
      const result = await checkRootOwnedCheckout(
        { projectRoot: build, composeFile: join(root, "absent.yml") },
        -1
      );
      expect(result.status).toBe("ok");
      const repair = await checkRootOwnedCheckout(
        { projectRoot: root, composeFile: join(root, "absent.yml") },
        process.getuid?.() ?? -1
      );
      expect(repair.message).toContain('"dist"');
      expect(repair.message).not.toContain("entry-");
      expect(repair.message).not.toContain("chown");
      expect(repair.message).not.toContain("Set user:");
      const composeFile = join(root, "compose.yml");
      await writeFile(
        composeFile,
        "services:\n  app:\n    volumes: [./dist/cache:/x]\n"
      );
      const attributed = await checkRootOwnedCheckout(
        { projectRoot: root, composeFile },
        process.getuid?.() ?? -1
      );
      expect(attributed.message).toContain('"dist" (possible services: app)');
      expect(attributed.message).toMatch(
        /Set user: .* on app in the Compose file/
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);

test.skipIf(process.platform !== "linux")(
  "an incomplete scan with no matching owner reports OK with the bounds",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "checkout-owner-limit-"));
    try {
      await mkdir(join(root, ...Array.from({ length: 33 }, () => "nested")), {
        recursive: true,
      });
      const report = await checkRootOwnedCheckout(
        { projectRoot: root, composeFile: join(root, "absent.yml") },
        -1
      );
      expect(report.status).toBe("ok");
      expect(report.message).toContain("partial scan");
      expect(report.message).toContain(
        "4,096 entries, 500 ms, and 32 directory levels"
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);
