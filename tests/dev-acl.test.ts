import { expect, test } from "bun:test";
import { hasDevMutationAcl } from "../src/lib/dev-acl.ts";

test("standard deny-delete and read-only Darwin ACLs retain a stable namespace", () => {
  expect(
    hasDevMutationAcl(
      "drwx------+ 1 example example 0 fixture\n 0: group:everyone deny delete\n"
    )
  ).toBe(false);
  expect(
    hasDevMutationAcl(
      " 0: user:example inherited allow list,search,readattr,readextattr,readsecurity\n"
    )
  ).toBe(false);
});
test("Darwin mutation grants and unrecognized ACL entries fail closed", () => {
  for (const right of [
    "add_file",
    "add_subdirectory",
    "delete_child",
    "delete",
    "write",
    "append",
    "writeattr",
    "writeextattr",
    "writesecurity",
    "chown",
    "unknown",
  ]) {
    expect(
      hasDevMutationAcl(` 0: user:example allow list,search,${right}\n`)
    ).toBe(true);
  }
  expect(hasDevMutationAcl(" 0: unreadable ACL entry\n")).toBe(true);
});

test("principal text cannot masquerade as a deny action", () => {
  expect(
    hasDevMutationAcl(" 0: user:example deny name allow delete_child\n")
  ).toBe(true);
});
