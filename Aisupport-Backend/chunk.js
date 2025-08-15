// Simple word-based chunking (token-approx). Replace with tiktoken later if needed.
export function chunkText(text, { maxTokens = 700, overlapTokens = 120 } = {}) {
  const words = (text || '').split(/\s+/);
  const chunks = [];
  let i = 0;
  while (i < words.length) {
    const slice = words.slice(i, i + maxTokens).join(' ');
    if (slice.trim()) chunks.push(slice);
    i += Math.max(1, (maxTokens - overlapTokens));
  }
  return chunks;
}
