import 'dotenv/config';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { bus, type BusEvent } from './bus.js';
import { createClinicalApi } from './clinical/index.js';
import { createDemoClinicalApi } from './clinical/demo.js';
import { insuranceApi } from './insurance/index.js';
import { createVoiceAdapter, URGENT_ESCALATION_RESPONSE } from './voice/index.js';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const app = express();
const server = createServer(app);
const sockets = new WebSocketServer({ server, path: '/events' });

app.use(express.json());
app.use(express.static('public'));

const hasMedplumCredentials = Boolean(process.env.MEDPLUM_CLIENT_ID && process.env.MEDPLUM_CLIENT_SECRET);
const clinical = hasMedplumCredentials ? await createClinicalApi() : createDemoClinicalApi();
const voice = createVoiceAdapter({ clinical, insurance: insuranceApi });
const demoPatientId = process.env.DEMO_MEDPLUM_PATIENT_ID || 'demo-patient';

app.get('/health', (_request, response) => {
  response.json({
    ok: true,
    adapters: {
      clinical: hasMedplumCredentials ? 'medplum' : 'demo',
      insurance: 'stub',
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

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : 'Unknown server error';
  bus.publish({ source: 'server', type: 'request.failed', data: { message } });
  response.status(500).json({ error: message });
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
