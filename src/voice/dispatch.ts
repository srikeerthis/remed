import { ClinicalApi, InsuranceApi, ReportedMedication } from '../contract.js';
import { bus } from '../bus.js';
import { URGENT_ESCALATION_RESPONSE } from './index.js';

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
    case 'record_medication_report':
      result = await handleRecordReport(call.args, patientId, memberId, clinical, insurance);
      break;
    case 'record_symptom':
      result = await handleRecordSymptom(call.args, patientId, clinical);
      break;
    case 'check_insurance_coverage':
      result = await handleCheckCoverage(call.args, memberId, insurance);
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
    ? review.medications.map((m) => `${m.display} — ${m.instructions ?? m.status}`).join('; ')
    : 'no medications on file';
  return { output: `Patient: ${review.displayName}. Prescribed: ${list}` };
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

  if (result.shouldCheckCoverage) {
    const coverage = await insurance.checkCoverage(input.labelText, memberId);
    bus.publish({ source: 'voice', type: 'coverage.result', data: { medication: input.labelText, copay: coverage.copay, stubbed: coverage.stubbed } });
    if (coverage.covered && coverage.speakable) {
      return { output: `Discrepancy recorded. ${coverage.speakable}` };
    }
    return { output: 'Discrepancy recorded. Coverage could not be confirmed — flagged for clinician review.' };
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
  await clinical.recordSymptom({ patientId, patientWords: String(args.patient_words ?? '') });
  return { output: 'Symptom recorded verbatim. The care team will review it at the visit.' };
}

async function handleCheckCoverage(
  args: Record<string, unknown>,
  memberId: string,
  insurance: InsuranceApi,
): Promise<ToolResult> {
  const medicationName = String(args.medication_name ?? '');
  const coverage = await insurance.checkCoverage(medicationName, memberId);
  bus.publish({ source: 'voice', type: 'coverage.result', data: { medication: medicationName, copay: coverage.copay, stubbed: coverage.stubbed } });
  return { output: coverage.speakable };
}

async function handleEscalate(
  args: Record<string, unknown>,
  patientId: string,
  clinical: ClinicalApi,
): Promise<ToolResult> {
  const patientWords = String(args.trigger_phrase ?? '');
  bus.publish({ source: 'voice', type: 'escalation.triggered', data: { patientWords } });
  await clinical.recordUrgentIssue({ patientId, patientWords }).catch((err: unknown) => {
    bus.publish({ source: 'voice', type: 'escalation.record.failed', data: { error: String(err) } });
  });
  return { output: URGENT_ESCALATION_RESPONSE, shouldEndCall: true };
}
