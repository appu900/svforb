import { describe, expect, it } from '@jest/globals';
import {
  notificationIsTerminal,
  retryDelayMs,
  shouldRequeueRetryableTokens,
} from './notification-status';

describe('notificationIsTerminal', () => {
  it('treats sent / failed / partially_sent as done', () => {
    expect(notificationIsTerminal('sent')).toBe(true);
    expect(notificationIsTerminal('failed')).toBe(true);
    expect(notificationIsTerminal('partially_sent')).toBe(true);
  });

  it('lets queued and processing continue', () => {
    expect(notificationIsTerminal('queued')).toBe(false);
    expect(notificationIsTerminal('processing')).toBe(false);
    expect(notificationIsTerminal(undefined)).toBe(false);
  });
});

describe('shouldRequeueRetryableTokens', () => {
  it('allows the first two extra waves so a blip can still deliver', () => {
    expect(shouldRequeueRetryableTokens({ retryGeneration: 0, failureCount: 0 })).toBe(true);
    expect(shouldRequeueRetryableTokens({ retryGeneration: 1, failureCount: 0 })).toBe(true);
  });

  it('stops after two extra waves', () => {
    expect(shouldRequeueRetryableTokens({ retryGeneration: 2, failureCount: 0 })).toBe(false);
  });

  it('stops if failureCount already shows a storm', () => {
    expect(shouldRequeueRetryableTokens({ retryGeneration: 0, failureCount: 5 })).toBe(false);
    expect(shouldRequeueRetryableTokens({ retryGeneration: 0, failureCount: 56 })).toBe(false);
  });
});

describe('retryDelayMs', () => {
  it('backs off 15s then 30s', () => {
    expect(retryDelayMs(0)).toBe(15_000);
    expect(retryDelayMs(1)).toBe(30_000);
  });
});
