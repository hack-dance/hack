# next.17 compiled-manager fixture

Source: tag `v5.0.0-next.17`, commit `e47681ea0af4a332135cede4aa32f53e6fa7df27`. These are that tag's
`scripts/installer/{bundle,channel,download,integrity,publication}.ts`, the modules the
released `hack-next-manager-darwin-arm64` (sha256 `85bbe4f064b3277efc88a9f79c197e81950ab8881320aef1b3443b70d95b530f`)
was compiled from. The only edit is import depth: `../../src/` became `../../../src/`
so the copies resolve the shared transfer helpers from this directory, plus one
`@ts-expect-error` comment in `channel.ts` for bun-types 1.4's numeric `signalCode`
type; the shipped code is unchanged.

They reproduce HACK-2262: a channel that the next.17 manager owns refuses the
next.18 bundle, whose archive adds `hack-lifecycle-supervisor`, with "Foreign,
duplicate or traversing archive entry." Do not update these files to match
current code; add a new fixture for a later shipped manager instead.
