# Remaining work before the live demo

The backend platform, clinical demo, Stedi integration, browser console, and
API integration tests are complete. This document lists the work that still
requires credentials, Person A's voice implementation, or team decisions.

Read `CLAUDE.md` first. Use synthetic patients only and never commit `.env`.

## Current verified baseline

```bash
nvm use
npm install
npm run check
npm run test:api
npm run dev
```

The API suite currently verifies:

- Console and health routes
- Clinical adapter mode reporting
- Synthetic patient and prescribed medication loading
- Matching medication reconciliation
- Dose/frequency discrepancy creation
- Medication stopped because of cost
- Stedi-mock coverage and copay parsing
- Verbatim symptom capture
- Fixed urgent response and high-severity issue
- Clinician issue listing
- Invalid request responses

These tests use isolated local processes and do not require external secrets.

## 1. Medplum live activation — Person B

### Create the Medplum application

1. Create a hosted Medplum project.
2. Create a dedicated `ClientApplication` in Project Admin → Clients.
3. Give its `ProjectMembership` the minimum required access to:
   `Patient`, `Organization`, `Coverage`, `MedicationRequest`, and
   `DetectedIssue`.
4. Review the `AccessPolicy` manually. Do not depend on UI filtering for PHI
   protection.
5. Put the credentials only in `.env`:

```dotenv
MEDPLUM_CLIENT_ID=
MEDPLUM_CLIENT_SECRET=
MEDPLUM_BASE_URL=https://api.medplum.com/
```

### Seed the correct patient

For local rehearsal with stubbed insurance:

```bash
npm run seed:demo
```

For a real Stedi test request, first copy Person C's approved portal identity
into the five `DEMO_PATIENT_*` values, character for character, then run:

```bash
npm run seed
```

The seed prints the Medplum Patient ID. Put it in:

```dotenv
DEMO_MEDPLUM_PATIENT_ID=
```

Restart the server and verify `/health` reports `clinical: "medplum"`.

### Validate hosted resources

Before the demo, verify in Medplum that:

- Patient name, date of birth, and member identifier match the approved Stedi
  identity semantically. Stedi uses `YYYYMMDD`; FHIR uses `YYYY-MM-DD`.
- Coverage references that Patient and the expected payor Organization.
- Three active MedicationRequests reference the Patient.
- A mismatch creates a moderate DetectedIssue with the patient's exact words.
- An urgent report creates a high-severity DetectedIssue.
- `DetectedIssue.patient` directly references the Patient so compartment-based
  access applies.

Run server-side FHIR `$validate` on representative resources if time allows.

## 2. Deepgram voice agent — Person A

Person A owns `src/voice/`. Replace the current adapter stub while keeping the
dependency boundary in `src/voice/index.ts`:

```ts
createVoiceAdapter({ clinical, insurance })
```

Do not import `clinical/` or `insurance/` directly.

### Required implementation

- Connect to the Deepgram Voice Agent WebSocket.
- Configure audio input/output and microphone capture.
- Define deterministic tools for:
  - Loading `clinical.getPatientReview(patientId)`
  - Reconciling one bottle with `clinical.reconcileMedication()`
  - Recording a symptom with `clinical.recordSymptom()`
  - Recording an urgent issue with `clinical.recordUrgentIssue()`
  - Checking cost with `insurance.checkCoverage(medicationName, memberId)`
- Publish redacted tool calls and responses to `bus`.
- Return `{ ready: true }` after the Deepgram socket is operational so
  `/health` reports `voice: "deepgram"`.
- Handle socket close, timeout, malformed tool arguments, and reconnect once.
- Stop the review immediately after an urgent trigger.

### Voice safety rules

- Every agent turn is under two sentences.
- Never assess a symptom or connect it to a drug aloud.
- Never give medical advice or suggest changing a dose.
- Preserve patient wording verbatim for clinical records.
- Use `URGENT_ESCALATION_RESPONSE` exactly; never let the model rewrite it.
- Implement every urgent trigger listed in root `CLAUDE.md`.
- Speak `CoverageResult.speakable` without inventing or changing a figure.
- If `CoverageResult.stubbed` is true, disclose that the result is recorded,
  not live.

### Voice tests still needed

- Tool dispatch for every ClinicalApi and InsuranceApi method
- Maximum two-sentence output enforcement
- All urgent phrases call the fixed escalation tool
- Cost stop calls insurance only after clinical returns
  `shouldCheckCoverage: true`
- Symptoms never produce an assessment
- Deepgram disconnect falls back cleanly without losing existing issues

## 3. Stedi live activation — Person C

The local Stedi implementation is complete and verified with:

```bash
npm run stedi:mock   # terminal 1
npm run stedi:probe  # terminal 2
```

To switch to the real Stedi test environment:

1. Generate a test-mode API key.
2. Choose an approved Eligibility mock-request patient in the Stedi portal.
3. Set all five `DEMO_PATIENT_*` values in `.env` exactly. Do NOT edit
   `MOCK_PATIENT` in `src/insurance/stedi.ts` — it resolves from those env
   values, and so does `npm run seed`, so Stedi and Medplum move together.
   Setting only some of the five fails fast rather than sending a half-and-half
   subscriber block.
4. Broadcast those values to the team.
5. Set `STEDI_API_KEY` in `.env`.
6. Remove `STEDI_BASE_URL` from `.env`; otherwise calls continue to use the
   local mock server.
7. Run `npm run stedi:probe -- lisinopril 30 --raw`.
8. Confirm `meta.applicationMode` is `test` and `stubbed` is false.
9. Inspect `.stedi-last.json` without committing it.

Do not use the five invented `DEMO_PATIENTS` identities against live Stedi.
They are guaranteed to fail eligibility.

Remember: X12 270/271 is medical eligibility, not true drug-level NCPDP
real-time benefit pricing. State this honestly during the pitch.

## 4. End-to-end integration

After A is merged and credentials are configured:

1. Start the server and confirm `/health` reports the intended three adapters.
2. Load the approved synthetic patient from Medplum.
3. Complete one matching bottle with no issue.
4. Complete one dose/frequency mismatch and confirm a moderate DetectedIssue.
5. Stop one medication because of cost and confirm Voice calls Insurance.
6. Show the payer response, copay, and live/stubbed status in the event console.
7. Record a non-urgent symptom verbatim.
8. Trigger one urgent phrase, confirm the fixed line, stop the conversation,
   and verify a high-severity DetectedIssue.
9. Open the clinician issue list and verify every flag is visible.

Person B owns resolution of conflicts in `src/contract.ts`, `src/server.ts`,
`src/bus.ts`, and `public/index.html`.

## 5. Tests still requiring external credentials

Keep `npm run test:api` as the required credential-free gate. Add optional
live smoke commands that skip when their credentials are absent:

- Medplum login, Patient read, MedicationRequest search, and DetectedIssue
  create/read round-trip
- Stedi test-mode probe against the approved portal patient
- Deepgram socket connection and one tool invocation using synthetic audio

Never run live-write tests against real PHI or a production Stedi key.

## 6. Deployment and rehearsal

- Choose a public HTTPS/WSS host compatible with Deepgram callbacks and audio.
- Configure secrets in the host, never in client-side JavaScript.
- Confirm the WebSocket event console works through the deployed proxy.
- Ensure logs redact API keys and do not contain real PHI.
- Record a fallback video while all three local adapters are green.
- Rehearse the happy path, cost path, and urgent path.
- Keep the local clinical demo and Stedi mock available as the stage fallback.

## Definition of done

- `npm run check` passes.
- `npm run test:api` passes.
- `/health` shows the intended adapter modes.
- The synthetic identity matches across Voice, Medplum, and Stedi.
- Every discrepancy and symptom reaches the clinician issue list.
- Urgent escalation is fixed, immediate, and high severity.
- Stubbed versus live insurance is disclosed automatically.
- No real PHI or secrets are committed or displayed.
