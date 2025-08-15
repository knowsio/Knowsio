export function renderPrompt({ contextSnippets, question }) {
  const context = (contextSnippets || []).map((s, i) => {
    const src = s.metadata?.source || s.id || `doc#${i+1}`;
    const body = (s.text || '').replace(/\s+/g, ' ').trim();
    return `- (${src}) ${body}`;
  }).join('\n');

  return `
You are a helpful assistant. Use ONLY the provided context. If information is missing, say what is missing and ask for it.

[CONTEXT]
${context}

[QUESTION]
${question}

[INSTRUCTIONS]
- Cite sources with their 'source' field in parentheses when relevant.
- Prefer concise step-by-step answers.
`.trim();
}
