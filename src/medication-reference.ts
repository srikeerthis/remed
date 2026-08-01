/**
 * SEED AUTHORING DATA ONLY — read by scripts/seed.ts, never at runtime.
 *
 * The running agent reads appearance and timing from Medplum, because Medplum
 * is the system of record. This table exists purely so the seed has something
 * to write. Nothing in src/voice/ or src/clinical/index.ts imports it.
 *
 * WHY THIS IS DATA AND NOT A PROMPT: the agent is talking to a patient holding
 * a bottle they cannot identify. A wrong description could get them to confirm
 * the wrong pill, which is worse than saying nothing. So appearance is stored
 * and retrieved, never generated.
 *
 * These are SYNTHETIC demo values for a synthetic patient. Real pill
 * appearance varies by manufacturer and by fill — this is not a substitute for
 * the imprint directory a pharmacist would use.
 */

export interface MedicationReference {
  /** Spoken description of the pill itself. */
  appearance: string;
  /** Plain words for when it is taken, used for time-of-day prompting. */
  schedule: string;
  /** FHIR Timing.repeat.timeOfDay. The `time` type requires HH:MM:SS. */
  timeOfDay: string[];
  /** What the label on the bottle reads, to help the patient find it. */
  labelHint: string;
}

const REFERENCE: Record<string, MedicationReference> = {
  metformin: {
    appearance: 'a white oval tablet, a bit bigger than the others',
    schedule: 'twice a day, morning and evening',
    timeOfDay: ['08:00:00', '19:00:00'],
    labelHint: 'the label reads Metformin 500 mg',
  },
  lisinopril: {
    appearance: 'a small round pink tablet',
    schedule: 'once a day in the morning',
    timeOfDay: ['08:00:00'],
    labelHint: 'the label reads Lisinopril 10 mg',
  },
  atorvastatin: {
    appearance: 'a white oval tablet with rounded ends',
    schedule: 'once a day in the evening',
    timeOfDay: ['21:00:00'],
    labelHint: 'the label reads Atorvastatin 40 mg',
  },
};

/** Matches "Metformin", "metformin 500 mg", "Take Metformin 500mg twice daily". */
export function lookupMedication(name: string): MedicationReference | undefined {
  const haystack = name.toLowerCase();
  const key = Object.keys(REFERENCE).find((candidate) => haystack.includes(candidate));
  return key ? REFERENCE[key] : undefined;
}

/** "morning" | "afternoon" | "evening" — used to open the call naturally. */
export function partOfDay(hour: number): string {
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}
