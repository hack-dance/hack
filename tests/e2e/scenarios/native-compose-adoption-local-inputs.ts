import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

type Checkout = { readonly root: string };
function refuse(): never {
  throw new Error(
    "Adoption typed-local fixture source check failed; values omitted."
  );
}

/** Authored sidecars only. Legacy generated writers still select qa, and the checkout layer restores that same selection after primary precedence. */
export async function prepareTypedLocalAdoptionFixtureSources(opts: {
  readonly primary: Checkout;
  readonly instances: readonly Checkout[];
}) {
  await writeFile(
    join(opts.primary.root, ".hack/hack.local.json"),
    JSON.stringify({
      schema_version: 1,
      environment: { default_overlay: "shadowed" },
    }),
    { mode: 0o600 }
  );
  for (const instance of opts.instances) {
    await writeFile(
      join(instance.root, ".hack/hack.local.json"),
      JSON.stringify({
        schema_version: 1,
        environment: { default_overlay: "qa" },
      }),
      { mode: 0o600 }
    );
  }
}

/** Private raw/inode oracle: no sidecar values or digests enter scenario logs or public reports. */
export async function typedLocalAdoptionFixtureSourceSnapshot(opts: {
  readonly primary: Checkout;
  readonly instance: Checkout;
}): Promise<string> {
  const files: { dev: number; ino: number; mode: number; hash: string }[] = [];
  for (const checkout of [opts.primary, opts.instance]) {
    const path = join(checkout.root, ".hack/hack.local.json");
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o022) !== 0
    ) {
      refuse();
    }
    files.push({
      dev: info.dev,
      ino: info.ino,
      mode: info.mode,
      hash: new Bun.CryptoHasher("sha256")
        .update(await readFile(path))
        .digest("hex"),
    });
  }
  return JSON.stringify(files);
}
