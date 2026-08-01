import type { ClinicalApi, InsuranceApi } from '../contract.js';
import { bus } from '../bus.js';

// This text is deliberately fixed. Never replace it with model-generated output.
export const URGENT_ESCALATION_RESPONSE =
  "I'm stopping the medication review now. Please call 911 or go to the nearest emergency department now.";

export interface VoiceDependencies {
  clinical: ClinicalApi;
  insurance: InsuranceApi;
}

export function createVoiceAdapter(dependencies: VoiceDependencies): {
  ready: boolean;
  dependencies: VoiceDependencies;
} {
  const ready = Boolean(process.env.DEEPGRAM_API_KEY?.trim());
  bus.publish({ source: 'voice', type: 'voice.adapter.ready', data: { provider: 'deepgram', configured: ready } });
  return { ready, dependencies };
}
