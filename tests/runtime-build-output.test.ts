import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  cp,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildArtifact,
  digest,
  inputIdentity,
  verifyArtifact,
} from "./fixtures/source-build/artifact.ts";

const roots: string[] = [];
const inputId = digest("fixture-input");
async function fixture(): Promise<string> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "hack-build-output-"))
  );
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    for (const path of [join(root, "build"), join(root, "pending")]) {
      await chmod(path, 0o700).catch(() => undefined);
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("builds actual TypeScript and reuses only a verified artifact", async () => {
  const root = await fixture();
  const source = await fixture();
  await writeFile(
    join(source, "marker.ts"),
    'export const marker: string = "compiled-fixture"'
  );
  await writeFile(
    join(source, "main.ts"),
    'import {marker} from "./marker.ts"; console.log(marker)'
  );
  let compiles = 0;
  const compile = async () => {
    compiles++;
    const result = await Bun.build({
      entrypoints: [join(source, "main.ts")],
      target: "bun",
    });
    expect(result.success).toBe(true);
    const output = result.outputs[0];
    if (!output) {
      throw new Error("Missing fixture output");
    }
    return new Uint8Array(await output.arrayBuffer());
  };
  const first = await buildArtifact({ root, inputId, compile });
  expect(first.reused).toBe(false);
  expect(await verifyArtifact({ root, inputId })).toEqual(first.manifest);
  const process = Bun.spawn(
    [Bun.which("bun") ?? "bun", join(root, "build/web.js")],
    { stdout: "pipe", stderr: "pipe" }
  );
  expect(await process.exited).toBe(0);
  expect(await new Response(process.stdout).text()).toBe("compiled-fixture\n");
  expect(await buildArtifact({ root, inputId, compile })).toEqual({
    ...first,
    reused: true,
  });
  expect(compiles).toBe(1);
  await expect(
    buildArtifact({ root, inputId: digest("changed-input"), compile })
  ).rejects.toThrow("identity refused");
  expect(compiles).toBe(1);
});

test("source bytes participate in the build identity", async () => {
  const source = await fixture();
  await cp(new URL("./fixtures/source-build", import.meta.url), source, {
    recursive: true,
  });
  const before = await inputIdentity(source);
  await writeFile(join(source, "marker.ts"), 'export const marker = "changed"');
  expect(await inputIdentity(source)).not.toBe(before);
});

test("failed or interrupted producers never activate partial output", async () => {
  for (const fault of [false, true]) {
    const root = await fixture();
    const compile = async () => {
      if (!fault) {
        throw new Error("compiler failed");
      }
      return new TextEncoder().encode("export default 'partial'");
    };
    await expect(
      buildArtifact({ root, inputId, compile, fault })
    ).rejects.toThrow();
    expect(await Bun.file(join(root, "build/manifest.json")).exists()).toBe(
      false
    );
    await expect(buildArtifact({ root, inputId, compile })).rejects.toThrow(
      "Pending or foreign output retained"
    );
    await expect(verifyArtifact({ root, inputId })).rejects.toThrow();
  }
});

test("empty and oversized bundles refuse before publication", async () => {
  for (const size of [0, 1024 * 1024 + 1]) {
    const root = await fixture();
    await expect(
      buildArtifact({
        root,
        inputId,
        compile: async () => new Uint8Array(size),
      })
    ).rejects.toThrow("fixture limit");
    expect(await Bun.file(join(root, "build/manifest.json")).exists()).toBe(
      false
    );
  }
});

test("content tampering is refused without rebuilding or replacing the artifact", async () => {
  const root = await fixture();
  const compile = async () => new TextEncoder().encode("bundle");
  await buildArtifact({ root, inputId, compile });
  const path = join(root, "build/web.js");
  await chmod(path, 0o600);
  await writeFile(path, "tamper");
  await expect(buildArtifact({ root, inputId, compile })).rejects.toThrow(
    "content refused"
  );
  expect(await readFile(path, "utf8")).toBe("tamper");
});

test("symlinks, hardlinks and extra entries are not accepted as published output", async () => {
  for (const mode of ["symlink", "hardlink", "extra"]) {
    const root = await fixture();
    const other = await fixture();
    await buildArtifact({
      root,
      inputId,
      compile: async () => new TextEncoder().encode("bundle"),
    });
    await chmod(join(root, "build"), 0o700);
    const bundle = join(root, "build/web.js");
    await writeFile(join(other, "bundle"), "bundle");
    if (mode === "extra") {
      await writeFile(join(root, "build/extra"), "extra");
    } else {
      await unlink(bundle);
      if (mode === "symlink") {
        await symlink(join(other, "bundle"), bundle);
      } else {
        await link(join(other, "bundle"), bundle);
      }
    }
    await expect(verifyArtifact({ root, inputId })).rejects.toThrow();
  }
});

test("foreign output is preserved and never adopted", async () => {
  const root = await fixture();
  await mkdir(join(root, "foreign"));
  await expect(
    buildArtifact({ root, inputId, compile: async () => new Uint8Array(1) })
  ).rejects.toThrow("foreign output retained");
});
