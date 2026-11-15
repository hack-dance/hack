# Version identity

`hack version --json` reports the running CLI without network access, PATH
lookup, project discovery, registry writes or starting Docker, a VM or hackd.
Plain `hack version` and `hack --version` keep their text output.

```json
{
  "ok": true,
  "data": {
    "version": "5.0.0-next.1",
    "channel": "next",
    "install_kind": "standalone",
    "binary_path": "/example/bin/hack",
    "schema": "hack.version.v1"
  }
}
```

- `version` is the running CLI's embedded version.
- `channel` is `next` for a `-next.` version, `prerelease` for other prerelease
  versions, and `stable` otherwise.
- `install_kind` describes the executable path exposed by the OS: `homebrew`,
  `standalone`, `source` or `unknown` when it cannot be inspected. A wrapper
  launching Bun on source reports `source`, never `dev-wrapper`. Linux resolves
  launch symlinks before exposing this path, so a symlink to a standalone binary
  reports `standalone`. The classifier can return `symlink` only when the OS
  exposes an unresolved path; this has not been verified on macOS. A source
  invocation never looks for a different installed Hack.
- `binary_path` is the absolute running executable path. For source invocations
  this is the Bun executable. It identifies the process, not an update target.
  The OS may already have resolved a launch symlink, so its original spelling
  is not guaranteed.

The four identity fields and `schema: "hack.version.v1"` are inside `data`
in the standard success envelope. See [Machine-readable output](./machine-readable-output.md).

The report inspects only local executable metadata and, for compiled installs,
its initial bytes. It does not check whether a newer version exists.
