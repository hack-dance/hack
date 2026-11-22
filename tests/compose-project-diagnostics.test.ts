import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runningComposeDirectAccess } from "../src/lib/compose-direct-access.ts";
import { findCheckoutFilesOwnedBy } from "../src/lib/doctor-root-owned.ts";
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
    workingDir: null,
    image: null,
    labels: null,
    mounts: [],
    networks: [
      { name: "default", ipAddress: "172.20.0.2", gateway: null, aliases: [] },
    ],
  };
  expect(runningComposeDirectAccess([container], true)).toBe(
    "Reach web directly at 127.0.0.1:8081, [::1]:8081."
  );
  const exposed = { ...container, ports: "80/tcp" };
  expect(runningComposeDirectAccess([exposed], true)).toBe(
    "Reach web directly at 172.20.0.2:80."
  );
  expect(runningComposeDirectAccess([exposed], false)).toBeNull();
  expect(
    runningComposeDirectAccess([{ ...exposed, state: "exited" }], true)
  ).toBeNull();
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
