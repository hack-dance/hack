# Develop Hack using Hack

In a linked worktree, choose an instance name unique to that checkout (for
example, `docs-preview`). Use the same name even if Git has a detached HEAD:

```sh
hack up --branch docs-preview --detach
hack open docs --branch docs-preview --json
hack down --branch docs-preview
```

Open the URL in the JSON output. In the main checkout you can omit `--branch`
from all three commands. Local HTTPS needs Hack's local routing setup.
Next.js reloads site changes and restages editorial edits under `docs/versions/`.
Run the same `up` command again after editing site dependencies or top-level
site configuration. To delete the docs dependency and build volumes, add
`--prune-caches --yes` **when stopping the running instance**. After a plain
`down`, a second `down` can no longer discover those volumes.

| Development entry point | What it starts | Where to run it |
| --- | --- | --- |
| `hack up` | Docs development server with local HTTPS and reload | Repository root |
| `bun run docs:dev` | Alias for the routed docs server | Calls `hack up` |
| Site package `dev` | Standalone loopback Next.js server | Use `hack up` for site development |
| `bun run dev`, CLI package `dev` | Branch CLI from source with the supplied arguments | Host for host runtime operations, or `hack run --profile toolchain toolchain -- exec bun index.ts --help` for portable commands |
| `bun run turbo:dev` | Runs workspace `dev` scripts in parallel, currently the CLI | Same paths as the CLI. The site has its own lockfile outside the workspace. |
| `bun run macos:dev` | Generates the native project and opens Xcode | macOS host with Xcode |
| `bun run install:dev` | Installs the development CLI on the host | Host whose CLI installation should change |
| `deps` service | Installs Linux workspace dependencies in the checkout as the invoking user | `HACK_DEPS_USER="$(id -u):$(id -g)" hack run --profile deps deps` (add `--branch docs-preview` before the service in a worktree). Use the host’s pinned Bun for macOS dependencies. |
| `dev` in `examples/basic`, `next-app`, `configs/web-postgres`, `configs/monorepo/apps/{api,web}` and `recipes/deps-service` | Sample Bun servers or Next.js | `hack up` from the example project root |
| `configs/host-dev-server` package `dev` | Host Bun server managed by a lifecycle hook | `hack up` from the example root |
| `configs/api-worker-queue` package `api` and `worker`, `configs/static-site` package `watch` | Sample API and worker, or watched static-site build | `hack up` from the example root |

On Linux, run `sh scripts/check-deps-ownership.sh` after `bun run build` to verify
the installer in a clean clone and run the source CLI against its dependencies.

Run portable checks in the opt-in `toolchain` service. The host needs Hack and a
working container runtime; Bun, Rust, Java and TLC are installed inside the image.
`mise.toml` pins the language tools and also supports an optional native mise setup.
`.tool-versions` retains matching Bun/Node/Zig pins for existing asdf consumers.
The Dockerfile pins mise and TLC with SHA256 checks. Debian packages receive the
updates available at build time; this is not a fully reproducible OS snapshot.

From the repository root:

```sh
hack run --profile toolchain toolchain -- models
hack run --profile toolchain toolchain -- test tests/tla-result.test.ts
hack run --profile toolchain toolchain -- test
hack run --profile toolchain toolchain -- check
hack run --profile toolchain toolchain -- rust
hack run --profile toolchain toolchain -- rust-check
hack run --profile toolchain toolchain -- lifecycle-supervisor
hack run --profile toolchain toolchain -- config-compiler
hack run --profile toolchain toolchain -- build
hack run --profile toolchain toolchain -- exec bun index.ts --help
```

During CLI development, use the current branch's `./dist/hack` as the outer command
after `bun run build`. The inner `bun index.ts` exercises source from the mounted
checkout. The installed CLI is a bootstrap path, not evidence of candidate behavior.
Compose checks the image build on every run and reuses unchanged build layers.
Changing the Dockerfile or tool pins therefore rebuilds through the same command.
The service is a one-shot task, not an idle development daemon.

After changing the Dockerfile or tool pins, run `sh scripts/check-toolchain-image.sh`.
It uses Docker to build without cached layers, checks the installed tools and TLC,
and removes its named container and image. Docker's build cache remains available.
The `Contributor toolchain image` workflow runs this check only when `mise.toml`,
the image inputs, the check script, or that workflow changes. Other PRs do not
spend hosted build minutes on it.
The service uses Compose `init: true` to reap orphaned process-group descendants;
direct Docker test invocations must likewise pass `--init`.

The Linux `node_modules`, compiled CLI `dist`, Rust registry, and `/build` outputs
use separate named volumes. They do not overwrite native build outputs. The build
task compiles from `/app/dist` so Bun 1.3.9 stages on the output filesystem; a
cross-device fallback from the host bind mount can otherwise emit an invalid binary
despite a successful compiler exit. The task also executes the result to verify it.
Dependency installation
uses the frozen lockfile and is serialized with test commands sharing that volume.
Each branch instance gets its own volumes today. Lockfile-compatible cross-worktree
reuse and bounded eviction remain follow-up work; do not claim this solves retention.
No Docker socket, user home, SSH agent, or credential directory is mounted. The
checkout is writable for normal development, so commands can edit source files.
The build context allows only the toolchain files and mise config, excluding project
secrets and runtime state. Preserve Hack-generated `.gitignore` entries.

Before the no-argument full `test` task, prepare its Linux compiler using the
`config-compiler` task above. Full tests check the selected compiler's protocol and
usability before launching; they do not automatically build or download it.
`HACK_CONFIG_COMPILER_BINARY`, when supplied inside the container, must name an
absolute compatible executable. Native host output does not substitute for the
container's separate `dist`. Focused `test <paths>` still runs without this suite
prerequisite; compiler-dependent paths require their own prepared compiler.

The test task preserves `TMPDIR` and `HACK_SYSTEMD_DISABLE` through Turbo. For
host checks, choose an owned fixture root with no ancestor `.hack` directory:
private `HOME` alone does not stop project discovery walking above a fixture.

Use host-native qualification for macOS Hypervisor/SmolVM/libkrun behavior, routing
and trust, idle reclamation, and full-runtime resource measurements. A Linux unit
suite or container benchmark does not establish those properties. Portable benchmark
commands can run through `toolchain exec`; record the image, architecture, CPU/memory
limits and whether measurements include the outer runtime. Nested Docker scenarios
need a separate isolated runtime fixture and are not enabled by this service.

The Linux container runs as root. Tests requiring macOS or an unprivileged chmod
failure are explicitly skipped there and must pass on the native host. This keeps
the container result distinct from full host acceptance.
