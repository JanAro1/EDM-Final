/**
 * HL7 v2 inbound endpoints.
 *
 * Mounted BEFORE express.json() and parses the body as text, because HL7 is a
 * pipe-delimited text protocol, not JSON.
 */
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { ok } from '../lib/envelope.js';
import { ingestAdt, ingestOru } from './hl7.js';

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

const textBody = express.text({ type: ['text/*', 'application/hl7-v2', 'application/x-hl7', 'application/octet-stream'], limit: '2mb' });

function rawText(req: Request): string {
  const body = req.body as unknown;
  if (typeof body === 'string') return body;
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  return '';
}

export const integrationsRouter: Router = Router();

integrationsRouter.use(requireAuth, requirePermission('read', 'Hl7Inbound'));

// POST /integrations/hl7/adt — ADT^A01 registration/admission.
integrationsRouter.post('/hl7/adt', textBody, wrap((req) => ingestAdt(rawText(req)), 201));
// POST /integrations/hl7/oru — ORU^R01 laboratory result.
integrationsRouter.post('/hl7/oru', textBody, wrap((req) => ingestOru(rawText(req)), 201));
