import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import test, { after, before } from 'node:test';
import WebSocket from 'ws';
import { URGENT_ESCALATION_RESPONSE } from '../src/voice/index.js';

const projectRoot = process.cwd();
const tsxCli = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const appPort = 32_000 + (process.pid % 1_000);
const mockPort = appPort + 1;
const appBaseUrl = `http://127.0.0.1:${appPort}`;
const mockBaseUrl = `http://127.0.0.1:${mockPort}`;

let appProcess: ChildProcessWithoutNullStreams;
let mockProcess: ChildProcessWithoutNullStreams;
let appOutput = '';
let mockOutput = '';

function startTypeScript(file: string, env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [tsxCli, file], {
    cwd: projectRoot,
    env: { ...process.env, ...env },
    stdio: 'pipe',
  });
}

function capture(processToCapture: ChildProcessWithoutNullStreams, target: 'app' | 'mock'): void {
  const append = (chunk: Buffer): void => {
    if (target === 'app') appOutput += chunk.toString();
    else mockOutput += chunk.toString();
  };
  processToCapture.stdout.on('data', append);
  processToCapture.stderr.on('data', append);
}

async function waitForHttp(url: string, child: ChildProcessWithoutNullStreams, output: () => string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Process exited before ${url} became ready:\n${output()}`);
    }
    try {
      await fetch(url);
      return;
    } catch {
      // Process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}:\n${output()}`);
}

async function stop(child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 1_000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function api(pathname: string, init?: RequestInit): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(`${appBaseUrl}${pathname}`, init);
  const body = await response.json() as unknown;
  return { response, body };
}

function post(pathname: string, body: unknown): Promise<{ response: Response; body: unknown }> {
  return api(pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function object(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
}

before(async () => {
  mockProcess = startTypeScript('src/insurance/mock-server.ts', {
    STEDI_MOCK_PORT: String(mockPort),
  });
  capture(mockProcess, 'mock');
  await waitForHttp(`${mockBaseUrl}/not-found`, mockProcess, () => mockOutput);

  appProcess = startTypeScript('src/server.ts', {
    PORT: String(appPort),
    MEDPLUM_CLIENT_ID: '',
    MEDPLUM_CLIENT_SECRET: '',
    DEEPGRAM_API_KEY: '',
    STEDI_API_KEY: 'local-mock-key',
    STEDI_BASE_URL: mockBaseUrl,
    STEDI_TEST_MODE: 'true',
  });
  capture(appProcess, 'app');
  await waitForHttp(`${appBaseUrl}/health`, appProcess, () => appOutput);
});

after(async () => {
  await Promise.all([stop(appProcess), stop(mockProcess)]);
});

test('Countback HTTP API routes', async (t) => {
  await t.test('serves the console', async () => {
    const response = await fetch(`${appBaseUrl}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await response.text(), /Countback clinical console/);
  });

  await t.test('reports active adapter modes', async () => {
    const { response, body } = await api('/health');
    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      ok: true,
      adapters: { clinical: 'demo', insurance: 'mock', voice: 'stub' },
    });
  });

  await t.test('rejects voice calls clearly when Deepgram is not configured', async () => {
    const socket = new WebSocket(`${appBaseUrl.replace('http', 'ws')}/call`);
    const [code, reason] = await once(socket, 'close') as [number, Buffer];
    assert.equal(code, 1013);
    assert.equal(reason.toString(), 'Deepgram is not configured');
  });

  await t.test('returns the synthetic patient review', async () => {
    const { response, body } = await api('/api/demo/patient');
    const patient = object(body);
    assert.equal(response.status, 200);
    assert.equal(patient.displayName, 'John Alvarez (Synthetic)');
    assert.equal(patient.memberId, 'MBR10001');
    assert.equal(Array.isArray(patient.medications), true);
    assert.equal((patient.medications as unknown[]).length, 4);

    // The agent leads with the medication for the most recent problem, so the
    // indication link and the pill description have to survive.
    const medications = patient.medications as Record<string, unknown>[];
    const ibuprofen = medications.find((medication) => medication.display === 'Ibuprofen');
    assert.ok(ibuprofen, 'Ibuprofen should be on the discharge list');
    assert.equal(ibuprofen.indication, 'Dental pain following tooth extraction');
    assert.equal(typeof ibuprofen.appearance, 'string');

    const conditions = patient.conditions as Record<string, unknown>[];
    assert.equal(Array.isArray(conditions), true);
    assert.ok(
      conditions.some((condition) => condition.display === 'Dental pain following tooth extraction'),
      'the dental problem should be on the condition list',
    );
  });

  await t.test('accepts a matching medication without creating an issue', async () => {
    const { response, body } = await post('/api/demo/reconcile', {
      labelText: 'Metformin 500 mg twice daily',
      patientWords: 'My bottle says Metformin 500 milligrams twice a day.',
      taking: true,
    });
    assert.equal(response.status, 200);
    assert.equal(object(body).kind, 'match');
    assert.equal(object(body).detectedIssueId, undefined);
  });

  await t.test('flags a dose-frequency mismatch', async () => {
    const { response, body } = await post('/api/demo/reconcile', {
      labelText: 'Metformin 500 mg once daily',
      patientWords: 'My bottle says Metformin 500 milligrams once a day.',
      taking: true,
    });
    const result = object(body);
    assert.equal(response.status, 200);
    assert.equal(result.kind, 'different-label');
    assert.match(String(result.detectedIssueId), /^demo-issue-/);
  });

  await t.test('routes a cost stop toward insurance', async () => {
    const { response, body } = await post('/api/demo/reconcile', {
      labelText: 'Lisinopril 10 mg once daily',
      patientWords: 'I stopped taking Lisinopril because it costs too much.',
      taking: false,
      stoppedReason: 'cost',
    });
    const result = object(body);
    assert.equal(response.status, 200);
    assert.equal(result.kind, 'not-taking');
    assert.equal(result.shouldCheckCoverage, true);
  });

  await t.test('returns parsed insurance coverage from the Stedi mock', async () => {
    const { response, body } = await post('/api/demo/coverage', { medicationName: 'lisinopril' });
    const coverage = object(body);
    assert.equal(response.status, 200);
    assert.equal(coverage.covered, true);
    assert.equal(coverage.copay, '$10');
    assert.equal(coverage.deductibleRemaining, '$250');
    assert.equal(coverage.stubbed, true);
    assert.match(String(coverage.speakable), /lisinopril is covered/);
  });

  await t.test('records a symptom verbatim', async () => {
    const patientWords = 'I have felt dizzy since I came home.';
    const { response, body } = await post('/api/demo/symptom', { patientWords, urgent: false });
    assert.equal(response.status, 200);
    assert.match(String(object(body).detectedIssueId), /^demo-issue-/);
  });

  await t.test('uses the fixed urgent response and creates a high-severity issue', async () => {
    const { response, body } = await post('/api/demo/symptom', {
      patientWords: 'I have chest pain.',
      urgent: true,
    });
    const result = object(body);
    assert.equal(response.status, 200);
    assert.equal(
      result.spokenResponse,
      URGENT_ESCALATION_RESPONSE,
    );
  });

  await t.test('lists every created clinician issue', async () => {
    const { response, body } = await api('/api/demo/issues');
    assert.equal(response.status, 200);
    assert.equal(Array.isArray(body), true);
    const issues = body as Array<Record<string, unknown>>;
    assert.equal(issues.length, 4);
    assert.equal(issues.some((issue) => issue.category === 'urgent' && issue.severity === 'high'), true);
    assert.equal(issues.some((issue) => issue.patientWords === 'I have felt dizzy since I came home.'), true);
  });

  await t.test('rejects malformed route inputs', async () => {
    const [reconcile, symptom, coverage] = await Promise.all([
      post('/api/demo/reconcile', {}),
      post('/api/demo/symptom', {}),
      post('/api/demo/coverage', {}),
    ]);
    assert.equal(reconcile.response.status, 400);
    assert.equal(symptom.response.status, 400);
    assert.equal(coverage.response.status, 400);
    assert.equal(object(reconcile.body).error, 'labelText, patientWords, and taking are required');
    assert.equal(object(symptom.body).error, 'patientWords is required');
    assert.equal(object(coverage.body).error, 'medicationName is required');
  });
});
