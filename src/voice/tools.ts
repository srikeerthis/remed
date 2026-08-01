// Tool definitions sent to the Deepgram Voice Agent.
// Shapes here must stay in sync with dispatch.ts handler names.

export const TOOLS = [
  {
    name: "get_prescribed_medications",
    description:
      "Fetch the list of medications prescribed to this patient at discharge. Call this at the start of the conversation before asking the patient about their bottles.",
    parameters: {
      type: "object",
      properties: {
        patient_id: {
          type: "string",
          description: "The patient's identifier in the FHIR system.",
        },
      },
      required: ["patient_id"],
    },
  },
  {
    name: "record_medication_report",
    description:
      "Record what the patient says about one medication — whether they are taking it as prescribed and why not if stopped. Call once per medication mentioned.",
    parameters: {
      type: "object",
      properties: {
        patient_id: {
          type: "string",
          description: "The patient's identifier.",
        },
        name: {
          type: "string",
          description: "Medication name exactly as the patient read from the bottle.",
        },
        taking_as_prescribed: {
          type: "boolean",
          description: "True if the patient says they are taking it as directed.",
        },
        stopped_reason: {
          type: "string",
          description:
            "If not taking as prescribed, the reason the patient gave — in their own words.",
        },
        patient_words: {
          type: "string",
          description: "Verbatim quote of what the patient said about this medication.",
        },
      },
      required: ["patient_id", "name", "taking_as_prescribed", "patient_words"],
    },
  },
  {
    name: "check_insurance_coverage",
    description:
      "Check real-time insurance eligibility for a specific medication. Only call this when the clinical reconciliation result indicates shouldCheckCoverage is true (i.e. the patient stopped due to cost).",
    parameters: {
      type: "object",
      properties: {
        patient_id: {
          type: "string",
          description: "The patient's identifier.",
        },
        medication_name: {
          type: "string",
          description: "The medication to check coverage for.",
        },
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
        trigger_phrase: {
          type: "string",
          description: "The exact phrase the patient said that triggered escalation.",
        },
      },
      required: ["trigger_phrase"],
    },
  },
];
