#!/usr/bin/env tsx
// ===========================================================================
// MOCK STEDI — a local stand-in for the real eligibility endpoint.
//
//   npm run stedi:mock          # listens on :3100
//
// Then point the client at it, in .env:
//   STEDI_BASE_URL=http://localhost:3100
//
// WHY THIS EXISTS: no test API key. Rather than stubbing checkCoverage() and
// skipping the code we actually want to demo, this speaks 271-shaped JSON at
// the real path, so stedi.ts's fetch, parser, in-network preference, and AAA
// error handling all run for real. When a key arrives, delete STEDI_BASE_URL
// from .env and the exact same code goes live. Nothing else changes.
//
// HONESTY: every response carries meta.applicationMode "mock", which makes
// checkCoverage() set stubbed:true automatically. Do not change that to
// "test" — the flag is what keeps the demo honest without anyone remembering.
//
// The five identities are src/demo-patients.ts. They are synthetic and are
// still rejected by the real Stedi; they work HERE and only here.
// ===========================================================================

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { DEMO_PATIENTS, findByMemberId } from "../demo-patients.js";
import { ELIGIBILITY_PATH } from "./stedi.js";

const PORT = Number(process.env.STEDI_MOCK_PORT ?? 3100);

/* ------------------------- benefit builders ------------------------ */
// Shapes copied from the documented 271 response. Read by CODE in stedi.ts,
// so order here is deliberately jumbled — if the parser ever regresses to
// reading by array position, these scenarios catch it.

const active = () => ({
  code: "1",
  name: "Active Coverage",
  serviceTypeCodes: ["30"],
  coverageLevelCode: "IND",
  inPlanNetworkIndicatorCode: "Y",
  planCoverage: "OPEN ACCESS PLUS",
});

const copay = (amount: string, inNetwork = true) => ({
  code: "B",
  name: "Co-Payment",
  benefitAmount: amount,
  serviceTypeCodes: ["30"],
  coverageLevelCode: "IND",
  inPlanNetworkIndicatorCode: inNetwork ? "Y" : "N",
});

const coinsurance = (percent: string, inNetwork = true) => ({
  code: "A",
  name: "Co-Insurance",
  benefitPercent: percent,
  serviceTypeCodes: ["30"],
  inPlanNetworkIndicatorCode: inNetwork ? "Y" : "N",
});

const deductible = (amount: string) => ({
  code: "C",
  name: "Deductible",
  benefitAmount: amount,
  timeQualifierCode: "29", // remaining
  serviceTypeCodes: ["30"],
  inPlanNetworkIndicatorCode: "Y",
});

const outOfPocket = (amount: string) => ({
  code: "G",
  name: "Out of Pocket (Stop Loss)",
  benefitAmount: amount,
  timeQualifierCode: "29",
  serviceTypeCodes: ["30"],
  inPlanNetworkIndicatorCode: "Y",
});

/* --------------------------- the scenarios ------------------------- */
// One per demo patient, chosen to cover every branch in the parser.

const SCENARIOS: Record<string, () => object> = {
  // John Alvarez — the happy path. This is the one to demo.
  MBR10001: () => ({
    payer: { name: "UNITED HEALTHCARE" },
    benefitsInformation: [
      copay("45.00", false), // out-of-network decoy, listed FIRST on purpose
      active(),
      copay("10.00"),
      deductible("250.00"),
      outOfPocket("3000.00"),
    ],
  }),

  // Jessy Okonkwo — coinsurance instead of a flat copay.
  MBR10002: () => ({
    payer: { name: "AETNA" },
    benefitsInformation: [
      active(),
      coinsurance("0.20"),
      deductible("1200.00"),
      outOfPocket("6000.00"),
    ],
  }),

  // Max Feldman — covered but expensive. The cost-barrier story.
  MBR10003: () => ({
    payer: { name: "CIGNA" },
    benefitsInformation: [active(), copay("75.00"), deductible("500.00")],
  }),

  // Joseph Nakamura — no active coverage. Exercises the !covered branch.
  MBR10004: () => ({
    payer: { name: "ANTHEM BCBS" },
    benefitsInformation: [
      { code: "6", name: "Inactive", serviceTypeCodes: ["30"] },
    ],
  }),

  // Jessica Brennan — payer down. Exercises the AAA error branch.
  MBR10005: () => ({
    payer: { name: "HUMANA" },
    errors: [
      {
        code: "42",
        description: "Unable to Respond at Current Time",
        followupAction: "Please Resubmit Original Transaction",
      },
    ],
  }),
};

/* ------------------------------ server ----------------------------- */

const server = createServer((req, res) => {
  const send = (status: number, body: object) => {
    const json = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(json);
    console.log(`[mock] ${status} ${req.method} ${req.url}`);
  };

  if (req.method !== "POST" || !req.url?.startsWith(ELIGIBILITY_PATH)) {
    return send(404, {
      error: `Not found. The real path is POST ${ELIGIBILITY_PATH}`,
    });
  }

  // Mirror the real service: auth is checked before anything else.
  if (!req.headers.authorization) {
    return send(401, { error: "Missing Authorization header" });
  }

  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    let body: {
      subscriber?: { memberId?: string; firstName?: string; lastName?: string };
      encounter?: { serviceTypeCodes?: string[] };
    };
    try {
      body = JSON.parse(raw);
    } catch {
      return send(400, { error: "Body is not valid JSON" });
    }

    const memberId = body.subscriber?.memberId ?? "";
    const patient = findByMemberId(memberId);
    console.log(
      `[mock] eligibility for memberId=${memberId || "(none)"} ` +
        `stc=${body.encounter?.serviceTypeCodes?.join(",") ?? "-"}`
    );

    // Unknown member → AAA 75, exactly as the real service answers an
    // identity that isn't on the approved list.
    if (!patient) {
      return send(200, {
        id: `ec_${randomUUID()}`,
        meta: { applicationMode: "mock" },
        errors: [
          {
            code: "75",
            description: "Subscriber/Insured Not Found",
            followupAction: "Please Correct and Resubmit",
          },
        ],
      });
    }

    const scenario = SCENARIOS[memberId]?.() ?? {
      payer: { name: "MOCK PAYER" },
      benefitsInformation: [active(), copay("10.00")],
    };

    send(200, {
      id: `ec_${randomUUID()}`,
      // "mock" — NOT "test". This is what drives stubbed:true downstream.
      meta: { applicationMode: "mock" },
      subscriber: {
        firstName: patient.firstName,
        lastName: patient.lastName,
        memberId: patient.memberId,
        dateOfBirth: patient.dateOfBirth,
      },
      ...scenario,
    });
  });
});

server.listen(PORT, () => {
  console.log(`\n── mock Stedi ──────────────────────────────────`);
  console.log(`   listening   http://localhost:${PORT}`);
  console.log(`   path        POST ${ELIGIBILITY_PATH}`);
  console.log(`\n   Put this in .env, then run the probe in another shell:`);
  console.log(`     STEDI_BASE_URL=http://localhost:${PORT}\n`);
  console.log(`   memberId    patient              scenario`);
  for (const p of DEMO_PATIENTS) {
    const what: Record<string, string> = {
      MBR10001: "active, $10 copay  ← demo this one",
      MBR10002: "active, 20% coinsurance",
      MBR10003: "active, $75 copay (cost barrier)",
      MBR10004: "no active coverage",
      MBR10005: "AAA 42, payer down",
    };
    console.log(
      `   ${p.memberId}    ${`${p.firstName} ${p.lastName}`.padEnd(20)} ${what[p.memberId] ?? ""}`
    );
  }
  console.log(`   anything else                    AAA 75, not found\n`);
});
