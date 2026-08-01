// ===========================================================================
// CONFIG — credentials, validated lazily per service.
//
// Lazy on purpose: Person C must be able to run the Stedi probe at 9:30
// before Person B has created the Medplum client application. Touching
// config.stedi must not require MEDPLUM_* to exist.
//
// NOTHING in here ever reaches the browser. See auth.ts.
// ===========================================================================

import "dotenv/config";

function need(key: string, svc: string): string {
  const v = process.env[key];
  if (!v || !v.trim()) {
    throw new Error(
      `[config] Missing ${key} (needed for ${svc}). Add it to .env at the repo root.`
    );
  }
  return v.trim();
}

export const config = {
  get medplum() {
    return {
      baseUrl: process.env.MEDPLUM_BASE_URL?.trim() || "https://api.medplum.com/",
      clientId: need("MEDPLUM_CLIENT_ID", "medplum"),
      clientSecret: need("MEDPLUM_CLIENT_SECRET", "medplum"),
    };
  },
  get deepgram() {
    return {
      apiKey: need("DEEPGRAM_API_KEY", "deepgram"),
      agentUrl: "wss://agent.deepgram.com/v1/agent/converse",
    };
  },
  get stedi() {
    return {
      apiKey: need("STEDI_API_KEY", "stedi"),
      baseUrl: process.env.STEDI_BASE_URL?.trim() || "https://healthcare.us.stedi.com",
      /** Guard rail: never hit production payers from a hackathon laptop. */
      testMode: (process.env.STEDI_TEST_MODE ?? "true").toLowerCase() !== "false",
    };
  },
  port: Number(process.env.PORT ?? 3000),
};

export const mask = (s: string) => `${s.slice(0, 4)}…${s.slice(-2)} (${s.length} chars)`;
