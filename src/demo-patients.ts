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

/** "19680314" → "1968-03-14", for FHIR Patient.birthDate when B seeds. */
export function toFhirBirthDate(dateOfBirth: string): string {
  return `${dateOfBirth.slice(0, 4)}-${dateOfBirth.slice(4, 6)}-${dateOfBirth.slice(6, 8)}`;
}
