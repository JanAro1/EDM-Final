/**
 * End-to-end API smoke check (no network listener: supertest drives the app).
 *
 * Verifies the contract the web app depends on:
 *   • login → bearer token
 *   • /health + /openapi.json
 *   • paginated lists return Paged<T> with items[]
 *   • governance MDM queue returns real candidates
 *   • a steward can review a candidate, and non-stewards are forbidden
 *   • FHIR + integrations routes are mounted
 *
 * Any candidate reviewed here is reverted to PENDING afterwards so the demo
 * dataset stays in its "awaiting steward" state.
 */
import request from 'supertest';
import { prisma } from '@medidata/db';
import { app } from '../apps/api/src/app.js';

const PASSWORD = 'Passw0rd!123';

async function login(email: string): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
  if (res.status !== 200 || !res.body?.data?.token) {
    throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data.token as string;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function main(): Promise<void> {
  const checks: string[] = [];
  const check = (name: string): void => {
    checks.push(name);
    console.log(`  ok  ${name}`);
  };

  const health = await request(app).get('/health');
  assert(health.status === 200 && health.body?.data?.ok === true, 'health endpoint');
  check('GET /health');

  const openapi = await request(app).get('/openapi.json');
  assert(openapi.status === 200 && openapi.body?.openapi === '3.0.3', 'openapi document');
  assert(openapi.body?.paths?.['/api/governance/mdm/candidates']?.get, 'openapi lists MDM queue');
  check('GET /openapi.json');

  const adminToken = await login('admin@medidata.local');
  const analystToken = await login('analyst@medidata.local');
  const billerToken = await login('biller@medidata.local');
  check('POST /api/auth/login (admin, analyst, biller)');

  const me = await request(app).get('/api/auth/me').set('authorization', `Bearer ${adminToken}`);
  assert(me.status === 200 && me.body?.data?.user?.role === 'ADMIN', 'auth/me role');
  check('GET /api/auth/me');

  const patients = await request(app)
    .get('/api/patients?pageSize=5')
    .set('authorization', `Bearer ${adminToken}`);
  assert(patients.status === 200, `patients status ${patients.status}`);
  assert(Array.isArray(patients.body?.data?.items), 'patients returns Paged.items');
  assert(patients.body.data.items.length <= 5, 'patients honours pageSize');
  assert(typeof patients.body.data.total === 'number' && patients.body.data.total >= 100, 'patients total');
  check('GET /api/patients (Paged<T>)');

  const results = await request(app)
    .get('/api/labs/results?pageSize=3')
    .set('authorization', `Bearer ${adminToken}`);
  assert(Array.isArray(results.body?.data?.items), 'lab results returns Paged.items');
  check('GET /api/labs/results (Paged<T>)');

  const claims = await request(app)
    .get('/api/billing/claims?pageSize=3')
    .set('authorization', `Bearer ${adminToken}`);
  assert(Array.isArray(claims.body?.data?.items), 'claims returns Paged.items');
  check('GET /api/billing/claims (Paged<T>)');

  const quality = await request(app)
    .get('/api/governance/quality')
    .set('authorization', `Bearer ${adminToken}`);
  assert(quality.status === 200 && typeof quality.body?.data?.overallScore === 'number', 'quality scorecard');
  check('GET /api/governance/quality');

  const freshness = await request(app)
    .get('/api/governance/freshness')
    .set('authorization', `Bearer ${adminToken}`);
  assert(Array.isArray(freshness.body?.data), 'freshness array');
  check('GET /api/governance/freshness');

  const outcomes = await request(app)
    .get('/api/kpis/outcomes')
    .set('authorization', `Bearer ${adminToken}`);
  assert(outcomes.status === 200 && typeof outcomes.body?.data?.dqScore === 'number', 'outcome KPIs');
  check('GET /api/kpis/outcomes');

  const candidates = await request(app)
    .get('/api/governance/mdm/candidates')
    .set('authorization', `Bearer ${adminToken}`);
  assert(Array.isArray(candidates.body?.data), 'MDM candidates array');
  assert(candidates.body.data.length >= 1, 'MDM candidates present (run npm run pipeline)');
  const candidate = candidates.body.data[0];
  assert(candidate.leftPatient?.mrn && candidate.rightPatient?.mrn, 'candidate carries patient summaries');
  check(`GET /api/governance/mdm/candidates (${candidates.body.data.length} candidates)`);

  const forbidden = await request(app)
    .post(`/api/governance/mdm/candidates/${candidate.id}/review`)
    .set('authorization', `Bearer ${billerToken}`)
    .send({ decision: 'MERGED' });
  assert(forbidden.status === 403, `biller review must be 403, got ${forbidden.status}`);
  check('POST review as BILLER → 403');

  const reviewed = await request(app)
    .post(`/api/governance/mdm/candidates/${candidate.id}/review`)
    .set('authorization', `Bearer ${analystToken}`)
    .send({ decision: 'REJECTED' });
  assert(reviewed.status === 200 && reviewed.body?.data?.status === 'REJECTED', 'analyst can reject');
  check('POST review as ANALYST → 200 REJECTED');

  // Restore the queue to its awaiting-steward state.
  await prisma.mdmMergeCandidate.update({ where: { id: candidate.id }, data: { status: 'PENDING', reviewedAt: null, reviewedById: null } });

  const risk = await request(app)
    .get(`/api/ml/risk/${candidate.leftPatientId}`)
    .set('authorization', `Bearer ${adminToken}`);
  assert([200, 409].includes(risk.status), `risk status ${risk.status}`);
  check(`GET /api/ml/risk/:patientId → ${risk.status}`);

  const fhir = await request(app)
    .get('/fhir/Patient?_count=2')
    .set('authorization', `Bearer ${adminToken}`);
  assert(fhir.status === 200 && fhir.body?.resourceType === 'Bundle', 'FHIR Patient bundle');
  check('GET /fhir/Patient');

  const adt = await request(app)
    .post('/integrations/hl7/adt')
    .set('authorization', `Bearer ${adminToken}`)
    .set('content-type', 'text/plain')
    .send(
      [
        'MSH|^~\\&|SMOKE_EMR|MEDIDATA_HOSP|MEDIDATA_LIS|LAB|202405151030||ADT^A01^ADT_A01|SMOKE0001|P|2.5.1',
        'EVN|A01|202405151030',
        'PID|1||MRN-SMOKE-1^^^MEDIDATA_HOSP^MR||Smoke^Test||19900101|M|||1 Test St^^Manila^NCR^0100^PH||(632)555-0199',
        'PV1|1|O|QC^OPD-2^01||||1234567890^Ramos^Elena^^^Dr.|||Outpatient',
      ].join('\r'),
    );
  assert(adt.status === 201 && adt.body?.data?.ack === 'AA', `HL7 ADT ingest: ${adt.status} ${JSON.stringify(adt.body)}`);
  check('POST /integrations/hl7/adt (ADT^A01)');

  const oruPatient = await prisma.patient.findFirst({
    where: { mrn: { not: { startsWith: 'MRN-SMOKE' } } },
    orderBy: { mrn: 'asc' },
    select: { mrn: true },
  });
  assert(oruPatient, 'a seeded patient is required for the ORU check');
  const oru = await request(app)
    .post('/integrations/hl7/oru')
    .set('authorization', `Bearer ${adminToken}`)
    .set('content-type', 'text/plain')
    .send(
      [
        'MSH|^~\\&|SMOKE_LIS|MEDIDATA_LIS|MEDIDATA_HOSP|EMR|202405151030||ORU^R01^ORU_R01|SMOKEORU1|P|2.5.1',
        `PID|1||${oruPatient.mrn}^^^MEDIDATA_HOSP^MR||Smoke^Oru||19900101|F`,
        'OBR|1||SMOKE-ORD-1|SMOKE-ORU^Smoke Test^L|||202405151000',
        'OBX|1|NM|SMOKE-ORU^Smoke Test^L||7.2|mg/dL|3.5-9.0|H|||F|||202405151030',
      ].join('\r'),
    );
  assert(
    oru.status === 201 && oru.body?.data?.ack === 'AA' && oru.body?.data?.resultId,
    `HL7 ORU ingest: ${oru.status} ${JSON.stringify(oru.body)}`,
  );
  check('POST /integrations/hl7/oru (ORU^R01)');

  // Clean up the ORU result/order + outbox event created above.
  const oruResultId = oru.body.data.resultId as string;
  const oruResult = await prisma.labResult.findUnique({
    where: { id: oruResultId },
    select: { orderId: true },
  });
  await prisma.outboxEvent.deleteMany({ where: { aggregateId: oruResultId } });
  await prisma.labResult.deleteMany({ where: { id: oruResultId } });
  if (oruResult) await prisma.labOrder.deleteMany({ where: { id: oruResult.orderId } });

  // Clean up the smoke patient + encounter created by the HL7 message.
  const smoke = await prisma.patient.findUnique({ where: { mrn: 'MRN-SMOKE-1' } });
  if (smoke) {
    await prisma.encounter.deleteMany({ where: { patientId: smoke.id } });
    await prisma.outboxEvent.deleteMany({ where: { aggregateId: smoke.id } });
    await prisma.patient.delete({ where: { id: smoke.id } });
  }

  console.log(`\nAPI smoke: ${checks.length} checks passed.`);
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch(async (err: unknown) => {
    console.error('\nAPI smoke FAILED:', err instanceof Error ? err.stack ?? err.message : err);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  });
