// Tool definitions sent to the Deepgram Voice Agent.
// Shapes here must stay in sync with dispatch.ts handler names.

export const TOOLS = [
  {
    name: "get_prescribed_medications",
    description:
      "Re-read the medications prescribed to this patient at discharge, including what each pill looks like and when it is taken. The list is already in your instructions; call this only if you need to confirm it again.",
    parameters: {
      type: "object",
      properties: {
        patient_id: { type: "string", description: "The patient's identifier in the FHIR system." },
      },
      required: ["patient_id"],
    },
  },
  {
    name: "describe_medication",
    description:
      "Look up what a specific prescribed pill looks like AND why it was prescribed, from the patient's record. Call this when the patient cannot identify a bottle, asks what a medication looks like, or asks why they are taking it. Never describe a pill or invent a reason from your own knowledge — only report what this tool returns.",
    parameters: {
      type: "object",
      properties: {
        patient_id: { type: "string", description: "The patient's identifier." },
        medication_name: { type: "string", description: "The medication the patient is asking about." },
      },
      required: ["patient_id", "medication_name"],
    },
  },
  {
    name: "record_medication_report",
    description:
      "Record what the patient says about one medication — whether they are taking it as prescribed and why not if stopped. Call once per medication mentioned.",
    parameters: {
      type: "object",
      properties: {
        patient_id: { type: "string", description: "The patient's identifier." },
        name: { type: "string", description: "Medication name exactly as the patient read from the bottle." },
        taking_as_prescribed: { type: "boolean", description: "True if the patient says they are taking it as directed." },
        stopped_reason: {
          type: "string",
          description: "If not taking as prescribed, the reason the patient gave — in their own words.",
        },
        patient_words: { type: "string", description: "Verbatim quote of what the patient said about this medication." },
      },
      required: ["patient_id", "name", "taking_as_prescribed", "patient_words"],
    },
  },
  {
    name: "record_missed_dose",
    description:
      "Record when the patient says they missed or skipped a specific dose recently (a one-off, not stopping the medication). Examples: 'I forgot last night', 'I skipped this morning'. Do NOT tell the patient to double up or catch up — just record it and move on.",
    parameters: {
      type: "object",
      properties: {
        patient_id: { type: "string", description: "The patient's identifier." },
        medication_name: { type: "string", description: "The medication the dose was missed for." },
        when: { type: "string", description: "When the dose was missed, in the patient's words (e.g. 'last night')." },
        patient_words: { type: "string", description: "Verbatim quote from the patient." },
      },
      required: ["patient_id", "medication_name", "patient_words"],
    },
  },
  {
    name: "record_side_effect_concern",
    description:
      "Record verbatim when the patient thinks a symptom is caused by a medication. Never confirm or deny the link — the care team decides. Never say the symptom is normal, expected, harmless, or concerning. Reply only that the care team will go over it at the visit.",
    parameters: {
      type: "object",
      properties: {
        patient_id: { type: "string", description: "The patient's identifier." },
        medication_name: { type: "string", description: "The medication the patient attributes the symptom to." },
        patient_words: { type: "string", description: "Exact quote of what the patient said. Do not paraphrase." },
      },
      required: ["patient_id", "medication_name", "patient_words"],
    },
  },
  {
    name: "record_symptom",
    description:
      "Record verbatim any symptom the patient mentions that is NOT life-threatening and NOT attributed by the patient to a specific medication. Never assess it. Always acknowledge briefly and say the care team will go over it at the visit.",
    parameters: {
      type: "object",
      properties: {
        patient_id: { type: "string", description: "The patient's identifier." },
        patient_words: { type: "string", description: "Exact quote of what the patient said. Do not paraphrase." },
      },
      required: ["patient_id", "patient_words"],
    },
  },
  {
    name: "record_treatment_feedback",
    description:
      "Record, verbatim, how the patient says a problem is doing since discharge — for example whether the dental pain has improved. Call this after asking one open question about the problem the medication was prescribed for. Never assess, interpret, or comment on what they say.",
    parameters: {
      type: "object",
      properties: {
        patient_id: { type: "string", description: "The patient's identifier." },
        condition: { type: "string", description: "The problem being asked about, as written in the record." },
        medication_name: { type: "string", description: "The medication prescribed for that problem, if relevant." },
        patient_words: { type: "string", description: "Exact quote of what the patient said. Do not paraphrase." },
      },
      required: ["patient_id", "condition", "patient_words"],
    },
  },
  {
    name: "note_for_care_team",
    description:
      "Record any non-clinical item the patient wants the care team to know: a question they want asked at the visit, a pharmacy switch, a scheduling concern, or anything that isn't a symptom or dose. Do NOT use this for symptoms — those go through record_symptom or record_side_effect_concern.",
    parameters: {
      type: "object",
      properties: {
        patient_id: { type: "string", description: "The patient's identifier." },
        topic: { type: "string", description: "Short tag: 'question for doctor', 'pharmacy switch', 'scheduling', 'general concern'." },
        patient_words: { type: "string", description: "Verbatim quote from the patient." },
      },
      required: ["patient_id", "topic", "patient_words"],
    },
  },
  {
    name: "request_refill",
    description:
      "Send a refill request when the patient says they are running out, need a refill, or are almost out of a specific medication. The tool tells you how many refills remain and whether the prescriber must renew. Read the tool's speakable back to the patient — do not invent a fill date, pharmacy, or delivery time.",
    parameters: {
      type: "object",
      properties: {
        patient_id: { type: "string", description: "The patient's identifier." },
        medication_name: { type: "string", description: "The medication the patient needs refilled." },
      },
      required: ["patient_id", "medication_name"],
    },
  },
  {
    name: "check_insurance_coverage",
    description:
      "Check real-time insurance eligibility for a specific medication. Call this whenever the patient mentions cost, price, copay, or affordability for a medication — whether or not they have stopped taking it.",
    parameters: {
      type: "object",
      properties: {
        patient_id: { type: "string", description: "The patient's identifier." },
        medication_name: { type: "string", description: "The medication to check coverage for." },
      },
      required: ["patient_id", "medication_name"],
    },
  },
  {
    name: "escalate_urgent",
    description:
      "Immediately escalate when the patient mentions a life-threatening symptom or emergency. This stops the medication review.",
    parameters: {
      type: "object",
      properties: {
        trigger_phrase: { type: "string", description: "The exact phrase the patient said that triggered escalation." },
      },
      required: ["trigger_phrase"],
    },
  },
];
