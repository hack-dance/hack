# Run an existing Compose project on native

This page sets up a project that already runs on the Compose backend so that it
also runs on native, without editing its Compose file where native can avoid it.
It assumes the `hack-next` install and the runtime setup from
[Try native](start.md):

```sh
CANDIDATE="$HOME/.hack-next/bin/hack-next"
"$CANDIDATE" native setup
```

Native is beta. Keep a copy of any data you care about; native does not move
Compose volumes.

For Postgres, use a TCP health check such as `pg_isready -h 127.0.0.1`. A
Unix-socket check can pass against the temporary server that initializes a fresh
volume. If the service omits `start_interval`, native uses the authored timing
on a start that creates its data volume and uses the fast defaults with retained data.

## 1. List the blockers

```sh
"$CANDIDATE" doctor --native-preflight --path /absolute/project
```

Add `--profile` if the project uses profiles. Preflight starts nothing. Work
through it until it reports no blockers and `Runtime review: completed`; each
finding names its fix. The steps below are the fixes most projects need.

## 2. Create the project's machine settings

Each opt-in is one field in one file per project and machine. Nothing in it is
committed, and it holds no secret values.

```sh
dir="${XDG_CONFIG_HOME:-$HOME/.config}/hack/native/my-app"
mkdir -p -m 700 "$dir"
chmod 700 "$dir"
touch "$dir/settings.json" && chmod 600 "$dir/settings.json"
```

Replace `my-app` with the project's name. Start with:

```json
{
  "version": 1,
  "projectRoots": ["/absolute/project"],
  "sharedSource": true
}
```

`sharedSource` is the consent for a writable project bind such as `..:/app`:
native shares the whole project directory, including ignored files, with its VM.
Each field below is added to the same object. Every field also has an
environment variable for one command; the variable wins. The
[settings table](../../guides/native-candidate.md#native-settings-files) lists
them.

## 3. Add the opt-ins the project needs

**gcloud application-default credentials.** For a service that binds
`~/.config/gcloud/application_default_credentials.json` read-only, add:

```json
"gcloud": {"mode": "file"}
```

Run `gcloud auth application-default login` first. The Compose file keeps its
mount line: native reads the file after lifecycle hooks and delivers it to each
such service as a private read-only file. An empty `HACK_NATIVE_GCLOUD_ADC=`
withholds the consent for one command.

**Image builds.** Services with `build:` need `HACK_NATIVE_BUILDS=1` on the `up`
command, and the image builder, which `native setup` installs with the rest of
the runtime. A home that an earlier build set up does not have it yet: `up` and
`hack doctor` say so, and `native setup --accept-downloads` adds it
([the image builder](setup.md#the-image-builder)). Each distinct build runs once
and is shared by the services that use it. A build may use `context`, `dockerfile`,
`target` and literal `args`. Any other build field, such as `additional_contexts`,
`ssh` or `dockerfile_inline`, keeps the project on the Compose backend: `up` names
the service and the field, and prints the command that runs it there.

On the Compose backend, Hack warns before a build if its context can send Hack's
machine-local files to Docker. Add the suggested lines to the effective ignore
file, which is `<Dockerfile>.dockerignore` if present or the context's
`.dockerignore` otherwise. With `--json`, the warning is a JSON line on stderr.

An image is reused while its build inputs are unchanged: the Dockerfile, the ignore
file, the target, the args, and every file in the build context the ignore file lets
the build read. Native always leaves Hack's machine-local files out of its build
context, including `.hack/.internal/`, `.hack/.branch/`, `.hack/.env` and the
checkout's `.hack.secret.key`. Explicitly copying one of these paths in the
Dockerfile fails. Change any included input and the next `up` builds again, also after
`hack down`; the run's containers are then recreated from the new image and named
volumes are kept. `hack restart` checks the same inputs before it stops anything: a
build that fails leaves the current project running, and a rebuilt image is what the
restarted project runs. A changed download in a `RUN` step or changed cache mount
contents do not trigger a rebuild. A changed base digest does. An unchanged build
verifies its receipt from local state before acquiring any base. Ordinary tag expiry
is checked in the background after readiness. Use `hack up --refresh-images` to
check base tags during startup. `HACK_NATIVE_REBUILD=1` forces a build with the
recorded selection.

For a cold build, BuildKit fetches any missing base by digest during the solve. After
readiness, native tries to retain the exact bases from current and previous builds,
one at a time. It tags a matching local engine image when available and otherwise
downloads and imports the base. It defers when startup, stop, build, or reclamation
already holds the required locks. Downloads stage outside the provider lease and
stop when they observe a foreground operation. An admitted import keeps the provider
lease until verification settles. Retention has a 30-minute budget and logs failures
without changing the startup result. `hack up --offline` can reuse an unchanged
build. An edited build also needs its verified base loaded in the guest. After an
`up` that built, native removes superseded build images while keeping the current
and previous image and any image a run still uses.

**Host aliases** (`extra_hosts` with `host-gateway`, or `internal.extra_hosts`).
Native's VM has no route to your machine except through a binding to one host
listener, so there is no setup-free form. Add a dependency file:

```json
"dependencies": "dependencies.json"
```

and put it beside `settings.json`, with mode 600:

```json
{
  "version": 2,
  "dependencies": [{
    "binding": "db-proxy",
    "aliases": ["host.docker.internal"],
    "guest_port": 5432,
    "host_port": 5432,
    "host_executable": "/absolute/path/to/the/listener"
  }]
}
```

The listener must be your own process with an exclusive listener on
`127.0.0.1:<host_port>`; use `host_pid` instead of `host_executable` for one that
does not change.

An entry without `services` covers every service that declares the alias. One
alias reaches one host listener, so two host ports need two aliases. `hack up`
lists up to eight unbound aliases with their services and sources, and counts any
others.
If an alias is not used, remove it from the Compose file, or run
`hack internal extra-hosts unset <alias>` for one set by a hook.

**An old `.hack/.env`.** If preflight reports that an `env_file` names possible
`hack env materialize` output, first check whether `.hack/.env` holds any value of
your own, and move such values with `hack env set --local`. Then remove `.hack/.env`
and `.hack/.env.state.json`, and remove the `env_file` entry or mark it
`required: false`. Native delivers the env layers' values itself.

## 4. Serve routes over HTTPS beside the Compose proxy

Native serves routes through its own Caddy process on the host. It can run at the
same time as the Compose proxy if it uses another port:

```json
"https": {"caddyBinary": "/absolute/path/to/caddy", "caddySha256": "<sha256 of that file>", "port": 18443}
```

Get the SHA-256 with `shasum -a 256 /absolute/path/to/caddy`. Route URLs then
carry the port, for example `https://<route host>:18443`. The Compose proxy
keeps port 443 and its own hostnames.

**Hostnames beside v4.** The project's existing route names (for example under
`hack.local`) keep resolving to the Compose proxy, and DNS activation does not
rename or copy routes. To open the native routes in a browser while v4 keeps its
names, give each routed service a name under a separate suffix in the native
adaptation, then activate that suffix:

```json
{"version": 1, "additionalHostnames": {"web": ["web.my-app.v5.example"]}}
```

Put it in `.hack/native/adaptation.json` (committed, shared by every checkout), or
in any absolute file selected with `HACK_NATIVE_ADAPTATION`. The names are appended
to the service's Caddy labels on native only; the Compose file is unchanged. Then:

```sh
"$CANDIDATE" global dns preview --domain v5.example
"$CANDIDATE" global dns activate --domain v5.example
```

Activation asks for confirmation and an administrator prompt.

**Which CA signs native routes.** Native's Caddy creates its own local CA under
the native home, at `native-https/data/caddy/pki/authorities/local/root.crt`, the
first time it serves HTTPS. It is not the Compose proxy's CA, so trust installed
by `hack global trust` does not cover native routes. Doctor installs it in step 5,
once the first `up` has created it.

## 5. Start, trust, check and stop

Finish steps 2 to 4 first: the routes and hostnames are read at `up`.

```sh
"$CANDIDATE" up --detach --path /absolute/project
"$CANDIDATE" ps --path /absolute/project
```

Use `HACK_NATIVE_BUILDS=1` on `up` if the project builds images. With HTTPS selected,
this first `up` creates the native CA. While the project runs, let Doctor install it
and check one route:

```sh
"$CANDIDATE" doctor --fix --browser-url https://web.my-app.v5.example:18443
```

Doctor installs only the verified live root, after your confirmation and the macOS
administrator prompt. It checks the owner, root and route again after that prompt, and
verifies trust afterwards. Do not import `root.crt` by hand: Doctor's checks are what
keep a substituted file from becoming a trusted root. Check the app yourself: a
running VM does not prove the app works. Stop it
when you are done:

```sh
"$CANDIDATE" down --path /absolute/project
```

To go back, run the project with `HACK_RUNTIME_BACKEND=compose`, as described in
[Try native](start.md#back-to-compose).

## What this page does not cover

- Files from outside the project other than the gcloud and AWS credential shapes.
  Place such a file inside the project tree.
- `platform: linux/amd64` builds; see [the limits](limits.md).
- Moving data between Compose volumes and native volumes.
