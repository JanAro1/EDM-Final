/**
 * Express application assembly (no listen — see server.ts).
 *
 * Middleware order matters:
 *   1. request context (pino-http, request ids)
 *   2. security headers + CORS + cookies
 *   3. rate limiting
 *   4. webhooks BEFORE express.json (raw-body HMAC verification)
 *   5. JSON body parsing
 *   6. optional auth attach + blanket mutation audit
 *   7. routes
 *   8. 404 + central error handler
 */
import './env.js';
import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { requestContext } from './middleware/requestContext.js';
import { apiLimiter } from './middleware/rateLimit.js';
import { attachAuth } from './middleware/auth.js';
import { auditMiddleware } from './middleware/audit.js';
import { errorMiddleware, notFoundHandler } from './middleware/errors.js';
import { openapiDocument } from './openapi.js';
import { webhooksRouter } from './webhooks/routes.js';
import { integrationsRouter } from './integrations/routes.js';
import { authRouter } from './modules/auth/routes.js';
import { patientsRouter } from './modules/patients/routes.js';
import { encountersRouter } from './modules/encounters/routes.js';
import { labsRouter } from './modules/labs/routes.js';
import { billingRouter } from './modules/billing/routes.js';
import { insuranceRouter } from './modules/insurance/routes.js';
import { portalRouter } from './modules/portal/routes.js';
import { governanceRouter } from './modules/governance/routes.js';
import { adminRouter } from './modules/admin/routes.js';
import { kpisRouter } from './modules/kpis/routes.js';
import { mlRouter } from './modules/ml/routes.js';
import { streamRouter } from './modules/stream/routes.js';
import { fhirRouter } from './fhir/routes.js';
import { ok } from './lib/envelope.js';

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(requestContext);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(
    cors({
      origin: config.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean),
      credentials: true,
    }),
  );
  app.use(cookieParser());
  app.use(apiLimiter);

  // Auth context must be attached before the raw-body routers so their
  // requireAuth guards can see the bearer token / session cookie.
  app.use(attachAuth);

  // Raw-body routes must be mounted before express.json().
  app.use('/webhooks', webhooksRouter);
  app.use('/integrations', integrationsRouter);

  app.use(express.json({ limit: '2mb' }));
  app.use(auditMiddleware);

  // Ops
  app.get('/health', (_req, res) => {
    res.status(200).json(ok({ ok: true, service: 'medidata-api', uptimeSeconds: Math.round(process.uptime()) }));
  });
  app.get('/openapi.json', (_req, res) => {
    res.status(200).json(openapiDocument);
  });

  // REST
  app.use('/api/auth', authRouter);
  app.use('/api/patients', patientsRouter);
  app.use('/api/encounters', encountersRouter);
  app.use('/api/labs', labsRouter);
  app.use('/api/billing', billingRouter);
  app.use('/api/insurance', insuranceRouter);
  app.use('/api/portal', portalRouter);
  app.use('/api/governance', governanceRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/kpis', kpisRouter);
  app.use('/api/ml', mlRouter);
  app.use('/api/stream', streamRouter);

  // FHIR R4 subset
  app.use('/fhir', fhirRouter);

  app.use(notFoundHandler);
  app.use(errorMiddleware);
  return app;
}

export const app: Express = createApp();
