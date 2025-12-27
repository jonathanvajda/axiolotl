// axiolotl-query.js
// This file manages UI interactions and connects them to inference logic

// Dependencies
  // axiolotl-inference.js
    //  parseTurtle,
    //  serializeTurtle,
    //  getSelectedRulesFromCheckboxes,
    //  inferUntilStable
  // comunica-indexeddb-bridge.js
    //  parseIntoNamedGraph,
    //  loadGraphFromIndexedDB,
    //  stashGraphToIndexedDB
    //  detectRdfMimeByName
  // semantic-core.js
    //  debuggingConsoleEnabled
    //  showToast
    //  handleFileUpload
    //  readFileAsText
    //  toastFromQueryError(err)
    //  toastInfo
    //  toastSuccess
    //  toastError
    //  commonSPARQLPrefixes
    //  commonMIMEType
    //  getSelectedOutputMime (depends on commonMIMEType)
    //  downloadText


    // Where the ontology files live (folder that also contains ontology-list.json)
const CANON_ONTOLOGIES_BASE = 'ontology-files/' ;
const CANON_ONTOLOGIES_LIST = CANON_ONTOLOGIES_BASE + 'ontology-list.json' ;

/**
 * Build a fetchable ontology URL from a name or path
 * @param {*} name 
 * @returns {string} Absolute URL or path
 */
function buildOntologyUrlFromName(name) {
  if (!name) return '';
  if (/^[a-z]+:\/\//i.test(name) || name.startsWith('/')) return name; // already absolute
  return `${CANON_ONTOLOGIES_BASE.replace(/\/+$/,'')}/${String(name).replace(/^\/+/,'')}`;
}

// Treat JSON "None" (string) like null
function nullIfNone(v) {
  return (v == null || String(v).toLowerCase() === 'none') ? null : v;
}

// Assumes the commonSPARQLPrefixes enumerages the relevant dictionary
const defaultActivePrefixes = ['rdfs', 'owl', 'skos'];

/**
 * Update the RDF preview box from the last overlay graph
 * Assumes:
 * window.__lastOverlayGraph exists
 * element with id="rdf-preview" exists
 * getSelectedOutputMime() function exists
 * $rdf.serialize function exists
 * @returns 
 */
function updatePreviewFromOverlay() {
  const g = window.__lastOverlayGraph;
  const box = document.getElementById('rdf-preview');
  if (!g || !box) return;
  try {
    const mime = getSelectedOutputMime(); // turtle, n-triples, etc.
    const text = $rdf.serialize(null, g, 'http://example.org/', mime);
    box.value = text;
  } catch (e) {
    if (debuggingConsoleEnabled) {console.error('[updatePreviewFromOverlay] serialize error:', e);}
    box.value = `Serialization error: ${e && (e.message || e)}`;
  }
}

/** 
* Get/set active prefixes from localStorage
* Assumes:
*  localStorage is available
*  commonSPARQLPrefixes object exists
*  defaultActivePrefixes array exists
*  @returns {Array<string>} Array of active prefix keys
*/
function getActivePrefixes() {
  let active = localStorage.getItem('activePrefixes');
  if (active) {
    try { return JSON.parse(active); } catch {}
  }
  return defaultActivePrefixes;
}

function setActivePrefixes(prefixArr) {
  localStorage.setItem('activePrefixes', JSON.stringify(prefixArr));
  // Optionally save to IndexedDB as well
}

// Render the prefix bar with active prefixes and [manage prefixes] button
// Assumes:
//  element with id="prefix-bar" exists
//  commonSPARQLPrefixes object exists
//  getActivePrefixes() function exists
//  openPrefixModal() function exists
//  setActivePrefixes() function exists

function renderPrefixBar() {
  const bar = document.getElementById('prefix-bar');
  bar.innerHTML = '';
  getActivePrefixes().forEach(prefix => {
    if (commonSPARQLPrefixes[prefix]) {
      const prefixBtn = document.createElement('button');
      prefixBtn.textContent = `${prefix}`;
      prefixBtn.classList.add('prefix-button');
      bar.appendChild(prefixBtn);
    }
  });
  // Create [add prefix] button dynamically
  const addPrefixBtn = document.createElement('button');
  addPrefixBtn.textContent = 'manage prefixes';
  addPrefixBtn.classList.add('prefix-button');
  addPrefixBtn.onclick = openPrefixModal;
  bar.appendChild(addPrefixBtn);
}


function openPrefixModal() {
  const modal = document.getElementById('prefix-annotation-modal');
  const modalContent = modal.querySelector('.prefix-list');

  // (Re)render the inner controls
  modalContent.innerHTML = `
    <h3>Manage Prefixes</h3>
    <form id="prefix-toggle-form" style="display:flex; flex-wrap:wrap; justify-content:flex-start; align-items:flex-start;">
      ${Object.entries(commonSPARQLPrefixes).map(([key, value]) => {
        const checked = getActivePrefixes().includes(key) ? 'checked' : '';
        return `<label style="display:block;margin-bottom:0.5em;">
          <input type="checkbox" name="prefix" value="${key}" ${checked}>
          <b>${key}</b>: <span style="font-size:0.95em;">${value.replace(/^PREFIX\\s+\\w+:\\s+/, '')}</span>
        </label>`;
      }).join('')}
    </form>
    <div>
      <label for="edit-prefix-label">Prefix:</label>
      <input type="text" id="edit-prefix-label">
    </div>
    <div>
      <label for="edit-prefix-iri">IRI:</label>
      <input type="text" id="edit-prefix-iri">
    </div>
    <button id="save-prefix-edit">Add Prefix</button>
    <button id="save-prefixes-btn" style="float:right">Save to Active Workspace</button>
  `;

  modal.style.display = 'block';

  // Buttons INSIDE .prefix-list
  const addBtn = modalContent.querySelector('#save-prefix-edit');
  if (addBtn) {
    addBtn.onclick = (e) => {
      e.preventDefault();
      const label = modalContent.querySelector('#edit-prefix-label')?.value.trim();
      const iri   = modalContent.querySelector('#edit-prefix-iri')?.value.trim();
      if (label && iri) {
        commonSPARQLPrefixes[label] = `PREFIX ${label}: <${iri}>`;
        renderPrefixBar();
        modalContent.querySelector('#edit-prefix-label').value = '';
        modalContent.querySelector('#edit-prefix-iri').value = '';
      } else {
        alert('Both prefix label and IRI are required to add a new prefix.');
      }
    };
  }

  const saveBtn = modalContent.querySelector('#save-prefixes-btn');
  if (saveBtn) {
    saveBtn.onclick = (e) => {
      e.preventDefault();
      const checked = Array.from(modalContent.querySelectorAll('input[name="prefix"]:checked'))
        .map(cb => cb.value);
      setActivePrefixes(checked);
      modal.style.display = 'none';
      renderPrefixBar();
    };
  }

  // Close button is OUTSIDE .prefix-list (in your HTML header area)
  const closeBtn = modal.querySelector('#close-prefix-modal');
  if (closeBtn) {
    closeBtn.onclick = () => {
      modal.style.display = 'none';
      renderPrefixBar();
    };
  }
}

/**
 * Runs inference using selected rules and updates UI.
 */
async function handleRunInference() {
  try {
    const selectedRules = getSelectedRulesFromCheckboxes();
    const baseIRI = 'http://example.org/';
    const overlayIRI = `${baseIRI}overlay/inferred#${Date.now()}`;

    const { overlayGraph, metrics } = await inferUntilStable(selectedRules, baseIRI, overlayIRI);

    // Serialize and display preview
    const previewText = await serializeTurtle(overlayGraph);
    document.getElementById('rdf-preview').value = previewText;

    // Save overlay graph
    await stashGraphToIndexedDB(overlayGraph, 'named', overlayIRI);

    // Log metrics
    if (debuggingConsoleEnabled) {console.info('[handleRunInference] Inference metrics:', metrics);}
  } catch (error) {
    if (debuggingConsoleEnabled) {console.error('[handleRunInference] Failed:', error);}
  }
}

/**
 * Downloads current preview RDF as a file.
 * @param {string} format - MIME type (e.g., 'text/turtle')
 */
function handleDownloadPreview(format = 'text/turtle') {
  try {
    const text = document.getElementById('rdf-preview').value;
    const blob = new Blob([text], { type: format });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `inferred-overlay.${format.includes('json') ? 'jsonld' : format.includes('xml') ? 'rdf' : 'ttl'}`;
    a.click();
    URL.revokeObjectURL(url);
    if (debuggingConsoleEnabled) {console.info('[handleDownloadPreview] RDF download triggered');}
  } catch (error) {
    if (debuggingConsoleEnabled) {console.error('[handleDownloadPreview] Failed:', error);}
  }
}

// Populate the multi-select (or single-select) of graphs
async function renderGraphList() {
  const select = document.getElementById('graph-select');
  if (!select) return;           // nothing to render into

  const names = await getAllGraphNames();
  select.innerHTML = '';
  for (const iri of names) {
    const opt = document.createElement('option');
    opt.value = iri;
    opt.textContent = iri;
    select.appendChild(opt);
  }
}

// Get user choice of where to save inferred triples
function getSaveTarget() {
  const isNamed = document.getElementById('save-target-named')?.checked;
  if (isNamed) {
    return { mode: 'named', graphIRI: makeNamedGraphIRI('http://example.org/inferred') };
  }
  return { mode: 'default', graphIRI: null };
}

// Save inferred overlay graph to IndexedDB
async function runInference() {
try {
    const rules = getSelectedRulesFromCheckboxes();
    const { overlayGraph, metrics } = await inferUntilStable(rules);
    window.__lastOverlayGraph = overlayGraph;
    updatePreviewFromOverlay();

    const n = overlayGraph.statements.length;
    showToast(
      n ? `Inference finished — ${n} triple${n === 1 ? '' : 's'} materialized.` 
        : 'Inference finished — no new triples.',
      n ? 'success' : 'info'
    );
  } catch (err) {
    if (debuggingConsoleEnabled) {console.error('[run-inference] failed:', err);}
    showToast(`Inference error: ${err.message || err}`, 'error');
  }
};

// Insert overlay graph into SPARQL endpoint
async function saveOverlayToIndexedDB(overlayGraph, { mode, graphIRI }) {
  if (!overlayGraph) throw new Error('No overlay graph to save.');
  // one canonical write path (default or named)
  return await stashGraphToIndexedDB(overlayGraph, mode ?? 'default', graphIRI ?? null);
}

// Save inferred overlay graph to IndexedDB
async function saveInferredTriplesToDB() {
  try {
    const g = window.__lastOverlayGraph;
    if (!g) throw new Error('Nothing to save. Run inference first.');
    const target = getSaveTarget();
    const res = await saveOverlayToIndexedDB(g, target);
    showToast(`Saved ${res.count} triple${res.count === 1 ? '' : 's'} to ${res.graphIRI}.`, 'success');
  } catch (e) {
    if (debuggingConsoleEnabled) {console.error(e);}
    showToast(e.message || String(e), 'error');
  }
};

// Insert inferred overlay graph into SPARQL endpoint
async function insertInferredTriplesIntoEndpoint() {
  try {
      const g = window.__lastOverlayGraph;
      if (!g) throw new Error('Nothing to insert. Run inference first.');
      const endpointUrl = document.getElementById('endpoint-reference')?.value?.trim();
      const target = getSaveTarget();
      if (target.mode === 'named' && !target.graphIRI) {
        target.graphIRI = makeNamedGraphIRI('http://example.org/inferred');
      }
      await insertOverlayIntoEndpoint(g, endpointUrl, target);
      showToast('Inserted inferred data into SPARQL endpoint.', 'success');
    } catch (e) {
      if (debuggingConsoleEnabled) {console.error(e);}
      showToast(e.message || String(e), 'error');
    }
};

// Export inferred overlay graph as a file in chosen format
function exportInferredOverlay() {
  try {
    const g = window.__lastOverlayGraph;
    if (!g) throw new Error('Nothing to export. Run inference first.');
    const mime = getSelectedOutputMime();
    const text = serializeGraph(g, mime);
    const ext = ({
      'text/turtle': 'ttl',
      'application/n-triples': 'nt',
      'application/ld+json': 'jsonld',
      'application/rdf+xml': 'rdf'
    })[mime] || 'ttl';
    downloadText(`inferred-${timestampUTC()}.${ext}`, text, mime);
    showToast('Download started.', 'success');
  } catch (e) {
    if (debuggingConsoleEnabled) {console.error(e);}
    showToast(e.message || String(e), 'error');
  }
};

// Dynamically add file + IRI input rows
function createFileInputRow(index) {
  const row = document.createElement('div');
  row.classList.add('file-upload-row');
  row.style.marginBottom = '0.5em';

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.classList.add('rdf-file');
  fileInput.setAttribute('data-index', index);

  const iriInput = document.createElement('input');
  iriInput.type = 'text';
  iriInput.placeholder = "Named Graph IRI (leave blank for default)";
  iriInput.classList.add('graph-iri');
  iriInput.setAttribute('data-index', index);
  iriInput.style.marginLeft = '1em';
  iriInput.style.width = '40%';

  row.appendChild(fileInput);
  row.appendChild(iriInput);

  return row;
}

let fileRowCounter = 0;

// Add initial row on load
function addNewFileRow() {
  const container = document.getElementById('file-upload-container');
  const row = createFileInputRow(fileRowCounter++);
  container.appendChild(row);
}

// This function shows/hides the save/insert buttons based on reasoner source choice
function toggleReasonerButtons() {
  const useDB = document.getElementById('reasoner-source-indexeddb')?.checked;
  const saveBtn = document.getElementById('save-inferred-to-db');
  const insertBtn = document.getElementById('insert-inferred-to-endpoint');
  if (saveBtn)   saveBtn.style.display   = useDB ? '' : 'none';
  if (insertBtn) insertBtn.style.display = useDB ? 'none' : '';
}
// run at load + when radios change
['reasoner-source-indexeddb','reasoner-source-endpoint'].forEach(id=>{
  document.getElementById(id)?.addEventListener('change', toggleReasonerButtons);
});
toggleReasonerButtons();

// Event handlers
document.getElementById('run-inference')?.addEventListener('click', runInference);
document.getElementById('save-inferred-to-db')?.addEventListener('click', saveInferredTriplesToDB);
document.getElementById('insert-inferred-to-endpoint')?.addEventListener('click', insertInferredTriplesIntoEndpoint);
document.getElementById('export-inferred')?.addEventListener('click', exportInferredOverlay);
document.getElementById('output-format')?.addEventListener('change', updatePreviewFromOverlay);

// Event handler for adding new rows
document.getElementById('add-file-row').addEventListener('click', addNewFileRow);

document.getElementById('add-to-db').addEventListener('click', () => {
  const rows = document.querySelectorAll('.file-upload-row');
  const errors = [];
  const namedGraphError = document.getElementById('namedGraphError');
  addFilesToDB(rows, errors, namedGraphError);
});

// Flush all IndexedDB + localStorage for this app
document.getElementById('flush-active-workspace')?.addEventListener('click', flushActiveWorkspace);


// Auth type selector changes visible fields
document.getElementById('auth-type').addEventListener('change', () => {
  const authType = document.getElementById('auth-type').value;
  const container = document.getElementById('auth-fields');
  container.innerHTML = '';
  setAuthTypeFromSettings(authType, container);
});

// Set auth fields based on saved settings on load
async function setAuthTypeFromSettings (authType, container) {
  if (authType === 'basic') {
    container.innerHTML = `
      <input type="text" id="auth-username" placeholder="Username" style="width: 40%; margin-right: 1em;">
      <input type="password" id="auth-password" placeholder="Password" style="width: 40%;">
    `;
  } else if (authType === 'bearer') {
    container.innerHTML = `
      <input type="text" id="auth-token" placeholder="Bearer token" style="width: 80%;">
    `;
  } else if (authType === 'custom') {
    container.innerHTML = `
      <input type="text" id="auth-header-name" placeholder="Header Name (e.g., X-API-Key)" style="width: 40%; margin-right: 1em;">
      <input type="text" id="auth-header-value" placeholder="Header Value" style="width: 40%;">
    `;
  }
};



// Global variable to hold current auth headers for endpoint queries
let endpointAuthHeaders = {};

// Helper to read and trim input values
function readValue(id) { return (document.getElementById(id)?.value || '').trim(); }

// Set and persist SPARQL endpoint + auth settings
document.getElementById('set-endpoint-auth')?.addEventListener('click', async () => {
  const authType = readValue('auth-type');
  let headers = {};
  const toSave = { sparqlAuthType: authType }; // keys you can persist

  try {
    if (authType === 'none') {
      headers = {};
      // Clear any previously saved creds
      toSave.sparqlAuthToken = '';
      toSave.sparqlAuthUser  = '';
      toSave.sparqlAuthPass  = '';
      toSave.sparqlAuthHeaderName  = '';
      toSave.sparqlAuthHeaderValue = '';
    }

    else if (authType === 'basic') {
      const username = readValue('auth-username');
      const password = readValue('auth-password');
      if (!username || !password) throw new Error('Username and password are required for Basic auth.');
      headers = { 'Authorization': `Basic ${btoa(`${username}:${password}`)}` };
      toSave.sparqlAuthUser = username;
      toSave.sparqlAuthPass = password;
    }

    else if (authType === 'bearer') {
      // Support either #auth-token or legacy #endpoint-authentication
      const token = readValue('auth-token') || readValue('endpoint-authentication');
      if (!token) throw new Error('Token is required for Bearer auth.');
      headers = { 'Authorization': `Bearer ${token}` };
      toSave.sparqlAuthToken = token;
    }

    else if (authType === 'custom') {
      const name  = readValue('auth-header-name');
      const value = readValue('auth-header-value');
      if (!name || !value) throw new Error('Header name and value are required for Custom auth.');
      headers = { [name]: value };
      toSave.sparqlAuthHeaderName  = name;
      toSave.sparqlAuthHeaderValue = value;
    }

    // 1) make headers available to the query code
    endpointAuthHeaders = headers;

    // 2) persist settings (adjust if your saveSetting accepts only one key/value)
    for (const [k, v] of Object.entries(toSave)) {
      await saveSetting(k, v);
    }
    // Fire one event for the batch and repaint:
    try { notifyIdbChange?.({ db: 'SPARQLSettings', store: 'Settings', type: 'put' }); } catch {}
    await refreshSparqlStatus();

    // 3) UI feedback
    document.getElementById('current-endpoint-auth-status').textContent =
      authType === 'none' ? 'Auth disabled' : `Auth set for: ${authType}`;
    showToast(authType === 'none' ? 'Authentication disabled.' : `Authentication set: ${authType}`, 'success');

  } catch (e) {
    if (debuggingConsoleEnabled) {console.error('[set-endpoint-auth] failed:', e);}
    showToast(e.message || String(e), 'error');
  }
});

// Set and persist SPARQL endpoint URL
document.getElementById('set-endpoint')?.addEventListener('click', async () => {
  const endpoint = document.getElementById('endpoint-reference').value;
  await saveSetting('sparqlEndpoint', endpoint);

  // Tell listeners (and other tabs) that settings changed:
  try { notifyIdbChange?.({ db: 'SPARQLSettings', store: 'Settings', type: 'put', key: 'sparqlEndpoint' }); } catch {}

  // Paint immediately in this tab:
  await refreshSparqlStatus();

  document.getElementById('current-endpoint').textContent = `Current: ${endpoint}`;
});

// Call this whenever you switch tabs
function activateTab(panelId) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    const isActive = btn.dataset.tab === panelId;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    btn.tabIndex = isActive ? 0 : -1;
  });

  document.querySelectorAll('.tab-panel').forEach(p => {
    p.classList.toggle('active', p.id === panelId);
  });
}

// Initialize tab buttons
function initTabs() {
  const btns = document.querySelectorAll('.tab-btn');
  if (!btns.length) return;

  btns.forEach(btn => {
    btn.addEventListener('click', () => activateTab(btn.dataset.tab));
  });

  // Default: first tab or hash
  const initial = location.hash && document.getElementById(location.hash.slice(1))
    ? location.hash.slice(1)
    : btns[0].dataset.tab;

  activateTab(initial);
}

// UI event bindings
window.addEventListener('DOMContentLoaded', () => {
  initTabs();
  document.getElementById('file-upload')?.addEventListener('change', async (e) => {
    for (const file of e.target.files) {
      await handleFileUpload(file);
    }
  });
  renderOntologyList();
  document.getElementById('load-selected-ontologies')?.addEventListener('click', loadSelectedOntologiesToDB);
  renderGraphList();
  document.getElementById('download-overlay')?.addEventListener('click', () => handleDownloadPreview('text/turtle'));
});

window.addEventListener('DOMContentLoaded', async () => {
  // Load saved endpoint + auth settings
  const endpoint = await getSetting('sparqlEndpoint');
  if (endpoint) {
    document.getElementById('endpoint-reference').value = endpoint;
    document.getElementById('current-endpoint').textContent = `Current: ${endpoint}`;
  }
  // Auth type
  const token = await getSetting('sparqlAuthToken');
  if (token) {
    document.getElementById('endpoint-authentication').value = token;
    document.getElementById('current-endpoint-auth-status').textContent = 'Token loaded';
  }
  // Refresh status display
  await Promise.all([
    refreshSparqlStatus(),
    refreshWorkspaceStatus()
  ]);
});

// -- UI wire-up: read/write radios --
const $modeRead  = document.getElementById('mode-read');
const $modeWrite = document.getElementById('mode-write');
const $writeOpts = document.getElementById('write-options');

[$modeRead, $modeWrite].forEach(el=>{
  el?.addEventListener('change', ()=>{
    const isWrite = $modeWrite?.checked;
    if ($writeOpts) $writeOpts.style.display = isWrite ? '' : 'none';
  });
});

/**
 * Validate that query kind matches UI mode. Returns {ok:boolean,reason?:string}
 * Pure; logs for developer visibility.
 */
const validateModeVsQuery = (kind, mode) => {
  if (mode === 'read' && kind === 'UPDATE') {
    if (debuggingConsoleEnabled) {console.warn('[validateModeVsQuery] UPDATE blocked in Read mode');}
    return { ok:false, reason:'This query modifies data. Switch to Write mode.' };
  }
  if (mode === 'write' && kind !== 'UPDATE') {
    if (debuggingConsoleEnabled) {console.warn('[validateModeVsQuery] Read query blocked in Write mode');}
    return { ok:false, reason:'This is a read query. Switch to Read mode.' };
  }
  return { ok:true };
};

// ! This function is not yet called by anything !
// Summarize a query response so we can toast the right message.
function summarizeResults(results) {
  // Nothing / empty
  if (!results || (Array.isArray(results) && results.length === 0)) {
    return { kind: 'empty' };
  }

  // ASK: your DB path returns [{ ASK: { value: "true"|"false" } }]
  if (Array.isArray(results) && results[0] && results[0].ASK) {
    const val = String(results[0].ASK.value).toLowerCase() === 'true';
    return { kind: 'ask', value: val };
  }

  // CONSTRUCT/DESCRIBE (DB path): array of { nt: { value: line } }
  if (Array.isArray(results) && results[0] && results[0].nt) {
    return { kind: 'graph', tripleCount: results.length };
  }

  // SELECT (DB path via bindings array) – your current DB path normalizes to plain objects
  if (Array.isArray(results) && typeof results[0] === 'object' && !results[0].nt && !results[0].ASK) {
    return { kind: 'select', rowCount: results.length };
  }

  // Endpoint path returns plain bindings array (same detection as above)
  if (Array.isArray(results)) {
    return { kind: 'select', rowCount: results.length };
  }

  // Fallback
  return { kind: 'unknown' };
}

// Render query results into HTML table or appropriate format
function structureQueryResults(result) {
  // SELECT: new shape { vars, rows }
  if (result && Array.isArray(result.rows) && Array.isArray(result.vars)) {
    const { vars, rows } = result;
    if (rows.length === 0) return '<em>No results.</em>';

    let html = `<table><thead><tr>${vars.map(v => `<th>${v}</th>`).join('')}</tr></thead><tbody>`;
    for (const row of rows) {
      html += `<tr class="query-results-tr">` +
        vars.map(v => `<td class="query-results-td">${row[v]?.value ?? ''}</td>`).join('') +
        `</tr>`;
    }
    html += '</tbody></table>';
    return html;
  }

  // ASK (if you returned { kind:'ask', value })
  if (result && result.kind === 'ask') {
    return `<pre>${result.value ? 'true' : 'false'}</pre>`;
  }

  // Graph/Quads: your old path (array of { nt: { value } })
  if (Array.isArray(result) && result[0] && result[0].nt) {
    return `<pre>${result.map(x => x.nt.value).join('\n')}</pre>`;
  }

  // Legacy / fallback: previous array-of-bindings shape
  if (Array.isArray(result) && result.length) {
    const vars = Object.keys(result[0]);
    let html = `<table><thead><tr>${vars.map(v => `<th>${v}</th>`).join('')}</tr></thead><tbody>`;
    for (const row of result) {
      html += `<tr class="query-results-tr">` +
        vars.map(v => `<td class="query-results-td">${row[v]?.value ?? ''}</td>`).join('') +
        `</tr>`;
    }
    html += '</tbody></table>';
    return html;
  }

  return '<em>No results.</em>';
}

/**
 * Commit an UPDATE by materializing its delta:
 * - For each "delete preview" → compute quads and delete exact matches from IndexedDB.
 * - For each "insert preview" → compute quads and append to chosen graph (default/named).
 * Pure re inputs; side-effect is the intended IndexedDB mutation on success.
 * @param {string} updateStr
 * @param {'default'|'named'} targetMode
 * @returns {Promise<{deleted:number, inserted:number, graphIRI:string}>}
 */
const commitUpdateByMaterialization = async (updateStr, targetMode='default') => {
  const previews = makePreviewConstructs(updateStr);
  if (!previews.length) throw new Error('Unsupported UPDATE shape for commit.');

  // We separate delete-like vs insert-like by their labels
  const delQs = previews.filter(p=>/deleted/i.test(p.label)).map(p=>p.query);
  const insQs = previews.filter(p=>/inserted/i.test(p.label)).map(p=>p.query);

  let deleted = 0, inserted = 0;
  const graphIRI = (targetMode === 'named') ? makeNamedGraphIRI('http://example.org/updated') : null;

  // ---- apply deletes
  for (const q of delQs) {
    const nt = await runConstructPreview(q, 'application/n-triples');
    const triples = nt.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
      // naive NT line split: <s> <p> <o> .
      // For literals with spaces, a full N-Triples parser would be safer; keep simple but robust:
      const m = line.match(/^(\S+)\s+(\S+)\s+(.+)\s+\.\s*$/);
      if (!m) return null;
      const subj = m[1].replace(/^<|>$/g,'');
      const pred = m[2].replace(/^<|>$/g,'');
      // object could be IRI or literal; we store raw value as persisted in your schema
      let obj = m[3];
      let objectValue = obj.startsWith('<') ? obj.replace(/^<|>$/g,'')
                        : obj; // literals stay as-is (rdflib persisted literal.value)
      return { subject: subj, predicate: pred, object: objectValue, graph: '' }; // default graph key (deletes are exact)
    }).filter(Boolean);

    deleted += await deleteExactTriples(triples);
  }

  // ---- apply inserts
  if (insQs.length) {
    for (const q of insQs) {
      const ttl = await runConstructPreview(q, 'text/turtle');
      const overlay = $rdf.graph();
      await new Promise((resolve, reject) => {
        $rdf.parse(ttl, overlay, 'http://example.org/', 'text/turtle', err => err ? reject(err) : resolve());
      });
      await stashGraphToIndexedDB(overlay, targetMode, graphIRI);
      inserted += overlay.statements.length;
    }
  }

  return { deleted, inserted, graphIRI: graphIRI || '(default graph)' };
};

// Display results in the designated div
function displayQueryResults(resultsHtml) {
  const resultsDiv = document.getElementById('query-results');
  resultsDiv.innerHTML = resultsHtml;
}

// Get selected graphs from the multi-select
function getSelectedGraphsFromUI() {
  const graphSelect = document.getElementById('graph-select');
  if (graphSelect) {
    return Array.from(graphSelect.selectedOptions).map(opt => opt.value);
  }
  return [];
}

addNewFileRow(); // start with one row
renderPrefixBar(); // initial render of prefix bar

// Tab switching
document.querySelectorAll('.tab').forEach((tab, idx) => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.querySelectorAll('.tab-content')[idx].classList.add('active');
  };
});


/**
 * Loads ontology-list.json and renders the ontology selection list.
 */
async function renderOntologyList() {
  const listElem = document.getElementById('ontology-list');
  listElem.innerHTML = '<li>Loading...</li>';

  try {
    const resp = await fetch(CANON_ONTOLOGIES_LIST, { cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    const data = await resp.json();

    listElem.innerHTML = '';
    const seenLabels = {};

    data.forEach((entry, idx) => {
      const labelRaw =
        nullIfNone(entry['rdfs:label']) ??
        nullIfNone(entry['dcterms:title']) ??
        nullIfNone(entry['dc:title']) ??
        entry['file:name'] ??
        'Unknown';

      let label = labelRaw;
      if (seenLabels[label]) {
        const ver = nullIfNone(entry['owl:versionInfo']) ?? nullIfNone(entry['owl:versionIRI']) ?? idx;
        label += ` (${ver})`;
      }
      seenLabels[label] = true;

      const version  = nullIfNone(entry['owl:versionInfo']) ?? nullIfNone(entry['owl:versionIRI']) ?? '';
      const dataIri  = nullIfNone(entry['owl:ontologyIRI']) ?? '';
      const fileName = entry['file:name'] || '';
      const dataPath = buildOntologyUrlFromName(fileName);

      const warnMissing = !fileName || !dataPath;
      const li = document.createElement('li');
      li.style.marginLeft = '0.4em';
      li.style.marginBottom = '0.4em';
      li.innerHTML = `
        <label ${warnMissing ? 'style="color:red;" title="Missing file name"' : ''}>
          <input type="checkbox" class="ontology-checkbox"
                 data-path="${dataPath}"
                 data-iri="${dataIri}"
                 data-version="${version}">
          ${label}
        </label>
      `;
      listElem.appendChild(li);
    });
  } catch (e) {
    listElem.innerHTML = '<li style="color:red;">Failed to load ontology list.</li>';
    if (debuggingConsoleEnabled) {console.error('[renderOntologyList] Error:', e);}
    showToast('Failed to load ontology list.', 'error');
  }
}


/**
 * Live updates: initialize + listen for changes
 * 
 * We support two mechanisms:
 * 1) Custom DOM events your code can dispatch after writes:
 *    window.dispatchEvent(new CustomEvent('settings-changed'));
 *    window.dispatchEvent(new CustomEvent('triples-changed'));
 *
 * 2) Cross-tab notifications via BroadcastChannel 'idb-updates'
 */

const bc = 'BroadcastChannel' in window ? new BroadcastChannel('idb-updates') : null;

function notifyIdbChange(payload) {
  // Call this AFTER your own IDB writes to sync other tabs & listeners
  try { bc?.postMessage(payload); } catch {}
  try {
    const type = (payload?.store === 'Settings') ? 'settings-changed'
              : (payload?.store === 'triples') ? 'triples-changed'
              : 'idb-changed';
    window.dispatchEvent(new CustomEvent(type, { detail: payload }));
  } catch {}
}

// Listen for events
window.addEventListener('settings-changed', refreshSparqlStatus);
window.addEventListener('triples-changed', refreshWorkspaceStatus);

bc?.addEventListener('message', (evt) => {
  const { db, store } = evt.data || {};
  if (db === 'SPARQLSettings' && store === 'Settings') refreshSparqlStatus();
  if (db === 'inferenceDB' && store === 'triples') refreshWorkspaceStatus();
});

// PURE: decide what the SPARQL status should look like
function presentSparqlStatus(hasEndpoint) {
  return {
    text: hasEndpoint ? 'SPARQL Endpoint Assigned' : 'No SPARQL Endpoint Assigned',
    isOk: !!hasEndpoint
  };
}

// PURE: decide what the workspace status should look like
function presentWorkspaceStatus(tripleCount, namedGraphCount) {
  const t = Number(tripleCount) || 0;
  const g = Number(namedGraphCount) || 0;
  return {
    text: `Active Workspace: ${t} triple${t===1?'':'s'}, ${g} named graph${g===1?'':'s'}`,
    isOk: (t > 0 || g > 0)
  };
}

// IMPURE: apply a presentation to the SPARQL button
function renderSparqlStatus(pres) {
  const el = document.getElementById('sparql-endpoint-status');
  if (!el) return;
  el.textContent = pres.text;
  el.classList.toggle('status-ok',   pres.isOk);
  el.classList.toggle('status-idle', !pres.isOk);
}

// IMPURE: apply a presentation to the workspace button
function renderWorkspaceStatus(pres) {
  const el = document.getElementById('active-workspace-status');
  if (!el) return;
  el.textContent = pres.text;
  el.classList.toggle('status-ok',   pres.isOk);
  el.classList.toggle('status-idle', !pres.isOk);
}

// IMPURE: IO -> PURE -> DOM
// refresh SPARQL status from IndexedDB
async function refreshSparqlStatus() {
  const val = await getSetting('sparqlEndpoint');                // IO
  renderSparqlStatus(presentSparqlStatus(!!(val && val.trim()))); // PURE -> DOM
}
// refresh workspace status from IndexedDB
async function refreshWorkspaceStatus() {
  const triples = await getAllTriples();          // IO
  const names   = await getAllGraphNames();       // IO
  renderWorkspaceStatus(presentWorkspaceStatus(triples.length, names.length)); // PURE -> DOM
}

// Initial idle states
function instantIdleSparqlStatus() {
  renderSparqlStatus(presentSparqlStatus(false));
}
function instantIdleWorkspaceStatus() {
  renderWorkspaceStatus(presentWorkspaceStatus(0, 0));
}



/**
 * Loads selected ontologies into IndexedDB as named graphs.
 * Updates UI with success/error per ontology and a summary toast.
 * Assumes:
 * - fetch(), parseIntoNamedGraph(text, g, base, mime), storeTriplesInNamedGraph(triples)
 * - showToast(msg, level)
 * - detectRdfMimeByName(filename)
 * - renderGraphList() if defined
 * - debuggingConsoleEnabled global for logging 
 */
async function loadSelectedOntologiesToDB() {
  const checkboxes = document.querySelectorAll('.ontology-checkbox:checked');
  if (!checkboxes.length) {
    showToast('No ontologies selected.', 'info');
    return;
  }

  let ok = 0, err = 0;

  for (const cb of checkboxes) {
    const filePath = cb.getAttribute('data-path') || '';
    const labelEl  = cb.parentElement;

    if (!filePath) {
      err++; labelEl.style.color = 'red';
      showToast('Missing file path for a selected ontology.', 'error');
      continue;
    }

    try {
      const resp = await fetch(filePath, { cache: 'no-store' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const text = await resp.text();
      const mime = detectRdfMimeByName(filePath);
      const g = $rdf.graph();

      await parseIntoNamedGraph(text, g, null, mime); // default graph
      await storeTriplesInNamedGraph(g.statements);

      ok++;
      labelEl.style.fontWeight = 'bold';
      labelEl.style.color = '#007acc';
      showToast(`Loaded ${g.statements.length} triple(s) from ${filePath}`, 'success');
    } catch (e) {
      err++; labelEl.style.color = 'red';
      if (debuggingConsoleEnabled) {console.error(`[loadSelectedOntologiesToDB] Failed for ${filePath}:`, e);}
      showToast(`Failed to load ${filePath}: ${e.message}`, 'error');
    }
  }

  if (typeof renderGraphList === 'function') await renderGraphList();
  showToast(`Done: ${ok} loaded, ${err} failed.`, err ? 'error' : 'success');
}

// Handle special characters in HTML
function escapeHtml(s) {
  return String(s)
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;');
}

/**
 * Render a query error with possible hints into the results div.
 * @param {} err 
 * @returns 
 */
function renderQueryError(err) {
  const resultsDiv = document.getElementById('query-results');
  if (!resultsDiv) return;

  const raw = (err && (err.message || err.toString())) || 'Unknown error';

  // Friendly hints for the 3 cases you mentioned
  let hint = '';
  if (/Unknown prefix/i.test(raw)) {
    // Example: "Query error: Error: Unknown prefix: foo"
    const m = raw.match(/Unknown prefix:\s*([^\s"'`]+)/i);
    const missing = m ? m[1] : '(unknown)';
    hint = `Tip: add <code>PREFIX ${missing}: &lt;…&gt;</code> via the Prefix Bar or inline in your query.`;
  } else if (/Parse error on line\s+(\d+)/i.test(raw)) {
    const line = raw.match(/Parse error on line\s+(\d+)/i)[1];
    hint = `Tip: check syntax near line ${line} — common issues are missing <code>.</code>, unmatched braces, or stray commas.`;
  } else if (/no base IRI was set/i.test(raw)) {
    hint = `Tip: add <code>BASE &lt;http://example.org/&gt;</code> to the top, or avoid relative IRIs.`;
  }

  const html = `
    <div class="error-box" style="border:1px solid #c33; background:#fee; padding:10px; border-radius:8px;">
      <div style="font-weight:600; margin-bottom:6px;">Query error</div>
      <pre style="white-space:pre-wrap; margin:0 0 6px 0">${escapeHtml(raw)}</pre>
      ${hint ? `<div style="color:#900">${hint}</div>` : ''}
    </div>
  `;
  resultsDiv.innerHTML = html;
}

// Make callable from other modules if they need it
window.renderQueryError = renderQueryError;

/**
 * Run button handler (Read/Write aware with Preview/Commit for UPDATE).
 * - Builds the final query from active prefixes + editor text.
 * - Validates that the query kind (READ vs UPDATE) matches the chosen UI mode.
 * - READ mode:
 *    * If "endpoint" selected -> runQueryOnEndpoint and render as usual.
 *    * Else -> runQueryOnDatabase and render as usual.
 * - WRITE mode:
 *    * If action=Preview -> transforms UPDATE into 1..n CONSTRUCTs, runs each locally, renders serialized RDF.
 *    * If action=Commit -> materializes INSERT/DELETE deltas against IndexedDB and reports counts.
 *
 * Assumptions:
 *   getActivePrefixes(), buildQuery(prefixes, queryText), getSelectedGraphsFromUI(),
 *   runQueryOnEndpoint(endpoint, query), runQueryOnDatabase(selectedGraphs, query),
 *   structureQueryResults(response), displayQueryResults(html),
 *   renderQueryError(err), toastFromQueryError(err), showToast(msg, level)
 *
 * New helpers used (from our added module utilities):
 *   getQueryKind(q), validateModeVsQuery(kind, mode),
 *   makePreviewConstructs(updateStr), runConstructPreview(constructQuery, format),
 *   commitUpdateByMaterialization(updateStr, targetMode)
 */
document.getElementById('run-query').onclick = async () => {
  // ---- small local helper for preview rendering (pure string builder)
  const makePreviewHtml = (sections) => {
    // sections: Array<{label:string, text:string}>
    const esc = (s) => s; // caller passes plain text for <pre>; no HTML needed
    const blocks = sections.map(({ label, text }) =>
      `\n<h4 style="margin:.6em 0;">${label}</h4>\n<pre style="white-space:pre-wrap">${esc(text)}</pre>`
    );
    return blocks.join('\n');
  };

  try {
    if (debuggingConsoleEnabled) {console.info('[run-query] Start');}
    const prefixes       = getActivePrefixes();
    const queryText      = document.getElementById('sparql-query')?.value ?? '';
    const useEndpoint    = !!document.getElementById('endpoint-radio')?.checked;
    const selectedGraphs = getSelectedGraphsFromUI();

    // Read/Write UI state
    const isWriteMode    = !!document.getElementById('mode-write')?.checked;
    const writeAction    = (document.querySelector('input[name="write-action"]:checked')?.value) || 'preview';
    const targetMode     = (document.getElementById('update-target-graph')?.value === 'named') ? 'named' : 'default';
    const previewFormat  = document.getElementById('update-preview-format')?.value || 'text/turtle';

    // Build the final query (prefixes + user text)
    const query = buildQuery(prefixes, queryText);

    // Determine query kind and enforce mode
    const kind = getQueryKind(query); // 'READ' | 'UPDATE' | 'UNKNOWN'
    const { ok, reason } = validateModeVsQuery(kind, isWriteMode ? 'write' : 'read');
    if (!ok) {
      if (debuggingConsoleEnabled) {console.warn('[run-query] Mode validation failed:', reason);}
      showToast(reason, 'warning');
      return;
    }

    // -------------------------------------------------------------------
    // READ MODE
    // -------------------------------------------------------------------
    if (!isWriteMode) {
      if (debuggingConsoleEnabled) {console.info('[run-query] READ mode');}
      let response;

      if (useEndpoint) {
        if (debuggingConsoleEnabled) {console.info('[run-query] Using remote endpoint for READ');}
        const endpoint = document.getElementById('endpoint-reference')?.value ?? '';
        response = await runQueryOnEndpoint(endpoint, query); // expected { vars, rows } for SELECT
      } else {
        if (debuggingConsoleEnabled) {console.info('[run-query] Using local database for READ');}
        response = await runQueryOnDatabase(selectedGraphs, query); // your function handles SELECT (and possibly others)
      }

      // Render using your existing pipeline
      const resultsHtml = structureQueryResults(response);
      displayQueryResults(resultsHtml);

      // Optional: success toast for SELECT-like shapes
      const isSelect = response && Array.isArray(response.vars) && Array.isArray(response.rows);
      if (isSelect) {
        showToast(`Query finished — ${response.rows.length} row${response.rows.length === 1 ? '' : 's'}.`, 'success');
      } else {
        showToast('Query finished.', 'success');
      }
      return;
    }

    // -------------------------------------------------------------------
    // WRITE MODE
    // -------------------------------------------------------------------
    if (debuggingConsoleEnabled) {console.info('[run-query] WRITE mode');}

    // Guard: UPDATE queries against remote endpoints are not supported here (preview or commit).
    if (useEndpoint) {
      const msg = 'Update queries against a remote endpoint are not supported in this UI. Switch to local database.';
      if (debuggingConsoleEnabled) {console.warn('[run-query] Blocked UPDATE to endpoint');}
      showToast(msg, 'warning');
      return;
    }

    // Safety gate for CLEAR/DROP/LOAD/CREATE/COPY/MOVE/ADD
    if (/\b(CLEAR|DROP|LOAD|CREATE|COPY|MOVE|ADD)\b/i.test(query)) {
      const confirmed = window.confirm('This operation looks administrative/destructive. Are you sure you want to continue?');
      if (!confirmed) {
        showToast('Canceled.', 'info');
        return;
      }
    }

    if (writeAction === 'preview') {
      if (debuggingConsoleEnabled) {console.info('[run-query] UPDATE preview');}
      const constructs = makePreviewConstructs(query); // 0..n {label, query}
      if (!constructs.length) {
        showToast('No preview available for this UPDATE shape.', 'info');
        displayQueryResults('<p>No preview available for this UPDATE shape.</p>');
        return;
      }

      const sections = [];
      for (const c of constructs) {
        if (!c.query) {
          sections.push({ label: c.label, text: '(operation has no preview)' });
          continue;
        }
        const serialized = await runConstructPreview(c.query, previewFormat); // 'text/turtle' | 'application/n-triples'
        sections.push({ label: c.label, text: serialized || '(no matching triples)' });
      }

      displayQueryResults(makePreviewHtml(sections));
      showToast('Preview generated.', 'success');
      return;
    }

    // Commit (materialize against IndexedDB)
    if (writeAction === 'commit') {
      if (debuggingConsoleEnabled) {console.info('[run-query] UPDATE commit (materialization)', { targetMode });}
      const { inserted, deleted, graphIRI } = await commitUpdateByMaterialization(query, targetMode);
      const summary = `Committed update: +${inserted} inserted, -${deleted} deleted → ${graphIRI}.`;
      if (debuggingConsoleEnabled) {console.info('[run-query] Commit summary:', summary);}
      displayQueryResults(`<pre>${summary}</pre>`);
      showToast(summary, 'success');
      return;
    }

    // Fallback (shouldn’t happen)
    if (debuggingConsoleEnabled) {console.warn('[run-query] Unknown writeAction:', writeAction);}
    showToast('Unknown write action.', 'warning');

  } catch (err) {
    if (debuggingConsoleEnabled) {console.error('[run-query] Query error:', err);}
    renderQueryError(err);
    toastFromQueryError(err);
  } finally {
    if (debuggingConsoleEnabled) {console.info('[run-query] End');}
  }
};

document.getElementById('get-all-triples').addEventListener('click', function() {
    // This is the text you want to insert. It could be from a variable,
    // a data attribute, or even the placeholder itself.
    const suggestedText = "SELECT ?s ?p ?o WHERE { ?s ?p ?o } ## This may be slow, maybe LIMIT 100";
    
    // Set the value of the textbox.
    document.getElementById('sparql-query').value = suggestedText;
});