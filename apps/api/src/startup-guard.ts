import { existsSync } from 'node:fs';

export function assertActiveNode(markerPath: string): void {
  if (existsSync(markerPath)) {
    throw new Error(`failover marker exists at ${markerPath}; refusing to start API`);
  }
}
