/**
 * OpenAPI 3.0 document generated from the canonical ENDPOINTS map.
 *
 * This is intentionally generated rather than hand-maintained: the contract in
 * @medidata/shared is the single source of truth, so a new endpoint can never
 * be missing from the docs. Schemas are described at a high level (the zod
 * schemas remain the runtime authority).
 */
import { ENDPOINTS } from '@medidata/shared';

type Endpoint = { path: string; method: 'GET' | 'POST' | 'GET+POST' };

const TAG_FOR = (path: string): string => {
  if (path.startsWith('/api/auth')) return 'Auth';
  if (path.startsWith('/api/patients')) return 'Patients';
  if (path.startsWith('/api/encounters')) return 'Encounters';
  if (path.startsWith('/api/labs')) return 'Labs';
  if (path.startsWith('/api/billing')) return 'Billing';
  if (path.startsWith('/api/insurance')) return 'Insurance';
  if (path.startsWith('/api/portal')) return 'Portal';
  if (path.startsWith('/api/governance')) return 'Governance';
  if (path.startsWith('/api/admin')) return 'Admin';
  if (path.startsWith('/api/kpis')) return 'KPIs';
  if (path.startsWith('/api/ml')) return 'ML';
  if (path.startsWith('/api/stream')) return 'Streaming';
  if (path.startsWith('/fhir')) return 'FHIR';
  if (path.startsWith('/integrations')) return 'Integrations';
  if (path.startsWith('/webhooks')) return 'Webhooks';
  return 'Ops';
};

const SUMMARY: Record<string, string> = {
  authLogin: 'Authenticate and receive a JWT (also sets the httpOnly cookie)',
  authLogout: 'Clear the auth cookie',
  authMe: 'Current user + CASL capability map',
  patients: 'Paginated patient index (role-masked, q= search)',
  patient360: 'Patient 360 aggregate (encounters, labs, claims, consents)',
  encounters: 'Paginated encounters',
  labOrders: 'List or create lab orders',
  labResults: 'Paginated lab results with TAT filters',
  labResultReview: 'Mark a result reviewed',
  labResultRelease: 'Release a reviewed result to the patient portal',
  claims: 'Paginated claims',
  invoices: 'Encounter-grouped invoice totals',
  insurancePolicies: 'Derived insurance policies',
  insuranceEligibility: 'Coverage eligibility for one patient',
  portalRecords: 'Self-scoped patient portal record bundle',
  portalResultDownload: 'Download a released result PDF',
  portalConsent: 'List or toggle portal consents',
  governanceCatalog: 'Data catalog with stewards',
  governanceGlossary: 'Business glossary',
  governanceLineage: 'Lineage nodes + recent pipeline runs',
  governanceQuality: 'Latest DQ scorecard',
  governanceFreshness: 'Freshness SLA status',
  governanceAudit: 'Audit trail (AUDITOR/ADMIN)',
  governanceMdmCandidates: 'MDM merge-review queue',
  governanceMdmCandidateReview: 'Approve or reject a merge candidate',
  adminUsers: 'List or create users',
  kpisOutcomes: 'Before/after outcome KPIs',
  mlRisk: 'DQ-gated patient risk score with top factors',
  streamEvents: 'Server-sent events feed',
  fhirPatient: 'FHIR R4 Patient search',
  fhirEncounter: 'FHIR R4 Encounter search',
  fhirObservation: 'FHIR R4 Observation search',
  fhirClaim: 'FHIR R4 Claim search',
  hl7Adt: 'Inbound HL7 v2 ADT (A01)',
  hl7Oru: 'Inbound HL7 v2 ORU (R01) lab results',
  webhooksLabResults: 'Inbound lab-result webhook (HMAC signed)',
  webhookOutboundDeliveries: 'Outbox / outbound webhook deliveries',
  openapi: 'This document',
  health: 'Liveness probe',
};

function parametersFor(path: string): Array<Record<string, unknown>> {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => ({
    name: m[1],
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));
}

function operationFor(key: string, endpoint: Endpoint, method: 'get' | 'post'): Record<string, unknown> {
  const operation: Record<string, unknown> = {
    operationId: `${key}_${method}`,
    summary: SUMMARY[key] ?? key,
    tags: [TAG_FOR(endpoint.path)],
    parameters: parametersFor(endpoint.path),
    responses: {
      '200': { description: 'Success (ApiEnvelope)' },
      '400': { description: 'Validation error' },
      '401': { description: 'Unauthenticated' },
      '403': { description: 'Forbidden' },
      '404': { description: 'Not found' },
    },
  };
  const publicPath = endpoint.path.startsWith('/webhooks') || endpoint.path === '/health' || endpoint.path === '/openapi.json';
  if (!publicPath) operation.security = [{ bearerAuth: [] }];
  if (method === 'post') {
    operation.requestBody = {
      required: true,
      content: { 'application/json': { schema: { type: 'object' } } },
    };
  }
  return operation;
}

function buildPaths(): Record<string, Record<string, unknown>> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [key, endpoint] of Object.entries(ENDPOINTS) as Array<[string, Endpoint]>) {
    const openApiPath = endpoint.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    const item = paths[openApiPath] ?? (paths[openApiPath] = {});
    const methods: Array<'get' | 'post'> =
      endpoint.method === 'GET+POST' ? ['get', 'post'] : [endpoint.method === 'GET' ? 'get' : 'post'];
    for (const method of methods) item[method] = operationFor(key, endpoint, method);
  }
  return paths;
}

export const openapiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'MediData API',
    version: '0.1.0',
    description:
      'Enterprise data-management platform for healthcare. All data is SYNTHETIC — no real PHI. ' +
      'Every JSON response uses the { success, data } / { success, error } envelope.',
    license: { name: 'Educational project' },
  },
  servers: [{ url: 'http://localhost:4000', description: 'Local development' }],
  tags: [
    'Auth', 'Patients', 'Encounters', 'Labs', 'Billing', 'Insurance', 'Portal',
    'Governance', 'Admin', 'KPIs', 'ML', 'Streaming', 'FHIR', 'Integrations', 'Webhooks', 'Ops',
  ].map((name) => ({ name })),
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
  },
  paths: buildPaths(),
} as const;

export type OpenApiDocument = typeof openapiDocument;
