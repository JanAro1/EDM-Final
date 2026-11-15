/**
 * HL7 v2 inbound integration (the "siloed source systems" story).
 *
 *   POST /integrations/hl7/adt  — ADT^A01 patient admission/registration
 *   POST /integrations/hl7/oru  — ORU^R01 laboratory result
 *
 * Messages are parsed with simple-hl7, mapped onto the canonical schema, and
 * written transactionally. Every accepted message also lands an
 * `app.OutboxEvent` so downstream consumers can be notified (outbox pattern).
 */
import { Parser, type Message } from 'simple-hl7';
import { prisma, type Sex } from '@medidata/db';
import { ApiError } from '../lib/envelope.js';

const parser = new Parser();

export interface Hl7IngestResult {
  ack: 'AA';
  messageType: string;
  messageControlId: string | null;
  action: 'created' | 'updated';
  patientId: string;
  encounterId?: string;
  resultId?: string;
  outboxEventId: string;
}

function field(segment: { getField(index: number, repeatIndex?: number): string } | undefined, index: number): string {
  if (!segment) return '';
  const value = segment.getField(index);
  return typeof value === 'string' ? value.trim() : '';
}

function component(value: string, index: number): string {
  return (value.split('^')[index] ?? '').trim();
}

/** YYYYMMDD → Date (UTC midnight). */
function parseHl7Date(value: string): Date | null {
  if (!/^\d{8}$/.test(value)) return null;
  const d = new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** HL7 TS (YYYYMMDDHHMM[SS]) → Date. */
function parseHl7Timestamp(value: string): Date | null {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 12) return parseHl7Date(value);
  const iso = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}T${digits.slice(8, 10)}:${digits.slice(10, 12)}:${digits.slice(12, 14) || '00'}.000Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function sexOf(value: string): Sex {
  const code = value.toUpperCase();
  if (code === 'M' || code === 'MALE') return 'MALE';
  if (code === 'F' || code === 'FEMALE') return 'FEMALE';
  if (code === 'O' || code === 'OTHER') return 'OTHER';
  return 'UNKNOWN';
}

export function parseHl7(raw: string): Message {
  try {
    return parser.parse(raw);
  } catch (err) {
    throw new ApiError(400, 'INVALID_HL7', `Could not parse HL7 message: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function messageTypeOf(message: Message): string {
  // simple-hl7 stores MSH starting at MSH-3 (MSH-1/MSH-2 are the delimiters),
  // so MSH-9 (message type) is header field 7 and MSH-10 (control id) is 8.
  return field(message.header, 7) || 'UNKNOWN';
}

function controlIdOf(message: Message): string | null {
  const id = field(message.header, 8);
  return id || null;
}

/** ADT^A01 — register/update a patient and open an encounter. */
export async function ingestAdt(raw: string): Promise<Hl7IngestResult> {
  const message = parseHl7(raw);
  const messageType = messageTypeOf(message);
  if (!messageType.toUpperCase().startsWith('ADT')) {
    throw new ApiError(422, 'UNSUPPORTED_MESSAGE', `Expected an ADT message, received ${messageType}`);
  }

  const pid = message.getSegment('PID');
  if (!pid) throw new ApiError(422, 'MISSING_PID', 'ADT message has no PID segment');

  const mrn = component(field(pid, 3), 0);
  if (!mrn) throw new ApiError(422, 'MISSING_MRN', 'PID-3 (patient identifier) is required');

  const name = field(pid, 5);
  const lastName = component(name, 0) || 'UNKNOWN';
  const firstName = component(name, 1) || 'UNKNOWN';
  const middleName = component(name, 2);
  const dateOfBirth = parseHl7Date(field(pid, 7));
  if (!dateOfBirth) throw new ApiError(422, 'MISSING_DOB', 'PID-7 (date of birth) must be YYYYMMDD');

  const sex = sexOf(field(pid, 8));
  const addressParts = field(pid, 11).split('^');
  const phone = field(pid, 13) || field(pid, 14) || null;
  const city = (addressParts[2] ?? '').trim() || null;
  const address = (addressParts[0] ?? '').trim() || null;
  const fullNameNormalized = `${firstName} ${middleName ? `${middleName} ` : ''}${lastName}`
    .toUpperCase()
    .replace(/[.]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const existing = await prisma.patient.findUnique({ where: { mrn } });
  const patient = existing
    ? await prisma.patient.update({
        where: { id: existing.id },
        data: { firstName, lastName, fullNameNormalized, dateOfBirth, sex, phone, city, address },
      })
    : await prisma.patient.create({
        data: {
          mrn,
          firstName,
          lastName,
          fullNameNormalized,
          dateOfBirth,
          sex,
          phone,
          city,
          address,
          sourceSystem: 'EMR',
          externalId: mrn,
        },
      });

  // PV1-2 patient class (I=inpatient, O=outpatient, E=emergency); PV1-44 admit time.
  const pv1 = message.getSegment('PV1');
  const patientClass = field(pv1, 2).toUpperCase();
  const type = patientClass === 'I' ? 'INPATIENT' : patientClass === 'E' ? 'EMERGENCY' : 'OUTPATIENT';
  const admittedAt = parseHl7Timestamp(field(pv1, 44)) ?? new Date();
  const [provider, location] = await Promise.all([
    prisma.provider.findFirst({ orderBy: { npi: 'asc' } }),
    prisma.location.findFirst({ orderBy: { code: 'asc' } }),
  ]);
  if (!provider) throw new ApiError(409, 'NO_PROVIDER', 'No provider configured');
  if (!location) throw new ApiError(409, 'NO_LOCATION', 'No location configured');

  const encounter = await prisma.encounter.create({
    data: {
      patientId: patient.id,
      providerId: provider.id,
      locationId: location.id,
      type,
      status: 'ACTIVE',
      admittedAt,
      dischargedAt: null,
      diagnosisCode: 'Z00.00',
      diagnosisText: 'General examination (HL7 ADT)',
    },
  });

  const outbox = await prisma.outboxEvent.create({
    data: {
      aggregateType: 'Patient',
      aggregateId: patient.id,
      eventType: 'hl7.adt.received',
      payload: {
        mrn,
        messageType,
        messageControlId: controlIdOf(message),
        encounterId: encounter.id,
      },
    },
  });

  return {
    ack: 'AA',
    messageType,
    messageControlId: controlIdOf(message),
    action: existing ? 'updated' : 'created',
    patientId: patient.id,
    encounterId: encounter.id,
    outboxEventId: outbox.id,
  };
}

/** ORU^R01 — create/update a lab order + result for a patient. */
export async function ingestOru(raw: string): Promise<Hl7IngestResult> {
  const message = parseHl7(raw);
  const messageType = messageTypeOf(message);
  if (!messageType.toUpperCase().startsWith('ORU')) {
    throw new ApiError(422, 'UNSUPPORTED_MESSAGE', `Expected an ORU message, received ${messageType}`);
  }

  const pid = message.getSegment('PID');
  const obr = message.getSegment('OBR');
  const obx = message.getSegment('OBX');
  if (!pid) throw new ApiError(422, 'MISSING_PID', 'ORU message has no PID segment');
  if (!obx) throw new ApiError(422, 'MISSING_OBX', 'ORU message has no OBX segment');

  const mrn = component(field(pid, 3), 0);
  if (!mrn) throw new ApiError(422, 'MISSING_MRN', 'PID-3 (patient identifier) is required');
  const patient = await prisma.patient.findUnique({ where: { mrn } });
  if (!patient) throw new ApiError(404, 'PATIENT_NOT_FOUND', `No patient with MRN ${mrn}`);

  const testField = field(obx, 3) || field(obr, 4);
  const testCode = component(testField, 0) || 'UNKNOWN';
  const testName = component(testField, 1) || testCode;
  const rawValue = field(obx, 5);
  const numeric = rawValue !== '' && Number.isFinite(Number(rawValue)) ? Number(rawValue) : null;
  const unit = field(obx, 6) || 'unit';
  const referenceRange = field(obx, 7) || '';
  const flag = field(obx, 8).toUpperCase();
  const abnormalFlag = ['H', 'L', 'A', 'N'].includes(flag) ? (flag === 'N' ? null : flag) : null;
  const observedAt = parseHl7Timestamp(field(obx, 14)) ?? parseHl7Timestamp(field(obr, 7)) ?? new Date();
  const collectedAt = parseHl7Timestamp(field(obr, 7)) ?? observedAt;

  const provider = await prisma.provider.findFirst({ orderBy: { npi: 'asc' } });
  if (!provider) throw new ApiError(409, 'NO_PROVIDER', 'No provider configured');

  // Reuse an open order for the same patient/test, otherwise create one.
  const existingOrder = await prisma.labOrder.findFirst({
    where: { patientId: patient.id, testCode },
    orderBy: { orderedAt: 'desc' },
    include: { result: true },
  });
  const order =
    existingOrder ??
    (await prisma.labOrder.create({
      data: {
        patientId: patient.id,
        orderingProviderId: provider.id,
        testCode,
        testName,
        orderedAt: collectedAt,
        status: 'COMPLETED',
      },
    }));

  const resultData = {
    patientId: patient.id,
    testCode,
    valueNumeric: numeric,
    valueText: numeric === null ? rawValue || null : null,
    unit,
    referenceRange,
    abnormalFlag,
    collectedAt,
    resultedAt: observedAt,
    status: 'RELEASED' as const,
  };

  const result = existingOrder?.result
    ? await prisma.labResult.update({ where: { id: existingOrder.result.id }, data: resultData })
    : await prisma.labResult.create({ data: { ...resultData, orderId: order.id } });

  const outbox = await prisma.outboxEvent.create({
    data: {
      aggregateType: 'LabResult',
      aggregateId: result.id,
      eventType: 'hl7.oru.received',
      payload: {
        mrn,
        messageType,
        messageControlId: controlIdOf(message),
        testCode,
        value: rawValue,
        unit,
        abnormalFlag,
      },
    },
  });

  return {
    ack: 'AA',
    messageType,
    messageControlId: controlIdOf(message),
    action: existingOrder?.result ? 'updated' : 'created',
    patientId: patient.id,
    resultId: result.id,
    outboxEventId: outbox.id,
  };
}
