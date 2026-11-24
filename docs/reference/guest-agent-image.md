# Package a guest image for qualification

From the checkout, pass an extracted, verified SmolVM 1.35.4 guest rootfs, a
trusted release build of `hack-vm-agent`, its Linux architecture (`aarch64`
or `x86_64`), and an existing output directory outside the rootfs.

```sh
scripts/package-guest-agent.sh "$ROOTFS" "$AGENT" aarch64 "$OUTPUT_PARENT"
```

The command prints the absolute path of a fresh rootfs after it verifies the
installed agent’s bytes and static ELF dependencies. It checks the ELF machine
type of both the installed agent and the provider binary against the requested architecture. The binary
is installed at `/usr/local/bin/hack-vm-agent`. Provider init, the provider
agent and the original image remain available. Each invocation owns a new
directory under the output parent, including when two builds run together.
Remove that directory after qualification. Starting the agent and exposing its
control socket require the separate launcher integration.
