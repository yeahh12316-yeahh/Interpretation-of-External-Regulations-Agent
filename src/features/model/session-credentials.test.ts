import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { sessionCredentials } from './session-credentials';

describe('sessionCredentials', () => {
  const originalSessionStorage = window.sessionStorage;

  beforeEach(() => {
    sessionCredentials.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      value: originalSessionStorage,
    });
    sessionCredentials.clear();
  });

  test('keeps model credentials in this browser session and can clear them', () => {
    sessionCredentials.set({
      baseUrl: 'https://model.example/v1',
      apiKey: 'secret-value',
      model: 'model-a',
    });

    expect(sessionCredentials.get()).toEqual({
      baseUrl: 'https://model.example/v1',
      apiKey: 'secret-value',
      model: 'model-a',
    });

    sessionCredentials.clear();
    expect(sessionCredentials.get()).toBeNull();
  });

  test('returns no credentials when session storage contains malformed data', () => {
    sessionStorage.setItem('external-regulation-agent:model-session', '{not-json');

    expect(sessionCredentials.get()).toBeNull();
  });

  test('falls back to memory when all session storage operations throw SecurityError', () => {
    const securityError = () => {
      throw new DOMException('Blocked in restricted privacy mode', 'SecurityError');
    };
    const throwingStorage: Storage = {
      length: 0,
      clear: securityError,
      getItem: securityError,
      key: securityError,
      removeItem: securityError,
      setItem: securityError,
    };
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      value: throwingStorage,
    });

    expect(() =>
      sessionCredentials.set({
        baseUrl: 'https://model.example/v1',
        apiKey: 'memory-only-value',
        model: 'model-a',
      }),
    ).not.toThrow();
    expect(() => sessionCredentials.get()).not.toThrow();
    expect(sessionCredentials.get()).toEqual({
      baseUrl: 'https://model.example/v1',
      apiKey: 'memory-only-value',
      model: 'model-a',
    });

    expect(() => sessionCredentials.clear()).not.toThrow();
    expect(sessionCredentials.get()).toBeNull();
  });
});
