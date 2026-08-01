# Countback

Countback is a synthetic-patient medication-reconciliation voice demo built on Medplum, Deepgram, and Stedi. Read `CLAUDE.md` before changing code.

Persons A and C should follow `INTEGRATION.md` when connecting the Deepgram and Stedi implementations. The credential-dependent and pre-demo work is tracked in `REMAINING.md`.

## Start locally

The current Medplum SDK requires Node 22.18+ or 24.2+.

```bash
nvm install
nvm use
npm install
cp .env.example .env
npm run dev
```

Open http://localhost:3000. Without credentials, the server deliberately uses the interactive clinical demo adapter and insurance stub so the team can rehearse immediately.

The credential-free clinical demo is fully interactive: use the buttons to show a matching bottle, a dose/frequency discrepancy, a medication stopped because of cost, verbatim symptom capture, and a high-severity urgent escalation. The event log and clinician issue list update live.

## API verification

```bash
npm run test:api
```

The integration suite launches isolated Countback and Stedi-mock processes and verifies the console, health status, patient review, matching and mismatched medication reconciliation, cost routing, parsed coverage, symptom capture, urgent fixed response, issue listing, and malformed-request responses.

## Connect Medplum (Person B)

1. Create a Medplum project and a dedicated `ClientApplication` in Project Admin → Clients.
2. Give its `ProjectMembership` the minimum access needed for `Patient`, `Organization`, `Coverage`, `MedicationRequest`, and `DetectedIssue`. Review the policy manually.
3. Put the client id and secret in `.env`; never commit or print them.
4. Get the exact approved Stedi mock identity from Person C and copy all five values into `.env`.
5. Run `npm run seed`, then `npm run dev`. `/health` should report `clinical: "medplum"`.

`npm run seed` refuses to run outside Stedi test mode or with any missing identity value. It uses stable identifiers and conditional creates, so rerunning it does not intentionally duplicate the Patient, payor Organization, or Coverage.

For credential-free Stedi rehearsal, `npm run seed:demo` creates the five invented patients from `src/demo-patients.ts` in Medplum, with Coverage and MedicationRequests. These identities must only use the stub insurance path; they are guaranteed to fail live Stedi eligibility.

## Source-of-truth checkout

`medplum-link/` is an ignored, shallow checkout of Medplum. Agents should read its documentation and real examples before writing FHIR code. To refresh it:

```bash
git -C medplum-link pull --ff-only
```

## Team boundary

All cross-team calls go through `src/contract.ts`. Voice, clinical, and insurance never import from one another. Coordinate any contract change before editing it.
