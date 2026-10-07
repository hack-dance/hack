# Private native Compose hostname claims

`openNativeComposeRouteClaims` is an internal filesystem admission API. It does
not activate routes, inspect Docker, start or stop containers, modify ingress, or
prove application readiness. It is inactive until command integration supplies
fresh ingress ownership checks and complete lifecycle verification.

The caller supplies `root` under the selected user Hack home (`compose-routing`),
`binding: { engineId, proxyId, networkId }` from verified public Docker observations,
and `owner: { composeProject, ownerToken }` from the private instance receipt. A
configuration-file path override is not the Hack home. The namespace is keyed
only by the verified stable engine ID. Replacing the proxy or network therefore
does not create a second namespace that could bypass an existing hostname claim.
The existing home is not chmodded; new directories are user-owned `0700` and files
are `0600`. The API pins ancestor and private-directory descriptors, refuses
symlinks/rebinding, and rechecks named and descriptor identities around effects.

`acquire({ hostnames, generationIdentity })` sorts and deduplicates canonical
lowercase ASCII DNS names. It records all intended random claim tokens in a
private immutable attempt before publishing any claims. Each claim contains only
the hostname, public ingress binding, Compose instance/owner nonce and random
claim token. The full file is written and synchronized privately before a hardlink
publishes it exclusively. Competitors cannot consume a half-written claim; missing,
malformed, foreign or changed ownership refuses. Failed acquisition rolls back
only newly published claims whose exact inode and content remain proven. Existing
same-owner claims remain, and adoption requires their durable prior attempt.
If rendering, generation publication or freshness fails after acquisition but
before effects, `rollback(attempt)` accepts only that live unarmed preparation.
It records durable aborted intent and removes only newly acquired exact claims;
adopted claims remain. Reopened, armed, completed and retained attempts refuse.

The returned attempt carries a private reference with attempt and generation IDs
plus exact immutable intent/reservation device, inode and digest anchors. The
reservation pins every acquired claim before returning. Persist this reference in
the private generated-document metadata; never put these anchors in engine labels
or public logs. `reopen(reference)` validates the saved reference and claims for
saved operations without gaining live completion authority.

Before starting **any** engine effect, call `markEffectsPossible(attempt)`. It
synchronizes an append-only armed marker. The caller must hold the existing
instance mutation lock across acquisition, effects, completion and retirement;
this module adds no global controller, JSON registry or second lock. Only the
same live armed attempt can call `complete({ attempt, assertTransition })`.
The callback must run after the engine child exits and is reaped, then freshly
verify the requested routes on the exact new generation and the absence of
obsolete route containers. Completion clears only this attempt's uncertainty.
Current, pending and newly claimed hostname unions remain claimed until explicit
verified retirement.

`retain(attempt)` records conservative retention. An armed attempt without its own
complete marker is also retained implicitly. Reopening, an absent PID, age, stopped
containers, or an engine snapshot cannot clear it. `down --recover` must preserve
these claims: an unknown/interrupted Compose child may outlive the CLI. A later
attempt cannot arm or release past unresolved effects. This API provides no
automatic recovery or takeover of that uncertainty.

`release({ keepHostnames, assertAbsent })` retires only this owner's claims outside
the keep set. The callback must verify exact-ingress route absence and that every
obsolete route container is **absent**, not stopped. With an empty keep set for
normal down, all owned containers must be absent. Failed or unavailable proof
preserves claims. Exact deletion intent is synchronized before unlinking; a
changed inode/content refuses, and interrupted deletion resumes only after fresh
proof. Other owners' claims and ingress/network resources are never deleted.

Reads use nonblocking, no-follow descriptors with regular-file, UID, mode, link
count, bounded bytes, timestamps and named-inode checks. Each artifact is bounded
to 64 KiB and each journal scan to 8 MiB; these are persistence/input budgets, not
service or runtime resource limits. No plan, environment values, arbitrary labels
or Docker credentials are stored. Errors are fixed and redacted.

This is a cooperative same-user boundary, not an atomic filesystem/Docker
transaction or protection against a hostile process with the same UID. Filesystem
checks alone do not prove route or engine ownership. Tests cover publication races,
kill/interruption retention and filesystem refusal; root command integration must
qualify real Docker routing, saved operations and normal/recovery cleanup separately.
