import { afterEach, expect, test } from "bun:test";
import { rename, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createNativeComposeVmFileClient } from "../src/lib/native-compose-vm-file-client.ts";
import {
  cleanupVmFileFixtures,
  VM_ENGINE,
  vmFileFixture,
} from "./helpers/native-compose-vm-files.ts";

afterEach(cleanupVmFileFixtures);

async function selectedClient() {
  const fixture = await vmFileFixture();
  const selected = join(fixture.root, "docker"),
    physical = join(fixture.root, "docker-multiplexer");
  await rename(selected, join(fixture.root, "original-docker"));
  await writeFile(
    physical,
    '#!/bin/sh\n[ "${0##*/}" = docker ] || exit 97\n[ "$#" = 2 ] && [ "$1" = synthetic ] && [ "$2" = selection ] || exit 98\nprintf "selected\\n"\n',
    { mode: 0o700, flag: "wx" }
  );
  await symlink(physical, selected);
  let freshnessChecks = 0;
  const client = createNativeComposeVmFileClient({
    engineId: VM_ENGINE,
    signal: new AbortController().signal,
    deadline: Date.now() + 5000,
    assertFresh: async () => {
      freshnessChecks++;
    },
  });
  return { fixture, selected, physical, client, checks: () => freshnessChecks };
}

test("VM client invokes the admitted Docker alias with its exact command name", async () => {
  const value = await selectedClient();
  expect(await value.client.call(["synthetic", "selection"])).toBe(
    "selected\n"
  );
  expect(value.checks()).toBe(2);
  expect(value.fixture.requests()).toBe(2);
});

test("VM client refuses an alias retarget before observation or child admission", async () => {
  const value = await selectedClient();
  const alternate = join(value.fixture.root, "alternate");
  await writeFile(alternate, "#!/bin/sh\nexit 99\n", {
    mode: 0o700,
    flag: "wx",
  });
  await unlink(value.selected);
  await symlink(alternate, value.selected);
  await expect(value.client.call(["synthetic", "selection"])).rejects.toThrow(
    "unsafe or changed"
  );
  expect(value.checks()).toBe(0);
  expect(value.fixture.requests()).toBe(0);
});
