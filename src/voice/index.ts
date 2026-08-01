import type { ClinicalApi, InsuranceApi } from '../contract.js';

// This text is deliberately fixed. Never replace it with model-generated output.
export const URGENT_ESCALATION_RESPONSE =
  'I’m stopping the medication review now. Please call 911 or go to the nearest emergency department now.';

export interface VoiceDependencies {
  clinical: ClinicalApi;
  insurance: InsuranceApi;
}
export function createVoiceAdapter(_dependencies: VoiceDependencies): { ready: false } {
  // Person A owns the Deepgram implementation. The shared dependencies are wired now so
  // that implementation does not need to import clinical/ or insurance/ directly.
  return { ready: false };
}
