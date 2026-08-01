# Insurance — Person C

Read the root `CLAUDE.md` first. This file is the detail for this directory
only. **Nobody but C edits anything in here.**

## What this half does

One job: when the patient says they stopped a medication because of cost, run
a live X12 270/271 eligibility check and hand back a sentence the voice agent
can say out loud. That's it.

Implements `InsuranceApi` from `../contract.ts`. Called by `voice/`, never by
`clinical/`. If you think you need something from `clinical/`, you need a
contract change — say so in chat.

```
config.ts      credentials, lazily validated (shared, at src/)
auth.ts        stediHeaders() — the ONE place the key is attached (shared)
stedi.ts       the request, the parser, the fallback
probe.ts       runnable in isolation. Your 10am gate.
README.md      how to run it, what the codes mean, what to do when it breaks
```

## The identity rule

`MOCK_PATIENT` in `stedi.ts` is the single most load-bearing constant in the
repo. Stedi test mode answers only for identities on its approved mock request
list — invented names, DOBs, and member IDs come back as AAA 72 or 75, every
time. There is no way around this and no point arguing with it.

- Copy the five values from the portal **character for character**.
- `dateOfBirth` is `YYYYMMDD` with no dashes.
- `tradingPartnerServiceId` is a **string** and keeps its leading zeros
  (`00540`, never `540`).
- Post them to chat the moment you have them. B seeds Medplum to match and A
  writes the script to match. Getting this wrong means reconciling identities
  at 3pm instead of rehearsing.

`src/demo-patients.ts` holds five invented patients for seeding and stub work.
**They are not substitutes for `MOCK_PATIENT`** and will fail a live check.

## Speaking rules — these are patient-facing

`speakable` is read aloud to a real person by a voice agent. The root
constraints all apply here:

- **Never state a figure the payer did not send.** No copay came back means we
  say so and defer to the care team. We do not estimate, round, or guess.
- **Never give medical advice** and never suggest changing or stopping a dose,
  even when the cheaper option is obvious.
- **Under two sentences**, always.
- When `stubbed: true`, the number is recorded, not live. That flag exists so
  honesty is automatic rather than remembered — wire it to the UI, and say it
  on stage.

## Parsing rules

Read `benefitsInformation[]` **by code, never by array position**. The order
varies between payers and between calls.

| code | meaning | field to read |
|---|---|---|
| `1` | active coverage | — |
| `A` | co-insurance | `benefitPercent` (never an amount) |
| `B` | co-payment | `benefitAmount` |
| `C` | deductible | `benefitAmount` |
| `G` | out-of-pocket max | `benefitAmount` |

In-network wins (`inPlanNetworkIndicatorCode === "Y"`). AAA errors land in the
top-level `errors` array, not inline. Never string-match
`possibleResolutions` — Stedi changes that text.

**Never invent a response shape.** Run the probe, read `.stedi-last.json`,
then write the parser. Every response is written there for exactly this
reason.

## Known constraints, verified 2026-08

- Endpoint is `POST https://healthcare.us.stedi.com` +
  `/2024-04-01/change/medicalnetwork/eligibility/v3`. The `/2024-04-01` prefix
  is part of the path; dropping it 404s in a way that looks like a bad host.
- Auth is a bare `Authorization: <key>`, no Bearer prefix. Documented
  alternative is `Key <key>`. One place to change it: `stediHeaders()`.
- Medical **mock requests support only `serviceTypeCode` 30.** Sending 88
  (pharmacy) returns no benefits and reads exactly like a broken parser.
- Use a **test-mode** key. `meta.applicationMode` echoes `test` — wire it to
  `stubbed`.
- The response `id` is `ec_<uuid>` and deep-links into the Stedi portal. Put it
  on screen; it reads as very real.

## Timeline

- **9:30** — pick the mock patient, broadcast the five values.
- **10:00** — probe green, or say so at standup.
- **1:00** — go/no-go. No live 271 by then, `fallback()` ships a recorded
  payload with `stubbed: true`. Tell the team, say it in the demo. Judges
  forgive a stub; they don't forgive a broken live demo.
- **After 1:00** — you own the video, the deck, and the pitch.

## The honest line for the pitch

270/271 is the **medical** eligibility rail. True drug-level pricing runs on
NCPDP real-time prescription benefit, which we are not on. Volunteer that
before a judge asks — it lands as rigour rather than as a gap.

## Blocked?

More than ~15 minutes stuck on Stedi, say it plainly and propose the stub.
Don't silently work around it.
