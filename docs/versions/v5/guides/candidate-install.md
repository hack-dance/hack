# Candidate installation history

Use [Install](../install.md) for released next.6. Its shell bootstrap and standalone
manager replace the Python installation path in earlier candidate documentation.
The next.1 Python example in the [preserved next.5 guide](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/docs/guides/candidate-install.md)
is historical, not the next.6 installation recipe. The release source's copy of
that guide also retains obsolete Python procedures; it is not current installer
instructions. Do not apply Python manager commands to the standalone channel root.

Installer PR525 shipped in next.6. The [standalone manager entry point](https://github.com/hack-dance/hack/blob/44aaf5156426dfcbb1c8a189b8e20531e5b95613/scripts/install-prerelease.ts)
and [channel implementation](https://github.com/hack-dance/hack/blob/44aaf5156426dfcbb1c8a189b8e20531e5b95613/scripts/installer/channel.ts)
are the source contracts for explicit selection and separate native/Compose homes.
Old or foreign roots refuse; do not delete or rewrite one to bypass ownership checks.

Cross-version upgrade and rollback and initialized-data preservation remain open
acceptance work. Fresh installation and manager status do not qualify those paths.
Native provider preparation and installed-client acceptance are separate too.

## Upgrade and return to a retained candidate

The standalone manager has explicit version selection and retained-candidate
operations; consult its source entry point above for current parsing and refusal
boundaries. Historical Python manager syntax does not apply. Cross-version
upgrade/rollback and initialized-data acceptance remain open. Stop and verify
ownership of active workloads before any separately authorized version change;
installation status alone is not proof that a transition is safe.
