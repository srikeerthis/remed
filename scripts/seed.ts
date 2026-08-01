import 'dotenv/config';
import { MedplumClient } from '@medplum/core';
import type { Appointment, Condition, Coverage, MedicationRequest, Organization, Patient } from '@medplum/fhirtypes';
import { resolveDemoIdentity } from '../src/demo-patients.js';
import { lookupMedication } from '../src/medication-reference.js';

const ID_SYSTEM = 'https://countback.health/identifiers/stedi-member-id';
const TRADING_PARTNER_SYSTEM = 'https://stedi.com/identifiers/trading-partner-service-id';
const MEDICATION_REQUEST_SYSTEM = 'https://countback.health/identifiers/demo-medication-request';
const CONDITION_SYSTEM = 'https://countback.health/identifiers/demo-condition';
const APPOINTMENT_SYSTEM = 'https://countback.health/identifiers/demo-appointment';
// Parsed back out by src/clinical/index.ts. Keep the two in step.
export const APPEARANCE_PREFIX = 'Appearance: ';
export const COVERAGE_SCENARIO_PREFIX = 'CoverageScenario: ';

// Why the patient was seen. The dental problem is the one that drives this
// visit, so its medication is what the agent should lead with and follow up on.
const demoConditions = [
  { key: 'dental-pain', display: 'Dental pain following tooth extraction', onsetDate: todayMinus(3) },
  { key: 'type-2-diabetes', display: 'Type 2 diabetes mellitus' },
  { key: 'hypertension', display: 'Essential hypertension' },
] as const;

// `treats` links a prescription to the problem it was written for, which is
// what lets the agent ask about the RIGHT medication instead of all of them.
// `coverageScenario` selects which stub payer response this med rehearses;
// `refills` maps to MedicationRequest.dispenseRequest.numberOfRepeatsAllowed
// so the refill tool has both branches (renewal vs pharmacy fill) to exercise.
const demoMedications = [
  { key: 'ibuprofen',    display: 'Ibuprofen',    instructions: 'Take 600 mg every 8 hours as needed for pain', treats: 'dental-pain',    coverageScenario: 'covered' as const,              refills: 0 },
  { key: 'metformin',    display: 'Metformin',    instructions: 'Take 500 mg twice daily',                       treats: 'type-2-diabetes', coverageScenario: 'high-copay' as const,           refills: 5 },
  { key: 'lisinopril',   display: 'Lisinopril',   instructions: 'Take 10 mg once daily',                         treats: 'hypertension',    coverageScenario: 'prior-auth-required' as const,  refills: 3 },
  { key: 'atorvastatin', display: 'Atorvastatin', instructions: 'Take 40 mg once daily',                         treats: 'hypertension',    coverageScenario: 'deductible-not-met' as const,   refills: 0 },
] as const;

// The visit this call prepares for. The dental follow-up is soonest, so it is
// what the review is scoped to — the diabetes review is weeks out and is NOT
// this call's business.
const demoAppointments = [
  {
    key: 'dental-followup',
    specialty: 'Dentistry',
    description: 'Dental follow-up after tooth extraction',
    treats: 'dental-pain',
    start: todayPlus(2),
  },
  {
    key: 'diabetes-review',
    specialty: 'General Practice',
    description: 'Routine diabetes and blood pressure review',
    treats: 'type-2-diabetes',
    start: todayPlus(45),
  },
] as const;

function todayPlus(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(10, 0, 0, 0);
  return date.toISOString();
}

function todayMinus(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

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

const conditionIds = new Map<string, string>();
for (const condition of demoConditions) {
  const identifierValue = `${memberId}:${condition.key}`;
  const resource: Condition = {
    resourceType: 'Condition',
    identifier: [{ system: CONDITION_SYSTEM, value: identifierValue }],
    clinicalStatus: {
      coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }],
    },
    subject: { reference: `Patient/${patient.id}` },
    code: { text: condition.display },
    ...('onsetDate' in condition && condition.onsetDate ? { onsetDateTime: condition.onsetDate } : {}),
  };
  console.log(JSON.stringify({ type: 'medplum.conditional-create.request', resourceType: 'Condition' }));
  const created = await medplum.createResourceIfNoneExist(
    resource,
    `identifier=${encodeURIComponent(`${CONDITION_SYSTEM}|${identifierValue}`)}`,
  );
  if (!created.id) throw new Error('Medplum returned a Condition without an id');
  conditionIds.set(condition.key, created.id);
  console.log(JSON.stringify({ type: 'medplum.conditional-create.response', resource: `Condition/${created.id}` }));
}

for (const appointment of demoAppointments) {
  const identifierValue = `${memberId}:${appointment.key}`;
  const conditionId = conditionIds.get(appointment.treats);
  const resource: Appointment = {
    resourceType: 'Appointment',
    identifier: [{ system: APPOINTMENT_SYSTEM, value: identifierValue }],
    status: 'booked',
    description: appointment.description,
    start: appointment.start,
    // FHIR constraint app-2: start and end are specified together, or neither.
    end: new Date(Date.parse(appointment.start) + 30 * 60_000).toISOString(),
    specialty: [{ text: appointment.specialty }],
    participant: [{ actor: { reference: `Patient/${patient.id}` }, status: 'accepted' }],
    ...(conditionId ? { reasonReference: [{ reference: `Condition/${conditionId}` }] } : {}),
  };
  console.log(JSON.stringify({ type: 'medplum.conditional-create.request', resourceType: 'Appointment' }));
  const created = await medplum.createResourceIfNoneExist(
    resource,
    `identifier=${encodeURIComponent(`${APPOINTMENT_SYSTEM}|${identifierValue}`)}`,
  );
  console.log(JSON.stringify({ type: 'medplum.conditional-create.response', resource: `Appointment/${created.id}` }));
  // Dates move as the demo ages; keep the upcoming visit actually upcoming.
  if (created.id && created.start !== appointment.start) {
    const updated = await medplum.updateResource({ ...created, ...resource, id: created.id });
    console.log(JSON.stringify({ type: 'medplum.update.response', resource: `Appointment/${updated.id}`, refreshed: 'start' }));
  }
}

for (const medication of demoMedications) {
  const identifierValue = `${memberId}:${medication.key}`;
  // Appearance and dosing times are written INTO Medplum so the voice agent
  // reads them from the system of record at call time rather than from a
  // table in the codebase. patientInstruction and Timing.repeat.timeOfDay are
  // standard FHIR R4 fields; the pill description has no coded FHIR home, so
  // it goes in a note tagged with a prefix we can parse back out.
  const reference = lookupMedication(medication.display);
  const conditionId = conditionIds.get(medication.treats);
  const treatsDisplay = demoConditions.find((c) => c.key === medication.treats)?.display ?? medication.treats;
  const request: MedicationRequest = {
    resourceType: 'MedicationRequest',
    identifier: [{ system: MEDICATION_REQUEST_SYSTEM, value: identifierValue }],
    status: 'active',
    intent: 'order',
    subject: { reference: `Patient/${patient.id}` },
    medicationCodeableConcept: { text: medication.display },
    // reasonReference is what tells the agent WHY this was prescribed.
    ...(conditionId
      ? { reasonReference: [{ reference: `Condition/${conditionId}`, display: treatsDisplay }] }
      : {}),
    dosageInstruction: [{
      text: medication.instructions,
      ...(reference ? { patientInstruction: reference.schedule } : {}),
      ...(reference ? { timing: { repeat: { timeOfDay: reference.timeOfDay } } } : {}),
    }],
    dispenseRequest: { numberOfRepeatsAllowed: medication.refills },
    note: [
      ...(reference ? [{ text: `${APPEARANCE_PREFIX}${reference.appearance}` }] : []),
      { text: `${COVERAGE_SCENARIO_PREFIX}${medication.coverageScenario}` },
    ],
  };
  console.log(JSON.stringify({ type: 'medplum.conditional-create.request', resourceType: 'MedicationRequest' }));
  const created = await medplum.createResourceIfNoneExist(
    request,
    `identifier=${encodeURIComponent(`${MEDICATION_REQUEST_SYSTEM}|${identifierValue}`)}`,
  );
  console.log(JSON.stringify({ type: 'medplum.conditional-create.response', resource: `MedicationRequest/${created.id}` }));

  // Conditional create returns the EXISTING resource untouched, so a re-seed
  // would never add appearance or dosing times to rows written by an earlier
  // run. Update in place when the stored copy is missing what we now write.
  const storedAppearance = created.note?.some((entry) => entry.text?.startsWith(APPEARANCE_PREFIX));
  const storedScenario = created.note?.some((entry) => entry.text?.startsWith(COVERAGE_SCENARIO_PREFIX));
  const storedTiming = created.dosageInstruction?.some((entry) => entry.timing?.repeat?.timeOfDay?.length);
  const storedReason = Boolean(created.reasonReference?.length);
  const storedRefills = typeof created.dispenseRequest?.numberOfRepeatsAllowed === 'number';
  if (!storedAppearance || !storedTiming || !storedReason || !storedScenario || !storedRefills) {
    console.log(JSON.stringify({ type: 'medplum.update.request', resource: `MedicationRequest/${created.id}` }));
    const updated = await medplum.updateResource({ ...created, ...request, id: created.id });
    console.log(JSON.stringify({ type: 'medplum.update.response', resource: `MedicationRequest/${updated.id}`, added: 'appearance+timing+scenario+refills' }));
  }
}
