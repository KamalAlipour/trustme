import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertActiveNode } from '../src/startup-guard.js';

describe('API startup guard', () => {
  it('refuses to start when the failover marker exists', () => {
    const directory = mkdtempSync(join(tmpdir(), 'trustme-api-'));
    const marker = join(directory, 'FAILED_OVER');
    writeFileSync(marker, 'standby\n');
    expect(() => assertActiveNode(marker)).toThrow(`failover marker exists at ${marker}`);
  });

  it('allows startup when the failover marker is absent', () => {
    const directory = mkdtempSync(join(tmpdir(), 'trustme-api-'));
    expect(() => assertActiveNode(join(directory, 'FAILED_OVER'))).not.toThrow();
  });
});
