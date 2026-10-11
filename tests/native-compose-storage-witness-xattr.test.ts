import { describe, expect, test } from "bun:test";
import {
  createNativeComposeStorageXattrMarker,
  decodeNativeComposeStorageXattrRequest,
  decodeNativeComposeStorageXattrResponse,
  encodeNativeComposeStorageXattrRequest,
  encodeNativeComposeStorageXattrResponse,
  NATIVE_STORAGE_XATTR_KIND,
  NATIVE_STORAGE_XATTR_VERSION,
  type NativeComposeStorageXattrRequest,
  type NativeComposeStorageXattrRoot,
  parseNativeComposeStorageXattrRequest,
  parseNativeComposeStorageXattrResponse,
} from "../src/lib/native-compose-storage-witness-xattr-codec.ts";
import {
  type NativeComposeStorageXattrKernel,
  runNativeComposeStorageXattrHelper,
} from "../src/lib/native-compose-storage-witness-xattr-helper.ts";
import { NATIVE_STORAGE_XATTR_LINUX_ABI } from "../src/lib/native-compose-storage-witness-xattr-linux.ts";

const root: NativeComposeStorageXattrRoot = {
  device: "1234567890123456789",
  inode: "9876543210123456789",
  uid: 0,
  gid: 0,
};
const marker = {
  kind: NATIVE_STORAGE_XATTR_KIND,
  version: NATIVE_STORAGE_XATTR_VERSION,
  name: `user.hack.storage.${"a".repeat(64)}`,
  valueHex: "b".repeat(64),
};
function request(
  operation: "seed" | "verify"
): NativeComposeStorageXattrRequest {
  return { ...marker, operation, root };
}
function fake() {
  const calls: string[] = [];
  const attributes = new Map<string, Uint8Array>();
  const state = {
    root: { ...root },
    uid: 0,
    gid: 0,
    readonly: false,
  };
  const kernel: NativeComposeStorageXattrKernel = {
    effectiveUid: () => state.uid,
    effectiveGid: () => state.gid,
    probeRoot() {
      calls.push("probe");
      return state.root;
    },
    openRoot() {
      calls.push("open");
      return 42;
    },
    statRoot(fd) {
      expect(fd).toBe(42);
      calls.push("stat");
      return state.root;
    },
    createXattr(fd, name, value) {
      expect(fd).toBe(42);
      calls.push("create");
      if (state.readonly || attributes.has(name)) {
        throw new Error("EEXIST/EROFS private diagnostic must not escape");
      }
      attributes.set(name, new Uint8Array(value));
    },
    syncRoot(fd) {
      expect(fd).toBe(42);
      calls.push("sync");
    },
    readXattr(fd, name, bytes) {
      expect(fd).toBe(42);
      expect(bytes).toBe(32);
      calls.push("read");
      const value = attributes.get(name);
      if (!value) {
        throw new Error(`ENODATA ${name} private diagnostic`);
      }
      return new Uint8Array(value);
    },
    closeRoot(fd) {
      expect(fd).toBe(42);
      calls.push("close");
    },
  };
  return { kernel, calls, attributes, state };
}
function refused(value: unknown) {
  expect(value).toEqual({
    kind: NATIVE_STORAGE_XATTR_KIND,
    version: NATIVE_STORAGE_XATTR_VERSION,
    outcome: "refused",
  });
  expect(JSON.stringify(value)).not.toContain(marker.name);
  expect(JSON.stringify(value)).not.toContain(marker.valueHex);
}

describe("distinct bounded directory-xattr codec", () => {
  test("Linux open flags retain the separate arm64 and x64 UAPI contracts without loading libc", () => {
    // Linux open does not set FD_CLOEXEC unless the initial flags request it.
    expect(NATIVE_STORAGE_XATTR_LINUX_ABI.openCloseExec).toBe(524_288);
    expect(NATIVE_STORAGE_XATTR_LINUX_ABI.fGetFd).toBe(1);
    expect(NATIVE_STORAGE_XATTR_LINUX_ABI.fdCloseExec).toBe(1);
    expect(NATIVE_STORAGE_XATTR_LINUX_ABI.arm64).toEqual({
      libc: "/lib/aarch64-linux-gnu/libc.so.6",
      directory: 16_384,
      noFollow: 32_768,
    });
    expect(NATIVE_STORAGE_XATTR_LINUX_ABI.x64).toEqual({
      libc: "/lib/x86_64-linux-gnu/libc.so.6",
      directory: 65_536,
      noFollow: 131_072,
    });
  });
  test("canonical requests and responses retain 64-bit root facts without number rounding", () => {
    const selected = request("verify");
    expect(
      parseNativeComposeStorageXattrRequest(
        encodeNativeComposeStorageXattrRequest(selected)
      )
    ).toEqual(selected);
    const response = {
      kind: NATIVE_STORAGE_XATTR_KIND,
      version: NATIVE_STORAGE_XATTR_VERSION,
      outcome: "verified" as const,
      root,
      valueHex: marker.valueHex,
    };
    expect(
      parseNativeComposeStorageXattrResponse(
        encodeNativeComposeStorageXattrResponse(response)
      )
    ).toEqual(response);
  });
  test("metadata discovery contains neither marker bytes nor enrollment authority", () => {
    const discovery = {
      kind: NATIVE_STORAGE_XATTR_KIND,
      version: NATIVE_STORAGE_XATTR_VERSION,
      operation: "root" as const,
    };
    expect(
      parseNativeComposeStorageXattrRequest(
        encodeNativeComposeStorageXattrRequest(discovery)
      )
    ).toEqual(discovery);
    const selected = fake();
    const result = runNativeComposeStorageXattrHelper({
      request: discovery,
      kernel: selected.kernel,
    });
    expect(result).toEqual({
      kind: NATIVE_STORAGE_XATTR_KIND,
      version: NATIVE_STORAGE_XATTR_VERSION,
      outcome: "root",
      root,
    });
    expect(selected.calls).toEqual(["probe", "probe"]);
  });
  test("random names and values are independent opaque 256-bit selections", () => {
    const first = createNativeComposeStorageXattrMarker();
    const second = createNativeComposeStorageXattrMarker();
    expect(first.name).not.toBe(second.name);
    expect(first.valueHex).not.toBe(second.valueHex);
    expect(first.name.endsWith(first.valueHex)).toBe(false);
    expect(Object.isFrozen(first)).toBe(true);
  });
  test.each([
    ["file kind", { ...request("seed"), kind: "regular-file" }],
    [
      "USTAR leaf",
      { ...request("seed"), name: `.hack-storage-${"a".repeat(64)}.witness` },
    ],
    ["unknown version", { ...request("seed"), version: 2 }],
    ["repair operation", { ...request("seed"), operation: "replace" }],
    ["extra path", { ...request("seed"), path: "/etc/passwd" }],
    ["name NUL", { ...request("seed"), name: `${marker.name}\0suffix` }],
    ["short value", { ...request("seed"), valueHex: "a".repeat(62) }],
    ["uppercase value", { ...request("seed"), valueHex: "B".repeat(64) }],
    ["negative uid", { ...request("seed"), root: { ...root, uid: -1 } }],
    ["negative zero uid", { ...request("seed"), root: { ...root, uid: -0 } }],
    [
      "oversized uid",
      { ...request("seed"), root: { ...root, uid: 4_294_967_296 } },
    ],
    ["float uid", { ...request("seed"), root: { ...root, uid: 1.5 } }],
    ["number inode", { ...request("seed"), root: { ...root, inode: 42 } }],
    ["zero inode", { ...request("seed"), root: { ...root, inode: "0" } }],
    [
      "rounded inode",
      { ...request("seed"), root: { ...root, inode: "18446744073709551616" } },
    ],
    ["leading zero", { ...request("seed"), root: { ...root, device: "001" } }],
    [
      "extra root field",
      { ...request("seed"), root: { ...root, path: "/private" } },
    ],
  ])("refuses %s before any syscall", (_, value) => {
    expect(() => decodeNativeComposeStorageXattrRequest(value)).toThrow(
      "values omitted"
    );
    const selected = fake();
    refused(
      runNativeComposeStorageXattrHelper({
        request: value,
        kernel: selected.kernel,
      })
    );
    expect(selected.calls).toEqual([]);
  });
  test.each([
    `{"kind":"directory-xattr","version":1,"operation":"root","operation":"root"}\n`,
    `{"kind":"directory-xattr","version":1,"operation":"root"}\n\n`,
    `${encodeNativeComposeStorageXattrRequest(request("verify"))}suffix`,
    " ".repeat(4097),
  ])("refuses noncanonical input without printing it", (text) => {
    expect(() => parseNativeComposeStorageXattrRequest(text)).toThrow(
      "values omitted"
    );
  });
  test("unknown responses cannot turn metadata discovery into marker proof", () => {
    expect(() =>
      decodeNativeComposeStorageXattrResponse({
        kind: NATIVE_STORAGE_XATTR_KIND,
        version: NATIVE_STORAGE_XATTR_VERSION,
        outcome: "verified",
        root,
      })
    ).toThrow("values omitted");
    expect(() =>
      decodeNativeComposeStorageXattrResponse({
        kind: NATIVE_STORAGE_XATTR_KIND,
        version: NATIVE_STORAGE_XATTR_VERSION,
        outcome: "refused",
        error: marker.valueHex,
      })
    ).toThrow("values omitted");
  });
});

describe("offline syscall boundary, no Linux helper execution", () => {
  test("seed performs one exclusive creation, synchronization and root recheck", () => {
    const selected = fake();
    const result = runNativeComposeStorageXattrHelper({
      request: request("seed"),
      kernel: selected.kernel,
    });
    expect(result.outcome).toBe("seeded");
    expect(selected.calls).toEqual([
      "open",
      "stat",
      "create",
      "sync",
      "stat",
      "close",
    ]);
    expect(selected.attributes.get(marker.name)).toEqual(
      Buffer.from(marker.valueHex, "hex")
    );
    expect(result).not.toHaveProperty("valueHex");
  });
  test.each([
    new Uint8Array(),
    Buffer.from("c".repeat(64), "hex"),
    Buffer.from(marker.valueHex, "hex"),
  ])("existing empty, wrong or matching attribute is never overwritten", (existing) => {
    const selected = fake();
    selected.attributes.set(marker.name, new Uint8Array(existing));
    refused(
      runNativeComposeStorageXattrHelper({
        request: request("seed"),
        kernel: selected.kernel,
      })
    );
    expect(selected.attributes.get(marker.name)).toEqual(existing);
    expect(selected.calls).toEqual(["open", "stat", "create", "close"]);
  });
  test("read-only verification never creates, synchronizes or repairs storage", () => {
    const selected = fake();
    selected.state.readonly = true;
    selected.attributes.set(marker.name, Buffer.from(marker.valueHex, "hex"));
    const result = runNativeComposeStorageXattrHelper({
      request: request("verify"),
      kernel: selected.kernel,
    });
    expect(result).toEqual({
      kind: NATIVE_STORAGE_XATTR_KIND,
      version: NATIVE_STORAGE_XATTR_VERSION,
      outcome: "verified",
      root,
      valueHex: marker.valueHex,
    });
    expect(selected.calls).toEqual([
      "open",
      "stat",
      "read",
      "stat",
      "read",
      "stat",
      "close",
    ]);
  });
  test("an enrolled-token stand-in refuses an empty replacement with every observed metadata field unchanged", () => {
    const metadata = Object.freeze({
      name: "owned-data",
      storage: "data",
      createdAt: "2026-10-08T12:00:00Z",
      owner: "a".repeat(32),
      root: { ...root },
    });
    const selected = fake();
    expect(
      runNativeComposeStorageXattrHelper({
        request: request("seed"),
        kernel: selected.kernel,
      }).outcome
    ).toBe("seeded");
    expect(
      runNativeComposeStorageXattrHelper({
        request: request("verify"),
        kernel: selected.kernel,
      }).outcome
    ).toBe("verified");
    const replacementMetadata = structuredClone(metadata);
    selected.attributes.clear();
    selected.state.readonly = true;
    selected.calls.length = 0;
    expect(replacementMetadata).toEqual(metadata);
    refused(
      runNativeComposeStorageXattrHelper({
        request: request("verify"),
        kernel: selected.kernel,
      })
    );
    expect(selected.calls).toEqual(["open", "stat", "read", "close"]);
    expect(selected.attributes.size).toBe(0);
  });
  test.each([
    undefined,
    new Uint8Array(),
    Buffer.from("c".repeat(64), "hex"),
    new Uint8Array(33),
  ])("same name/labels/birth with absent, empty, wrong or oversized bytes refuses without seed", (replacement) => {
    const selected = fake();
    selected.state.readonly = true;
    if (replacement) {
      selected.attributes.set(marker.name, replacement);
    }
    refused(
      runNativeComposeStorageXattrHelper({
        request: request("verify"),
        kernel: selected.kernel,
      })
    );
    expect(selected.calls).not.toContain("create");
    expect(selected.calls).not.toContain("sync");
    expect(selected.calls.at(-1)).toBe("close");
  });
  test("a post-read marker change is detected by a second bounded read", () => {
    const selected = fake();
    selected.attributes.set(marker.name, Buffer.from(marker.valueHex, "hex"));
    const original = selected.kernel.readXattr;
    let reads = 0;
    const kernel = {
      ...selected.kernel,
      readXattr(fd: number, name: string, bytes: number) {
        const value = original(fd, name, bytes);
        if (++reads === 1) {
          selected.attributes.set(name, Buffer.from("c".repeat(64), "hex"));
        }
        return value;
      },
    };
    refused(
      runNativeComposeStorageXattrHelper({ request: request("verify"), kernel })
    );
    expect(reads).toBe(2);
    expect(selected.calls).not.toContain("create");
  });
  test("replacement behind a pinned root and UID drift refuse", () => {
    const selected = fake();
    selected.attributes.set(marker.name, Buffer.from(marker.valueHex, "hex"));
    const original = selected.kernel.readXattr;
    const kernel = {
      ...selected.kernel,
      readXattr(fd: number, name: string, bytes: number) {
        const value = original(fd, name, bytes);
        selected.state.root.inode = "54321";
        selected.state.root.uid = 70;
        return value;
      },
    };
    refused(
      runNativeComposeStorageXattrHelper({ request: request("verify"), kernel })
    );
    expect(selected.calls).toEqual(["open", "stat", "read", "stat", "close"]);
  });
  test("cold UID0 then Postgres70 requires explicit matching credentials; actual permissions are unqualified", () => {
    const selected = fake();
    expect(
      runNativeComposeStorageXattrHelper({
        request: request("seed"),
        kernel: selected.kernel,
      }).outcome
    ).toBe("seeded");
    selected.state.root.uid = 70;
    selected.state.root.gid = 70;
    const postStart = {
      ...request("verify"),
      root: { ...selected.state.root },
    };
    selected.calls.length = 0;
    refused(
      runNativeComposeStorageXattrHelper({
        request: postStart,
        kernel: selected.kernel,
      })
    );
    expect(selected.calls).toEqual([]);
    selected.state.uid = 70;
    selected.state.gid = 70;
    expect(
      runNativeComposeStorageXattrHelper({
        request: postStart,
        kernel: selected.kernel,
      }).outcome
    ).toBe("verified");
    expect(selected.calls).not.toContain("create");
  });
  test("synchronization failure retains the attempted value without a success or repair", () => {
    const selected = fake();
    const kernel = {
      ...selected.kernel,
      syncRoot() {
        throw new Error(marker.valueHex);
      },
    };
    refused(
      runNativeComposeStorageXattrHelper({ request: request("seed"), kernel })
    );
    expect(selected.attributes.get(marker.name)).toEqual(
      Buffer.from(marker.valueHex, "hex")
    );
    expect(selected.calls).toEqual(["open", "stat", "create", "close"]);
  });
  test("kernel callback substitution cannot replace captured seed authority", () => {
    const selected = fake();
    let substituted = 0;
    const kernel = {
      ...selected.kernel,
      effectiveUid() {
        kernel.createXattr = () => {
          substituted++;
        };
        return 0;
      },
    };
    expect(
      runNativeComposeStorageXattrHelper({ request: request("seed"), kernel })
        .outcome
    ).toBe("seeded");
    expect(substituted).toBe(0);
    expect(selected.attributes.has(marker.name)).toBe(true);
  });
  test("root drift before seed prevents creation and closes the descriptor", () => {
    const selected = fake();
    selected.state.root.inode = "12345";
    refused(
      runNativeComposeStorageXattrHelper({
        request: request("seed"),
        kernel: selected.kernel,
      })
    );
    expect(selected.calls).toEqual(["open", "stat", "close"]);
    expect(selected.attributes.size).toBe(0);
  });
  test("read-only mount refuses a seed attempt without synchronizing or repairing", () => {
    const selected = fake();
    selected.state.readonly = true;
    refused(
      runNativeComposeStorageXattrHelper({
        request: request("seed"),
        kernel: selected.kernel,
      })
    );
    expect(selected.calls).toEqual(["open", "stat", "create", "close"]);
    expect(selected.attributes.size).toBe(0);
  });
  test("close failure does not publish a successful token proof", () => {
    const selected = fake();
    selected.attributes.set(marker.name, Buffer.from(marker.valueHex, "hex"));
    const kernel = {
      ...selected.kernel,
      closeRoot() {
        throw new Error(marker.valueHex);
      },
    };
    refused(
      runNativeComposeStorageXattrHelper({ request: request("verify"), kernel })
    );
    expect(selected.calls).not.toContain("create");
  });
  test("metadata discovery drift is a refusal, never an unverified UID switch", () => {
    const selected = fake();
    let probes = 0;
    const kernel = {
      ...selected.kernel,
      probeRoot() {
        if (++probes === 2) {
          selected.state.root.uid = 70;
        }
        return selected.state.root;
      },
    };
    refused(
      runNativeComposeStorageXattrHelper({
        request: {
          kind: NATIVE_STORAGE_XATTR_KIND,
          version: NATIVE_STORAGE_XATTR_VERSION,
          operation: "root",
        },
        kernel,
      })
    );
    expect(probes).toBe(2);
    expect(selected.attributes.size).toBe(0);
  });
});
