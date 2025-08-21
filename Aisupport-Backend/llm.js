// llm.js
import axios from 'axios';

const P = (k, d='') => process.env[k] ?? d;

// llm-config.js
export const PROVIDERS = {
  OLLAMA: {
    label: 'Local (Ollama)',
    defaultModel: process.env.GEN_MODEL || 'llama3.2:3b-instruct-q4_0',
  },
  GROQ: {
    label: 'Groq (fast Llama)',
    defaultModel: 'llama-3.1-8b-instant',
  },
  OPENAI: {
    label: 'OpenAI',
    defaultModel: 'gpt-4o-mini',
  },
  MISTRAL: {
    label: 'Mistral',
    defaultModel: 'open-mixtral-8x7b',
  }
};

// (Optional) expose safe, non-secret info to the UI
export function listProviders() {
  return Object.entries(PROVIDERS).map(([key, v]) => ({
    key, label: v.label, defaultModel: v.defaultModel
  }));
}


export async function generateLLM({
  provider = P('PROVIDER','OLLAMA'),
  model = P('GEN_MODEL'),
  prompt,
  options = {},
  timeoutMs = parseInt(P('TIMEOUT_GENERATE') || '180000', 10) // 3m
}) {
  provider = provider.toUpperCase();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  const common = {
    temperature: options.temperature ?? 0.2,
    max_tokens: options.num_predict ?? 256
  };

  try {
    if (provider === 'OLLAMA') {
      const { data } = await axios.post(
        `${P('OLLAMA_URL')}/api/generate`,
        { model, prompt, options, stream: false },
        { signal: controller.signal }
      );
      return typeof data === 'string' ? data : (data.response ?? data);
    }

    if (provider === 'GROQ') {
      const { data } = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        { model, messages: [{ role: 'user', content: prompt }], ...common },
        { headers: { Authorization: `Bearer ${P('GROQ_API_KEY')}` }, signal: controller.signal }
      );
      return data.choices?.[0]?.message?.content ?? '';
    }

    if (provider === 'OPENAI') {
      const { data } = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        { model, messages: [{ role: 'user', content: prompt }], ...common },
        { headers: { Authorization: `Bearer ${P('OPENAI_API_KEY')}` }, signal: controller.signal }
      );
      return data.choices?.[0]?.message?.content ?? '';
    }

    if (provider === 'MISTRAL') {
      const { data } = await axios.post(
        'https://api.mistral.ai/v1/chat/completions',
        { model, messages: [{ role: 'user', content: prompt }], ...common },
        { headers: { Authorization: `Bearer ${P('MISTRAL_API_KEY')}` }, signal: controller.signal }
      );
      return data.choices?.[0]?.message?.content ?? '';
    }

    throw new Error(`Unsupported provider: ${provider}`);
  } finally {
    clearTimeout(timer);
  }
}
