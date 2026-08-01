// ===========================================================================
// DEMO PATIENTS — synthetic roster for local work.
//
// ⚠️  THESE ARE INVENTED AND WILL FAIL A LIVE STEDI CHECK. ⚠️
//
// Stedi test mode only answers for identities on its approved mock request
// list; anything else returns AAA 72 (invalid member ID) or 75 (subscriber
// not found). The payer IDs below are serial placeholders, not real payers.
//
// Use these for:  seeding Medplum, the stubClinical/stubInsurance path,
//                 populating the console, rehearsing the call flow.
// Do NOT use for: MOCK_PATIENT in insurance/stedi.ts — that ONE identity
//                 must be copied character for character from the portal.
//
// No real PHI. All five are fabricated.
// ===========================================================================

export interface DemoPatient {
  firstName: string;
  lastName: string;
  /** YYYYMMDD, no dashes — same shape Stedi wants, so these are drop-in. */
  dateOfBirth: string;
  /** Serial, not a real policy number. */
  memberId: string;
  /** Serial placeholder. Real payer IDs are assigned by Stedi's network. */
  tradingPartnerServiceId: string;
}

/** All five are over 50 as of 2026-08-01. */
export const DEMO_PATIENTS: readonly DemoPatient[] = [
  {
    firstName: "John",
    lastName: "Alvarez",
    dateOfBirth: "19680314", // 58
    memberId: "MBR10001",
    tradingPartnerServiceId: "00001",
  },
  {
    firstName: "Jessy",
    lastName: "Okonkwo",
    dateOfBirth: "19711102", // 54
    memberId: "MBR10002",
    tradingPartnerServiceId: "00002",
  },
  {
    firstName: "Max",
    lastName: "Feldman",
    dateOfBirth: "19590625", // 67
    memberId: "MBR10003",
    tradingPartnerServiceId: "00003",
  },
  {
    firstName: "Joseph",
    lastName: "Nakamura",
    dateOfBirth: "19640908", // 61
    memberId: "MBR10004",
    tradingPartnerServiceId: "00004",
  },
  {
    firstName: "Jessica",
    lastName: "Brennan",
    dateOfBirth: "19740130", // 52
    memberId: "MBR10005",
    tradingPartnerServiceId: "00005",
  },
] as const;

export function findByMemberId(memberId: string): DemoPatient | undefined {
  return DEMO_PATIENTS.find((p) => p.memberId === memberId);
}

/* ------------------------------------------------------------------ */
/* THE ONE IDENTITY — Stedi, the Medplum seed, and the voice script    */
/* all resolve it from here. Two copies of these five values is how a  */
/* team ends up reconciling identities at 3pm instead of rehearsing.   */
/* ------------------------------------------------------------------ */

export interface DemoIdentity extends DemoPatient {
  /**
   * True only when all five DEMO_PATIENT_* values are set, meaning someone
   * copied an approved identity from the Stedi portal. False means we fell
   * back to the synthetic patient below, which live Stedi rejects.
   */
  approved: boolean;
}

/**
 * Prefers the approved portal identity from .env; falls back to the first
 * synthetic patient so the mock server, the probe, and the seed all work
 * today with no configuration.
 *
 * To go live, set the five DEMO_PATIENT_* values in .env. Both Stedi and the
 * Medplum seed pick them up together — there is nothing to keep in sync by
 * hand.
 */
export function resolveDemoIdentity(): DemoIdentity {
  const fromEnv = {
    firstName: process.env['DEMO_PATIENT_FIRST_NAME']?.trim() ?? '',
    lastName: process.env['DEMO_PATIENT_LAST_NAME']?.trim() ?? '',
    dateOfBirth: process.env['DEMO_PATIENT_DATE_OF_BIRTH']?.trim() ?? '',
    memberId: process.env['DEMO_PATIENT_MEMBER_ID']?.trim() ?? '',
    tradingPartnerServiceId: process.env['DEMO_PATIENT_TRADING_PARTNER_SERVICE_ID']?.trim() ?? '',
  };

  // All five or none. A partial override is how you get a subscriber block
  // that is half one person and half another, which fails as AAA 72/75 and
  // takes an hour to spot.
  const provided = Object.values(fromEnv).filter((value) => value.length > 0);
  if (provided.length === 5) {
    return { ...fromEnv, approved: true };
  }
  if (provided.length > 0) {
    throw new Error(
      `[identity] ${provided.length} of 5 DEMO_PATIENT_* values are set. Set all five or none — a partial identity is rejected by Stedi as AAA 72/75.`,
    );
  }

  const fallback = DEMO_PATIENTS[0];
  if (!fallback) {
    throw new Error('[identity] DEMO_PATIENTS is empty and DEMO_PATIENT_* is unset.');
  }
  return { ...fallback, approved: false };
}

/** "19680314" → "1968-03-14", for FHIR Patient.birthDate when B seeds. */
export function toFhirBirthDate(dateOfBirth: string): string {
  return `${dateOfBirth.slice(0, 4)}-${dateOfBirth.slice(4, 6)}-${dateOfBirth.slice(6, 8)}`;
}
