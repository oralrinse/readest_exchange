import { opdsCatalogAdapter } from './adapters/opdsCatalog';
import { settingsAdapter } from './adapters/settings';
import { getReplicaAdapter, registerReplicaAdapter } from './replicaRegistry';
import type { ReplicaAdapter } from './replicaRegistry';

// Only metadata-only kinds replicate now. The binary-bearing kinds
// (dictionary / font / texture) stopped replicating when Readest Cloud
// storage was removed — their files had nowhere to live on the wire.
const KNOWN_ADAPTERS: ReplicaAdapter<unknown>[] = [
  // Metadata-only — no binary download handler needed.
  opdsCatalogAdapter as unknown as ReplicaAdapter<unknown>,
  // Bundled scalar settings — singleton row, no binary.
  settingsAdapter as unknown as ReplicaAdapter<unknown>,
];

let didBootstrap = false;

export const bootstrapReplicaAdapters = (): void => {
  if (didBootstrap) return;
  for (const adapter of KNOWN_ADAPTERS) {
    if (getReplicaAdapter(adapter.kind)) continue;
    registerReplicaAdapter(adapter);
  }
  didBootstrap = true;
};

export const __resetBootstrapForTests = (): void => {
  didBootstrap = false;
};
