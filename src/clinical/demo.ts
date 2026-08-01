import type {
  CareTeamNote,
  CareTeamNoteInput,
  ClinicalApi,
  ClinicalIssue,
  MissedDoseInput,
  PatientReview,
  PrescribedMedication,
  RefillRequestInput,
  RefillStatus,
  ReportedMedication,
  SideEffectConcernInput,
  SymptomReportInput,
  UrgentIssueInput,
} from '../contract.js';
import { bus } from '../bus.js';
import { reconcileAgainst } from './reconciliation.js';
import { lookupMedication } from '../medication-reference.js';

/**
 * FALLBACK ONLY. This path runs when Medplum credentials are absent. With
 * Medplum configured, appearance and timing come from the FHIR record instead
 * — see src/clinical/index.ts.
 */
function withReference(medication: PrescribedMedication): PrescribedMedication {
  const reference = lookupMedication(medication.display);
  if (!reference) return medication;
  return { ...medication, appearance: reference.appearance, schedule: reference.schedule, dueTimes: reference.timeOfDay };
}

const conditions = [
  { id: 'demo-dental-pain', display: 'Dental pain following tooth extraction', clinicalStatus: 'active' },
  { id: 'demo-t2dm', display: 'Type 2 diabetes mellitus', clinicalStatus: 'active' },
  { id: 'demo-htn', display: 'Essential hypertension', clinicalStatus: 'active' },
];

const appointment = {
  id: 'demo-dental-followup',
  start: new Date(Date.now() + 2 * 86400000).toISOString(),
  specialty: 'Dentistry',
  reason: 'Dental follow-up after tooth extraction',
  conditionIds: ['demo-dental-pain'],
};

// Per-medication coverage scenarios + refill counts, chosen so a rehearsal can
// walk through every insurance path and both the refill and renewal branches
// without changing code between takes.
const medications: PrescribedMedication[] = ([
  {
    requestId: 'demo-ibuprofen',
    display: 'Ibuprofen',
    instructions: 'Take 600 mg every 8 hours as needed for pain',
    status: 'active',
    indication: 'Dental pain following tooth extraction',
    conditionId: 'demo-dental-pain',
    refillsRemaining: 0,
    coverageScenario: 'covered',
  },
  {
    requestId: 'demo-metformin',
    display: 'Metformin',
    instructions: 'Take 500 mg twice daily',
    status: 'active',
    indication: 'Type 2 diabetes mellitus',
    conditionId: 'demo-t2dm',
    refillsRemaining: 5,
    coverageScenario: 'high-copay',
  },
  {
    requestId: 'demo-lisinopril',
    display: 'Lisinopril',
    instructions: 'Take 10 mg once daily',
    status: 'active',
    indication: 'Essential hypertension',
    conditionId: 'demo-htn',
    refillsRemaining: 3,
    coverageScenario: 'prior-auth-required',
  },
  {
    requestId: 'demo-atorvastatin',
    display: 'Atorvastatin',
    instructions: 'Take 40 mg once daily',
    status: 'active',
    indication: 'Essential hypertension',
    conditionId: 'demo-htn',
    refillsRemaining: 0,
    coverageScenario: 'deductible-not-met',
  },
] as PrescribedMedication[]).map(withReference);

function findMedication(name: string): PrescribedMedication | undefined {
  const needle = name.toLowerCase();
  return medications.find((m) => needle.includes(m.display.toLowerCase()) || m.display.toLowerCase().includes(needle));
}

export function createDemoClinicalApi(): ClinicalApi {
  const issues: ClinicalIssue[] = [];
  const notes: CareTeamNote[] = [];

  function addIssue(
    category: ClinicalIssue['category'],
    severity: ClinicalIssue['severity'],
    summary: string,
    patientWords: string,
  ): ClinicalIssue {
    const issue: ClinicalIssue = {
      id: `demo-issue-${issues.length + 1}`,
      category,
      severity,
      summary,
      patientWords,
      createdAt: new Date().toISOString(),
    };
    issues.unshift(issue);
    bus.publish({ source: 'clinical', type: 'demo.detected-issue.created', data: issue });
    return issue;
  }

  return {
    async getPatientReview(_patientId): Promise<PatientReview> {
      return {
        patientId: 'demo-patient',
        displayName: 'John Alvarez (Synthetic)',
        memberId: 'MBR10001',
        dateOfBirth: '1968-03-14',
        conditions,
        appointment,
        medications,
      };
    },

    async reconcileMedication(input: ReportedMedication) {
      const match = reconcileAgainst(medications, input);
      let detectedIssueId: string | undefined;
      if (match.kind !== 'match') {
        detectedIssueId = addIssue(
          'medication',
          'moderate',
          `Medication discrepancy: ${match.kind}`,
          input.patientWords,
        ).id;
      }
      bus.publish({ source: 'clinical', type: 'demo.reconciliation.completed', data: match });
      return {
        ...match,
        reported: input,
        ...(detectedIssueId ? { detectedIssueId } : {}),
      };
    },

    async recordSymptom(input: SymptomReportInput) {
      const issue = addIssue('symptom', 'moderate', 'Patient-reported symptom for clinician review', input.patientWords);
      return { detectedIssueId: issue.id };
    },

    async recordUrgentIssue(input: UrgentIssueInput) {
      const issue = addIssue('urgent', 'high', 'Urgent escalation', input.patientWords);
      return { detectedIssueId: issue.id };
    },

    async recordCareTeamNote(input: CareTeamNoteInput) {
      const note: CareTeamNote = {
        id: `demo-note-${notes.length + 1}`,
        topic: input.topic,
        patientWords: input.patientWords,
        createdAt: new Date().toISOString(),
      };
      notes.unshift(note);
      bus.publish({ source: 'clinical', type: 'demo.care-team-note.created', data: note });
      return { noteId: note.id };
    },

    async recordMissedDose(input: MissedDoseInput) {
      const detail = input.when ? `[${input.when}] ${input.patientWords}` : input.patientWords;
      const issue = addIssue(
        'missed-dose',
        'low',
        `Missed dose reported: ${input.medicationName}`,
        detail,
      );
      return { detectedIssueId: issue.id };
    },

    async recordSideEffectConcern(input: SideEffectConcernInput) {
      // The link between symptom and medication is the PATIENT'S — record it
      // verbatim; never state the connection is real.
      const issue = addIssue(
        'side-effect',
        'moderate',
        `Patient-attributed side effect concern (${input.medicationName})`,
        input.patientWords,
      );
      return { detectedIssueId: issue.id };
    },

    async requestRefill(input: RefillRequestInput): Promise<RefillStatus> {
      const medication = findMedication(input.medicationName);
      if (!medication) {
        addIssue(
          'refill',
          'moderate',
          `Refill request for medication not on file: ${input.medicationName}`,
          input.medicationName,
        );
        return {
          medication: input.medicationName,
          refillsRemaining: 0,
          needsRenewal: true,
          speakable: `I don't see ${input.medicationName} on your discharge list — your care team will follow up on this before the visit.`,
        };
      }
      const remaining = medication.refillsRemaining ?? 0;
      const taskId = `demo-refill-${issues.length + 1}`;
      if (remaining <= 0) {
        addIssue(
          'refill',
          'moderate',
          `Renewal needed: ${medication.display}`,
          `Patient reports running out; zero refills remaining on file.`,
        );
        return {
          medication: medication.display,
          refillsRemaining: 0,
          needsRenewal: true,
          taskId,
          speakable: `Your ${medication.display} has no refills left, so I've asked your prescriber to send a renewal.`,
        };
      }
      addIssue(
        'refill',
        'low',
        `Refill requested: ${medication.display}`,
        `${remaining} refill${remaining === 1 ? '' : 's'} remaining; forwarded to pharmacy.`,
      );
      return {
        medication: medication.display,
        refillsRemaining: remaining,
        needsRenewal: false,
        taskId,
        speakable: `You have ${remaining} refill${remaining === 1 ? '' : 's'} left on ${medication.display}; I've sent the request to your pharmacy.`,
      };
    },

    async listIssues() {
      return [...issues];
    },

    async listCareTeamNotes() {
      return [...notes];
    },
  };
}
