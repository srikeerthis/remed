/**
 * The only seam shared by voice, clinical, and insurance.
 * Coordinate with the whole team before changing these signatures.
 */

export type DiscrepancyKind = 'match' | 'not-prescribed' | 'not-taking' | 'different-label';

/**
 * The insurance outcome to rehearse for a given medication. In real Stedi
 * mode this is ignored; in stub mode it selects which canned response the
 * agent gets so all six paths are demoable without payer traffic.
 */
export type CoverageScenario =
  | 'covered'
  | 'high-copay'
  | 'not-covered'
  | 'prior-auth-required'
  | 'deductible-not-met'
  | 'payer-error';

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
  /**
   * Why this was prescribed, read from MedicationRequest.reasonReference /
   * reasonCode. The agent may state this back as record ("your notes say this
   * was for the dental pain") but must never interpret it or say whether the
   * medication is working.
   */
  indication?: string;
  /** Condition.id this treats, so feedback can be tied to the right problem. */
  conditionId?: string;
  /** MedicationRequest.dispenseRequest.numberOfRepeatsAllowed. undefined = unknown. */
  refillsRemaining?: number;
  /** Which stub scenario this med rehearses. Ignored by real Stedi. */
  coverageScenario?: CoverageScenario;
}

export interface PatientCondition {
  id: string;
  display: string;
  /** active | recurrence | resolved … from Condition.clinicalStatus. */
  clinicalStatus?: string;
  /** When it started, if recorded. */
  onsetDate?: string;
}

/**
 * The visit this call is preparing for. It is what scopes the review: a dental
 * appointment should not turn into a diabetes medication audit.
 */
export interface PatientAppointment {
  id: string;
  /** ISO datetime the appointment starts. */
  start?: string;
  /** e.g. "Dentistry" — from Appointment.specialty. */
  specialty?: string;
  /** Free text reason, from Appointment.description or reasonCode. */
  reason?: string;
  /** Condition ids this visit is about, from Appointment.reasonReference. */
  conditionIds: string[];
}

export interface PatientReview {
  patientId: string;
  displayName: string;
  /** Exact policy member id used by voice for an insurance check. */
  memberId?: string;
  /** FHIR YYYY-MM-DD. Lets the agent answer identity questions from record. */
  dateOfBirth?: string;
  /** Active problems from the FHIR Condition list. */
  conditions?: PatientCondition[];
  /** The next upcoming appointment, which scopes what this call covers. */
  appointment?: PatientAppointment;
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

export interface CareTeamNoteInput {
  patientId: string;
  /** Short tag — "question for doctor", "pharmacy switch", "general concern". */
  topic: string;
  patientWords: string;
}

export interface MissedDoseInput {
  patientId: string;
  medicationName: string;
  /** Optional patient description of when: "last night", "this morning". */
  when?: string;
  patientWords: string;
}

export interface SideEffectConcernInput {
  patientId: string;
  medicationName: string;
  patientWords: string;
}

export interface RefillRequestInput {
  patientId: string;
  medicationName: string;
}

export interface ClinicalIssue {
  id: string;
  severity: 'high' | 'moderate' | 'low';
  category: 'medication' | 'symptom' | 'urgent' | 'side-effect' | 'missed-dose' | 'note' | 'refill';
  summary: string;
  patientWords: string;
  createdAt: string;
}

export interface CareTeamNote {
  id: string;
  topic: string;
  patientWords: string;
  createdAt: string;
}

export interface RefillStatus {
  medication: string;
  refillsRemaining: number;
  /** True when the prescription has zero refills and the prescriber must renew. */
  needsRenewal: boolean;
  /** FHIR Task.id created for pharmacy fill or prescriber renewal. */
  taskId?: string;
  /** Patient-facing sentence. Never invents a fill date the record does not have. */
  speakable: string;
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
  recordCareTeamNote(input: CareTeamNoteInput): Promise<{ noteId: string }>;
  recordMissedDose(input: MissedDoseInput): Promise<{ detectedIssueId: string }>;
  recordSideEffectConcern(input: SideEffectConcernInput): Promise<{ detectedIssueId: string }>;
  requestRefill(input: RefillRequestInput): Promise<RefillStatus>;
  listIssues(patientId: string): Promise<ClinicalIssue[]>;
  listCareTeamNotes(patientId: string): Promise<CareTeamNote[]>;
}

export interface CoverageCheckInput {
  medicationName: string;
  memberId: string;
  /** Which scenario the stub should return. Real Stedi ignores this. */
  scenario?: CoverageScenario;
}

export interface CoverageResult {
  covered: boolean;
  copay: string | null;
  coinsurance: string | null;
  deductibleRemaining: string | null;
  /** True when the payer requires prior authorization before dispensing. */
  priorAuthRequired?: boolean;
  /**
   * Coverage bucket, coarser than benefitsInformation codes. Voice + UI both
   * read this — do not add values without updating both.
   */
  formularyStatus?: 'covered' | 'non-formulary' | 'requires-prior-auth' | 'deductible-only' | 'unknown';
  /** Which canned scenario this response represents. Absent for live Stedi. */
  scenario?: CoverageScenario;
  /** Patient-facing text. Never contains an invented payer figure. */
  speakable: string;
  /** True for the recorded/local fallback; disclose this during the demo. */
  stubbed: boolean;
}

export interface InsuranceApi {
  checkCoverage(input: CoverageCheckInput): Promise<CoverageResult>;
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
  async recordCareTeamNote() {
    return { noteId: 'stub-care-team-note' };
  },
  async recordMissedDose() {
    return { detectedIssueId: 'stub-missed-dose-issue' };
  },
  async recordSideEffectConcern() {
    return { detectedIssueId: 'stub-side-effect-issue' };
  },
  async requestRefill(input) {
    return {
      medication: input.medicationName,
      refillsRemaining: 0,
      needsRenewal: true,
      speakable: `I've flagged a renewal for ${input.medicationName}; the care team will follow up.`,
    };
  },
  async listIssues() {
    return [];
  },
  async listCareTeamNotes() {
    return [];
  },
};

/**
 * Scenario-driven fake payer. Every canned response is honest about being
 * stubbed so the demo can walk through every path without a live 271.
 */
export const stubInsurance: InsuranceApi = {
  async checkCoverage({ medicationName, scenario = 'covered' }) {
    const drug = medicationName || 'that medication';
    switch (scenario) {
      case 'high-copay':
        return {
          covered: true,
          copay: '$340',
          coinsurance: null,
          deductibleRemaining: null,
          formularyStatus: 'covered',
          scenario,
          speakable: `${drug} is covered, but your copay comes back at $340 — I've flagged it for your care team to review before the visit.`,
          stubbed: true,
        };
      case 'not-covered':
        return {
          covered: false,
          copay: null,
          coinsurance: null,
          deductibleRemaining: null,
          formularyStatus: 'non-formulary',
          scenario,
          speakable: `${drug} isn't on your plan's formulary right now — your care team will review the price before your visit.`,
          stubbed: true,
        };
      case 'prior-auth-required':
        return {
          covered: true,
          copay: null,
          coinsurance: null,
          deductibleRemaining: null,
          priorAuthRequired: true,
          formularyStatus: 'requires-prior-auth',
          scenario,
          speakable: `${drug} needs a prior authorization from your plan; I've flagged it so your care team can start that paperwork.`,
          stubbed: true,
        };
      case 'deductible-not-met':
        return {
          covered: true,
          copay: null,
          coinsurance: '20%',
          deductibleRemaining: '$980',
          formularyStatus: 'deductible-only',
          scenario,
          speakable: `${drug} is covered, but you still have $980 left on your deductible so you'd pay the full price for now — your care team will confirm before the visit.`,
          stubbed: true,
        };
      case 'payer-error':
        return {
          covered: false,
          copay: null,
          coinsurance: null,
          deductibleRemaining: null,
          formularyStatus: 'unknown',
          scenario,
          speakable: `I couldn't reach your plan just now — your care team will check the price for ${drug} before your visit.`,
          stubbed: true,
        };
      case 'covered':
      default:
        return {
          covered: true,
          copay: '$10',
          coinsurance: null,
          deductibleRemaining: null,
          formularyStatus: 'covered',
          scenario: 'covered',
          speakable: `Good news — ${drug} is covered. Your copay would be ten dollars.`,
          stubbed: true,
        };
    }
  },
};
