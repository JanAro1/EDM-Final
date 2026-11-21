/** Connector registry — the siloed source systems of the MediData demo. */
import { IS_BILLING_SCOPE } from '@medidata/shared';
import type { Connector } from '../types.js';
import { emrConnector } from './emr.js';
import { lisConnector } from './lis.js';
import { billingConnector } from './billing.js';
import { insuranceConnector } from './insurance.js';
import { legacyConnector } from './legacy.js';

export { defaultFixturesDir } from '../paths.js';

export { emrConnector, lisConnector, billingConnector, insuranceConnector, legacyConnector };

export const CONNECTOR_NAMES = ['emr', 'lis', 'billing', 'insurance', 'legacy'] as const;
export type ConnectorName = (typeof CONNECTOR_NAMES)[number];

/**
 * Connectors enabled for the active scope profile. On the `billing` profile the
 * platform ingests only the billing source; `full` keeps all five.
 */
export const ACTIVE_CONNECTOR_NAMES: readonly ConnectorName[] = IS_BILLING_SCOPE
  ? ['billing']
  : CONNECTOR_NAMES;

const FACTORIES: Record<ConnectorName, (fixturesDir?: string) => Connector> = {
  emr: emrConnector,
  lis: lisConnector,
  billing: billingConnector,
  insurance: insuranceConnector,
  legacy: legacyConnector,
};

export function getConnector(name: ConnectorName, fixturesDir?: string): Connector {
  const factory = FACTORIES[name];
  if (!factory) throw new Error(`Unknown connector: ${name}`);
  return factory(fixturesDir);
}

/** All connectors for the active scope profile, in deterministic order. */
export function allConnectors(fixturesDir?: string): Connector[] {
  return ACTIVE_CONNECTOR_NAMES.map((n) => getConnector(n, fixturesDir));
}
