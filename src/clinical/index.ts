import { MedplumClient, getDisplayString } from '@medplum/core';
import type { Communication, DetectedIssue, MedicationRequest, Patient, Task } from '@medplum/fhirtypes';
import type {
  CareTeamNote,
  CareTeamNoteInput,
  ClinicalApi,
  ClinicalIssue,
  CoverageScenario,
  MissedDoseInput,
  PatientAppointment,
  PatientCondition,
  PatientReview,
  PrescribedMedication,
  RefillRequestInput,
  RefillStatus,
  ReconciliationResult,
  ReportedMedication,
  SideEffectConcernInput,
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
/** MedicationRequest.note carrying the "CoverageScenario: <slug>" tag the seed writes. */
const COVERAGE_SCENARIO_PREFIX = 'CoverageScenario: ';

const COVERAGE_SCENARIOS: readonly CoverageScenario[] = [
  'covered',
  'high-copay',
  'not-covered',
  'prior-auth-required',
  'deductible-not-met',
  'payer-error',
];

function medicationAppearance(request: MedicationRequest): string | undefined {
  const note = request.note?.find((entry) => entry.text?.startsWith(APPEARANCE_PREFIX));
  return note?.text?.slice(APPEARANCE_PREFIX.length).trim() || undefined;
}

function medicationCoverageScenario(request: MedicationRequest): CoverageScenario | undefined {
  const note = request.note?.find((entry) => entry.text?.startsWith(COVERAGE_SCENARIO_PREFIX));
  const value = note?.text?.slice(COVERAGE_SCENARIO_PREFIX.length).trim();
  return COVERAGE_SCENARIOS.find((scenario) => scenario === value);
}

function toPrescribedMedication(request: MedicationRequest): PrescribedMedication {
  if (!request.id) {
    throw new Error('Medplum returned a MedicationRequest without an id');
  }
  const instructions = medicationInstructions(request);
  const display = medicationDisplay(request);
  const appearance = medicationAppearance(request);
  const schedule = request.dosageInstruction?.find((d) => d.patientInstruction)?.patientInstruction;
  const dueTimes = request.dosageInstruction?.flatMap((d) => d.timing?.repeat?.timeOfDay ?? []) ?? [];
  const reason = request.reasonReference?.[0];
  const indication = reason?.display ?? request.reasonCode?.[0]?.text;
  const conditionId = reason?.reference?.split('/')[1];
  const refillsRemaining = request.dispenseRequest?.numberOfRepeatsAllowed;
  const coverageScenario = medicationCoverageScenario(request);
  return {
    requestId: request.id,
    display,
    status: request.status,
    ...(instructions ? { instructions } : {}),
    ...(appearance ? { appearance } : {}),
    ...(schedule ? { schedule } : {}),
    ...(dueTimes.length ? { dueTimes } : {}),
    ...(indication ? { indication } : {}),
    ...(conditionId ? { conditionId } : {}),
    ...(typeof refillsRemaining === 'number' ? { refillsRemaining } : {}),
    ...(coverageScenario ? { coverageScenario } : {}),
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

  async function loadConditions(patientId: string): Promise<PatientCondition[]> {
    bus.publish({ source: 'clinical', type: 'medplum.search.request', data: { resourceType: 'Condition', patient: `Patient/${patientId}` } });
    const rows = await medplum.searchResources('Condition', { subject: `Patient/${patientId}` });
    bus.publish({ source: 'clinical', type: 'medplum.search.response', data: { resourceType: 'Condition', count: rows.length } });
    return rows.flatMap((row) => {
      if (!row.id) return [];
      const status = row.clinicalStatus?.coding?.[0]?.code;
      return [{
        id: row.id,
        display: row.code?.text ?? row.code?.coding?.[0]?.display ?? 'Unnamed condition',
        ...(status ? { clinicalStatus: status } : {}),
        ...(row.onsetDateTime ? { onsetDate: row.onsetDateTime.slice(0, 10) } : {}),
      }];
    });
  }

  /** The soonest upcoming booked appointment — what this call is preparing for. */
  async function loadNextAppointment(patientId: string): Promise<PatientAppointment | undefined> {
    bus.publish({ source: 'clinical', type: 'medplum.search.request', data: { resourceType: 'Appointment', patient: `Patient/${patientId}` } });
    const rows = await medplum.searchResources('Appointment', { patient: `Patient/${patientId}`, _sort: 'date' });
    bus.publish({ source: 'clinical', type: 'medplum.search.response', data: { resourceType: 'Appointment', count: rows.length } });

    const now = Date.now();
    const upcoming = rows
      .filter((row) => row.id && row.status !== 'cancelled' && row.start && Date.parse(row.start) >= now)
      .sort((a, b) => Date.parse(a.start ?? '') - Date.parse(b.start ?? ''));
    const next = upcoming[0];
    if (!next?.id) return undefined;

    const specialty = next.specialty?.[0]?.text ?? next.specialty?.[0]?.coding?.[0]?.display;
    const reason = next.description ?? next.reasonCode?.[0]?.text;
    return {
      id: next.id,
      ...(next.start ? { start: next.start } : {}),
      ...(specialty ? { specialty } : {}),
      ...(reason ? { reason } : {}),
      conditionIds: (next.reasonReference ?? [])
        .map((ref) => ref.reference?.split('/')[1])
        .filter((id): id is string => Boolean(id)),
    };
  }

  async function loadMedications(patientId: string): Promise<PrescribedMedication[]> {
    bus.publish({ source: 'clinical', type: 'medplum.search.request', data: { resourceType: 'MedicationRequest', subject: `Patient/${patientId}` } });
    const requests = await medplum.searchResources('MedicationRequest', { subject: `Patient/${patientId}` });
    bus.publish({ source: 'clinical', type: 'medplum.search.response', data: { resourceType: 'MedicationRequest', count: requests.length } });
    return requests.map(toPrescribedMedication);
  }

  async function findMedication(patientId: string, name: string): Promise<PrescribedMedication | undefined> {
    const list = await loadMedications(patientId);
    const needle = name.toLowerCase();
    return list.find((m) => needle.includes(m.display.toLowerCase()) || m.display.toLowerCase().includes(needle));
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

  async function createRefillTask(
    patientId: string,
    medication: PrescribedMedication,
    description: string,
    intent: 'renewal' | 'fulfillment',
  ): Promise<string> {
    const task: Task = {
      resourceType: 'Task',
      status: 'requested',
      intent: 'order',
      priority: intent === 'renewal' ? 'urgent' : 'routine',
      for: { reference: `Patient/${patientId}` },
      focus: { reference: `MedicationRequest/${medication.requestId}` },
      authoredOn: new Date().toISOString(),
      description,
      code: {
        text: intent === 'renewal' ? 'Prescription renewal request' : 'Medication refill request',
      },
    };
    bus.publish({ source: 'clinical', type: 'medplum.create.request', data: { resourceType: 'Task', intent } });
    const created = await medplum.createResource(task);
    if (!created.id) throw new Error('Medplum returned a Task without an id');
    bus.publish({ source: 'clinical', type: 'medplum.create.response', data: { resource: `Task/${created.id}` } });
    return created.id;
  }

  function toClinicalIssue(issue: DetectedIssue): ClinicalIssue | undefined {
    if (!issue.id || !issue.identifiedDateTime) return undefined;
    const detail = issue.detail ?? '';
    const summary = issue.code?.text ?? 'Clinical issue';
    const category: ClinicalIssue['category'] = summary.startsWith('Urgent')
      ? 'urgent'
      : summary.startsWith('Patient-attributed side effect')
        ? 'side-effect'
        : summary.startsWith('Missed dose')
          ? 'missed-dose'
          : summary.startsWith('Refill') || summary.startsWith('Renewal')
            ? 'refill'
            : summary === 'Patient-reported symptom' || summary.startsWith('Patient-reported symptom')
              ? 'symptom'
              : 'medication';
    const urgentPrefix = 'Urgent patient report (verbatim): ';
    const patientPrefix = 'Patient report (verbatim): ';
    return {
      id: issue.id,
      severity: issue.severity ?? 'moderate',
      category,
      summary,
      patientWords: detail.replace(urgentPrefix, '').replace(patientPrefix, ''),
      createdAt: issue.identifiedDateTime,
    };
  }

  return {
    async getPatientReview(patientId): Promise<PatientReview> {
      const [patient, medications, conditions, appointment] = await Promise.all([
        loadPatient(patientId),
        loadMedications(patientId),
        loadConditions(patientId),
        loadNextAppointment(patientId),
      ]);
      const memberId = patient.identifier?.find((identifier) =>
        identifier.system?.includes('member-id') && Boolean(identifier.value)
      )?.value;
      return {
        patientId,
        displayName: getDisplayString(patient),
        ...(memberId ? { memberId } : {}),
        ...(patient.birthDate ? { dateOfBirth: patient.birthDate } : {}),
        ...(conditions.length ? { conditions } : {}),
        ...(appointment ? { appointment } : {}),
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

    async recordCareTeamNote(input: CareTeamNoteInput): Promise<{ noteId: string }> {
      const communication: Communication = {
        resourceType: 'Communication',
        status: 'completed',
        subject: { reference: `Patient/${input.patientId}` },
        category: [{
          coding: [{
            system: 'http://terminology.hl7.org/CodeSystem/communication-category',
            code: 'notification',
            display: 'Notification',
          }],
          text: input.topic,
        }],
        sent: new Date().toISOString(),
        payload: [{ contentString: input.patientWords }],
      };
      bus.publish({ source: 'clinical', type: 'medplum.create.request', data: { resourceType: 'Communication', topic: input.topic } });
      const created = await medplum.createResource(communication);
      if (!created.id) throw new Error('Medplum returned a Communication without an id');
      bus.publish({ source: 'clinical', type: 'medplum.create.response', data: { resource: `Communication/${created.id}` } });
      return { noteId: created.id };
    },

    async recordMissedDose(input: MissedDoseInput): Promise<{ detectedIssueId: string }> {
      const medication = await findMedication(input.patientId, input.medicationName);
      const when = input.when ? `[${input.when}] ` : '';
      const detectedIssueId = await createIssue(
        input.patientId,
        `Patient report (verbatim): ${when}${input.patientWords}`,
        'low',
        `Missed dose reported: ${input.medicationName}`,
        medication,
      );
      return { detectedIssueId };
    },

    async recordSideEffectConcern(input: SideEffectConcernInput): Promise<{ detectedIssueId: string }> {
      const medication = await findMedication(input.patientId, input.medicationName);
      const detectedIssueId = await createIssue(
        input.patientId,
        `Patient report (verbatim): ${input.patientWords}`,
        'moderate',
        `Patient-attributed side effect concern (${input.medicationName})`,
        medication,
      );
      return { detectedIssueId };
    },

    async requestRefill(input: RefillRequestInput): Promise<RefillStatus> {
      const medication = await findMedication(input.patientId, input.medicationName);
      if (!medication) {
        return {
          medication: input.medicationName,
          refillsRemaining: 0,
          needsRenewal: true,
          speakable: `I don't see ${input.medicationName} on your discharge list — your care team will follow up on this before the visit.`,
        };
      }
      const remaining = medication.refillsRemaining ?? 0;
      if (remaining <= 0) {
        const taskId = await createRefillTask(
          input.patientId,
          medication,
          `Patient reports running out; zero refills remaining on file. Renewal needed.`,
          'renewal',
        );
        return {
          medication: medication.display,
          refillsRemaining: 0,
          needsRenewal: true,
          taskId,
          speakable: `Your ${medication.display} has no refills left, so I've asked your prescriber to send a renewal.`,
        };
      }
      const taskId = await createRefillTask(
        input.patientId,
        medication,
        `Refill request forwarded to dispensing pharmacy. ${remaining} refill${remaining === 1 ? '' : 's'} remaining.`,
        'fulfillment',
      );
      return {
        medication: medication.display,
        refillsRemaining: remaining,
        needsRenewal: false,
        taskId,
        speakable: `You have ${remaining} refill${remaining === 1 ? '' : 's'} left on ${medication.display}; I've sent the request to your pharmacy.`,
      };
    },

    async listIssues(patientId): Promise<ClinicalIssue[]> {
      bus.publish({ source: 'clinical', type: 'medplum.search.request', data: { resourceType: 'DetectedIssue', patient: `Patient/${patientId}` } });
      const issues = await medplum.searchResources('DetectedIssue', { patient: `Patient/${patientId}`, _sort: '-identified' });
      bus.publish({ source: 'clinical', type: 'medplum.search.response', data: { resourceType: 'DetectedIssue', count: issues.length } });
      return issues.map(toClinicalIssue).filter((issue): issue is ClinicalIssue => Boolean(issue));
    },

    async listCareTeamNotes(patientId): Promise<CareTeamNote[]> {
      bus.publish({ source: 'clinical', type: 'medplum.search.request', data: { resourceType: 'Communication', patient: `Patient/${patientId}` } });
      const rows = await medplum.searchResources('Communication', { subject: `Patient/${patientId}`, _sort: '-sent' });
      bus.publish({ source: 'clinical', type: 'medplum.search.response', data: { resourceType: 'Communication', count: rows.length } });
      return rows.flatMap((row) => {
        if (!row.id || !row.sent) return [];
        return [{
          id: row.id,
          topic: row.category?.[0]?.text ?? 'Care team note',
          patientWords: row.payload?.[0]?.contentString ?? '',
          createdAt: row.sent,
        }];
      });
    },
  };
}
