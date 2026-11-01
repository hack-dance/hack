# Candidate installation history

Use [Install](../install.md) for released next.6. Its shell bootstrap and standalone
manager replace the Python installation path in earlier candidate documentation.
The next.1 Python example in the [preserved next.5 guide](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/docs/guides/candidate-install.md)
is historical, not the next.6 installation recipe. Do not apply its Python manager
commands to the standalone manager's channel root.

The [next.6 candidate guide](https://github.com/hack-dance/hack/blob/44aaf5156426dfcbb1c8a189b8e20531e5b95613/docs/guides/candidate-install.md)
and [channel implementation](https://github.com/hack-dance/hack/blob/44aaf5156426dfcbb1c8a189b8e20531e5b95613/scripts/installer/channel.ts)
describe retained versions, explicit selection and the separate native/Compose
homes. Installer PR525 shipped in this source. Old or foreign roots refuse; do not
delete or rewrite an existing root to bypass the ownership check.

Cross-version upgrade and rollback and initialized-data preservation remain open
acceptance work. Fresh installation and manager status do not qualify those paths.
Native provider preparation and installed-client acceptance are separate too.
