// ===========================================================================
// CONTRACT — THE SHARED SEAM. The only file all three of us touch.
//
// Need a signature changed? SAY SO IN CHAT FIRST. Editing this unilaterally
// breaks someone else's build silently.
//
//   ClinicalApi   implemented by B (src/clinical/)
//   InsuranceApi  implemented by C (src/insurance/)
//   both called by A (src/voice/)
//
// clinical/ and insurance/ never import each other. When reconciliation
// decides a coverage check is warranted it returns shouldCheckCoverage:true
// and VOICE makes the call. That keeps B and C independent all day.
//
// Both APIs are stubbed at the bottom. Work against the stubs from minute
// one; never block on someone else's half being real.
// ===========================================================================

/* ===================== INSURANCE — owned by C ====================== */

export interface CoverageResult {
  /** Payer returned an active-coverage benefit (X12 code 1). */
  covered: boolean;
  /** Formatted for speech, e.g. "$10". null = payer sent no copay. */
  copay: string | null;
  /** e.g. "20%". */
  coinsurance: string | null;
  /** Remaining deductible, formatted, e.g. "$250". */
  deductibleRemaining: string | null;
  /** Read ALOUD verbatim. Never contains codes, JSON, or invented figures. */
  speakable: string;
  /** true = recorded fallback, not a live 271. Must be disclosed on stage. */
  stubbed: boolean;
}

export interface InsuranceApi {
  /**
   * Live eligibility check, called mid-conversation when a patient says they
   * stopped a medication because of cost.
   * @param medicationName spoken drug name, used in `speakable`
   * @param memberId must match the Stedi mock patient in test mode
   */
  checkCoverage(medicationName: string, memberId: string): Promise<CoverageResult>;
}

/* ====================== CLINICAL — owned by B ======================= */
// DRAFT sketch so A and C can compile. B: reshape this and tell the team.

/** A medication as prescribed at discharge (from Medplum). */
export interface PrescribedMed {
  name: string;
  dose: string;
  /** FHIR MedicationRequest id, for writing DetectedIssue back. */
  id: string;
}

export type ReconcileStatus =
  | "match"          // patient read back what was prescribed
  | "dose_mismatch"  // right drug, wrong strength
  | "not_taking"     // prescribed but patient doesn't have it
  | "extra";         // patient has something not on the discharge list

export interface ReconcileResult {
  status: ReconcileStatus;
  /** Matched prescription, if any. */
  med: PrescribedMed | null;
  /**
   * True when the stop reason was cost. VOICE reacts to this by calling
   * InsuranceApi.checkCoverage — clinical/ never calls insurance/ itself.
   */
  shouldCheckCoverage: boolean;
  /** Under two sentences. Never assesses a symptom, never advises. */
  speakable: string;
}

export interface ClinicalApi {
  /** The discharge medication list the agent reads from. */
  getPrescribedMeds(patientId: string): Promise<PrescribedMed[]>;

  /** Diff one pill bottle the patient read aloud against what was prescribed. */
  reconcile(
    patientId: string,
    spokenMedication: string,
    reason?: string
  ): Promise<ReconcileResult>;

  /**
   * Record a symptom VERBATIM for a clinician. Never interpreted, never
   * linked to a drug out loud. Returns the DetectedIssue id.
   */
  recordSymptom(patientId: string, verbatim: string): Promise<string>;

  /** Write a flagged discrepancy for clinician review. */
  flagIssue(
    patientId: string,
    severity: "high" | "moderate" | "low",
    detail: string
  ): Promise<string>;
}

/* ============================== STUBS ============================== */
// Import these until the real half lands. Both are deliberately boring.

export const stubInsurance: InsuranceApi = {
  async checkCoverage(medicationName) {
    return {
      covered: true,
      copay: "$10",
      coinsurance: null,
      deductibleRemaining: null,
      speakable: `Good news — ${medicationName} is covered. Your copay would be ten dollars.`,
      stubbed: true,
    };
  },
};

export const stubClinical: ClinicalApi = {
  async getPrescribedMeds() {
    return [
      { id: "stub-1", name: "lisinopril", dose: "10 mg" },
      { id: "stub-2", name: "atorvastatin", dose: "20 mg" },
    ];
  },
  async reconcile(_patientId, spokenMedication, reason) {
    const cost = /cost|expensive|afford|price|copay/i.test(reason ?? "");
    return {
      status: cost ? "not_taking" : "match",
      med: { id: "stub-1", name: spokenMedication, dose: "10 mg" },
      shouldCheckCoverage: cost,
      speakable: cost
        ? `Let me check what that would actually cost you.`
        : `Got it, thank you.`,
    };
  },
  async recordSymptom() {
    return "stub-issue-symptom";
  },
  async flagIssue() {
    return "stub-issue-flag";
  },
};
