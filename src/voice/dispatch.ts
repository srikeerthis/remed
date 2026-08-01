import { ClinicalApi, InsuranceApi, PrescribedMedication, ReportedMedication } from '../contract.js';
import { bus } from '../bus.js';
import { URGENT_ESCALATION_RESPONSE } from './index.js';
import { detectEscalation } from './prompt.js';
import { recordCovered, recordCoverage, recordEscalation, recordSymptom as rememberSymptom } from './memory.js';

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  output: string;
  shouldEndCall?: boolean;
}

export async function dispatch(
  call: ToolCall,
  clinical: ClinicalApi,
  insurance: InsuranceApi,
  patientId: string,
  memberId: string,
): Promise<ToolResult> {
  bus.publish({ source: 'voice', type: 'tool.call', data: { tool: call.name, args: call.args } });

  let result: ToolResult;

  switch (call.name) {
    case 'get_prescribed_medications':
      result = await handleGetPatientReview(patientId, clinical);
      break;
    case 'describe_medication':
      result = await handleDescribeMedication(call.args, patientId, clinical);
      break;
    case 'record_medication_report':
      result = await handleRecordReport(call.args, patientId, memberId, clinical, insurance);
      break;
    case 'record_symptom':
      result = await handleRecordSymptom(call.args, patientId, clinical);
      break;
    case 'record_treatment_feedback':
      result = await handleTreatmentFeedback(call.args, patientId, clinical);
      break;
    case 'record_missed_dose':
      result = await handleMissedDose(call.args, patientId, clinical);
      break;
    case 'record_side_effect_concern':
      result = await handleSideEffectConcern(call.args, patientId, clinical);
      break;
    case 'note_for_care_team':
      result = await handleCareTeamNote(call.args, patientId, clinical);
      break;
    case 'request_refill':
      result = await handleRefill(call.args, patientId, clinical);
      break;
    case 'check_insurance_coverage':
      result = await handleCheckCoverage(call.args, patientId, memberId, clinical, insurance);
      break;
    case 'escalate_urgent':
      result = await handleEscalate(call.args, patientId, clinical);
      break;
    default:
      result = { output: `Unknown tool: ${call.name}` };
  }

  bus.publish({ source: 'voice', type: 'tool.result', data: { tool: call.name, output: result.output } });
  return result;
}

async function handleGetPatientReview(patientId: string, clinical: ClinicalApi): Promise<ToolResult> {
  const review = await clinical.getPatientReview(patientId);
  const list = review.medications.length
    ? review.medications
        .map((m) => {
          const bits = [`${m.display} — ${m.instructions ?? m.status}`];
          if (m.schedule) bits.push(`taken ${m.schedule}`);
          if (m.appearance) bits.push(`looks like ${m.appearance}`);
          return bits.join(', ');
        })
        .join('; ')
    : 'no medications on file';
  return { output: `Patient: ${review.displayName}. Prescribed: ${list}` };
}

async function handleDescribeMedication(
  args: Record<string, unknown>,
  patientId: string,
  clinical: ClinicalApi,
): Promise<ToolResult> {
  const asked = String(args.medication_name ?? '').toLowerCase();
  const review = await clinical.getPatientReview(patientId);
  const match = review.medications.find((medication) =>
    asked.includes(medication.display.toLowerCase()) || medication.display.toLowerCase().includes(asked),
  );

  if (!match) {
    const names = review.medications.map((medication) => medication.display).join(', ');
    return { output: `"${args.medication_name}" is not on this patient's discharge list. On file: ${names || 'nothing'}.` };
  }
  if (!match.appearance) {
    const why = match.indication ? ` The record says it was prescribed for ${match.indication}.` : '';
    return { output: `No pill description is on file for ${match.display}.${why} Tell the patient the pharmacy label is the best guide; do not describe it yourself.` };
  }
  const timing = match.schedule ? ` It is taken ${match.schedule}.` : '';
  const why = match.indication
    ? ` The record says it was prescribed for ${match.indication}.`
    : ' No reason is recorded for it — say the care team will confirm why.';
  return { output: `${match.display} is ${match.appearance}.${timing}${why}` };
}

function findPrescribed(medications: PrescribedMedication[], name: string): PrescribedMedication | undefined {
  const needle = name.toLowerCase();
  return medications.find((m) => needle.includes(m.display.toLowerCase()) || m.display.toLowerCase().includes(needle));
}

async function handleRecordReport(
  args: Record<string, unknown>,
  patientId: string,
  memberId: string,
  clinical: ClinicalApi,
  insurance: InsuranceApi,
): Promise<ToolResult> {
  const input: ReportedMedication = {
    patientId,
    labelText: String(args.name ?? ''),
    ...(args.dose_text ? { doseText: String(args.dose_text) } : {}),
    patientWords: String(args.patient_words ?? ''),
    taking: Boolean(args.taking_as_prescribed),
    ...(args.stopped_reason ? { stoppedReason: String(args.stopped_reason) } : {}),
  };

  const result = await clinical.reconcileMedication(input);
  bus.publish({ source: 'voice', type: 'reconciliation.result', data: { kind: result.kind, medication: input.labelText } });
  recordCovered(patientId, { reported: input.labelText, kind: result.kind, patientWords: input.patientWords });

  if (result.shouldCheckCoverage) {
    const scenario = result.prescribed?.coverageScenario;
    const coverage = await insurance.checkCoverage({
      medicationName: input.labelText,
      memberId,
      ...(scenario ? { scenario } : {}),
    });
    bus.publish({
      source: 'voice',
      type: 'coverage.result',
      data: {
        medication: input.labelText,
        copay: coverage.copay,
        deductibleRemaining: coverage.deductibleRemaining,
        priorAuthRequired: coverage.priorAuthRequired,
        formularyStatus: coverage.formularyStatus,
        scenario: coverage.scenario,
        stubbed: coverage.stubbed,
      },
    });
    recordCoverage(patientId, { medication: input.labelText, copay: coverage.copay, stubbed: coverage.stubbed });
    const prefix = result.kind === 'match' ? '' : 'Discrepancy recorded. ';
    return { output: `${prefix}${coverage.speakable}` };
  }

  return {
    output: result.kind === 'match'
      ? 'No discrepancy — patient is taking as prescribed.'
      : `Discrepancy recorded (${result.kind}): ${input.labelText}.`,
  };
}

async function handleRecordSymptom(
  args: Record<string, unknown>,
  patientId: string,
  clinical: ClinicalApi,
): Promise<ToolResult> {
  const words = String(args.patient_words ?? '');
  await clinical.recordSymptom({ patientId, patientWords: words });
  rememberSymptom(patientId, words);
  return { output: 'Symptom recorded verbatim. Acknowledge briefly and say the care team will go over it at the visit — do not comment on whether it is normal, expected, or concerning.' };
}

async function handleTreatmentFeedback(
  args: Record<string, unknown>,
  patientId: string,
  clinical: ClinicalApi,
): Promise<ToolResult> {
  const condition = String(args.condition ?? 'unspecified problem');
  const medication = args.medication_name ? String(args.medication_name) : '';
  const words = String(args.patient_words ?? '');
  const context = medication ? `${condition}; on ${medication}` : condition;

  await clinical.recordSymptom({ patientId, patientWords: `[Treatment response — ${context}] ${words}` });
  rememberSymptom(patientId, `${context}: ${words}`);
  bus.publish({ source: 'voice', type: 'treatment.feedback', data: { condition, medication, patientWords: words } });

  return {
    output:
      'Recorded verbatim for the care team. Acknowledge briefly and move on — do not say whether it sounds better or worse, and do not comment on whether the medication is working.',
  };
}

async function handleMissedDose(
  args: Record<string, unknown>,
  patientId: string,
  clinical: ClinicalApi,
): Promise<ToolResult> {
  const medicationName = String(args.medication_name ?? '');
  const patientWords = String(args.patient_words ?? '');
  const when = args.when ? String(args.when) : undefined;
  await clinical.recordMissedDose({
    patientId,
    medicationName,
    patientWords,
    ...(when ? { when } : {}),
  });
  bus.publish({ source: 'voice', type: 'missed-dose.recorded', data: { medication: medicationName, when, patientWords } });
  return {
    output:
      'Missed dose recorded. Do NOT tell the patient to double up, catch up, or skip the next dose — say the care team will follow up if needed.',
  };
}

async function handleSideEffectConcern(
  args: Record<string, unknown>,
  patientId: string,
  clinical: ClinicalApi,
): Promise<ToolResult> {
  const medicationName = String(args.medication_name ?? '');
  const patientWords = String(args.patient_words ?? '');
  await clinical.recordSideEffectConcern({ patientId, medicationName, patientWords });
  bus.publish({ source: 'voice', type: 'side-effect.recorded', data: { medication: medicationName, patientWords } });
  return {
    output:
      'Side effect concern recorded verbatim. Do NOT confirm or deny the link to the medication. Reply only: "The care team will go over that at your visit."',
  };
}

async function handleCareTeamNote(
  args: Record<string, unknown>,
  patientId: string,
  clinical: ClinicalApi,
): Promise<ToolResult> {
  const topic = String(args.topic ?? 'general note');
  const patientWords = String(args.patient_words ?? '');
  const result = await clinical.recordCareTeamNote({ patientId, topic, patientWords });
  bus.publish({ source: 'voice', type: 'care-team-note.recorded', data: { topic, patientWords, noteId: result.noteId } });
  return { output: `Note saved for the care team (${topic}). Acknowledge briefly and move on.` };
}

async function handleRefill(
  args: Record<string, unknown>,
  patientId: string,
  clinical: ClinicalApi,
): Promise<ToolResult> {
  const medicationName = String(args.medication_name ?? '');
  const status = await clinical.requestRefill({ patientId, medicationName });
  bus.publish({
    source: 'voice',
    type: 'refill.requested',
    data: {
      medication: status.medication,
      refillsRemaining: status.refillsRemaining,
      needsRenewal: status.needsRenewal,
      taskId: status.taskId,
    },
  });
  return { output: status.speakable };
}

async function handleCheckCoverage(
  args: Record<string, unknown>,
  patientId: string,
  memberId: string,
  clinical: ClinicalApi,
  insurance: InsuranceApi,
): Promise<ToolResult> {
  const medicationName = String(args.medication_name ?? '');
  const review = await clinical.getPatientReview(patientId);
  const prescribed = findPrescribed(review.medications, medicationName);
  const scenario = prescribed?.coverageScenario;
  const coverage = await insurance.checkCoverage({
    medicationName,
    memberId,
    ...(scenario ? { scenario } : {}),
  });
  bus.publish({
    source: 'voice',
    type: 'coverage.result',
    data: {
      medication: medicationName,
      copay: coverage.copay,
      deductibleRemaining: coverage.deductibleRemaining,
      priorAuthRequired: coverage.priorAuthRequired,
      formularyStatus: coverage.formularyStatus,
      scenario: coverage.scenario,
      stubbed: coverage.stubbed,
    },
  });
  recordCoverage(patientId, { medication: medicationName, copay: coverage.copay, stubbed: coverage.stubbed });
  return { output: coverage.speakable };
}

async function handleEscalate(
  args: Record<string, unknown>,
  patientId: string,
  clinical: ClinicalApi,
): Promise<ToolResult> {
  const patientWords = String(args.trigger_phrase ?? '');
  const trigger = detectEscalation(patientWords);
  if (!trigger) {
    bus.publish({ source: 'voice', type: 'escalation.rejected', data: { patientWords, reason: 'No hardcoded urgent trigger matched' } });
    return { output: 'Please continue the medication review.', shouldEndCall: false };
  }
  bus.publish({ source: 'voice', type: 'escalation.triggered', data: { patientWords } });
  recordEscalation(patientId);
  await clinical.recordUrgentIssue({ patientId, patientWords }).catch((err: unknown) => {
    bus.publish({ source: 'voice', type: 'escalation.record.failed', data: { error: String(err) } });
  });
  return { output: URGENT_ESCALATION_RESPONSE, shouldEndCall: true };
}
