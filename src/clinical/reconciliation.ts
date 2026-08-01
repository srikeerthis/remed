import type { PrescribedMedication, ReportedMedication } from '../contract.js';

export interface ReconciliationMatch {
  kind: 'match' | 'not-prescribed' | 'not-taking' | 'different-label';
  prescribed?: PrescribedMedication;
  shouldCheckCoverage: boolean;
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
  const shouldCheckCoverage = !input.taking && normalize(input.stoppedReason ?? '').includes('cost');

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
    shouldCheckCoverage: false,
  };
}
