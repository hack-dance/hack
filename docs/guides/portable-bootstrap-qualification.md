# Qualify portable bootstrap

Use this check when preparing a managed cloud environment or a new remote host.
It exercises an explicitly selected Hack executable with a disposable project.
It requires Bun; use the version pinned in this repository's `package.json`.

```bash
bun install --frozen-lockfile
bun run build
bun run smoke:portable-bootstrap --hack-bin "$PWD/dist/hack"
```

The runner uses only Bun and Node built-ins. You can copy
`scripts/portable-bootstrap-smoke.ts` to an otherwise clean Linux environment and
run it with an installed CLI:

```bash
bun portable-bootstrap-smoke.ts --hack-bin /absolute/path/to/hack
```

It creates an isolated Hack home and project, encrypts a synthetic value, and
supplies the key only to child processes that need it. It checks missing and
wrong keys, repeated configuration reads, a loopback HTTP application launched
through `hack host exec`, a development command, and application data after a
restart. It checks for secret leakage in captured output and fixture files,
then removes its own processes and temporary files. It never needs a real
project key or cloud credential.

For a fresh container check, first build the repository's slim image. Record
the source revision and resulting image ID with the result:

```bash
docker build -f docker/slim-runtime/Dockerfile -t hack-portable:qualification .
docker run --rm --cap-drop ALL --security-opt no-new-privileges \
  --mount "type=bind,src=$PWD/scripts/portable-bootstrap-smoke.ts,dst=/tmp/bootstrap.ts,readonly" \
  --entrypoint bun hack-portable:qualification \
  /tmp/bootstrap.ts --hack-bin /usr/local/bin/hack
```

This does not mount the host Docker socket or publish a host port. The image's
anonymous volumes are removed by `--rm`. Keep downloaded tools and dependency
caches separate from credentials; do not bake a real env key into the image.
In a remote Docker context, the bind source must exist on the Docker host.

## What a pass proves

A pass qualifies the selected CLI's portable host-command path in that
environment. It does not prove the CLI installer, Docker-in-container access,
native VM support, application OAuth, browser routing, or provider secret
delivery. Test installation separately with an explicit release tag and verify
the installed executable before running this check.

For Codex Cloud, run this check inside the actual environment after its Install
script succeeds. Record the checked-out branch and SHA, runtime versions,
available container capabilities, and any skips. Review the tested Install
script and Start skill before publishing the private environment. A local or
ordinary Linux-container result does not qualify Codex Cloud by itself.

## Repeat maintenance

`scripts/maintain-codex-slim.sh` installs dependencies with
`bun install --frozen-lockfile` before installing the source wrapper. A failure
stops the operation. Correct the dependency or tool-version mismatch explicitly;
do not retry with an unlocked install that can rewrite the project's lockfile.
