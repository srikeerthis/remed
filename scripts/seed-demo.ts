import 'dotenv/config';
import { MedplumClient } from '@medplum/core';
import type { Coverage, MedicationRequest, Organization, Patient } from '@medplum/fhirtypes';
import { DEMO_PATIENTS, toFhirBirthDate } from '../src/demo-patients.js';

const MEMBER_SYSTEM = 'https://countback.health/identifiers/demo-member-id';
const TRADING_PARTNER_SYSTEM = 'https://countback.health/identifiers/demo-trading-partner';
const COVERAGE_SYSTEM = 'https://countback.health/identifiers/demo-coverage';
const MEDICATION_REQUEST_SYSTEM = 'https://countback.health/identifiers/demo-medication-request';
const medications = [
  { key: 'metformin', display: 'Metformin', instructions: 'Take 500 mg twice daily' },
  { key: 'lisinopril', display: 'Lisinopril', instructions: 'Take 10 mg once daily' },
  { key: 'atorvastatin', display: 'Atorvastatin', instructions: 'Take 40 mg once daily' },
] as const;

function required(name: 'MEDPLUM_CLIENT_ID' | 'MEDPLUM_CLIENT_SECRET'): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required to seed the Medplum demo roster`);
  return value;
}

const clientId = required('MEDPLUM_CLIENT_ID');
const clientSecret = required('MEDPLUM_CLIENT_SECRET');
const medplum = new MedplumClient({ baseUrl: process.env.MEDPLUM_BASE_URL ?? 'https://api.medplum.com/' });
console.log(JSON.stringify({ type: 'medplum.login.request', seedMode: 'synthetic-demo' }));
await medplum.startClientLogin(clientId, clientSecret);
console.log(JSON.stringify({ type: 'medplum.login.response', ok: true }));

for (const demo of DEMO_PATIENTS) {
  const patientResource: Patient = {
    resourceType: 'Patient',
    active: true,
    identifier: [{ system: MEMBER_SYSTEM, value: demo.memberId }],
    name: [{ use: 'official', given: [demo.firstName], family: demo.lastName }],
    birthDate: toFhirBirthDate(demo.dateOfBirth),
  };
  const patient = await medplum.createResourceIfNoneExist(
    patientResource,
    `identifier=${encodeURIComponent(`${MEMBER_SYSTEM}|${demo.memberId}`)}`,
  );
  if (!patient.id) throw new Error(`Medplum returned no id for synthetic member ${demo.memberId}`);

  const organizationResource: Organization = {
    resourceType: 'Organization',
    active: true,
    identifier: [{ system: TRADING_PARTNER_SYSTEM, value: demo.tradingPartnerServiceId }],
    name: `Synthetic Demo Payor ${demo.tradingPartnerServiceId}`,
  };
  const payor = await medplum.createResourceIfNoneExist(
    organizationResource,
    `identifier=${encodeURIComponent(`${TRADING_PARTNER_SYSTEM}|${demo.tradingPartnerServiceId}`)}`,
  );
  if (!payor.id) throw new Error(`Medplum returned no payor id for synthetic member ${demo.memberId}`);

  const coverageIdentifier = `${demo.tradingPartnerServiceId}:${demo.memberId}`;
  const coverageResource: Coverage = {
    resourceType: 'Coverage',
    status: 'active',
    beneficiary: { reference: `Patient/${patient.id}` },
    subscriberId: demo.memberId,
    identifier: [{ system: COVERAGE_SYSTEM, value: coverageIdentifier }],
    payor: [{ reference: `Organization/${payor.id}` }],
  };
  await medplum.createResourceIfNoneExist(
    coverageResource,
    `identifier=${encodeURIComponent(`${COVERAGE_SYSTEM}|${coverageIdentifier}`)}`,
  );

  for (const medication of medications) {
    const identifierValue = `${demo.memberId}:${medication.key}`;
    const request: MedicationRequest = {
      resourceType: 'MedicationRequest',
      identifier: [{ system: MEDICATION_REQUEST_SYSTEM, value: identifierValue }],
      status: 'active',
      intent: 'order',
      subject: { reference: `Patient/${patient.id}` },
      medicationCodeableConcept: { text: medication.display },
      dosageInstruction: [{ text: medication.instructions }],
    };
    await medplum.createResourceIfNoneExist(
      request,
      `identifier=${encodeURIComponent(`${MEDICATION_REQUEST_SYSTEM}|${identifierValue}`)}`,
    );
  }

  console.log(JSON.stringify({
    type: 'medplum.demo-patient.seeded',
    resource: `Patient/${patient.id}`,
    syntheticMemberId: demo.memberId,
  }));
}

console.log(JSON.stringify({ type: 'medplum.demo-roster.complete', patientCount: DEMO_PATIENTS.length }));
