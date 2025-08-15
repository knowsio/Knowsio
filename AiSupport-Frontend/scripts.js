function loadPage(page) {
  fetch(`${page}.html`)
    .then(response => response.text())
    .then(html => {
      const mount = document.getElementById('content');
      if (mount) mount.innerHTML = html;
      if (page === 'lotte' && typeof initLotte === 'function') initLotte();
      if (page === 'lara' && typeof initLara === 'function') initLara();
    });
}

window.onload = () => loadPage('lara');

// ---- Lotte logic (unchanged) ----
async function initLotte() {
  const list = document.getElementById('ticketList');
  const detail = document.getElementById('ticketDetail');
  if (!list || !detail) return;

  const res = await fetch('https://app-74077e00-3d50-4354-aeea-1cfd4127b0de.cleverapps.io/api/tickets');
  const tickets = await res.json();

  list.innerHTML = '';
  tickets.forEach((ticket) => {
    const li = document.createElement('li');
    li.className = 'py-2 cursor-pointer hover:bg-gray-100 px-2 rounded';
    li.innerHTML = `
      <div class="font-semibold">${ticket.subject}</div>
      <div class="text-sm text-gray-600">${ticket.date} - ${ticket.from}</div>
    `;
    li.onclick = () => {
      detail.innerHTML = `
        <h3 class="text-xl font-semibold mb-2">${ticket.subject}</h3>
        <p class="text-sm text-gray-600 mb-1">Van: ${ticket.from}</p>
        <p class="text-sm text-gray-600 mb-3">Datum: ${ticket.date}</p>
        <p class="mb-4"><strong>Beschrijving:</strong><br>${ticket.description}</p>
        <p class="mb-4"><strong>Antwoordvoorstel:</strong><br>${ticket.response}</p>
        <p class="mb-2"><strong>Voorgestelde taken:</strong></p>
        <ul class="list-disc list-inside mb-4">
          ${ticket.tasks.map(task => `<li>${task}</li>`).join('')}
        </ul>
        <button class="bg-blue-600 text-white px-4 py-2 rounded">Accepteer alle taken</button>
      `;
    };
    list.appendChild(li);
  });
}

// ---- Backend settings ----
const BACKEND_URL = 'http://localhost:8080';

// ---- Ask the backend (/ask) instead of Ollama directly ----
async function askBackend(question, orgId) {
  const res = await fetch(`${BACKEND_URL}/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question,
      org_id: orgId || undefined
    })
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// ---- KB uploader + chat wiring ----
function initLara() {
  // chat elements
  const input = document.getElementById('laraPrompt');
  const answer = document.getElementById('laraAnswer');
  const btn = document.getElementById('laraAskBtn');
  const status = document.getElementById('laraStatus');
  const citations = document.getElementById('laraCitations');

  // uploader elements
  const kbLayer = document.getElementById('kbLayer');
  const kbOrgId = document.getElementById('kbOrgId');
  const kbFiles = document.getElementById('kbFiles');
  const kbDrop = document.getElementById('kbDrop');
  const kbUploadBtn = document.getElementById('kbUploadBtn');
  const kbList = document.getElementById('kbList');
  const kbStatus = document.getElementById('kbStatus');

  // ---- chat (uses /ask -> RAG) ----
  async function go() {
    const q = (input?.value || '').trim();
    if (!q) { input?.focus(); return; }
    const orgId = (kbOrgId?.value || '').trim();

    btn.disabled = true;
    btn.classList.add('opacity-60', 'cursor-not-allowed');
    answer.textContent = '';
    citations.textContent = '';
    status.textContent = orgId ? `Zoekt in kennisbank van "${orgId}"…` : 'Zoekt in standaard kennisbank…';

    try {
      const data = await askBackend(q, orgId);
      answer.textContent = data.answer || '(geen antwoord)';
      if (Array.isArray(data.context) && data.context.length) {
        const s = data.context
          .map(c => c.source ? `(${c.source})` : `(${c.id})`)
          .join(' · ');
        citations.textContent = `Bronnen: ${s}`;
      } else {
        citations.textContent = '';
      }
      status.textContent = 'Klaar.';
    } catch (err) {
      status.textContent = '';
      answer.textContent = `⚠️ Fout bij /ask: ${err.message}`;
    } finally {
      btn.disabled = false;
      btn.classList.remove('opacity-60', 'cursor-not-allowed');
    }
  }
  btn?.addEventListener('click', go);
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); }
  });

  // ---- uploader helpers ----
  function addLog(text, cls = '') {
    const li = document.createElement('li');
    li.className = `border rounded p-2 ${cls}`;
    li.textContent = text;
    kbList?.appendChild(li);
    return li;
  }
  function requireOrgIdIfNeeded() {
    const need = kbLayer?.value === 'org';
    kbOrgId?.toggleAttribute('disabled', !need);
    kbOrgId?.classList.toggle('opacity-50', !need);
  }
  requireOrgIdIfNeeded();
  kbLayer?.addEventListener('change', requireOrgIdIfNeeded);

  // drag & drop
  kbDrop?.addEventListener('dragover', (e) => { e.preventDefault(); kbDrop.classList.add('ring'); });
  kbDrop?.addEventListener('dragleave', () => kbDrop.classList.remove('ring'));
  kbDrop?.addEventListener('drop', (e) => {
    e.preventDefault();
    kbDrop.classList.remove('ring');
    if (!e.dataTransfer?.files?.length) return;
    kbFiles.files = e.dataTransfer.files;
    addLog(`Geselecteerd: ${Array.from(kbFiles.files).map(f => f.name).join(', ')}`);
  });

  async function uploadOne(file, layer, orgId) {
    const url = new URL(BACKEND_URL + '/upload');
    url.searchParams.set('layer', layer);
    if (layer === 'org') url.searchParams.set('org_id', orgId);

    const fd = new FormData();
    fd.append('file', file);

    const row = addLog(`⬆️ Uploaden: ${file.name}…`);
    try {
      const res = await fetch(url, { method: 'POST', body: fd });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      row.textContent = `✅ ${file.name} — ${data.parts} delen opgeslagen`;
      row.classList.add('border-emerald-300', 'bg-emerald-50');
    } catch (e) {
      row.textContent = `⚠️ ${file.name} — ${e.message}`;
      row.classList.add('border-red-300', 'bg-red-50');
    }
  }

  async function uploadAll() {
    const files = kbFiles?.files || [];
    const layer = kbLayer?.value || 'domain';
    const orgId = (kbOrgId?.value || '').trim();

    if (!files.length) { kbStatus.textContent = 'Kies eerst bestand(en).'; return; }
    if (layer === 'org' && !orgId) { kbStatus.textContent = 'Vul org ID in.'; kbOrgId?.focus(); return; }

    kbStatus.textContent = 'Bezig met uploaden…';
    kbUploadBtn.disabled = true; kbUploadBtn.classList.add('opacity-60', 'cursor-not-allowed');
    try {
      for (const f of files) {
        await uploadOne(f, layer, orgId);
      }
      kbStatus.textContent = 'Klaar.';
    } finally {
      kbUploadBtn.disabled = false; kbUploadBtn.classList.remove('opacity-60', 'cursor-not-allowed');
    }
  }

  kbUploadBtn?.addEventListener('click', uploadAll);
}
