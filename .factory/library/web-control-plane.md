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

## Runtime Constraint

- Local web validation should run through hack-managed routing once the web runtime is declared.
- Browser verification must use `agent-browser` against the routed local host.
