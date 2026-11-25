import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const packager = resolve(import.meta.dir, "../scripts/package-guest-agent.sh");
const bin = "usr/local/bin";
const member = join(bin, "hack-vm-agent");

function staticElf(machine: number): Buffer<ArrayBuffer> {
  // ELF64 executable with one executable PT_LOAD covering the file.
  const elf = Buffer.alloc(120);
  elf.set([0x7f, 69, 76, 70, 2, 1, 1]);
  elf.writeUInt16LE(2, 16);
  elf.writeUInt16LE(machine, 18);
  elf.writeUInt32LE(1, 20);
  elf.writeBigUInt64LE(64n, 32);
  elf.writeUInt16LE(64, 52);
  elf.writeUInt16LE(56, 54);
  elf.writeUInt16LE(1, 56);
  elf.writeUInt32LE(1, 64);
  elf.writeUInt32LE(5, 68);
  elf.writeBigUInt64LE(120n, 96);
  elf.writeBigUInt64LE(120n, 104);
  return elf;
}

test("packages verified static agents into independent rootfs copies", async () => {
  const root = await mkdtemp(join(tmpdir(), "guest-image-"));
  try {
    const out = join(root, "out");
    await mkdir(out);
    const packageImage = async (
      base: string,
      agent: string,
      arch: string,
      parent = out
    ) =>
      (
        await execute(packager, [base, agent, arch, parent], { timeout: 5000 })
      ).stdout.trim();
    const images = await Promise.all(
      (
        [
          ["aarch64", 183],
          ["x86_64", 62],
        ] as const
      ).map(async ([arch, machine]) => {
        const agent = join(root, arch);
        const bytes = staticElf(machine);
        const base = join(root, `${arch}-base`);
        await mkdir(join(base, bin), { recursive: true });
        const provider = Buffer.concat([bytes, Buffer.from("provider")]);
        await writeFile(join(base, bin, "smolvm-agent"), provider);
        await symlink("/sbin/init", join(base, "init"));
        await writeFile(agent, bytes);
        const image = await packageImage(base, agent, arch);
        expect(await readFile(join(image, member))).toEqual(bytes);
        expect((await lstat(join(image, member))).mode & 0o777).toBe(0o755);
        expect(await readFile(join(image, bin, "smolvm-agent"))).toEqual(
          provider
        );
        expect(await readlink(join(image, "init"))).toBe("/sbin/init");
        return image;
      })
    );
    expect(new Set(images).size).toBe(2);
    const base = join(root, "aarch64-base");
    await expect(lstat(join(base, member))).rejects.toThrow();

    const arm = join(root, "aarch64");
    await expect(packageImage(base, arm, "x86_64")).rejects.toThrow();
    await expect(packageImage(base, arm, "aarch64", base)).rejects.toThrow();
    await expect(
      packageImage(join(root, "x86_64-base"), arm, "aarch64")
    ).rejects.toThrow();
    const dynamic = staticElf(183);
    dynamic.writeUInt32LE(3, 64); // PT_INTERP
    await writeFile(arm, dynamic);
    await expect(packageImage(base, arm, "aarch64")).rejects.toThrow();
    await writeFile(arm, staticElf(183));
    await symlink("missing", join(base, member));
    await expect(packageImage(base, arm, "aarch64")).rejects.toThrow();
    expect(await readlink(join(base, member))).toBe("missing");
    expect(await readdir(out)).toHaveLength(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
