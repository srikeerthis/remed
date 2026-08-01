import 'dotenv/config';
import express from 'express';
import { createServer } from 'node:http';
import WsClient, { WebSocketServer } from 'ws';
import { bus, type BusEvent } from './bus.js';
import { createDemoClinicalApi } from './clinical/demo.js';
import { insuranceApi, insuranceMode } from './insurance/index.js';
import { createVoiceAdapter, URGENT_ESCALATION_RESPONSE } from './voice/index.js';
import { startVoiceSession, stopVoiceSession } from './voice/session.js';
import { getMemory, resetMemory } from './voice/memory.js';

// Medplum's subscription client expects the browser WebSocket global, which Node 18 does not provide.
if (!globalThis.WebSocket) Object.assign(globalThis, { WebSocket: WsClient });

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const app = express();
const server = createServer(app);
// Both use noServer and share ONE upgrade listener. Passing { server, path }
// twice makes each WebSocketServer add its own upgrade listener, and ws aborts
// with 400 whenever the path is not its own — so whichever is constructed
// first kills the other's handshake. That made every /call connection fail.
const sockets = new WebSocketServer({ noServer: true });
const callSockets = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const { pathname } = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const target = pathname === '/events' ? sockets : pathname === '/call' ? callSockets : null;
  if (!target) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  target.handleUpgrade(request, socket, head, (ws) => target.emit('connection', ws, request));
});

app.use(express.json());
app.use(express.static('public'));

const hasMedplumCredentials = Boolean(process.env.MEDPLUM_CLIENT_ID && process.env.MEDPLUM_CLIENT_SECRET);
const clinical = hasMedplumCredentials
  ? await (await import('./clinical/index.js')).createClinicalApi()
  : createDemoClinicalApi();
const voice = createVoiceAdapter({ clinical, insurance: insuranceApi });
const demoPatientId = process.env.DEMO_MEDPLUM_PATIENT_ID || 'demo-patient';

app.get('/health', (_request, response) => {
  response.json({
    ok: true,
    adapters: {
      clinical: hasMedplumCredentials ? 'medplum' : 'demo',
      insurance: insuranceMode,
      voice: voice.ready ? 'deepgram' : 'stub',
    },
  });
});

app.get('/api/demo/patient', async (_request, response, next) => {
  try {
    response.json(await clinical.getPatientReview(demoPatientId));
  } catch (error) {
    next(error);
  }
});

app.get('/api/demo/issues', async (_request, response, next) => {
  try {
    response.json(await clinical.listIssues(demoPatientId));
  } catch (error) {
    next(error);
  }
});

app.post('/api/demo/reconcile', async (request, response, next) => {
  try {
    const { labelText, doseText, patientWords, taking, stoppedReason } = request.body as Record<string, unknown>;
    if (typeof labelText !== 'string' || typeof patientWords !== 'string' || typeof taking !== 'boolean') {
      response.status(400).json({ error: 'labelText, patientWords, and taking are required' });
      return;
    }
    const result = await clinical.reconcileMedication({
      patientId: demoPatientId,
      labelText,
      patientWords,
      taking,
      ...(typeof doseText === 'string' && doseText ? { doseText } : {}),
      ...(typeof stoppedReason === 'string' && stoppedReason ? { stoppedReason } : {}),
    });
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/api/demo/coverage', async (request, response, next) => {
  try {
    const { medicationName, scenario: scenarioOverride } = request.body as Record<string, unknown>;
    if (typeof medicationName !== 'string' || !medicationName.trim()) {
      response.status(400).json({ error: 'medicationName is required' });
      return;
    }
    const review = await clinical.getPatientReview(demoPatientId);
    if (!review.memberId) {
      response.status(409).json({ error: 'Patient has no insurance member id' });
      return;
    }
    // The endpoint only applies a scenario when the caller passes one — auto-
    // inferring from the seed would shadow live Stedi responses for anything
    // rehearsal-tagged. Voice dispatch owns the "which scenario for which med"
    // decision; this endpoint stays a straight passthrough.
    const scenario = typeof scenarioOverride === 'string' && scenarioOverride
      ? (scenarioOverride as import('./contract.js').CoverageScenario)
      : undefined;
    bus.publish({ source: 'insurance', type: 'coverage.check.request', data: { medicationName, scenario } });
    const result = await insuranceApi.checkCoverage({
      medicationName,
      memberId: review.memberId,
      ...(scenario ? { scenario } : {}),
    });
    bus.publish({
      source: 'insurance',
      type: 'coverage.check.response',
      data: {
        medication: medicationName,
        covered: result.covered,
        copay: result.copay,
        deductibleRemaining: result.deductibleRemaining,
        priorAuthRequired: result.priorAuthRequired,
        formularyStatus: result.formularyStatus,
        scenario: result.scenario,
        stubbed: result.stubbed,
      },
    });
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/api/demo/refill', async (request, response, next) => {
  try {
    const { medicationName } = request.body as Record<string, unknown>;
    if (typeof medicationName !== 'string' || !medicationName.trim()) {
      response.status(400).json({ error: 'medicationName is required' });
      return;
    }
    const status = await clinical.requestRefill({ patientId: demoPatientId, medicationName });
    bus.publish({ source: 'clinical', type: 'refill.requested', data: status });
    response.json(status);
  } catch (error) {
    next(error);
  }
});

app.post('/api/demo/care-team-note', async (request, response, next) => {
  try {
    const { topic, patientWords } = request.body as Record<string, unknown>;
    if (typeof topic !== 'string' || !topic.trim() || typeof patientWords !== 'string' || !patientWords.trim()) {
      response.status(400).json({ error: 'topic and patientWords are required' });
      return;
    }
    const result = await clinical.recordCareTeamNote({ patientId: demoPatientId, topic, patientWords });
    bus.publish({ source: 'clinical', type: 'care-team-note.recorded', data: { topic, noteId: result.noteId } });
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/api/demo/missed-dose', async (request, response, next) => {
  try {
    const { medicationName, patientWords, when } = request.body as Record<string, unknown>;
    if (typeof medicationName !== 'string' || !medicationName.trim() || typeof patientWords !== 'string' || !patientWords.trim()) {
      response.status(400).json({ error: 'medicationName and patientWords are required' });
      return;
    }
    const result = await clinical.recordMissedDose({
      patientId: demoPatientId,
      medicationName,
      patientWords,
      ...(typeof when === 'string' && when ? { when } : {}),
    });
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/api/demo/side-effect', async (request, response, next) => {
  try {
    const { medicationName, patientWords } = request.body as Record<string, unknown>;
    if (typeof medicationName !== 'string' || !medicationName.trim() || typeof patientWords !== 'string' || !patientWords.trim()) {
      response.status(400).json({ error: 'medicationName and patientWords are required' });
      return;
    }
    const result = await clinical.recordSideEffectConcern({ patientId: demoPatientId, medicationName, patientWords });
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.get('/api/demo/care-team-notes', async (_request, response, next) => {
  try {
    response.json(await clinical.listCareTeamNotes(demoPatientId));
  } catch (error) {
    next(error);
  }
});

app.post('/api/demo/symptom', async (request, response, next) => {
  try {
    const { patientWords, urgent } = request.body as Record<string, unknown>;
    if (typeof patientWords !== 'string' || !patientWords.trim()) {
      response.status(400).json({ error: 'patientWords is required' });
      return;
    }
    const result = urgent === true
      ? await clinical.recordUrgentIssue({ patientId: demoPatientId, patientWords })
      : await clinical.recordSymptom({ patientId: demoPatientId, patientWords });
    response.json(urgent === true ? { ...result, spokenResponse: URGENT_ESCALATION_RESPONSE } : result);
  } catch (error) {
    next(error);
  }
});

// Conversation memory: what the agent already asked and was told. Survives a
// dropped socket so a reconnect resumes rather than restarts.
app.get('/api/demo/memory', (_request, response) => {
  const memory = getMemory(demoPatientId);
  response.json({
    sessions: memory.sessions,
    covered: memory.covered,
    coverage: memory.coverage,
    symptoms: memory.symptoms,
    escalated: memory.escalated,
    turns: memory.turns.length,
  });
});

// Start a genuinely new review — use between demo runs.
app.post('/api/demo/memory/reset', (_request, response) => {
  resetMemory(demoPatientId);
  response.json({ ok: true });
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : 'Unknown server error';
  bus.publish({ source: 'server', type: 'request.failed', data: { message } });
  response.status(500).json({ error: message });
});

callSockets.on('connection', async (ws) => {
  if (!voice.ready) {
    bus.publish({ source: 'voice', type: 'call.rejected', data: { reason: 'DEEPGRAM_API_KEY is not set' } });
    ws.close(1013, 'Deepgram is not configured');
    return;
  }
  try {
    const review = await clinical.getPatientReview(demoPatientId);
    const memberId = review.memberId ?? '';
    await startVoiceSession(ws, clinical, insuranceApi, demoPatientId, memberId);
    ws.send(JSON.stringify({ type: 'ready' }));
    ws.on('close', () => stopVoiceSession());
  } catch (err) {
    bus.publish({ source: 'voice', type: 'call.error', data: { error: String(err) } });
    ws.close(1011, 'Voice session failed');
  }
});

sockets.on('connection', (socket) => {
  socket.send(JSON.stringify({ at: new Date().toISOString(), source: 'server', type: 'console.connected' } satisfies BusEvent));
});

bus.on('event', (event: BusEvent) => {
  const message = JSON.stringify(event);
  for (const socket of sockets.clients) {
    if (socket.readyState === socket.OPEN) {
      socket.send(message);
    }
  }
});

server.listen(port, () => {
  bus.publish({ source: 'server', type: 'server.started', data: { port, url: `http://localhost:${port}` } });
  if (!hasMedplumCredentials) {
    bus.publish({ source: 'clinical', type: 'clinical.demo.active', data: { reason: 'MEDPLUM_CLIENT_ID and MEDPLUM_CLIENT_SECRET are not set' } });
  }
});

function shutdown(): void {
  for (const socket of sockets.clients) socket.terminate();
  sockets.close();
  server.close();
  setTimeout(() => process.exit(0), 100);
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
