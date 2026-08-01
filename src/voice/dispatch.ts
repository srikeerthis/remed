import { ClinicalApi, InsuranceApi, ReportedMedication } from '../contract.js';
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
    case 'check_insurance_coverage':
      result = await handleCheckCoverage(call.args, patientId, memberId, insurance);
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

/**
 * Appearance comes from the record only. If it is not on file we say so
 * rather than let the model fill the gap — a confidently wrong description
 * could get a patient to confirm the wrong bottle.
 */
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
    return { output: `No pill description is on file for ${match.display}. Tell the patient the pharmacy label is the best guide; do not describe it yourself.` };
  }
  const timing = match.schedule ? ` It is taken ${match.schedule}.` : '';
  return { output: `${match.display} is ${match.appearance}.${timing}` };
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
    const coverage = await insurance.checkCoverage(input.labelText, memberId);
    bus.publish({ source: 'voice', type: 'coverage.result', data: { medication: input.labelText, copay: coverage.copay, stubbed: coverage.stubbed } });
    recordCoverage(patientId, { medication: input.labelText, copay: coverage.copay, stubbed: coverage.stubbed });
    // A cost question on a medication they are still taking correctly is not
    // a discrepancy. Saying so anyway would put a false flag in the agent's
    // mouth on a live call.
    const prefix = result.kind === 'match' ? '' : 'Discrepancy recorded. ';
    if (coverage.covered && coverage.speakable) {
      return { output: `${prefix}${coverage.speakable}` };
    }
    return { output: `${prefix}Coverage could not be confirmed — flagged for clinician review.` };
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
  return { output: 'Symptom recorded verbatim. The care team will review it at the visit.' };
}

async function handleCheckCoverage(
  args: Record<string, unknown>,
  patientId: string,
  memberId: string,
  insurance: InsuranceApi,
): Promise<ToolResult> {
  const medicationName = String(args.medication_name ?? '');
  const coverage = await insurance.checkCoverage(medicationName, memberId);
  bus.publish({ source: 'voice', type: 'coverage.result', data: { medication: medicationName, copay: coverage.copay, stubbed: coverage.stubbed } });
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
