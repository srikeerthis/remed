import 'dotenv/config';
import { MedplumClient } from '@medplum/core';
import type { Coverage, MedicationRequest, Organization, Patient } from '@medplum/fhirtypes';
import { resolveDemoIdentity } from '../src/demo-patients.js';

const ID_SYSTEM = 'https://countback.health/identifiers/stedi-member-id';
const TRADING_PARTNER_SYSTEM = 'https://stedi.com/identifiers/trading-partner-service-id';
const MEDICATION_REQUEST_SYSTEM = 'https://countback.health/identifiers/demo-medication-request';

const demoMedications = [
  { key: 'metformin', display: 'Metformin', instructions: 'Take 500 mg twice daily' },
  { key: 'lisinopril', display: 'Lisinopril', instructions: 'Take 10 mg once daily' },
  { key: 'atorvastatin', display: 'Atorvastatin', instructions: 'Take 40 mg once daily' },
] as const;

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required. Copy the exact approved Stedi mock-patient value; do not invent one.`);
  }
  return value;
}

function toFhirBirthDate(stediDateOfBirth: string): string {
  if (!/^\d{8}$/.test(stediDateOfBirth)) {
    throw new Error('DEMO_PATIENT_DATE_OF_BIRTH must use Stedi YYYYMMDD format');
  }
  const year = stediDateOfBirth.slice(0, 4);
  const month = stediDateOfBirth.slice(4, 6);
  const day = stediDateOfBirth.slice(6, 8);
  const result = `${year}-${month}-${day}`;
  const parsed = new Date(`${result}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== result) {
    throw new Error('DEMO_PATIENT_DATE_OF_BIRTH is not a valid calendar date');
  }
  return result;
}

if (process.env.STEDI_TEST_MODE !== 'true') {
  throw new Error('Seed refused: STEDI_TEST_MODE must be exactly "true"');
}

const clientId = required('MEDPLUM_CLIENT_ID');
const clientSecret = required('MEDPLUM_CLIENT_SECRET');

// Same resolver Stedi uses, so the seeded Patient and the eligibility request
// cannot disagree. Set the five DEMO_PATIENT_* values to move both at once.
const identity = resolveDemoIdentity();
const { firstName, lastName, memberId, tradingPartnerServiceId } = identity;
const birthDate = toFhirBirthDate(identity.dateOfBirth);

if (!identity.approved) {
  console.warn(
    JSON.stringify({
      type: 'seed.identity.synthetic',
      message:
        'DEMO_PATIENT_* is unset, so this seeds the synthetic demo patient. Live Stedi rejects it. Fine for rehearsal with the mock server; set all five before a live eligibility check.',
      memberId,
    }),
  );
}

const medplum = new MedplumClient({ baseUrl: process.env.MEDPLUM_BASE_URL ?? 'https://api.medplum.com/' });
console.log(JSON.stringify({ type: 'medplum.login.request' }));
await medplum.startClientLogin(clientId, clientSecret);
console.log(JSON.stringify({ type: 'medplum.login.response', ok: true }));

const patientResource: Patient = {
  resourceType: 'Patient',
  active: true,
  identifier: [{ system: ID_SYSTEM, value: memberId }],
  name: [{ use: 'official', given: [firstName], family: lastName }],
  birthDate,
};
console.log(JSON.stringify({ type: 'medplum.conditional-create.request', resourceType: 'Patient' }));
const patient = await medplum.createResourceIfNoneExist(patientResource, `identifier=${encodeURIComponent(`${ID_SYSTEM}|${memberId}`)}`);
if (!patient.id) {
  throw new Error('Medplum returned a Patient without an id');
}
console.log(JSON.stringify({ type: 'medplum.conditional-create.response', resource: `Patient/${patient.id}` }));

const payorResource: Organization = {
  resourceType: 'Organization',
  active: true,
  identifier: [{ system: TRADING_PARTNER_SYSTEM, value: tradingPartnerServiceId }],
};
console.log(JSON.stringify({ type: 'medplum.conditional-create.request', resourceType: 'Organization' }));
const payor = await medplum.createResourceIfNoneExist(
  payorResource,
  `identifier=${encodeURIComponent(`${TRADING_PARTNER_SYSTEM}|${tradingPartnerServiceId}`)}`,
);
if (!payor.id) {
  throw new Error('Medplum returned an Organization without an id');
}
console.log(JSON.stringify({ type: 'medplum.conditional-create.response', resource: `Organization/${payor.id}` }));

const coverageResource: Coverage = {
  resourceType: 'Coverage',
  status: 'active',
  beneficiary: { reference: `Patient/${patient.id}` },
  subscriberId: memberId,
  identifier: [{
    system: 'https://countback.health/identifiers/stedi-coverage',
    value: `${tradingPartnerServiceId}:${memberId}`,
  }],
  payor: [{ reference: `Organization/${payor.id}` }],
};
const coverageIdentifier = coverageResource.identifier?.[0];
if (!coverageIdentifier?.system || !coverageIdentifier.value) {
  throw new Error('Coverage seed identifier is missing');
}
console.log(JSON.stringify({ type: 'medplum.conditional-create.request', resourceType: 'Coverage' }));
const coverage = await medplum.createResourceIfNoneExist(
  coverageResource,
  `identifier=${encodeURIComponent(`${coverageIdentifier.system}|${coverageIdentifier.value}`)}`,
);
console.log(JSON.stringify({ type: 'medplum.conditional-create.response', resource: `Coverage/${coverage.id}` }));

for (const medication of demoMedications) {
  const identifierValue = `${memberId}:${medication.key}`;
  const request: MedicationRequest = {
    resourceType: 'MedicationRequest',
    identifier: [{ system: MEDICATION_REQUEST_SYSTEM, value: identifierValue }],
    status: 'active',
    intent: 'order',
    subject: { reference: `Patient/${patient.id}` },
    medicationCodeableConcept: { text: medication.display },
    dosageInstruction: [{ text: medication.instructions }],
  };
  console.log(JSON.stringify({ type: 'medplum.conditional-create.request', resourceType: 'MedicationRequest' }));
  const created = await medplum.createResourceIfNoneExist(
    request,
    `identifier=${encodeURIComponent(`${MEDICATION_REQUEST_SYSTEM}|${identifierValue}`)}`,
  );
  console.log(JSON.stringify({ type: 'medplum.conditional-create.response', resource: `MedicationRequest/${created.id}` }));
}
