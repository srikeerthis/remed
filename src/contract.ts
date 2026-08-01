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
}

export interface PatientReview {
  patientId: string;
  displayName: string;
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

export interface CoverageCheckRequest {
  patientId: string;
  memberId: string;
  tradingPartnerServiceId: string;
  medicationText: string;
}

export interface CoverageCheckResult {
  status: 'active' | 'inactive' | 'unknown';
  copayCents?: number;
  rawReference?: string;
}

export interface ClinicalApi {
  getPatientReview(patientId: string): Promise<PatientReview>;
  reconcileMedication(input: ReportedMedication): Promise<ReconciliationResult>;
  recordSymptom(input: SymptomReportInput): Promise<{ detectedIssueId: string }>;
  recordUrgentIssue(input: UrgentIssueInput): Promise<{ detectedIssueId: string }>;
  listIssues(patientId: string): Promise<ClinicalIssue[]>;
}

export interface InsuranceApi {
  checkCoverage(input: CoverageCheckRequest): Promise<CoverageCheckResult>;
}

export const stubClinical: ClinicalApi = {
  async getPatientReview(patientId) {
    console.log('[stubClinical] getPatientReview', { patientId });
    return { patientId, displayName: 'John Alvarez', medications: [] };
  },
  async reconcileMedication(input) {
    console.log('[stubClinical] reconcileMedication', input);
    return { kind: 'not-prescribed', reported: input, shouldCheckCoverage: input.stoppedReason === 'cost' };
  },
  async recordSymptom(input) {
    console.log('[stubClinical] recordSymptom', input);
    return { detectedIssueId: 'stub-symptom-issue' };
  },
  async recordUrgentIssue(input) {
    console.log('[stubClinical] recordUrgentIssue', input);
    return { detectedIssueId: 'stub-detected-issue' };
  },
  async listIssues(patientId) {
    console.log('[stubClinical] listIssues', { patientId });
    return [];
  },
};

export const stubInsurance: InsuranceApi = {
  async checkCoverage(input) {
    console.log('[stubInsurance] checkCoverage', input);
    return { status: 'unknown' };
  },
};
