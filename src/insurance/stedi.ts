// ===========================================================================
// STEDI — real-time eligibility check (X12 270/271), JSON flavour.
//
// PERSON C owns this file. Implements InsuranceApi from ../contract.ts.
//
// Endpoint:  POST https://healthcare.us.stedi.com
//                 /2024-04-01/change/medicalnetwork/eligibility/v3
// Auth:      Authorization: <STEDI_API_KEY>   (no Bearer prefix)
//
// Host, the /2024-04-01 date prefix, and the auth scheme are all CONFIRMED
// against the API reference (2026-08). The date prefix is easy to drop and
// gives a 404 that reads like a wrong host — don't.
//
// Never hand-parse X12. This endpoint returns JSON.
// ===========================================================================

import { config } from "../config.js";
import { stediHeaders } from "../auth.js";
import { resolveDemoIdentity } from "../demo-patients.js";
import type { CoverageCheckInput, CoverageResult, InsuranceApi } from "../contract.js";

export const ELIGIBILITY_PATH = "/2024-04-01/change/medicalnetwork/eligibility/v3";

/* ------------------------------------------------------------------ */
/* THE MOCK PATIENT — resolved, not hardcoded.                          */
/*                                                                      */
/* Today this is the synthetic John Alvarez (DEMO_PATIENTS[0]) and we    */
/* are pointed at the local mock server, because we have no Stedi test   */
/* key. Real Stedi rejects this identity.                                */
/*                                                                      */
/* To go live: set the five DEMO_PATIENT_* values in .env from an        */
/* approved portal patient and drop STEDI_BASE_URL. The Medplum seed     */
/* reads the SAME resolver, so it moves with us — there is nothing to    */
/* copy by hand and nothing that can silently disagree.                  */
/* ------------------------------------------------------------------ */

export const MOCK_PATIENT = resolveDemoIdentity();

// Your own NPI is not required to be real for mock requests, but the payer
// object IS required. Use whatever the mock request list shows.
// Mock requests accept ANY NPI that passes check-digit validation, so the
// provider is not part of the identity you have to match. Only the
// subscriber block and tradingPartnerServiceId must be copied exactly.
const PROVIDER = {
  organizationName: "Countback Health",
  npi: "1999999984",
} as const;

/* --------------------------- response types ------------------------ */
// Only the fields we actually read. The full response is much larger.

interface BenefitsInformation {
  code?: string;                    // "1" active, "A" coinsurance, "B" copay, "C" deductible
  name?: string;                    // e.g. "Active Coverage", "Co-Payment"
  benefitAmount?: string;           // decimal string, e.g. "10.00"
  benefitPercent?: string;          // decimal, e.g. "0.20" for 20%
  serviceTypeCodes?: string[];
  inPlanNetworkIndicatorCode?: string; // Y | N | U | W
  coverageLevelCode?: string;
  timeQualifierCode?: string;       // e.g. "29" remaining
  planCoverage?: string;
}

interface AaaError {
  code?: string;
  description?: string;
  followupAction?: string;
  possibleResolutions?: string;
}

interface EligibilityResponse {
  id?: string;                      // ec_<uuid> — deep links to the Stedi portal
  benefitsInformation?: BenefitsInformation[];
  errors?: AaaError[];
  meta?: { applicationMode?: string }; // "test" | "production"
  payer?: { name?: string };
}

/* ------------------------------ request ---------------------------- */

export function buildRequest(serviceTypeCode: string) {
  return {
    // Required. Identifies who is asking.
    provider: PROVIDER,

    // Required. The policyholder. Supplying memberId + dateOfBirth +
    // firstName + lastName together obliges the payer to respond if the
    // member is in their database — send all four.
    subscriber: {
      firstName: MOCK_PATIENT.firstName,
      lastName: MOCK_PATIENT.lastName,
      dateOfBirth: MOCK_PATIENT.dateOfBirth,
      memberId: MOCK_PATIENT.memberId,
    },

    // Required. The payer ID. Include any leading zeros — these are strings,
    // not integers ("00540", never 540).
    tradingPartnerServiceId: MOCK_PATIENT.tradingPartnerServiceId,

    encounter: {
      // ONE service type code per request. 30 = Health Benefit Plan Coverage.
      // The docs are explicit that medical MOCK requests support ONLY 30 —
      // 88 (pharmacy) will not come back with mock benefits. Keep 30 for the
      // demo; 88 is worth one try against a live payer, nothing more.
      serviceTypeCodes: [serviceTypeCode],
      // dateOfService deliberately OMITTED — for a check dated today, leaving
      // it out gives consistent behaviour across payers.
    },

    // Recommended on every request; lets Stedi correlate checks for one person.
    externalPatientId: MOCK_PATIENT.memberId,
  };
}

/* ------------------------------ parsing ---------------------------- */
// Read benefitsInformation by CODE, never by array position.
//   1 = Active Coverage
//   A = Co-Insurance   → benefitPercent  (benefitAmount is never sent)
//   B = Co-Payment     → benefitAmount
//   C = Deductible     → benefitAmount
//   G = Out of Pocket  → benefitAmount
// Prefer in-network entries (inPlanNetworkIndicatorCode === "Y").

function pick(items: BenefitsInformation[], code: string): BenefitsInformation | undefined {
  const matching = items.filter((b) => b.code === code);
  return matching.find((b) => b.inPlanNetworkIndicatorCode === "Y") ?? matching[0];
}

function money(v: string | undefined): string | null {
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? `$${n.toFixed(2).replace(/\.00$/, "")}` : null;
}

/* ---------------------------- speakable ---------------------------- */
// This string is read ALOUD to a patient. No JSON, no codes, no figure we
// did not actually receive.

function toSpeakable(
  drug: string,
  active: boolean,
  copay: string | null,
  deductible: string | null
): string {
  if (!active) {
    return `I'm not seeing active coverage for that on your plan right now — your care team will follow up on it.`;
  }
  if (!copay) {
    return `You're covered, but your plan didn't send back a price for ${drug}. Your care team will check it before your visit.`;
  }
  const base = `Good news — ${drug} is covered. Your copay would be ${copay}.`;
  return deductible ? `${base} You still have ${deductible} left on your deductible.` : base;
}

/* ------------------------------- api ------------------------------- */

export const insurance: InsuranceApi = {
  async checkCoverage({ medicationName, memberId }: CoverageCheckInput): Promise<CoverageResult> {
    if (memberId !== MOCK_PATIENT.memberId) {
      console.warn(
        `[stedi] memberId "${memberId}" does not match the mock patient. Test mode will reject this.`
      );
    }

    const body = buildRequest("30"); // health benefit plan coverage — the only STC mocks return
    const started = Date.now();

    let res: Response;
    try {
      res = await fetch(`${config.stedi.baseUrl}${ELIGIBILITY_PATH}`, {
        method: "POST",
        headers: stediHeaders(),
        body: JSON.stringify(body),
      });
    } catch (err) {
      console.error("[stedi] network error", err);
      return fallback(medicationName, "network");
    }

    const raw = await res.text();
    console.log(`[stedi] ${res.status} in ${Date.now() - started}ms`);

    if (!res.ok) {
      // Log the body ONCE on the first 401 — it tells you whether the auth
      // scheme wants a bare key or a Bearer prefix.
      console.error("[stedi] error body:", raw.slice(0, 800));
      return fallback(medicationName, `http_${res.status}`);
    }

    let data: EligibilityResponse;
    try {
      data = JSON.parse(raw) as EligibilityResponse;
    } catch {
      console.error("[stedi] unparseable response:", raw.slice(0, 400));
      return fallback(medicationName, "parse");
    }

    // Honesty is automatic, not remembered. Only a real Stedi response —
    // applicationMode "test" or "production" — counts as live. Our local
    // mock server answers "mock", so it flags itself as stubbed and the UI
    // and the demo script both tell the truth without anyone deciding to.
    const mode = data.meta?.applicationMode;
    const live = mode === "test" || mode === "production";

    // AAA errors are collected centrally in `errors`. Payer down (42),
    // subscriber not found (75), invalid member ID (72) all land here.
    if (data.errors?.length) {
      const e = data.errors[0];
      console.warn(`[stedi] AAA ${e?.code}: ${e?.description} → ${e?.followupAction}`);
      return {
        covered: false,
        copay: null,
        coinsurance: null,
        deductibleRemaining: null,
        speakable: `I couldn't reach your plan just now — your care team will check the price before your visit.`,
        stubbed: !live,
      };
    }

    const items = data.benefitsInformation ?? [];
    const active = items.some((b) => b.code === "1");
    const copay = money(pick(items, "B")?.benefitAmount);
    const deductible = money(pick(items, "C")?.benefitAmount);
    const coinsurancePct = pick(items, "A")?.benefitPercent;

    if (data.id) console.log(`[stedi] eligibility check ${data.id}`); // deep-links in the portal
    console.log(`[stedi] mode=${mode} payer=${data.payer?.name}`);

    return {
      covered: active,
      copay,
      coinsurance: coinsurancePct ? `${Math.round(Number(coinsurancePct) * 100)}%` : null,
      deductibleRemaining: deductible,
      speakable: toSpeakable(medicationName, active, copay, deductible),
      stubbed: !live,
    };
  },
};

/* ------------------------- recorded fallback ----------------------- */
// The 1pm go/no-go lands here. If a live 271 hasn't returned, we ship this
// and SAY SO on stage. stubbed: true is what makes that honest.

function fallback(drug: string, reason: string): CoverageResult {
  console.warn(`[stedi] falling back to recorded payload (${reason})`);
  return {
    covered: true,
    copay: "$10",
    coinsurance: null,
    deductibleRemaining: null,
    speakable: `Good news — ${drug} is covered as a preferred generic. Your copay would be ten dollars for a thirty-day supply.`,
    stubbed: true,
  };
}
