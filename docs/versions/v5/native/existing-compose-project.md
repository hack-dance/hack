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
command, and the native builder prepared once with the exact `buildx` release
that the runtime pins (`runtime prepare-builder --archive`; see the
[native guide](../../guides/native-candidate.md)). Each distinct build runs once and is shared by the services that use
it.

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

**Which CA signs native routes.** Native's Caddy creates its own local CA under
the native home, at `native-https/data/caddy/pki/authorities/local/root.crt`, the
first time it serves HTTPS. It is not the Compose proxy's CA, so trust installed
by `hack global trust` does not cover native routes. Trust the native root once,
from your own terminal:

```sh
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain \
  /absolute/native-home/native-https/data/caddy/pki/authorities/local/root.crt
```

`hack doctor --json` with native selected reports whether that exact root is
trusted. For browser access the hostnames must also resolve to loopback; to keep
native names apart from v4, use a separate suffix with
`hack global dns preview --domain <suffix>` and then
`hack global dns activate --domain <suffix>`.

## 5. Start, check and stop

```sh
"$CANDIDATE" up --detach --path /absolute/project
"$CANDIDATE" ps --path /absolute/project
"$CANDIDATE" down --path /absolute/project
```

Use `HACK_NATIVE_BUILDS=1` on `up` if the project builds images. Check the app
yourself: a running VM does not prove the app works. To go back, run the project
with `HACK_RUNTIME_BACKEND=compose`, as described in [Try native](start.md#back-to-compose).

## What this page does not cover

- Files from outside the project other than the gcloud and AWS credential shapes.
  Place such a file inside the project tree.
- `platform: linux/amd64` builds; see [the limits](limits.md).
- Moving data between Compose volumes and native volumes.
