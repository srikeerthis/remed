import type {
  ClinicalApi,
  ClinicalIssue,
  PatientReview,
  PrescribedMedication,
  ReportedMedication,
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

const medications: PrescribedMedication[] = [
  { requestId: 'demo-metformin', display: 'Metformin', instructions: 'Take 500 mg twice daily', status: 'active' },
  { requestId: 'demo-lisinopril', display: 'Lisinopril', instructions: 'Take 10 mg once daily', status: 'active' },
  { requestId: 'demo-atorvastatin', display: 'Atorvastatin', instructions: 'Take 40 mg once daily', status: 'active' },
].map(withReference);

export function createDemoClinicalApi(): ClinicalApi {
  const issues: ClinicalIssue[] = [];

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
    async getPatientReview(patientId): Promise<PatientReview> {
      return {
        patientId,
        displayName: 'John Alvarez (Synthetic)',
        memberId: 'MBR10001',
        dateOfBirth: '1968-03-14',
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

    async listIssues() {
      return [...issues];
    },
  };
}
