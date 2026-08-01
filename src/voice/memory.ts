/**
 * Conversation memory, per patient, for the life of the server process.
 *
 * WHY: the Deepgram session holds the dialogue, and it dies with the socket.
 * Drop the call, lose the network, or hit refresh, and the agent reintroduces
 * itself and asks about medications the patient already answered. On a review
 * call that is worse than annoying — it invites a second, contradictory answer
 * for the same bottle.
 *
 * So what the patient told us is recorded here as it happens, and replayed
 * into the system prompt when a session starts. The agent resumes instead of
 * restarting.
 *
 * In-memory on purpose: it is scoped to a demo, holds synthetic data only, and
 * a restart is a legitimate reset. Nothing here is a clinical record —
 * DetectedIssue in Medplum remains the system of record. This is conversation
 * state, not clinical state.
 */

import { bus } from '../bus.js';

export interface Turn {
  role: 'agent' | 'patient';
  text: string;
  at: string;
}

export interface CoveredMedication {
  /** As the patient said it. */
  reported: string;
  /** Reconciliation outcome: match, not-taking, different-label, not-prescribed. */
  kind: string;
  patientWords: string;
  at: string;
}

export interface CoverageMemory {
  medication: string;
  copay: string | null;
  stubbed: boolean;
  at: string;
}

export interface ConversationMemory {
  patientId: string;
  startedAt: string;
  lastActiveAt: string;
  /** Number of separate socket connections in this conversation. */
  sessions: number;
  turns: Turn[];
  covered: CoveredMedication[];
  coverage: CoverageMemory[];
  symptoms: { patientWords: string; at: string }[];
  escalated: boolean;
}

const store = new Map<string, ConversationMemory>();

/** Keeps the replayed context small enough for a voice prompt. */
const MAX_TURNS = 40;

const now = (): string => new Date().toISOString();

export function getMemory(patientId: string): ConversationMemory {
  const existing = store.get(patientId);
  if (existing) return existing;
  const fresh: ConversationMemory = {
    patientId,
    startedAt: now(),
    lastActiveAt: now(),
    sessions: 0,
    turns: [],
    covered: [],
    coverage: [],
    symptoms: [],
    escalated: false,
  };
  store.set(patientId, fresh);
  return fresh;
}

function touch(memory: ConversationMemory): void {
  memory.lastActiveAt = now();
}

/** Call once per socket connection, so the agent knows it is resuming. */
export function beginSession(patientId: string): ConversationMemory {
  const memory = getMemory(patientId);
  memory.sessions += 1;
  touch(memory);
  bus.publish({
    source: 'voice',
    type: 'memory.session',
    data: { session: memory.sessions, resumed: memory.sessions > 1, covered: memory.covered.length, turns: memory.turns.length },
  });
  return memory;
}

export function recordTurn(patientId: string, role: Turn['role'], text: string): void {
  if (!text.trim()) return;
  const memory = getMemory(patientId);
  memory.turns.push({ role, text, at: now() });
  if (memory.turns.length > MAX_TURNS) memory.turns.splice(0, memory.turns.length - MAX_TURNS);
  touch(memory);
}

export function recordCovered(patientId: string, entry: Omit<CoveredMedication, 'at'>): void {
  const memory = getMemory(patientId);
  // One entry per medication — a later answer replaces an earlier one rather
  // than stacking two contradictory reports for the same bottle.
  const key = entry.reported.toLowerCase();
  const index = memory.covered.findIndex((item) => item.reported.toLowerCase() === key);
  const record: CoveredMedication = { ...entry, at: now() };
  if (index >= 0) memory.covered[index] = record;
  else memory.covered.push(record);
  touch(memory);
  bus.publish({ source: 'voice', type: 'memory.covered', data: { medication: entry.reported, kind: entry.kind, total: memory.covered.length } });
}

export function recordCoverage(patientId: string, entry: Omit<CoverageMemory, 'at'>): void {
  const memory = getMemory(patientId);
  memory.coverage.push({ ...entry, at: now() });
  touch(memory);
}

export function recordSymptom(patientId: string, patientWords: string): void {
  const memory = getMemory(patientId);
  memory.symptoms.push({ patientWords, at: now() });
  touch(memory);
}

export function recordEscalation(patientId: string): void {
  const memory = getMemory(patientId);
  memory.escalated = true;
  touch(memory);
}

/** Start a genuinely new review for this patient. */
export function resetMemory(patientId: string): void {
  store.delete(patientId);
  bus.publish({ source: 'voice', type: 'memory.reset', data: { patientId } });
}

/**
 * Has this medication already been answered for? Used to tell the agent what
 * is left rather than making it infer from the transcript.
 */
export function isCovered(memory: ConversationMemory, display: string): boolean {
  const needle = display.toLowerCase();
  return memory.covered.some(
    (item) => item.reported.toLowerCase().includes(needle) || needle.includes(item.reported.toLowerCase()),
  );
}

/** Compact, speakable-adjacent summary replayed into the system prompt. */
export function summarize(memory: ConversationMemory, medicationNames: string[]): string {
  if (!memory.covered.length && !memory.turns.length) return '';

  const lines: string[] = [];
  const remaining = medicationNames.filter((name) => !isCovered(memory, name));

  if (memory.covered.length) {
    lines.push('Already answered — do NOT ask about these again:');
    for (const item of memory.covered) {
      lines.push(`- ${item.reported}: ${item.kind} — patient said "${item.patientWords}"`);
    }
  }
  if (memory.coverage.length) {
    for (const item of memory.coverage) {
      lines.push(`- Coverage already quoted for ${item.medication}: ${item.copay ?? 'no price returned'}${item.stubbed ? ' (recorded, not live)' : ''}`);
    }
  }
  if (memory.symptoms.length) {
    lines.push(`Symptoms already recorded verbatim: ${memory.symptoms.map((s) => `"${s.patientWords}"`).join('; ')}`);
  }
  lines.push(remaining.length ? `Still to cover: ${remaining.join(', ')}.` : 'All medications on file have been covered.');

  const recent = memory.turns.slice(-8);
  if (recent.length) {
    lines.push('', 'Last thing said before the call resumed:');
    for (const turn of recent) lines.push(`${turn.role === 'agent' ? 'You' : 'Patient'}: ${turn.text}`);
  }
  return lines.join('\n');
}
