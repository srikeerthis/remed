#!/usr/bin/env tsx
// ===========================================================================
// STEDI PROBE — the 10am hard gate, runnable in isolation.
//
//   npm run stedi:probe                     # default drug, STC 30
//   npm run stedi:probe -- lisinopril 88    # drug name, service type code
//   npm run stedi:probe -- lisinopril 30 --raw
//
// Needs only STEDI_API_KEY in .env. No Medplum, no Deepgram, no server.
// Writes the full response to .stedi-last.json so you can read the shape
// instead of guessing at it.
// ===========================================================================

import { writeFileSync } from "node:fs";
import { config, mask } from "../config.js";
import { stediHeaders } from "../auth.js";
import { MOCK_PATIENT, insurance, buildRequest, ELIGIBILITY_PATH } from "./stedi.js";

const [drug = "lisinopril", stc = "30"] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const showRaw = process.argv.includes("--raw");

function fail(msg: string): never {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
}

async function main() {
  console.log("\n── Stedi probe ─────────────────────────────────");
  console.log(`   key       ${mask(config.stedi.apiKey)}`);
  console.log(`   base      ${config.stedi.baseUrl}`);
  console.log(`   testMode  ${config.stedi.testMode}`);
  console.log(`   drug      ${drug}   serviceTypeCode ${stc}`);

  const usingMock = /localhost|127\.0\.0\.1/.test(config.stedi.baseUrl);
  if (usingMock) {
    console.log(
      `\n   ⚠  MOCK SERVER — this is not a live payer check.\n` +
        `      Responses come back stubbed:true. Say so in the demo.\n` +
        `      To go live: get a test key, replace MOCK_PATIENT with an\n` +
        `      approved portal identity, drop STEDI_BASE_URL from .env.`
    );
  }

  if (String(MOCK_PATIENT.firstName).startsWith("REPLACE")) {
    fail(
      "MOCK_PATIENT still has placeholder values.\n" +
        "    Open src/insurance/stedi.ts and paste one approved mock patient\n" +
        "    from Stedi's Eligibility mock requests page, then post those exact\n" +
        "    values to the team chat before anyone else writes code."
    );
  }
  if (!/^\d{8}$/.test(MOCK_PATIENT.dateOfBirth)) {
    fail(`dateOfBirth must be YYYYMMDD with no dashes — got "${MOCK_PATIENT.dateOfBirth}"`);
  }

  const body = buildRequest(stc);
  console.log(`\n   POST ${config.stedi.baseUrl}${ELIGIBILITY_PATH}`);
  console.log(`   subscriber ${MOCK_PATIENT.firstName} ${MOCK_PATIENT.lastName} / ${MOCK_PATIENT.memberId}`);
  console.log(`   payer      ${MOCK_PATIENT.tradingPartnerServiceId}\n`);

  const started = Date.now();
  const res = await fetch(`${config.stedi.baseUrl}${ELIGIBILITY_PATH}`, {
    method: "POST",
    headers: stediHeaders(),
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  const ms = Date.now() - started;

  writeFileSync(".stedi-last.json", raw);
  console.log(`   HTTP ${res.status} in ${ms}ms  → full body in .stedi-last.json`);

  if (!res.ok) {
    console.error("\n── error body ──────────────────────────────────");
    console.error(raw.slice(0, 1200));
    if (res.status === 401 || res.status === 403) {
      console.error(
        "\n   401/403 → the auth scheme is the thing to check.\n" +
          "   We send a bare `Authorization: <key>`. If the body suggests a\n" +
          "   Bearer token, change stediHeaders() in src/auth.ts.\n" +
          "   Also confirm you generated a TEST-mode key, not a production one."
      );
    }
    process.exit(1);
  }

  const data = JSON.parse(raw);

  if (showRaw) {
    console.log("\n── raw ─────────────────────────────────────────");
    console.log(JSON.stringify(data, null, 2).slice(0, 4000));
  }

  console.log("\n── response ────────────────────────────────────");
  console.log(`   mode      ${data.meta?.applicationMode ?? "?"}`);
  console.log(`   payer     ${data.payer?.name ?? "?"}`);
  if (data.id) console.log(`   check id  ${data.id}   (deep-links in the Stedi portal)`);

  if (data.errors?.length) {
    console.log("\n── AAA errors ──────────────────────────────────");
    for (const e of data.errors) {
      console.log(`   ${e.code}  ${e.description}`);
      console.log(`         → ${e.followupAction}`);
    }
    console.log(
      "\n   Common ones: 42 payer unavailable · 72 invalid member ID\n" +
        "   75 subscriber not found · 79 invalid participant ID\n" +
        "   If you see 72 or 75, your MOCK_PATIENT values don't match the\n" +
        "   approved list exactly. Re-copy them character for character."
    );
    process.exit(1);
  }

  const items = data.benefitsInformation ?? [];
  console.log(`\n── benefitsInformation (${items.length}) ────────────────`);
  const label: Record<string, string> = {
    "1": "ACTIVE", A: "COINS", B: "COPAY", C: "DEDUCT", G: "OOP MAX",
  };
  for (const b of items.slice(0, 25)) {
    const kind = label[b.code ?? ""] ?? b.code ?? "?";
    const val = b.benefitAmount
      ? `$${b.benefitAmount}`
      : b.benefitPercent
      ? `${Math.round(Number(b.benefitPercent) * 100)}%`
      : "";
    const net = b.inPlanNetworkIndicatorCode === "Y" ? "in-net" : b.inPlanNetworkIndicatorCode ?? "";
    console.log(
      `   ${kind.padEnd(7)} ${String(val).padEnd(9)} ${net.padEnd(7)} ` +
        `stc=${(b.serviceTypeCodes ?? []).join(",").padEnd(6)} ${b.name ?? ""}`
    );
  }
  if (items.length > 25) console.log(`   … ${items.length - 25} more`);

  console.log("\n── what checkCoverage() would return ───────────");
  const result = await insurance.checkCoverage(drug, MOCK_PATIENT.memberId);
  console.log(`   covered   ${result.covered}`);
  console.log(`   copay     ${result.copay ?? "—"}`);
  console.log(`   deduct    ${result.deductibleRemaining ?? "—"}`);
  console.log(`   coins     ${result.coinsurance ?? "—"}`);
  console.log(`   stubbed   ${result.stubbed}`);
  console.log(`\n   spoken:   "${result.speakable}"\n`);

  if (!result.copay) {
    console.log(
      "   No copay came back. Not every mock payer returns a co-payment —\n" +
        "   some return coinsurance (code A) or deductible (C) instead.\n" +
        "   Try another approved mock patient before changing the STC;\n" +
        "   medical mock requests only support serviceTypeCode 30.\n" +
        "   Read .stedi-last.json to see what the payer actually sent.\n"
    );
  }
}

main().catch((err) => {
  console.error("\n  ✗", err?.message ?? err, "\n");
  process.exit(1);
});
