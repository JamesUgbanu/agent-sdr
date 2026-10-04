## What does this change do?

## Why (problem / motivation)?

## Verification

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes (note if live-DB tests were run)
- [ ] `npm run build` succeeds
- [ ] Docs updated if behavior/env/ops changed: _none / docs/…_

## Guardrail checklist (for agent/tool/provider changes)

- [ ] No model path bypasses suppression, idempotency, approvals, opt-outs, or limits
- [ ] No secrets added; `.env.example` uses empty placeholders only
- [ ] External-credential gaps fail loudly, never fake success
