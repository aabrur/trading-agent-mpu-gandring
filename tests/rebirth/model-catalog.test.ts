import { describe, expect, it } from 'vitest';
import {
  MODEL_CHOICES,
  MODEL_KEY_ENV,
  MODEL_SOURCES,
  fetchLiveProviderModels
} from '../../server/v2/settings/model-catalog.js';
import { API_PROVIDERS } from '../../server/v2/settings/schema.js';

describe('T6 model catalog and verified provider models', () => {
  it('covers all ten API providers plus mock and local', () => {
    for (const provider of API_PROVIDERS) {
      expect(MODEL_CHOICES[provider]).toBeDefined();
      expect(MODEL_CHOICES[provider].length).toBeGreaterThan(0);
      expect(MODEL_CHOICES[provider].length).toBeLessThanOrEqual(25);
      expect(MODEL_KEY_ENV[provider]).toBeDefined();
      expect(MODEL_SOURCES[provider]).toBeDefined();
    }
    expect(MODEL_CHOICES.mock).toBeDefined();
    expect(MODEL_CHOICES.local).toBeDefined();
  });

  it('contains authentic model IDs including 2026 frontier and live ranking models', () => {
    const openaiIds = MODEL_CHOICES.openai.map((m) => m.id);
    expect(openaiIds).toContain('gpt-6-astra');
    expect(openaiIds).toContain('gpt-6.1-sol');
    expect(openaiIds).toContain('gpt-6-luna');
    expect(openaiIds).toContain('gpt-4o');

    const anthropicIds = MODEL_CHOICES.anthropic.map((m) => m.id);
    expect(anthropicIds).toContain('claude-opus-5-5');
    expect(anthropicIds).toContain('claude-sonnet-5-5');
    expect(anthropicIds).toContain('claude-3-7-sonnet-latest');

    const xaiIds = MODEL_CHOICES.xai.map((m) => m.id);
    expect(xaiIds).toContain('grok-4.7');
    expect(xaiIds).toContain('grok-2-latest');

    const deepseekIds = MODEL_CHOICES.deepseek.map((m) => m.id);
    expect(deepseekIds).toContain('deepseek-v4.1-flash');
    expect(deepseekIds).toContain('deepseek-chat');
  });

  it('provides 25 authentic models for openrouter matching live OpenRouter token usage rankings', () => {
    const openrouter = MODEL_CHOICES.openrouter;
    expect(openrouter).toHaveLength(25);

    const openrouterIds = openrouter.map((m) => m.id);

    // Live ranking from openrouter.ai/rankings (November 2026)
    expect(openrouterIds).toContain('deepseek/deepseek-v4.1-flash'); // #1 116T tokens
    expect(openrouterIds).toContain('deepseek/deepseek-v4.1-flash-1017'); // #2 79.4T tokens
    expect(openrouterIds).toContain('z-ai/glm-5.3-flash'); // #3 55.3T tokens
    expect(openrouterIds).toContain('tencent/hy4-preview'); // #4 35.5T tokens
    expect(openrouterIds).toContain('xiaomi/mimo-v2.6-flash'); // #5 34.1T tokens
    expect(openrouterIds).toContain('openai/gpt-6-luna'); // #6 32.8T tokens
    expect(openrouterIds).toContain('stepfun/step-5-preview'); // #7 29.4T tokens
    expect(openrouterIds).toContain('anthropic/claude-opus-5.5'); // #8 26.6T tokens (active model)
    expect(openrouterIds).toContain('stealth/space-bunny-alpha'); // #9 22.8T tokens
    expect(openrouterIds).toContain('nvidia/nemotron-3-ultra-550b-a55b:free'); // #10 22.8T tokens
    expect(openrouterIds).toContain('minimax/minimax-m3.1-flash:free'); // #13 13.7T tokens
    expect(openrouterIds).toContain('openai/gpt-6.1-sol'); // #18 10.6T tokens
    expect(openrouterIds).toContain('anthropic/claude-sonnet-5.5'); // #19 10.1T tokens

    // Frontier flagships
    expect(openrouterIds).toContain('google/gemini-4-argon');
    expect(openrouterIds).toContain('x-ai/grok-4.7');
    expect(openrouterIds).toContain('qwen/qwen-3.5-max');

    // Free tier endpoints
    const freeTier = openrouter.filter((m) => m.tags.includes('free tier'));
    expect(freeTier.length).toBeGreaterThanOrEqual(2);
  });

  it('fetchLiveProviderModels falls back gracefully when key is empty or offline', async () => {
    const res = await fetchLiveProviderModels('openai', '');
    expect(res.source).toBe('provider_documented');
    expect(res.models.map((m) => m.id)).toContain('gpt-4o');

    const resDeepseek = await fetchLiveProviderModels('deepseek', 'invalid-key');
    expect(resDeepseek.source).toBe('provider_documented');
    expect(resDeepseek.models).toHaveLength(6);
  });
});
