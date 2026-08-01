import type { PrescribedMedication, ReportedMedication } from '../contract.js';

export interface ReconciliationMatch {
  kind: 'match' | 'not-prescribed' | 'not-taking' | 'different-label';
  prescribed?: PrescribedMedication;
  shouldCheckCoverage: boolean;
}

/** Cost language, in a patient's words rather than a billing system's. */
const COST_WORDS = [
  'cost', 'costs', 'costly', 'expensive', 'afford', 'affordable', 'price', 'pricey',
  'pricy', 'copay', 'co pay', 'too much', 'out of pocket', 'money', 'cheaper',
  'insurance', 'not covered', 'coverage',
];

export function mentionsCost(text: string): boolean {
  const haystack = normalize(text);
  return COST_WORDS.some((word) => haystack.includes(word));
}

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9.]+/g, ' ').trim();
}

function dose(value: string): string | undefined {
  const match = normalize(value).match(/\b(\d+(?:\.\d+)?)\s*(mcg|mg|g|ml)\b/);
  return match ? `${match[1]}${match[2]}` : undefined;
}

function timesPerDay(value: string): number | undefined {
  const text = normalize(value);
  if (/\b(three times daily|three times a day|tid)\b/.test(text)) return 3;
  if (/\b(twice daily|twice a day|two times a day|bid)\b/.test(text)) return 2;
  if (/\b(once daily|once a day|one time a day|every day|daily)\b/.test(text)) return 1;
  return undefined;
}

function medicationMatches(display: string, label: string): boolean {
  const name = normalize(display).replace(/\b\d+(?:\.\d+)?\s*(mcg|mg|g|ml)\b/g, '').replace(/\b(tablet|capsule|oral)\b/g, '').trim();
  return name.length > 0 && normalize(label).includes(name);
}

export function reconcileAgainst(
  medications: PrescribedMedication[],
  input: ReportedMedication,
): ReconciliationMatch {
  const prescribed = medications.find((item) => medicationMatches(item.display, input.labelText));
  // Any mention of cost triggers a live eligibility check — not only when the
  // patient has already stopped. "I'm still taking it but it's expensive" is
  // exactly the moment a real copay is worth saying out loud.
  const shouldCheckCoverage = mentionsCost(`${input.stoppedReason ?? ''} ${input.patientWords}`);

  if (!prescribed) {
    return { kind: 'not-prescribed', shouldCheckCoverage };
  }
  if (!input.taking) {
    return { kind: 'not-taking', prescribed, shouldCheckCoverage };
  }

  const reportedLabel = `${input.labelText} ${input.doseText ?? ''}`;
  const prescribedDose = dose(`${prescribed.display} ${prescribed.instructions ?? ''}`);
  const reportedDose = dose(reportedLabel);
  const prescribedFrequency = timesPerDay(prescribed.instructions ?? '');
  const reportedFrequency = timesPerDay(reportedLabel);
  const doseDiffers = Boolean(prescribedDose && reportedDose && prescribedDose !== reportedDose);
  const frequencyDiffers = Boolean(
    prescribedFrequency && reportedFrequency && prescribedFrequency !== reportedFrequency,
  );

  return {
    kind: doseDiffers || frequencyDiffers ? 'different-label' : 'match',
    prescribed,
    // Still taking it and it matches, but they said it is expensive — that is
    // exactly when a real copay is worth saying out loud, so keep the flag.
    shouldCheckCoverage,
  };
}
