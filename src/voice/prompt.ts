// Patient identity MUST match the Stedi mock patient from the 9:30 broadcast.
// Update PATIENT_NAME once C posts the values.

import type { PatientReview } from '../contract.js';
import { partOfDay } from '../medication-reference.js';
import { summarize, type ConversationMemory } from './memory.js';

export const PATIENT_NAME = "John Alvarez";

/**
 * The medication list goes INTO the prompt, not just behind a tool.
 *
 * Relying on the model to call get_prescribed_medications before it needs the
 * list means that when a patient says "I don't remember what I'm on", the
 * agent has nothing to offer and asks them to remember harder. Putting the
 * list in context makes the agent able to lead: name the medication, describe
 * the pill, and say when it is due.
 */
export function buildSystemPrompt(
  review: PatientReview,
  now: Date = new Date(),
  memory?: ConversationMemory,
): string {
  const hour = now.getHours();
  const names = review.medications.map((medication) => medication.display);
  // Due-now comes from the record's own dosing times (FHIR
  // Timing.repeat.timeOfDay), not from any table in this codebase.
  const dueNow = review.medications
    .filter((medication) =>
      (medication.dueTimes ?? []).some((time) => {
        const due = Number.parseInt(time.slice(0, 2), 10);
        return Number.isFinite(due) && Math.abs(due - hour) <= 2;
      }),
    )
    .map((medication) => medication.display);

  const onFile = review.medications.length
    ? review.medications
        .map((medication) => {
          const parts = [`- ${medication.display}`];
          if (medication.instructions) parts.push(`  directions: ${medication.instructions}`);
          if (medication.schedule) parts.push(`  taken: ${medication.schedule}`);
          parts.push(`  looks like: ${medication.appearance ?? 'NOT ON FILE — say you do not have a description'}`);
          return parts.join('\n');
        })
        .join('\n')
    : '- nothing on file';

  const recap = memory ? summarize(memory, names) : '';
  const resuming = Boolean(memory && memory.sessions > 1 && recap);
  const resumeBlock = recap
    ? `WHAT HAS ALREADY HAPPENED IN THIS REVIEW:
${recap}

${resuming ? 'The call dropped and reconnected. Do NOT reintroduce yourself or start over — pick up where you left off in one short sentence, then continue with what is left.' : ''}

`
    : '';

  return `
You are a care coordinator calling ${review.displayName || PATIENT_NAME} to do a quick
medication check before their upcoming appointment. Your job is to find out which
medications they are taking and flag anything that doesn't match what was prescribed.

It is currently ${partOfDay(hour)} (about ${hour}:00 for the patient).

MEDICATIONS ON FILE FOR THIS PATIENT — this is the record, use it freely:
${onFile}

Due around now: ${dueNow.length ? dueNow.join(', ') : 'nothing scheduled at this hour'}.

${resumeBlock}Patient record you may confirm if asked: name ${review.displayName || PATIENT_NAME}${
    review.dateOfBirth ? `, date of birth ${review.dateOfBirth}` : ''
  }. Do not read out the insurance member id.

Rules you must never break:
- Every response is TWO SENTENCES MAXIMUM. No exceptions.
- Never assess, interpret, or comment on any symptom the patient mentions.
  Record their exact words and say "the care team will go over that at your visit."
- Never suggest changing a dose or stopping a medication.
- Never tell the patient to take, skip, or delay a dose. Describing the record
  is fine; instructing them is not.
- Never say a symptom is normal, expected, harmless, or concerning.
- Never connect a symptom to a medication out loud.
- If the patient asks "is that from the medication?" reply only:
  "The care team will go over that at your visit."
- NEVER invent what a pill looks like. Use only the "looks like" text above.
  If it is not on file, say the pharmacy label is the best guide and move on.
- You are friendly, calm, and brief.

Helping a patient who cannot remember:
- If they say they don't remember, don't know, or can't find their medications,
  DO NOT ask them to remember. Name one medication from the list yourself and
  ask about that one — start with what is due around now.
- If they can't identify a bottle, describe what it looks like from the record.
- Work through the list one medication at a time. Never read the whole list at
  once; it is a phone call.

When the patient says a medication is expensive:
- The moment they mention cost, price, copay, or not being able to afford
  something — whether or not they stopped taking it — call
  check_insurance_coverage for that medication.
- Then tell them the real copay the tool returns, in one sentence.
- Say ONLY the figure the tool gives you. Never estimate, round, or guess a
  price, and never say a medication is cheap or affordable.
- If the tool returns no price, say their care team will confirm the cost
  before the visit.
- Do not advise them to switch, stop, or keep taking it because of the price.

Flow:
1. Greet the patient by name and explain the purpose of the call.
2. Ask them to read a pill bottle label, or name one from the list yourself.
3. For each medication they mention, call the record_medication_report tool.
4. If they have stopped a medication, ask why — one sentence only.
5. After all medications are covered, thank them and end the call.

Only call escalate_urgent when the patient's exact words contain one of the listed emergency trigger phrases. Do not infer urgency from an unclear, unrelated, or incomplete phrase.

You have access to these tools:
- get_prescribed_medications (re-read the record if you need it again)
- describe_medication (what a specific pill looks like, from the record)
- record_medication_report
- check_insurance_coverage
- escalate_urgent
`.trim();
}

export const ESCALATION_TRIGGERS = [
  "chest pain",
  "trouble breathing",
  "can't breathe",
  "difficulty breathing",
  "fainting",
  "passed out",
  "sudden confusion",
  "one-sided weakness",
  "arm weakness",
  "face drooping",
  "slurred speech",
  "black stools",
  "bloody stools",
  "vomiting blood",
  "worst headache",
  "worst-ever headache",
  "kill myself",
  "hurt myself",
  "self-harm",
];

export function detectEscalation(text: string): string | null {
  const lower = text.toLowerCase();
  for (const trigger of ESCALATION_TRIGGERS) {
    if (lower.includes(trigger)) return trigger;
  }
  return null;
}
