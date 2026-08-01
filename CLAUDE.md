# Countback — root context

Read this before touching anything. All three team members' agents read this file.

## What we're building

A voice agent that phones a patient between hospital discharge and their
follow-up appointment. The patient reads their pill bottle labels aloud. The
agent diffs what they say against what was prescribed, asks why anything was
stopped, and — when the reason is cost — runs a live insurance eligibility
check mid-conversation and tells them the real copay. Output is a set of
flagged discrepancies a clinician reviews before the visit.

Built in one day at the YC × Medplum Agentic Healthcare Hackathon.
Submissions close 5pm. **Working beats complete.**

## Non-negotiable constraints

These are product decisions, not preferences. Do not "improve" past them.

1. **The agent never assesses a symptom.** It records the patient's words
   verbatim and routes them to a clinician. It must never say a symptom is
   normal, expected, harmless, or concerning, and must never connect a symptom
   to a drug out loud. If asked "is that from the medication?", the answer is
   that the care team will go over it at the visit.
2. **The agent never gives medical advice** and never suggests changing a dose.
3. **`escalate_urgent` responses are hardcoded strings**, not model-generated.
   Chest pain, trouble breathing, fainting, sudden confusion, one-sided
   weakness, slurred speech, black or bloody stools, vomiting blood,
   worst-ever headache, self-harm → stop the review, deliver the fixed line,
   write a high-severity issue.
4. **Every agent turn is under two sentences.** Voice agents that monologue
   kill live demos.
5. **All patient identity values must exactly match our Stedi mock patient.**
   Stedi test mode rejects invented names, DOBs, and member IDs. See
   `src/insurance/CLAUDE.md` and "The 9:30 broadcast" below.
6. **No real PHI, ever.** Synthetic patients only.

## Stack

- Node + TypeScript, one process. No monorepo, no workspaces, no Docker.
- `express` + `ws` — serves the console and holds both sockets
- `@deepgram/sdk` — Voice Agent API
- `@medplum/core` — FHIR system of record (hosted at api.medplum.com)
- Stedi REST — real-time eligibility, **test mode only**

## Medplum documentation is the source of truth

Medplum's source is checked out at `medplum-link/`; its docs are under
`medplum-link/packages/docs/docs/`. Read the relevant doc before building in a
Medplum/FHIR area and adapt a real Medplum pattern instead of guessing. If the
conversation has been compacted and the source text is no longer visible,
re-read it before changing code.

- FHIR R4 only. Type resources with `@medplum/fhirtypes` and reuse
  `@medplum/core` helpers.
- Never invent FHIR fields, search parameters, operations, or clinical codes.
- Use conditional writes keyed by stable identifiers; never search then create.
- Patient-compartment access comes from a resource's own patient reference.
  Enforce access with `AccessPolicy` and `ProjectMembership`, never UI filters.
- Before finishing, run `npm run check` and re-check the relevant Medplum doc.

## Layout and ownership

```
src/
  contract.ts        SHARED SEAM — see rules below
  bus.ts             event emitter → browser console (shared, rarely edited)
  server.ts          express + ws wiring (shared, rarely edited)
  voice/             PERSON A owns. Nobody else edits.
  clinical/          PERSON B owns. Nobody else edits.
  insurance/         PERSON C owns. Nobody else edits.
public/index.html    the console UI (already built)
scripts/seed.ts      seeds Medplum with the demo patient
```

|       | Owns                                             | From 1pm                        |
| ----- | ------------------------------------------------ | ------------------------------- |
| **A** | Deepgram socket, tools, dispatch, mic capture    | Rehearsal — plays the patient   |
| **B** | Medplum, reconciliation, symptoms, DetectedIssue | Integration; **owns the merge** |
| **C** | Stedi eligibility, 271 parsing                   | Video, deck, pitch              |

B owns the merge because they sit in the middle of the dependency graph. All
integration happens on their branch.

## The contract rule

`src/contract.ts` declares every type and function signature that crosses
between the three halves. It is the **only** file all three people touch.
`ClinicalApi` is implemented by B, `InsuranceApi` by C, and both are called
by A.

- If you need a signature changed, **stop and say so.** Do not edit
  `contract.ts` unilaterally — it breaks the other person's build silently.
- Both APIs are stubbed in `contract.ts` from minute one (`stubClinical`,
  `stubInsurance`). Work against the stubs. Never wait for another half to be
  real.
- Never import across the three directories in any direction. If you think you
  need to, you need a contract change instead.
- `clinical/` and `insurance/` never call each other. If a reconciliation
  outcome should trigger a coverage check, `clinical/` returns
  `shouldCheckCoverage: true` and **voice/** makes the call. That keeps B and C
  fully independent all day.

## Commands

```bash
npm run dev        # server on :3000, console at http://localhost:3000
npm run seed       # (re)seed the Medplum demo patient
npm run check      # tsc --noEmit — run before saying you're done
```

## Env

`.env` at repo root. Never commit it, never log its values.

```
MEDPLUM_CLIENT_ID=
MEDPLUM_CLIENT_SECRET=
MEDPLUM_BASE_URL=https://api.medplum.com/
DEEPGRAM_API_KEY=
STEDI_API_KEY=
STEDI_TEST_MODE=true
```

## The 9:30 broadcast — do this before writing code

C picks one Stedi approved mock patient and posts the exact `firstName`,
`lastName`, `dateOfBirth`, `memberId`, and `tradingPartnerServiceId` to the team
chat. Everyone else builds to those values:

- B seeds the Medplum `Patient` and `Coverage` to match, character for character
- A writes the voice script around that patient
- C sets the `PATIENT` constant in `public/index.html`

Stedi test mode rejects invented identity values. Getting this wrong means
reconciling identities at 3pm instead of rehearsing.

## Standups

11:00, 13:00, 15:00. Three minutes, standing. One question: what's blocking you.

## Working style for today

- **Smallest change that makes the demo work.** No abstraction layers, no
  config systems, no plugin architecture. We throw this away Monday.
- **No test suite.** Verify by running the thing.
- **Log every tool call and every external response** to stdout. When something
  breaks at 3pm we need to see it, not reproduce it.
- **Never invent API response shapes.** If you haven't seen the actual JSON
  from Deepgram or Stedi, log it first, then write the parser.
- If you're blocked more than ~15 minutes on an external API, say so plainly
  and propose the stubbed fallback. Do not silently work around it.
