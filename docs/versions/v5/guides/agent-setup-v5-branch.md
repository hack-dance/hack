# Agent setup in next.6

**Released next.6:** merged [PR531](https://github.com/hack-dance/hack/pull/531) is included in source `44aaf5156426dfcbb1c8a189b8e20531e5b95613`. Automatic guidance injection is retired; plugin and MCP integrations are opt-in.

## Select the released executable

Complete [Install](../install.md). Select the explicit candidate executable; this does not change your global PATH.

~~~sh
V5_CLI="$HOME/.hack-next/bin/hack-next"
"$V5_CLI" --version
~~~

This selects a command executable, not a native runtime, provider pool or home. Native project work still needs a matching prepared bundle/launcher and private `HACK_NATIVE_HOME`; see [Native preparation](native-candidate.md) for the separate contract.

## Choose skills or direct CLI use

An agent with shell access can use the selected CLI directly. No agent plugin is required.

The release's `hack` package contains seven skills: hack-cli, hack-branches, hack-env, hack-diagnose, hack-init, hack-install and hack-remote. Its [Codex](https://github.com/hack-dance/hack/blob/44aaf5156426dfcbb1c8a189b8e20531e5b95613/plugins/hack/.codex-plugin/plugin.json), [Claude](https://github.com/hack-dance/hack/blob/44aaf5156426dfcbb1c8a189b8e20531e5b95613/plugins/hack/.claude-plugin/plugin.json) and [Cursor](https://github.com/hack-dance/hack/blob/44aaf5156426dfcbb1c8a189b8e20531e5b95613/plugins/hack/.cursor-plugin/plugin.json) manifests select skills only. It declares no session-primer hooks, injected Cursor rules or MCP server. Read the [actual skill bodies](https://github.com/hack-dance/hack/tree/44aaf5156426dfcbb1c8a189b8e20531e5b95613/plugins/hack/skills) before selecting them.

For Codex, register a checkout of this reviewed revision as a local plugin source:

~~~sh
codex plugin marketplace add /absolute/path/to/reviewed-next6-checkout
~~~

Registration is not installation or loading. Follow the current [OpenAI plugin guide](https://developers.openai.com/plugins/build/plugins) for client Plugins Directory selection and testing. This repository marketplace is not a public directory listing.

Alternatively, explicitly install the standalone Codex skills into one project:

~~~sh
"$V5_CLI" setup codex --path /absolute/project
~~~

This project-scoped opt-in writes the hack-cli and hack-init skills, not AGENTS.md or CLAUDE.md. The [handler](https://github.com/hack-dance/hack/blob/44aaf5156426dfcbb1c8a189b8e20531e5b95613/src/commands/setup.ts) selects the scope, and the [skill writer](https://github.com/hack-dance/hack/blob/44aaf5156426dfcbb1c8a189b8e20531e5b95613/src/agents/codex-skill.ts) retains its custom-file ownership checks. Do not combine redundant integration paths for the same client.

## Optional, separate MCP

The [hack-mcp package](https://github.com/hack-dance/hack/blob/44aaf5156426dfcbb1c8a189b8e20531e5b95613/plugins/hack-mcp/README.md) contains only the stdio `hack mcp serve` interface, with no skills, hooks or rules. Its [default server definition](https://github.com/hack-dance/hack/blob/44aaf5156426dfcbb1c8a189b8e20531e5b95613/plugins/hack-mcp/mcp.json) resolves `hack` on the client's PATH. Neither plugin selection nor invoking an installer through `V5_CLI` makes that server use a candidate automatically.

For a normal project-scoped registration, use the following **only when the client's intended PATH command already selects the matching reviewed executable**. Preview first, then install one selected client configuration:

~~~sh
"$V5_CLI" mcp print --codex --scope project --path /absolute/project
"$V5_CLI" mcp install --codex --scope project --path /absolute/project
~~~

Do not change global PATH or overwrite stable registration merely to make this example fit. For side-by-side candidates, use the separately verified adapter-bundle flow instead. A preview with explicit selection is:

~~~sh
"$V5_CLI" mcp print --codex --scope project --path /absolute/project \
  --bundle /absolute/reviewed-mcp-adapter-bundle \
  --cli /absolute/path/to/verified-native-launcher \
  --runtime-directory /absolute/private/mcp-socket-directory
~~~

The adapter bundle, tool executable and private socket directory are separate choices. `--cli` only checks/selects an executable and sets `HACK_MCP_COMMAND`; it does not set `HACK_RUNTIME_BACKEND` or `HACK_NATIVE_HOME`. Use a separately verified native launcher with its matching prepared private environment, including explicit backend and home selection. A private home alone does not select the native backend. Review the printed configuration before any explicitly authorized installation. See the exact [MCP command options](https://github.com/hack-dance/hack/blob/44aaf5156426dfcbb1c8a189b8e20531e5b95613/src/commands/mcp.ts) and [bundle validation/launch source](https://github.com/hack-dance/hack/blob/44aaf5156426dfcbb1c8a189b8e20531e5b95613/src/mcp/bundle-launch.ts). Keep one registration per client.

The alternative `setup mcp` helper also requires a selected client or explicit all-clients choice. It does not silently configure every client. Choose only the requested client and scope.

## What next.6 retires

In this source, legacy setup sync/cursor/claude/agents paths refuse rather than inventory, write or repair agent files. MCP instruction-writing flags refuse before configuration effects. The old primer entry point prints a retirement notice instead of injecting guidance; it does not audit freshness. Canonical guidance no longer requires automatic freshness checks or skill updates. See [setup](https://github.com/hack-dance/hack/blob/44aaf5156426dfcbb1c8a189b8e20531e5b95613/src/commands/setup.ts), [MCP](https://github.com/hack-dance/hack/blob/44aaf5156426dfcbb1c8a189b8e20531e5b95613/src/commands/mcp.ts), [primer retirement](https://github.com/hack-dance/hack/blob/44aaf5156426dfcbb1c8a189b8e20531e5b95613/src/commands/agent.ts) and [canonical guidance](https://github.com/hack-dance/hack/blob/44aaf5156426dfcbb1c8a189b8e20531e5b95613/src/agents/instruction-source.ts).

Existing installed/customized instructions, skills, rules and old hooks are preserved, not automatically removed. Cleanup is a separate user-owned action; do not delete whole policy files or client directories.

These facts are source and fixture evidence. They do not establish installed-client loading, an MCP handshake, cloud acceptance or native application acceptance. The pinned [capability reference](https://github.com/hack-dance/hack/blob/44aaf5156426dfcbb1c8a189b8e20531e5b95613/docs/reference/agent-client-capabilities.md) keeps those evidence limits explicit.

## Give an agent the selected context

Use the actual documentation host. For local review, substitute the preview host before copying this text; use the public host only after deployment.

~~~text
Read https://<selected-docs-host>/docs/v5/guides/agent-setup-v5-branch.
Use released next.6, source 44aaf5156426dfcbb1c8a189b8e20531e5b95613.
Confirm its executable and the requested project before acting.
Install skills or a selected MCP configuration only when explicitly requested.
Preserve existing user policy and customizations.
~~~
