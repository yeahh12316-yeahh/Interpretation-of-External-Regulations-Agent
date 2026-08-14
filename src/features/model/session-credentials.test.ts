import { beforeEach, describe, expect, test } from 'vitest';

import { sessionCredentials } from './session-credentials';

describe('sessionCredentials', () => {
  beforeEach(() => {
    sessionStorage.clear();
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
});
