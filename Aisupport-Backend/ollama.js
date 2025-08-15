import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const OLLAMA_URL = process.env.OLLAMA_URL;
const EMBED_MODEL = process.env.EMBED_MODEL;
const GEN_MODEL = process.env.GEN_MODEL;

export async function embed(text) {
  const { data } = await axios.post(`${OLLAMA_URL}/api/embeddings`, {
    model: EMBED_MODEL,
    prompt: text
  });
  return data.embedding; // array of numbers
}

export async function generate(prompt, { stream = false } = {}) {
  try {
    const res = await axios.post(`${process.env.OLLAMA_URL}/api/generate`, {
      model: process.env.GEN_MODEL, prompt, stream
    }, { responseType: stream ? 'stream' : 'json' });
    return res.data;
  } catch (err) {
    const detail = err.response?.data || err.message || err;
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
}
