/**
 * The only seam shared by voice, clinical, and insurance.
 * Coordinate with the whole team before changing these signatures.
 */

export type DiscrepancyKind = 'match' | 'not-prescribed' | 'not-taking' | 'different-label';

export interface PrescribedMedication {
  requestId: string;
  display: string;
  instructions?: string;
  status: string;
  /**
   * Spoken description of the pill, read from the Medplum record
   * (MedicationRequest.note). Never model-generated — a wrong description
   * could get a patient to confirm the wrong bottle. Absent = not on file.
   */
  appearance?: string;
  /** Plain words for when it is taken, e.g. "once a day in the morning". */
  schedule?: string;
  /** FHIR Timing.repeat.timeOfDay (HH:MM:SS), e.g. ["08:00:00"]. */
  dueTimes?: string[];
}

export interface PatientReview {
  patientId: string;
  displayName: string;
  /** Exact policy member id used by voice for an insurance check. */
  memberId?: string;
  /** FHIR YYYY-MM-DD. Lets the agent answer identity questions from record. */
  dateOfBirth?: string;
  medications: PrescribedMedication[];
}

export interface ReportedMedication {
  patientId: string;
  labelText: string;
  doseText?: string;
  patientWords: string;
  taking: boolean;
  stoppedReason?: string;
}

export interface SymptomReportInput {
  patientId: string;
  patientWords: string;
}

export interface ClinicalIssue {
  id: string;
  severity: 'high' | 'moderate' | 'low';
  category: 'medication' | 'symptom' | 'urgent';
  summary: string;
  patientWords: string;
  createdAt: string;
}

export interface ReconciliationResult {
  kind: DiscrepancyKind;
  reported: ReportedMedication;
  prescribed?: PrescribedMedication;
  shouldCheckCoverage: boolean;
  detectedIssueId?: string;
}

export interface UrgentIssueInput {
  patientId: string;
  patientWords: string;
}

export interface ClinicalApi {
  getPatientReview(patientId: string): Promise<PatientReview>;
  reconcileMedication(input: ReportedMedication): Promise<ReconciliationResult>;
  recordSymptom(input: SymptomReportInput): Promise<{ detectedIssueId: string }>;
  recordUrgentIssue(input: UrgentIssueInput): Promise<{ detectedIssueId: string }>;
  listIssues(patientId: string): Promise<ClinicalIssue[]>;
}

export interface CoverageResult {
  covered: boolean;
  copay: string | null;
  coinsurance: string | null;
  deductibleRemaining: string | null;
  /** Patient-facing text. Never contains an invented payer figure. */
  speakable: string;
  /** True for the recorded/local fallback; disclose this during the demo. */
  stubbed: boolean;
}

export interface InsuranceApi {
  checkCoverage(medicationName: string, memberId: string): Promise<CoverageResult>;
}

export const stubClinical: ClinicalApi = {
  async getPatientReview(patientId) {
    return { patientId, displayName: 'Synthetic demo patient', medications: [] };
  },
  async reconcileMedication(input) {
    return { kind: 'not-prescribed', reported: input, shouldCheckCoverage: input.stoppedReason === 'cost' };
  },
  async recordSymptom() {
    return { detectedIssueId: 'stub-symptom-issue' };
  },
  async recordUrgentIssue() {
    return { detectedIssueId: 'stub-detected-issue' };
  },
  async listIssues() {
    return [];
  },
};

export const stubInsurance: InsuranceApi = {
  async checkCoverage(medicationName) {
    return {
      covered: true,
      copay: '$10',
      coinsurance: null,
      deductibleRemaining: null,
      speakable: `Good news — ${medicationName} is covered. Your copay would be ten dollars.`,
      stubbed: true,
    };
  },
};
