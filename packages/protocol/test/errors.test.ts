import { describe, expect, it } from 'vitest';

import { BridgeErrorSchema, ProtocolError, toProtocolError } from '../src/index.js';

describe('protocol errors', () => {
  it('serialises a stable, JSON-safe error', () => {
    const error = new ProtocolError('PROFILE_NOT_FOUND', 'Profile is missing', {
      details: { profile_id: 'unknown' },
    });

    expect(BridgeErrorSchema.parse(error.toJSON())).toEqual({
      protocol_version: 'bridge.dsh.dev/v1alpha1',
      code: 'PROFILE_NOT_FOUND',
      message: 'Profile is missing',
      retryable: false,
      details: { profile_id: 'unknown' },
    });
  });

  it('normalises validation failures', () => {
    const error = toProtocolError(new Error('backend exploded'));
    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.message).toBe('backend exploded');
  });
});
