# Version identity

`hack version --json` reports the running CLI without network access, PATH
lookup, project discovery, registry writes or starting Docker, a VM or hackd.
Plain `hack version` and `hack --version` keep their text output.

```json
{"version":"5.0.0-next.1","channel":"next","install_kind":"standalone","binary_path":"/example/bin/hack"}
```

- `version` is the running CLI's embedded version.
- `channel` is `next` for a `-next.` version, `prerelease` for other prerelease
  versions, and `stable` otherwise.
- `install_kind` uses the local installer classifier: `homebrew`, `symlink`,
  `dev-wrapper` or `standalone`. An unavailable executable is `unknown`.
  A source invocation such as `bun index.ts` reports `source`; it never looks
  for a different installed Hack.
- `binary_path` is the absolute running executable path. For source invocations
  this is the Bun executable. It identifies the process, not an update target.
  The OS may already have resolved a launch symlink, so its original spelling
  is not guaranteed.

The report inspects only local executable metadata and, for compiled installs,
its initial bytes. It does not check whether a newer version exists.
