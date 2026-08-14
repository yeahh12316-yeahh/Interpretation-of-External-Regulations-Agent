export interface SessionCredentials {
  baseUrl: string;
  apiKey: string;
  model: string;
}

const STORAGE_KEY = 'external-regulation-agent:model-session';
let inMemoryCredentials: SessionCredentials | null = null;

const isSessionCredentials = (value: unknown): value is SessionCredentials => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.baseUrl === 'string' &&
    typeof candidate.apiKey === 'string' &&
    typeof candidate.model === 'string'
  );
};

const availableSessionStorage = (): Storage | null => {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
};

export const sessionCredentials = {
  set(credentials: SessionCredentials): void {
    inMemoryCredentials = {
      baseUrl: credentials.baseUrl,
      apiKey: credentials.apiKey,
      model: credentials.model,
    };
    availableSessionStorage()?.setItem(STORAGE_KEY, JSON.stringify(inMemoryCredentials));
  },

  get(): SessionCredentials | null {
    const storage = availableSessionStorage();
    const serialized = storage?.getItem(STORAGE_KEY);
    if (serialized !== null && serialized !== undefined) {
      try {
        const parsed: unknown = JSON.parse(serialized);
        if (!isSessionCredentials(parsed)) {
          return null;
        }
        inMemoryCredentials = {
          baseUrl: parsed.baseUrl,
          apiKey: parsed.apiKey,
          model: parsed.model,
        };
        return { ...inMemoryCredentials };
      } catch {
        return null;
      }
    }
    return inMemoryCredentials ? { ...inMemoryCredentials } : null;
  },

  clear(): void {
    inMemoryCredentials = null;
    availableSessionStorage()?.removeItem(STORAGE_KEY);
  },
};
