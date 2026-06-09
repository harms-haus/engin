// ─── API Key Resolution ─────────────────────────────────────────────────────
import { findEnvKeys, getEnvApiKey } from '@earendil-works/pi-ai';

/**
 * Resolve an API key for the given provider.
 *
 * Resolution order:
 * 1. `customKeys[provider]` — caller-supplied overrides.
 * 2. `getEnvApiKey(provider)` — well-known environment variables (e.g. `OPENAI_API_KEY`).
 *
 * @returns The resolved key, or `undefined` when no key is found.
 */
export function resolveApiKey(provider: string, customKeys?: Record<string, string>): string | undefined {
  if (customKeys && provider in customKeys) {
    return customKeys[provider];
  }
  return getEnvApiKey(provider);
}

/**
 * Resolve an API key for the given provider, throwing when none is found.
 *
 * The error message includes environment-variable hints from `findEnvKeys` when
 * available, making it easier for the caller to diagnose missing configuration.
 */
export function resolveApiKeyOrThrow(provider: string, customKeys?: Record<string, string>): string {
  const key = resolveApiKey(provider, customKeys);
  if (key !== undefined) {
    return key;
  }

  const envKeys = findEnvKeys(provider);
  const envHint = envKeys && envKeys.length > 0 ? ` Expected environment variable: ${envKeys.join(', ')}.` : '';

  throw new Error(
    `No API key found for provider "${provider}".${envHint} Provide one via the customKeys option or set the appropriate environment variable.`,
  );
}
