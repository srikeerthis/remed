// ===========================================================================
// AUTH — outbound credentials for third-party APIs.
//
// NOTHING here ever reaches the browser. The console (public/index.html)
// talks only to our own server over ws; it never sees a key.
// ===========================================================================

import { config } from "./config.js";

/**
 * Stedi wants the raw API key in Authorization — NO Bearer prefix.
 * Confirmed against the API reference (2026-08).
 *
 * If a call 401s, the probe prints the response body. If that body asks for
 * a different scheme, this is the one place to change it:
 *   `Key ${config.stedi.apiKey}`  is the documented alternative form.
 */
export function stediHeaders(): Record<string, string> {
  return {
    Authorization: config.stedi.apiKey,
    "Content-Type": "application/json",
  };
}
