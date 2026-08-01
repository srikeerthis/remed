import { ClinicalApi, InsuranceApi, ReportedMedication, CoverageCheckRequest } from "../contract";
import { bus } from "../bus";
import { ESCALATION_RESPONSE } from "./prompt";

// memberId and tradingPartnerServiceId for John Alvarez (demo patient MBR10001)
const MEMBER_ID = "MBR10001";
const TRADING_PARTNER_SERVICE_ID = "00001";

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
  insurance: InsuranceApi
): Promise<ToolResult> {
  console.log("[dispatch] tool_call", JSON.stringify(call));
  bus.publish({ type: "tool_call", tool: call.name, args: call.args });

  let result: ToolResult;

  switch (call.name) {
    case "get_prescribed_medications":
      result = await handleGetPatientReview(call.args, clinical);
      break;
    case "record_medication_report":
      result = await handleRecordReport(call.args, clinical, insurance);
      break;
    case "record_symptom":
      result = await handleRecordSymptom(call.args, clinical);
      break;
    case "check_insurance_coverage":
      result = await handleCheckCoverage(call.args, insurance);
      break;
    case "escalate_urgent":
      result = await handleEscalate(call.args, clinical);
      break;
    default:
      result = { output: `Unknown tool: ${call.name}` };
  }

  console.log("[dispatch] tool_result", JSON.stringify({ tool: call.name, result }));
  bus.publish({ type: "tool_result", tool: call.name, result });

  return result;
}

async function handleGetPatientReview(
  args: Record<string, unknown>,
  clinical: ClinicalApi
): Promise<ToolResult> {
  const patientId = String(args.patient_id ?? "");
  const review = await clinical.getPatientReview(patientId);
  const list = review.medications.length
    ? review.medications.map((m) => `${m.display} (${m.instructions ?? m.status})`).join("; ")
    : "no medications on file";
  return { output: `Patient: ${review.displayName}. Prescribed: ${list}` };
}

async function handleRecordReport(
  args: Record<string, unknown>,
  clinical: ClinicalApi,
  insurance: InsuranceApi
): Promise<ToolResult> {
  const patientId = String(args.patient_id ?? "");

  const input: ReportedMedication = {
    patientId,
    labelText: String(args.name ?? ""),
    doseText: args.dose_text ? String(args.dose_text) : undefined,
    patientWords: String(args.patient_words ?? ""),
    taking: Boolean(args.taking_as_prescribed),
    stoppedReason: args.stopped_reason ? String(args.stopped_reason) : undefined,
  };

  const result = await clinical.reconcileMedication(input);

  if (result.kind !== "match") {
    bus.publish({
      type: "discrepancy",
      medication: input.labelText,
      reason: input.stoppedReason ?? result.kind,
    });
  }

  // If stopped due to cost, auto-trigger coverage check immediately.
  if (result.shouldCheckCoverage) {
    const coverageReq: CoverageCheckRequest = {
      patientId,
      memberId: MEMBER_ID,
      tradingPartnerServiceId: TRADING_PARTNER_SERVICE_ID,
      medicationText: input.labelText,
    };
    const coverage = await insurance.checkCoverage(coverageReq);
    console.log("[dispatch] auto coverage result", JSON.stringify(coverage));

    bus.publish({
      type: "coverage_result",
      medication: input.labelText,
      copay: coverage.copayCents != null ? `$${(coverage.copayCents / 100).toFixed(2)}` : "unknown",
    });

    if (coverage.status === "active" && coverage.copayCents != null) {
      const copay = `$${(coverage.copayCents / 100).toFixed(2)}`;
      return {
        output: `Discrepancy recorded. Coverage check: ${input.labelText} is covered — your copay is ${copay}. Tell the patient their actual copay.`,
      };
    }

    return {
      output: `Discrepancy recorded. Coverage check came back as "${coverage.status}" for ${input.labelText}. Flag for clinician review.`,
    };
  }

  const summary =
    result.kind === "match"
      ? "No discrepancy — patient is taking as prescribed."
      : `Discrepancy recorded (${result.kind}): ${input.labelText}.`;

  return { output: summary };
}

async function handleRecordSymptom(
  args: Record<string, unknown>,
  clinical: ClinicalApi
): Promise<ToolResult> {
  const patientId = String(args.patient_id ?? "");
  const patientWords = String(args.patient_words ?? "");
  await clinical.recordSymptom({ patientId, patientWords });
  return { output: "Symptom recorded verbatim. The care team will review it at the visit." };
}

async function handleCheckCoverage(
  args: Record<string, unknown>,
  insurance: InsuranceApi
): Promise<ToolResult> {
  const patientId = String(args.patient_id ?? "");
  const medicationText = String(args.medication_name ?? "");

  const req: CoverageCheckRequest = {
    patientId,
    memberId: MEMBER_ID,
    tradingPartnerServiceId: TRADING_PARTNER_SERVICE_ID,
    medicationText,
  };

  const coverage = await insurance.checkCoverage(req);

  bus.publish({
    type: "coverage_result",
    medication: medicationText,
    copay: coverage.copayCents != null ? `$${(coverage.copayCents / 100).toFixed(2)}` : "unknown",
  });

  if (coverage.status === "active" && coverage.copayCents != null) {
    return { output: `${medicationText} is covered — your copay is $${(coverage.copayCents / 100).toFixed(2)}.` };
  }

  return { output: `Coverage status for ${medicationText}: ${coverage.status}. Flag for clinician.` };
}

async function handleEscalate(
  args: Record<string, unknown>,
  clinical: ClinicalApi
): Promise<ToolResult> {
  const patientWords = String(args.trigger_phrase ?? "");
  console.log("[dispatch] ESCALATION triggered by:", patientWords);

  // Record as urgent issue in the clinical system.
  const patientId = String(args.patient_id ?? "");
  if (patientId) {
    await clinical.recordUrgentIssue({ patientId, patientWords }).catch((err) => {
      console.error("[dispatch] failed to record urgent issue", err);
    });
  }

  bus.publish({ type: "escalation", trigger: patientWords });

  return {
    output: ESCALATION_RESPONSE,
    shouldEndCall: true,
  };
}
