# Countback — Stedi service (Person C)

Runnable on its own. You need **one** thing in `.env`: a Stedi **test-mode**
API key. No Medplum, no Deepgram, no server, no teammates.

```bash
npm install
cp .env.example .env      # add STEDI_API_KEY
npm run stedi:probe
```

## 9:30 — before anything else

1. Open Stedi's **Eligibility mock requests** page.
2. Pick ONE mock patient with active coverage that returns copay data.
3. Paste the exact values into `MOCK_PATIENT` in `src/insurance/stedi.ts`.
4. **Post those values to the team chat.** B seeds Medplum to match, A writes
   the voice script to match, and the console's `PATIENT` constant matches.

The probe refuses to run until you do this. That's deliberate — test mode
rejects invented identity values, and reconciling identities at 3pm costs
two hours.

Note `dateOfBirth` is `YYYYMMDD` with no dashes, and `tradingPartnerServiceId`
keeps its leading zeros (`00540`, never `540`).

## 10:00 — the hard gate

```bash
npm run stedi:probe                    # medical plan coverage (STC 30)
npm run stedi:probe -- lisinopril 30 --raw
npm run stedi:probe -- lisinopril 88   # pharmacy — mocks do NOT support this
```

A green run prints the parsed benefits table and the exact sentence the voice
agent will say. Every response is written to `.stedi-last.json` — read the
real shape rather than guessing at it.

If nothing has come back by 11:00, say so at standup.

## Reading the output

`benefitsInformation[]` is read **by code, never by array position**:

| code | meaning | field |
|---|---|---|
| `1` | Active coverage | — |
| `A` | Co-insurance | `benefitPercent` (never an amount) |
| `B` | Co-payment | `benefitAmount` |
| `C` | Deductible | `benefitAmount` |
| `G` | Out-of-pocket max | `benefitAmount` |

In-network entries (`inPlanNetworkIndicatorCode === "Y"`) win.

AAA errors land in the top-level `errors` array. `72` and `75` mean your
`MOCK_PATIENT` doesn't match the approved list — re-copy it character for
character. `42` means the payer is down; retry in a few minutes.

Don't write logic that string-matches `possibleResolutions`. Stedi changes
that text and it varies between responses.

## No copay came back?

Payers aren't required to echo the service type code you sent, and many don't
support `88` (pharmacy) on the medical eligibility rail. Try `30`. Send one
STC per request unless you've confirmed the payer handles several.

This is also the honest thing to say on stage: 270/271 is the **medical**
eligibility rail. Drug-level pricing properly runs on NCPDP real-time
prescription benefit. Volunteer that before a judge asks.

## 1pm — go/no-go

No live 271 by 1pm? `fallback()` in `stedi.ts` returns a recorded payload with
`stubbed: true`. Ship it, tell the team, say so in the demo. Judges forgive a
stub; they don't forgive a broken live demo.

Then you switch to owning the video, the deck, and the rehearsal — see
`src/insurance/CLAUDE.md`.

## Two details worth showing on camera

`meta.applicationMode` returns `test` with a test key — wire it to your
`stubbed` flag so honesty is automatic, not remembered.

The response `id` is `ec_<uuid>` and deep-links to the check in the Stedi
portal. Putting that on screen reads as very real.

## Verified against the API reference (2026-08)

```
POST https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/eligibility/v3
Authorization: <STEDI_API_KEY>        # bare key, no Bearer prefix
Content-Type: application/json
```

Two things that bite:

- The **`/2024-04-01` date prefix is part of the path.** Drop it and you get a
  404 that reads like a wrong hostname.
- Medical **mock requests only support `serviceTypeCode` `30`.** That is why
  the probe now defaults to 30, not 88. Sending 88 to a mock payer returns no
  benefits and looks like a broken parser.

Override the host with `STEDI_BASE_URL` if it ever moves. If a call 401s the
probe prints the body; the documented alternative auth form is
`Authorization: Key <key>` — change it in `stediHeaders()` in `src/auth.ts`,
which is the single place either endpoint header is built.
