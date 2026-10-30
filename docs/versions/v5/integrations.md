# Use Hack with an agent

For the separately published, unreleased PR531 source, see [Agent setup on the v5 branch](guides/agent-setup-v5-branch.md). That guide identifies its own revision; the next.5 runtime and artifact facts on this page remain unchanged.

With shell access, an agent can use the CLI directly. Complete [Install](install.md), select the intended executable and give the agent this version's [documentation index](/v5/llms.txt) or [full corpus](/v5/llms-full.txt).

For a local review, replace the public host below with the actual preview host **before** copying the task. Keep the /v5/ path so the agent reads the selected version. After publication, use the public host shown.

A copyable task introduction:

~~~text
Read https://hack.foo/v5/llms.txt.
Confirm the Hack executable, version, host and project before changing anything.
Use the CLI for the requested task and verify the application's behavior.
Preserve existing repository policy. Do not install agent instructions, hooks
or rules, run guidance sync, or update skills as a setup side effect.
~~~

Plugins and MCP are optional. They do not install Hack or prepare its runtime.

## Optional Codex skills

Use a reviewed checkout of the selected source revision. Its [native marketplace](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/.agents/plugins/marketplace.json) lists `./plugins/hack` and `./plugins/hack-mcp` relative to the repository marketplace root. The [Codex manifest](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/plugins/hack/.codex-plugin/plugin.json) selects `./skills/`.

Register that local source:

~~~sh
codex plugin marketplace add /absolute/path/to/reviewed-checkout
~~~

Registration does not install or load the plugin. Follow the current [OpenAI plugin documentation](https://developers.openai.com/plugins/build/plugins) to select, install and test it through the client Plugins Directory. A repository marketplace is not a public directory listing.

The `hack` bundle ships these seven skills; select only the guidance you want:

| Skill | Purpose |
| --- | --- |
| hack-cli | CLI workflows, services, URLs, logs and workspaces |
| hack-branches | Parallel branch instances and aliases |
| hack-env | Env layers and value-safe configuration workflows |
| hack-diagnose | Read-first diagnosis and error-code reference |
| hack-init | Explicit project onboarding through the CLI prompt |
| hack-install | Installation and executable/channel selection |
| hack-remote | Prepare a project on another host or in a cloud environment; it does not enable unsupported node/gateway commands |

**Released next.5 caveat:** the [skill bodies](https://github.com/hack-dance/hack/tree/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/plugins/hack/skills), including hack-cli, still recommend freshness checks, sync and standalone exports. Its Codex manifest declares skills only, but the sibling [Claude manifest](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/plugins/hack/.claude-plugin/plugin.json) selects SessionStart/PreCompact primer hooks and the [Cursor manifest](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/plugins/hack/.cursor-plugin/plugin.json) selects rules. Review these artifacts before enabling them. The intended hook-free model has not shipped in this pin; use the CLI and versioned docs if you do not want that behavior. See the short [compatibility boundary](reference/agent-compatibility.md).

Clients supporting individual opt-in skills can use a separately reviewed skill and its references. That choice does not require policy-file exports, global settings or automatic skill updates. For project setup, see [Give an agent an explicit task](guides/agent-first-setup.md).

## Optional, separate MCP

The `hack` plugin has no MCP server. The separate [hack-mcp bundle](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/plugins/hack-mcp/README.md) supplies one stdio server, `hack mcp serve`, with no skills, hooks or rules. Its [server definition](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/plugins/hack-mcp/mcp.json) finds `hack` on the client's PATH; it does not select `hack-next` or a native home. Choose one Hack MCP registration per client.

For an explicitly selected candidate integration, next.5's `mcp print` supports `--bundle`, `--cli` and `--runtime-directory`. These select a verified MCP adapter bundle, its intended Hack executable and a private socket directory; an adapter bundle is separate from the native CLI installation. Printing previews configuration without installing it. See the [pinned command declarations](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/commands/mcp.ts) and [bundle launch contract](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/mcp/bundle-launch.ts) for requirements.

Read [MCP tools](../reference/mcp-tools.md), [fields/results](reference/mcp-fields.md) and [log limits](../reference/mcp-logs.md) when choosing this interface. Plugin registration is not proof of client loading or runtime compatibility, and local plugins do not automatically appear in cloud tasks.
