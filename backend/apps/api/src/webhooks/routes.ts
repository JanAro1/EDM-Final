/**
 * Webhooks.
 *
 * Inbound (`POST /webhooks/lab-results`) is mounted BEFORE express.json() so it
 * receives the exact raw bytes and can verify an HMAC-SHA256 signature:
 *
 *     x-medidata-signature: sha256=<hex hmac of the raw body>
 *
 * Outbound deliveries are not pushed from this process; the worker drains
 * `app.OutboxEvent` (see apps/worker/src/jobs.ts#deliverOutbox). This route
 * exposes the delivery ledger for ops/UI.
 *
 * Demo note: `WEBHOOK_SECRET` is optional and falls back to JWT_SECRET. In
 * development an unsigned payload is accepted (flagged `signatureVerified:
 * false`); in production it is rejected with 401.
 */
import crypto from 'node:crypto';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { prisma } from '@medidata/db';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { ApiError, ok } from '../lib/envelope.js';

type Handler = (req: Request, res: Response, next: NextFunction) => Promise<void>;

const wrap =
  (fn: (req: Request) => Promise<unknown>, status = 200): Handler =>
  async (req, res, next) => {
    try {
      res.status(status).json(ok(await fn(req)));
    } catch (err) {
      next(err);
    }
  };

function signatureOf(req: Request): string | null {
  const header = req.headers['x-medidata-signature'] ?? req.headers['x-hub-signature-256'];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  return value.startsWith('sha256=') ? value.slice(7).trim() : value.trim();
}

/** Constant-time HMAC verification over the exact raw request bytes. */
export function verifySignature(raw: Buffer, signatureHex: string, secret = config.webhookSecret): boolean {
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const provided = signatureHex.toLowerCase();
  if (provided.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

function parseJson(raw: Buffer): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('body must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new ApiError(400, 'INVALID_BODY', `Webhook body must be a JSON object: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const webhooksRouter: Router = Router();

// POST /webhooks/lab-results — raw body, HMAC verified.
webhooksRouter.post(
  '/lab-results',
  express.raw({ type: '*/*', limit: '2mb' }),
  wrap(async (req) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : '');
    if (raw.length === 0) throw new ApiError(400, 'EMPTY_BODY', 'Webhook body is empty');

    const signature = signatureOf(req);
    const verified = signature ? verifySignature(raw, signature) : false;
    if (!verified && config.isProd) {
      throw new ApiError(401, 'INVALID_SIGNATURE', 'Missing or invalid webhook signature');
    }
    if (signature && !verified) {
      throw new ApiError(401, 'INVALID_SIGNATURE', 'Webhook signature does not match the request body');
    }

    const payload = parseJson(raw);
    const resultId = typeof payload.resultId === 'string' ? payload.resultId : typeof payload.id === 'string' ? payload.id : null;
    const status = typeof payload.status === 'string' ? payload.status : null;

    let updatedResultId: string | null = null;
    if (resultId) {
      const existing = await prisma.labResult.findUnique({ where: { id: resultId }, select: { id: true } });
      if (existing && status === 'RELEASED') {
        await prisma.labResult.update({
          where: { id: resultId },
          data: { status: 'RELEASED', releasedAt: new Date() },
        });
        updatedResultId = resultId;
      }
    }

    const event = await prisma.outboxEvent.create({
      data: {
        aggregateType: 'LabResult',
        aggregateId: resultId ?? 'unknown',
        eventType: 'webhook.lab_result.received',
        payload: { ...payload, signatureVerified: verified } as never,
      },
    });

    return {
      received: true,
      signatureVerified: verified,
      outboxEventId: event.id,
      updatedResultId,
    };
  }, 202),
);

// GET /webhooks/outbound/deliveries — outbox ledger (auth + WebhookOutbound read).
webhooksRouter.get(
  '/outbound/deliveries',
  requireAuth,
  requirePermission('read', 'WebhookOutbound'),
  wrap(async (req) => {
    const take = Math.min(500, Math.max(1, Number(req.query.limit ?? 100) || 100));
    const [total, rows] = await Promise.all([
      prisma.outboxEvent.count(),
      prisma.outboxEvent.findMany({ orderBy: { createdAt: 'desc' }, take }),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        eventType: r.eventType,
        aggregateType: r.aggregateType,
        aggregateId: r.aggregateId,
        createdAt: r.createdAt,
        publishedAt: r.publishedAt,
        status: r.publishedAt ? 'DELIVERED' : 'PENDING',
        payload: r.payload,
      })),
      total,
      take,
    };
  }),
);
