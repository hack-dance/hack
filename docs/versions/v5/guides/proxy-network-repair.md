# Repair the shared proxy network

Use this guide for the Docker-backed global proxy stack. A proxy container can
be running while detached from `hack-dev`, attached to another network, or using
the wrong address; a running container alone does not prove routing works.

## Diagnose it

```sh
hack doctor
hack global status --json
```

Doctor reports a `proxy network` finding. Global status includes `proxy_network`:

| Field | Meaning |
| --- | --- |
| `ok: true` | The readable proxy containers have the expected network attachments and addresses. |
| `ok: false` | `issues` describes the detached, wrong-network or wrong-address containers. |
| `ok: null`, `readable: false` | Docker could not be read; the network state is unknown. |

The default shared stack reserves `172.30.0.2` for Caddy and `172.30.0.53` for
CoreDNS. Project containers must not occupy those addresses.

## Repair and recheck

After reviewing the finding and the active projects that share the proxy, run:

```sh
hack global up
hack global status --json
hack doctor
```

When it finds a misattached proxy, `global up` takes the proxy stack down before
recreating it. It also moves project containers off reserved proxy addresses
before starting the stack. Shared routes can be briefly unavailable during this
repair. A plain Compose `up -d` would keep an already-running proxy as it is.

Recheck the same application URL after the network finding clears. DNS,
certificate trust and browser permission remain separate checks; see
[macOS browser connectivity](macos-browser-network.md) and
[Certificate trust](macos-certificate-trust.md). The
[architecture guide](../architecture.md) explains the shared routing path.

This command repairs the shared Compose proxy, not a native guest's routing.
