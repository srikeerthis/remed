# Countback integration handoff

Read `CLAUDE.md` first. This document explains how Persons A and C plug their
implementations into the working Person B platform on the `backend` branch.

## Current state

- Person B is implemented in `src/clinical/`.
- `src/server.ts` selects hosted Medplum when both Medplum credentials exist;
  otherwise it uses the in-memory clinical demo.
- Person A currently has a stub in `src/voice/index.ts`.
- Person C's Stedi client, parser, probe, and local mock server are integrated.
- `src/insurance/index.ts` selects Stedi when `STEDI_API_KEY` is set and uses
  the honest recorded stub otherwise.
- All cross-team data types live in `src/contract.ts`.
- The browser console receives integration events through `src/bus.ts`.

Do not import from `voice/`, `clinical/`, or `insurance/` into another owned
directory. Use the interfaces in `src/contract.ts` and dependency injection in
`src/server.ts`.

## Install and verify

```bash
nvm use
npm install
cp .env.example .env   # only when .env does not already exist
npm run check
npm run dev
```

The server runs at http://localhost:3000. Check adapter selection at
http://localhost:3000/health.

Never commit `.env`, print secrets, or use real PHI.

## Person A: Deepgram voice integration

Person A owns only `src/voice/`. Implement `createVoiceAdapter()` using the
injected dependencies:

```ts
export interface VoiceDependencies {
  clinical: ClinicalApi;
  insurance: InsuranceApi;
}
```

The voice implementation must call `dependencies.clinical` and
`dependencies.insurance`; it must not import either owned directory.

### Recommended call flow

1. Start a call and load the review with
   `clinical.getPatientReview(patientId)`.
2. Read one prescribed medication at a time and keep every spoken agent turn
   under two sentences.
3. Send the patient's complete bottle wording to
   `clinical.reconcileMedication()`. Preserve the original words in
   `patientWords`.
4. If the result has `shouldCheckCoverage: true`, call
   `insurance.checkCoverage(medicationName, review.memberId)`. Do not make the
   call when `memberId` is absent. Clinical must never call insurance directly.
5. Record non-urgent symptoms with `clinical.recordSymptom()` and say only
   that the care team will review them.
6. On an urgent trigger, stop the medication review, call
   `clinical.recordUrgentIssue()`, and speak `URGENT_ESCALATION_RESPONSE`.
   Never ask a model to generate or rewrite that line.
7. Publish tool calls and redacted responses to `bus` for the console.

Example reconciliation input:

```ts
await clinical.reconcileMedication({
  patientId,
  labelText: 'Metformin 500 mg once daily',
  patientWords: 'My bottle says Metformin 500 milligrams once a day.',
  taking: true,
});
```

Person A must implement all urgent triggers listed in the root `CLAUDE.md`.
The agent never assesses a symptom, connects a symptom to a medication, gives
medical advice, or suggests changing a dose.

### Voice adapter readiness

Keep the server-facing return value compatible with the health check:

```ts
return { ready: true };
```

If A needs additional lifecycle methods, add them inside `voice/` and adjust
the shared server only during the integration merge.

## Person C: Stedi insurance integration

Read `src/insurance/CLAUDE.md` before implementation. Person C owns only
`src/insurance/` except for a coordinated contract or shared-config change.

The integrated `InsuranceApi` is:

```ts
interface InsuranceApi {
  checkCoverage(medicationName: string, memberId: string): Promise<CoverageResult>;
}
```

`CoverageResult` includes `speakable` and `stubbed`; Person A must speak the
provided sentence without inventing a price and must visibly disclose a
stubbed result during the demo.

Run C's implementation in isolation before voice integration:

```bash
npm run stedi:mock   # terminal 1
npm run stedi:probe  # terminal 2
```

### Required Stedi behavior

- Test-mode key only.
- Use the exact approved portal mock patient, not `DEMO_PATIENTS`.
- Keep leading zeroes in `tradingPartnerServiceId`.
- Send `serviceTypeCode: '30'` for the medical mock request.
- Send the key through the single `stediHeaders()` helper.
- Parse `benefitsInformation` by code, never array position.
- Prefer in-network entries.
- Read AAA failures from the top-level `errors` array.
- Log the redacted request and complete response shape before finalizing the
  parser. Save the response to `.stedi-last.json`, which must be ignored.
- Never invent or estimate a copay.

The five identities in `src/demo-patients.ts` are only for Medplum and the
stub demonstration. They are guaranteed to fail live Stedi eligibility.

`PatientReview.memberId` is the boundary between B and A. C owns the remaining
approved mock-patient fields inside `stedi.ts`; A must not import that file.

## Person B: Medplum setup

Create a dedicated Medplum `ClientApplication` with the minimum access needed
for `Patient`, `Organization`, `Coverage`, `MedicationRequest`, and
`DetectedIssue`. Put its ID and secret in `.env` and review its `AccessPolicy`
manually.

Two seed modes exist:

```bash
npm run seed       # exact approved Stedi mock identity
npm run seed:demo  # five invented patients; stub insurance only
```

Both paths use stable identifiers and conditional creates. Re-running them
should not intentionally duplicate resources.

For the live path, set `DEMO_MEDPLUM_PATIENT_ID` to the Patient ID printed by
the seed command. `/health` should then report `clinical: "medplum"`.

## Merge order

1. Treat the integrated `src/contract.ts` as frozen.
2. Run Person C's isolated mock/probe gate.
3. Merge Person A's voice implementation against the frozen interfaces.
4. Person B resolves shared-file conflicts in `contract.ts`, `server.ts`,
   `bus.ts`, and the console.
5. Run `npm run check`.
6. Start the server and confirm `/health` reports the intended adapters.
7. Rehearse one matching medication, one discrepancy, one cost stop, one
   non-urgent symptom, and one urgent escalation.

## Final demo checklist

- Synthetic patient only; no real PHI.
- Every voice response is under two sentences.
- Urgent wording is fixed and the review stops immediately.
- Patient symptoms are stored verbatim without assessment.
- Cost stop visibly calls insurance from voice, not clinical.
- Live versus stubbed eligibility is visible and spoken honestly.
- Medplum contains the expected `DetectedIssue` records.
- External calls and redacted responses appear in the event console.
- `npm run check` passes.
- A recorded fallback is ready if Deepgram, Medplum, or Stedi is unavailable.
