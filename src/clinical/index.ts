import { MedplumClient, getDisplayString } from '@medplum/core';
import type { DetectedIssue, MedicationRequest, Patient } from '@medplum/fhirtypes';
import type {
  ClinicalApi,
  ClinicalIssue,
  PatientReview,
  PrescribedMedication,
  ReconciliationResult,
  ReportedMedication,
  SymptomReportInput,
  UrgentIssueInput,
} from '../contract.js';
import { bus } from '../bus.js';
import { reconcileAgainst } from './reconciliation.js';

function requireEnv(name: 'MEDPLUM_CLIENT_ID' | 'MEDPLUM_CLIENT_SECRET'): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for the Medplum clinical adapter`);
  }
  return value;
}

function medicationDisplay(request: MedicationRequest): string {
  return request.medicationCodeableConcept?.text ?? request.medicationCodeableConcept?.coding?.[0]?.display ?? request.medicationReference?.display ?? 'Medication name unavailable';
}

function medicationInstructions(request: MedicationRequest): string | undefined {
  return request.dosageInstruction?.map((instruction) => instruction.text).filter(Boolean).join('; ') || undefined;
}

/** MedicationRequest.note carrying the "Appearance: ..." prefix the seed writes. */
const APPEARANCE_PREFIX = 'Appearance: ';

function medicationAppearance(request: MedicationRequest): string | undefined {
  const note = request.note?.find((entry) => entry.text?.startsWith(APPEARANCE_PREFIX));
  return note?.text?.slice(APPEARANCE_PREFIX.length).trim() || undefined;
}

function toPrescribedMedication(request: MedicationRequest): PrescribedMedication {
  if (!request.id) {
    throw new Error('Medplum returned a MedicationRequest without an id');
  }
  const instructions = medicationInstructions(request);
  const display = medicationDisplay(request);
  // Everything below comes out of the Medplum record. `npm run seed` writes
  // it; nothing here is hardcoded. Absent fields simply stay absent, and the
  // agent is instructed to say "not on file" rather than fill the gap.
  const appearance = medicationAppearance(request);
  const schedule = request.dosageInstruction?.find((d) => d.patientInstruction)?.patientInstruction;
  const dueTimes = request.dosageInstruction?.flatMap((d) => d.timing?.repeat?.timeOfDay ?? []) ?? [];
  return {
    requestId: request.id,
    display,
    status: request.status,
    ...(instructions ? { instructions } : {}),
    ...(appearance ? { appearance } : {}),
    ...(schedule ? { schedule } : {}),
    ...(dueTimes.length ? { dueTimes } : {}),
  };
}

export async function createClinicalApi(): Promise<ClinicalApi> {
  const medplum = new MedplumClient({ baseUrl: process.env.MEDPLUM_BASE_URL ?? 'https://api.medplum.com/' });
  bus.publish({ source: 'clinical', type: 'medplum.login.request' });
  const profile = await medplum.startClientLogin(requireEnv('MEDPLUM_CLIENT_ID'), requireEnv('MEDPLUM_CLIENT_SECRET'));
  bus.publish({ source: 'clinical', type: 'medplum.login.response', data: { profile: `${profile.resourceType}/${profile.id}` } });

  async function loadPatient(patientId: string): Promise<Patient> {
    bus.publish({ source: 'clinical', type: 'medplum.read.request', data: { resource: `Patient/${patientId}` } });
    const patient = await medplum.readResource('Patient', patientId);
    bus.publish({ source: 'clinical', type: 'medplum.read.response', data: { resource: `Patient/${patientId}` } });
    return patient;
  }

  async function loadMedications(patientId: string): Promise<PrescribedMedication[]> {
    bus.publish({ source: 'clinical', type: 'medplum.search.request', data: { resourceType: 'MedicationRequest', subject: `Patient/${patientId}` } });
    const requests = await medplum.searchResources('MedicationRequest', { subject: `Patient/${patientId}` });
    bus.publish({ source: 'clinical', type: 'medplum.search.response', data: { resourceType: 'MedicationRequest', count: requests.length } });
    return requests.map(toPrescribedMedication);
  }

  async function createIssue(
    patientId: string,
    detail: string,
    severity: NonNullable<DetectedIssue['severity']>,
    summary: string,
    medication?: PrescribedMedication,
  ): Promise<string> {
    const issue: DetectedIssue = {
      resourceType: 'DetectedIssue',
      status: 'final',
      severity,
      patient: { reference: `Patient/${patientId}` },
      identifiedDateTime: new Date().toISOString(),
      code: { text: summary },
      detail,
      ...(medication ? { implicated: [{ reference: `MedicationRequest/${medication.requestId}` }] } : {}),
    };
    bus.publish({ source: 'clinical', type: 'medplum.create.request', data: { resourceType: issue.resourceType, severity } });
    const created = await medplum.createResource(issue);
    if (!created.id) {
      throw new Error('Medplum returned a DetectedIssue without an id');
    }
    bus.publish({ source: 'clinical', type: 'medplum.create.response', data: { resource: `DetectedIssue/${created.id}` } });
    return created.id;
  }

  function toClinicalIssue(issue: DetectedIssue): ClinicalIssue | undefined {
    if (!issue.id || !issue.identifiedDateTime) return undefined;
    const detail = issue.detail ?? '';
    const prefix = 'Patient report (verbatim): ';
    const urgentPrefix = 'Urgent patient report (verbatim): ';
    return {
      id: issue.id,
      severity: issue.severity ?? 'moderate',
      category: detail.startsWith(urgentPrefix) ? 'urgent' : issue.code?.text === 'Patient-reported symptom' ? 'symptom' : 'medication',
      summary: issue.code?.text ?? 'Clinical issue',
      patientWords: detail.replace(urgentPrefix, '').replace(prefix, ''),
      createdAt: issue.identifiedDateTime,
    };
  }

  return {
    async getPatientReview(patientId): Promise<PatientReview> {
      const [patient, medications] = await Promise.all([loadPatient(patientId), loadMedications(patientId)]);
      const memberId = patient.identifier?.find((identifier) =>
        identifier.system?.includes('member-id') && Boolean(identifier.value)
      )?.value;
      return {
        patientId,
        displayName: getDisplayString(patient),
        ...(memberId ? { memberId } : {}),
        ...(patient.birthDate ? { dateOfBirth: patient.birthDate } : {}),
        medications,
      };
    },

    async reconcileMedication(input: ReportedMedication): Promise<ReconciliationResult> {
      const medications = await loadMedications(input.patientId);
      const match = reconcileAgainst(medications, input);
      if (match.kind === 'match') {
        return { ...match, reported: input };
      }
      const detectedIssueId = await createIssue(
        input.patientId,
        `Patient report (verbatim): ${input.patientWords}`,
        'moderate',
        `Medication discrepancy: ${match.kind}`,
        match.prescribed,
      );
      return { ...match, reported: input, detectedIssueId };
    },

    async recordSymptom(input: SymptomReportInput): Promise<{ detectedIssueId: string }> {
      const detectedIssueId = await createIssue(
        input.patientId,
        `Patient report (verbatim): ${input.patientWords}`,
        'moderate',
        'Patient-reported symptom',
      );
      return { detectedIssueId };
    },

    async recordUrgentIssue(input: UrgentIssueInput): Promise<{ detectedIssueId: string }> {
      const detectedIssueId = await createIssue(
        input.patientId,
        `Urgent patient report (verbatim): ${input.patientWords}`,
        'high',
        'Urgent escalation',
      );
      return { detectedIssueId };
    },

    async listIssues(patientId): Promise<ClinicalIssue[]> {
      bus.publish({ source: 'clinical', type: 'medplum.search.request', data: { resourceType: 'DetectedIssue', patient: `Patient/${patientId}` } });
      const issues = await medplum.searchResources('DetectedIssue', { patient: `Patient/${patientId}`, _sort: '-identified' });
      bus.publish({ source: 'clinical', type: 'medplum.search.response', data: { resourceType: 'DetectedIssue', count: issues.length } });
      return issues.map(toClinicalIssue).filter((issue): issue is ClinicalIssue => Boolean(issue));
    },
  };
}
