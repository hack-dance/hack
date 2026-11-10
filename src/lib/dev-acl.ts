const ENTRY_START = /^\s*\d+:/;
const ENTRY = /^\s*\d+:\s+.+\s+(allow|deny)\s+(.+)$/;
const READ_ONLY_RIGHTS = new Set([
  "read",
  "list",
  "search",
  "execute",
  "readattr",
  "readextattr",
  "readsecurity",
  "synchronize",
  "file_inherit",
  "directory_inherit",
  "limit_inherit",
  "only_inherit",
  "inherited",
]);

/** Darwin ACL grants are independent of POSIX mode bits. Unknown allow rights fail closed. */
export function hasDevMutationAcl(output: string): boolean {
  return output.split("\n").some((line) => {
    if (!ENTRY_START.test(line)) {
      return false;
    }
    const entry = ENTRY.exec(line);
    if (!entry) {
      return true;
    }
    if (entry[1] === "deny") {
      return false;
    }
    return (
      entry[2]
        ?.split(",")
        .some((right) => !READ_ONLY_RIGHTS.has(right.trim())) ?? true
    );
  });
}
