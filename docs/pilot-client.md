# Pilot client sandbox — Acme Widgets (fictional)

This is the reference onboarding used to prove the pilot flow end to end.
Everything here is safe test data: `example.com` domains, console email
provider, no real credentials. A real client replaces each value 1:1.

## Client profile (fictional)

- **Workspace:** `Acme Widgets Pilot`
- **ICP:** US B2B SaaS, 20–200 employees, CTO / VP Engineering / Head of Engineering
- **Offer:** AI automation implementation for support workflows
- **Approval policy:** `assisted` (pilot mode — human approves every send; autonomous stays OFF)
- **Providers:** console email, seed prospecting, no CRM/calendar (verifies as NOT_CONFIGURED)

## Knowledge base (seed via `/api/knowledge` or onboarding wizard)

| Document | Key facts the agent may use |
|---|---|
| Pricing | Pro plan $500/mo, annual saves 20% |
| Objections | "too expensive" → acknowledge budget pressure, restate ROI in hours saved |
| Product | onboarding under a day, no professional-services fees |

## Campaign (seed via `/api/campaigns`)

```json
{
  "name": "Acme pilot — US SaaS CTO",
  "targetIndustries": ["SaaS"],
  "targetGeography": "United States",
  "companySizeMin": 20,
  "companySizeMax": 200,
  "jobTitles": ["CTO", "VP Engineering"],
  "approvalPolicy": "assisted",
  "dailySendLimit": 25,
  "timezone": "UTC"
}
```

## Expected pilot walkthrough

1. `POST /api/workspaces` → workspace + owner membership
2. `GET /api/admin/integrations?workspaceId=` → email/CRM/calendar report NOT_CONFIGURED, seed prospecting reports dev-seed warning
3. Knowledge docs ingested → chunks + (with `OPENAI_API_KEY`) embeddings
4. Campaign created → prospecting discovers seed leads
5. Research → score → draft (confidence < threshold → `pending_approval`)
6. Operator approves in approval queue → console send (logged, nothing leaves the box)
7. Inbound test reply via webhook → classified → sequence stops
8. `POST /api/admin/deliverability` → verdict recorded (console provider yields FAIL → autonomous stays blocked)

## What this sandbox deliberately does NOT prove

Live provider delivery, real inbox placement, real CRM writes, real calendar
bookings, real-model RAG quality — all marked UNVERIFIED without credentials.
