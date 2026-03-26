# Web Control Plane

Guidance specific to the optional `apps/web` control plane.

**What belongs here:** web stack, UX rules, deployment boundary, and UI-system expectations.

---

## Delivery Target

- Build `apps/web` as a Next.js App Router application that is ready for Vercel deployment.
- The mission does not need a live Vercel deployment; local validation plus deploy-ready wiring is sufficient.

## UI System

- Tailwind CSS v4 is the styling baseline.
- Use `shadcn/ui` as the primitive layer.
- Use Kibo UI selectively for richer admin patterns where it genuinely helps.
- Use Motion only for subtle, accessible transitions; always respect reduced-motion preferences.

## UX Constraints

- The app should feel like a calm, durable control plane rather than a demo dashboard.
- Preserve semantic structure, labels, focus states, and keyboard navigation.
- Do not hide critical state transitions behind animation.

## Current Shell Contract

The first shipped shell in `apps/web/src/components/control-plane-shell.tsx` establishes concrete foundation rules for later slices:
- keep a skip link that targets the main region
- use a labeled section nav (`aria-label="Control plane sections"`)
- keep the primary content in a focusable `main` region with explicit section ids
- preserve visible `focus-visible` outlines and `motion-reduce` fallbacks on interactive surfaces
- treat auth, admin, and integration flows as future slices instead of implying they already landed

## Testing Quirk

- `bunfig.toml` pins Bun tests to `./tests`, so workspace-targeted coverage may need a root shim file (for example `tests/apps/web.test.ts`) that imports package-local tests when workers need `bun test apps/web` to execute package assertions from the repo root.
- The routed `/account` proof from `.factory/validation/env-hardening-closeout/user-testing/flows/web-env-linear-state.json` includes populated Linear delivery and closeout audit cards, so account-shell regressions that touch the Linear section should not rely only on `audit: null` fixtures.

## Runtime Constraint

- Local web validation should run through hack-managed routing once the web runtime is declared.
- Browser verification must use `agent-browser` against the routed local host.
