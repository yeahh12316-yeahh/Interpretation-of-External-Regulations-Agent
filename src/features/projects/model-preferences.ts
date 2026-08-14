import { projectDatabase } from './db';

export interface ModelPreferences {
  baseUrl: string;
  model: string;
}

export interface RememberModelPreferencesOptions {
  remember: boolean;
}

export const modelPreferences = {
  async save(
    preferences: ModelPreferences,
    options: RememberModelPreferencesOptions,
  ): Promise<void> {
    if (!options.remember) {
      await projectDatabase.modelPreferences.delete('model-endpoint');
      return;
    }

    await projectDatabase.modelPreferences.put({
      id: 'model-endpoint',
      baseUrl: preferences.baseUrl,
      model: preferences.model,
    });
  },

  async load(): Promise<ModelPreferences | null> {
    const stored = await projectDatabase.modelPreferences.get('model-endpoint');
    if (!stored) {
      return null;
    }

    return { baseUrl: stored.baseUrl, model: stored.model };
  },

  async clear(): Promise<void> {
    await projectDatabase.modelPreferences.delete('model-endpoint');
  },
};
