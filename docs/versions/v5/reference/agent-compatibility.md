# Historical agent compatibility at next.5

This is an availability boundary for source pinned to `28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc`, not a setup or maintenance guide. The recommended v5 path is [explicit agent interfaces](../integrations.md). The forthcoming hook-free model has not shipped in this snapshot.

The pinned CLI still declares `agent prime`; `setup cursor`, `setup claude`, `setup codex`, `setup agents`, `setup sync`, `setup mcp`; and `mcp install`. The pinned init command also has an optional `--with` handoff. Their omission from the recommended command selection is editorial, not a claim that these interfaces disappeared.

Those paths include primer output/checks, guidance exports, hooks/rules, policy-file writes and compatibility configuration management. They are not part of v5 onboarding. Setup-sync JSON/status types remain historical implementation details; their omission from the diagnostic reference does not change the released command.

For exact availability, arguments, flags and reports, consult the preserved pinned sources:

- [Original generated command reference](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/docs/reference/cli.md)
- [Agent declarations](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/commands/agent.ts)
- [Setup declarations](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/commands/setup.ts) and [sync report types](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/agents/setup-sync.ts)
- [MCP declarations](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/commands/mcp.ts)
- [Project/init declarations](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/commands/project.ts)

The shipped Codex manifest selects skills; skill bodies still contain maintenance recommendations. Claude's sibling manifest also selects SessionStart/PreCompact primer hooks, and Cursor's selects rules. The hook-free replacement is pending; these source links are not installation instructions.

V4 documentation remains historical and unchanged. Runtime env delivery, lifecycle definition freshness and resource ownership are separate contracts and are not retired by this editorial choice.
