// axiolotl-query.js
// This file manages UI interactions and connects them to inference logic

import {
  clearInferenceConsole,
  getSelectedRulesFromCheckboxes,
  inferUntilStable,
  setInferenceBusy
} from './axiolotl-inference.js';
import {
  buildQuery,
  clearActiveSavedQueries,
  clearActiveSettings,
  clearActiveTriples,
  flushActiveWorkspace,
  isAbsoluteIri,
  loadGraphFromIndexedDB,
  makeNamedGraphIRI,
  makePreviewConstructs,
  getQueryKind,
  parseRdfTextToGraph,
  runConstructPreview,
  runQueryOnLocalDataset,
  stashGraphToIndexedDB
} from './comunica-indexeddb-bridge.js';
import {
  clearSavedQueries,
  deleteExactTriples,
  deleteSavedQuery,
  exportSavedQueriesAsCsv,
  exportSavedQueriesAsJsonLd,
  getAllSavedQueries,
  getSetting,
  importSavedQueriesFromCsv,
  saveSavedQuery,
  saveSetting,
  storeTriplesInNamedGraph
} from './indexeddb-triplestore.js';
import { COMMON_NAMESPACE_IRIS } from './shared/namespace-registry/index.js';
import {
  commonSPARQLPrefixes,
  debuggingConsoleEnabled,
  showToast,
  toastFromQueryError
} from './semantic-core.js';
import { downloadTextFile, readFileAsText } from './shared/browser-file-io/index.js';
import {
  serializeWorkspaceExport
} from './axiolotl-workspace-export.js';
import {
  getMimeTypeForFormatKey,
  getPreferredExtensionForMimeType,
  getRdfAdapterDescriptorForMimeType,
  getSupportedMimeTypeForFilename,
  rdfSerializationPreservesNamedGraphs
} from './shared/format-registry/index.js';
import {
  serializeRdfGraphExport,
  parseRdfTextWithAdapters,
  serializeRdfDatasetWithAdapters
} from './shared/rdf-io/index.js';
import { createUuid } from './shared/ontology-utils/index.js';
import { inspectOntologyDataset } from './shared/ontology-metadata/index.js';
import { applySparqlUpdateToQuadStore } from './shared/sparql-utils/index.js';

// Assumes the commonSPARQLPrefixes enumerages the relevant dictionary
const defaultActivePrefixes = ['rdfs', 'owl', 'skos'];
const ACTIVE_PREFIXES_SETTING_KEY = 'activePrefixes';
let activePrefixesCache = [...defaultActivePrefixes];

/**
 * Update the RDF preview box from the last overlay graph
 * Assumes:
 * window.__lastOverlayGraph exists
 * element with id="rdf-preview" exists
 * getSelectedOutputMime() function exists
 * @returns 
 */
async function updatePreviewFromOverlay() {
  const g = window.__lastOverlayGraph;
  const box = document.getElementById('rdf-preview');
  if (!g || !box) return;

  try {
    const mime = getSelectedOutputMime();
    const text = await serializeStore(g, mime);
    box.value = text;
  } catch (e) {
    if (debuggingConsoleEnabled) {
      console.error('[updatePreviewFromOverlay] serialize error:', e);
    }
    box.value = `Serialization error: ${e && (e.message || e)}`;
  }
}

async function serializeStore(store, mime = 'text/turtle') {
  if (!store || typeof store.getQuads !== 'function') {
    throw new Error('serializeStore expected an N3.Store or compatible RDF/JS source.');
  }

  const serialized = await serializeRdfGraphExport(store, {
    scope: 'all',
    format: mime,
    runtime: { N3, jsonld: globalThis.jsonld, $rdf: globalThis.$rdf }
  });
  return serialized.text;
}

async function serializeStoreToNTriples(store) {
  const { serializeRdfDatasetWithAdapters } = await import('./shared/rdf-io/index.js');
  const serialized = await serializeRdfDatasetWithAdapters(store, {
    format: 'application/n-triples',
    runtime: { N3, jsonld: globalThis.jsonld, $rdf: globalThis.$rdf }
  });
  return serialized.text;
}

function getWorkspaceExportOptions() {
  return {
    scope: document.getElementById('workspace-export-scope')?.value || 'default',
    mime: document.getElementById('workspace-export-format')?.value || 'text/turtle',
  };
}

function getWorkspaceExportFormats(scope) {
  if (scope === 'default') {
    return [
      ['text/turtle', 'Turtle'],
      ['application/n-triples', 'N-Triples'],
      ['application/ld+json', 'JSON-LD'],
    ];
  }

  return [
    ['application/trig', 'TriG'],
    ['application/n-quads', 'N-Quads'],
    ['application/ld+json', 'JSON-LD'],
  ];
}

function timestampUTC() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function syncWorkspaceExportFormatOptions() {
  const scope = document.getElementById('workspace-export-scope')?.value || 'default';
  const formatSelect = document.getElementById('workspace-export-format');
  const hint = document.getElementById('workspace-export-hint');
  if (!formatSelect) return;

  const previous = formatSelect.value;
  const formats = getWorkspaceExportFormats(scope);
  formatSelect.innerHTML = formats
    .map(([value, label]) => `<option value="${value}">${label}</option>`)
    .join('');
  formatSelect.value = formats.some(([value]) => value === previous) ? previous : formats[0][0];

  if (hint) {
    hint.textContent = scope === 'default'
      ? 'Default graph exports support Turtle, N-Triples, and JSON-LD.'
      : 'Named graph exports support TriG, N-Quads, and JSON-LD.';
  }
}

async function handleDownloadActiveWorkspace() {
  try {
    const { scope, mime } = getWorkspaceExportOptions();
    const store = await getWorkspaceExportStore(scope);
    const { text, count } = await serializeWorkspaceExport(store, {
      scope: 'all',
      mimeType: mime,
      runtime: { N3, jsonld: globalThis.jsonld, $rdf: globalThis.$rdf }
    });

    if (!count) {
      showToast('No triples found for that export scope.', 'info');
      return;
    }

    const extension = getPreferredExtensionForMimeType(mime);
    downloadTextFile(
      `active-workspace-${scope}-${timestampUTC()}.${extension.ok ? extension.value : 'rdf'}`,
      text,
      { mimeType: mime }
    );
    showToast(`Downloaded ${count} triple${count === 1 ? '' : 's'}.`, 'success');
  } catch (err) {
    if (debuggingConsoleEnabled) {
      console.error('[handleDownloadActiveWorkspace] failed:', err);
    }
    showToast(err.message || String(err), 'error');
  }
}

async function getWorkspaceExportStore(scope) {
  const store = await loadGraphFromIndexedDB();
  if (scope === 'all') return store;

  const { Store, DataFactory } = N3;
  const { defaultGraph } = DataFactory;
  const scoped = new Store();
  const quads = scope === 'default'
    ? store.getQuads(null, null, null, defaultGraph())
    : store.getQuads(null, null, null, null).filter(q => q.graph.termType !== 'DefaultGraph');

  scoped.addQuads(quads);
  return scoped;
}

async function serializeJsonLdFromNQuads(nquads) {
  const parsed = await parseRdfTextWithAdapters(nquads, {
    format: 'application/n-quads',
    runtime: { N3, jsonld: globalThis.jsonld, $rdf: globalThis.$rdf }
  });
  const serialized = await serializeRdfDatasetWithAdapters(parsed.dataset, {
    format: 'application/ld+json',
    runtime: { N3, jsonld: globalThis.jsonld, $rdf: globalThis.$rdf }
  });
  return serialized.text;
}

/**
 * Loads the active SPARQL prefix selection from shared IndexedDB settings.
 *
 * @returns {Promise<string[]>} Active prefix keys.
 */
async function hydrateActivePrefixes() {
  const active = await getSetting(ACTIVE_PREFIXES_SETTING_KEY);
  activePrefixesCache = Array.isArray(active) && active.length
    ? active.filter((prefix) => typeof prefix === 'string')
    : [...defaultActivePrefixes];
  return [...activePrefixesCache];
}

/**
 * Reads the cached active SPARQL prefix selection.
 *
 * @returns {string[]} Active prefix keys.
 */
function getActivePrefixes() {
  return [...activePrefixesCache];
}

/**
 * Persists the active SPARQL prefix selection to shared IndexedDB settings.
 *
 * @param {string[]} prefixArr Active prefix keys.
 * @returns {Promise<void>}
 */
async function storeActivePrefixes(prefixArr) {
  activePrefixesCache = Array.isArray(prefixArr) ? [...prefixArr] : [...defaultActivePrefixes];
  await saveSetting(ACTIVE_PREFIXES_SETTING_KEY, activePrefixesCache);
}

// Render the prefix bar with active prefixes and [manage prefixes] button
// Assumes:
//  element with id="prefix-bar" exists
//  commonSPARQLPrefixes object exists
//  getActivePrefixes() function exists
//  openPrefixModal() function exists
//  storeActivePrefixes() function exists

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
    saveBtn.onclick = async (e) => {
      e.preventDefault();
      const checked = Array.from(modalContent.querySelectorAll('input[name="prefix"]:checked'))
        .map(cb => cb.value);
      await storeActivePrefixes(checked);
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

    window.__lastOverlayGraph = overlayGraph;

    const previewText = await serializeStore(overlayGraph, getSelectedOutputMime());
    document.getElementById('rdf-preview').value = previewText;

    await stashGraphToIndexedDB(overlayGraph, 'named', overlayIRI);

    if (debuggingConsoleEnabled) {
      console.info('[handleRunInference] Inference metrics:', metrics);
    }
  } catch (error) {
    if (debuggingConsoleEnabled) {
      console.error('[handleRunInference] Failed:', error);
    }
  }
}

/**
 * Downloads current preview RDF as a file.
 * @param {string} format - MIME type (e.g., 'text/turtle')
 */
function handleDownloadPreview(format = 'text/turtle') {
  try {
    const text = document.getElementById('rdf-preview').value;
    const extension = getPreferredExtensionForMimeType(format);
    const filename = `inferred-overlay.${extension.ok ? extension.value : 'rdf'}`;
    downloadTextFile(filename, text, { mimeType: format });
    if (debuggingConsoleEnabled) {console.info('[handleDownloadPreview] RDF download triggered');}
  } catch (error) {
    if (debuggingConsoleEnabled) {console.error('[handleDownloadPreview] Failed:', error);}
  }
}

// Get user choice of where to save inferred triples
function getSaveTarget() {
  const isNamed = document.getElementById('save-target-named')?.checked;

  if (isNamed) {
    const iriForOverlay = document.getElementById('iri-for-save-target')?.value;

    return {
      mode: 'named',
      // Uses iriForOverlay if it has a value, otherwise generates one
      graphIRI: iriForOverlay?.trim() ? iriForOverlay : makeNamedGraphIRI('http://example.org/inferred')
    };
  }

  return { mode: 'default', graphIRI: null };
}

// Save inferred overlay graph to IndexedDB
async function runInference() {
  try {
    clearInferenceConsole?.();
    setInferenceBusy(true);

    const rules = getSelectedRulesFromCheckboxes();
    const { overlayGraph, metrics } = await inferUntilStable(rules);

    window.__lastOverlayGraph = overlayGraph;
    await updatePreviewFromOverlay();

    const n = overlayGraph.getQuads(null, null, null, null).length;

    showToast(
      n
        ? `Inference finished — ${n} triple${n === 1 ? '' : 's'} materialized.`
        : 'Inference finished — no new triples.',
      n ? 'success' : 'info'
    );
  } catch (err) {
    if (debuggingConsoleEnabled) {
      console.error('[run-inference] failed:', err);
    }
    showToast(`Inference error: ${err.message || err}`, 'error');
  } finally {
    setInferenceBusy(false);
  }
}

// Save an inferred overlay graph to the local workspace.
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

// Export inferred overlay graph as a file in chosen format
async function exportInferredOverlay() {
  try {
    const g = window.__lastOverlayGraph;
    if (!g) throw new Error('Nothing to export. Run inference first.');

    const mime = getSelectedOutputMime();
    const text = await serializeStore(g, mime);

    const extension = getPreferredExtensionForMimeType(mime);

    downloadTextFile(`inferred-${timestampUTC()}.${extension.ok ? extension.value : 'rdf'}`, text, { mimeType: mime });
    showToast('Download started.', 'success');
  } catch (e) {
    if (debuggingConsoleEnabled) {
      console.error(e);
    }
    showToast(e.message || String(e), 'error');
  }
}

const STAGEABLE_RDF_FORMAT_IDS = new Set(['turtle', 'nTriples', 'trig', 'nQuads', 'jsonLd']);

let stagedOntologySequence = 0;
const stagedOntologies = [];

async function stageOntologyFiles(files, suppliesImport = '') {
  const errors = [];
  for (const file of Array.from(files || [])) {
    try {
      const detected = getSupportedMimeTypeForFilename(file.name);
      const mimeType = detected.ok && detected.value.category === 'rdf'
        ? detected.value.mimeType
        : '';
      const adapter = getRdfAdapterDescriptorForMimeType(mimeType);
      if (!adapter.ok || !STAGEABLE_RDF_FORMAT_IDS.has(detected.value.id)) {
        throw new Error('Use Turtle, N-Triples, TriG, N-Quads, or JSON-LD.');
      }

      const text = await readFileAsText(file);
      const graph = await parseRdfTextToGraph(text, mimeType);
      const inspection = inspectOntologyDataset(graph);
      stagedOntologies.push({
        id: `staged-ontology-${stagedOntologySequence++}`,
        file,
        graph,
        mimeType,
        assignedGraphIri: '',
        suppliesImport,
        ...inspection
      });
    } catch (error) {
      errors.push(`${file.name}: ${error.message || error}`);
    }
  }

  renderStagedOntologies();
  const errorElement = document.getElementById('namedGraphError');
  if (errorElement) errorElement.textContent = errors.join(' | ');
  if (errors.length) showToast(`Could not stage ${errors.length} file(s).`, 'error');
}

function renderImportRows(item) {
  if (!item.imports.length) {
    return '<p class="staged-ontology-muted">No declared imports found.</p>';
  }

  return item.imports.map(importIri => {
    const supplied = stagedOntologies.find(candidate =>
      candidate.id !== item.id
      && (candidate.suppliesImport === importIri || candidate.ontologyIris.includes(importIri))
    );
    return `
      <div class="staged-import-row">
        <span class="staged-import-state" aria-hidden="true">${supplied ? '&#10003;' : '!'}</span>
        <div class="staged-import-detail">
          <code>${escapeHtml(importIri)}</code>
          <span class="staged-ontology-muted">
            ${supplied ? `Supplied by ${escapeHtml(supplied.file.name)}` : 'File not supplied'}
          </span>
        </div>
        <button type="button" data-add-import="${escapeHtml(importIri)}">
          ${supplied ? 'Add another file' : 'Add ontology file'}
        </button>
      </div>`;
  }).join('');
}

function renderGraphControls(item) {
  if (item.namedGraphs.length) {
    return `
      <div class="staged-detail-row staged-graph-summary">
        <strong>Named graph${item.namedGraphs.length === 1 ? '' : 's'}</strong>
        <div>${item.namedGraphs.map(graph => `<code>${escapeHtml(graph)}</code>`).join('')}</div>
      </div>`;
  }

  const adapter = getRdfAdapterDescriptorForMimeType(item.mimeType);
  const canAssignGraph = adapter.ok && (
    !rdfSerializationPreservesNamedGraphs(item.mimeType) || adapter.value.parserAdapter === 'jsonld'
  );
  if (canAssignGraph) {
    return `
      <label class="staged-graph-assignment">
        <span><strong>Named graph IRI</strong><small>Optional; blank loads into the default graph</small></span>
        <input type="url" class="graph-iri" data-graph-iri-for="${item.id}"
          value="${escapeHtml(item.assignedGraphIri)}" placeholder="https://example.org/graph">
      </label>`;
  }

  return '<div class="staged-detail-row staged-graph-summary"><strong>Graph</strong><span>Default graph declared by dataset file</span></div>';
}

function renderStagedOntologies() {
  const container = document.getElementById('file-upload-container');
  const loadButton = document.getElementById('add-to-db');
  if (!container) return;
  if (loadButton) loadButton.disabled = stagedOntologies.length === 0;

  if (!stagedOntologies.length) {
    container.innerHTML = '<p class="staged-ontology-empty">No files staged.</p>';
    return;
  }

  container.innerHTML = stagedOntologies.map(item => `
    <article class="staged-ontology-card" data-staged-id="${item.id}">
      <header>
        <div>
          <h4>${escapeHtml(item.file.name)}</h4>
          <div class="staged-ontology-muted">
            ${escapeHtml(item.mimeType)} · ${item.tripleCount.toLocaleString()} triple${item.tripleCount === 1 ? '' : 's'}
          </div>
        </div>
        <button type="button" class="danger" data-remove-staged="${item.id}">Remove</button>
      </header>
      <div class="staged-detail-row staged-ontology-metadata">
        <strong>Ontology IRI</strong>
        <code>${escapeHtml(item.ontologyIris[0] || 'Not declared')}</code>
      </div>
      ${renderGraphControls(item)}
      <section class="staged-imports">
        <h5>Declared imports</h5>
        ${renderImportRows(item)}
      </section>
    </article>`).join('');

  container.querySelectorAll('[data-remove-staged]').forEach(button => {
    button.addEventListener('click', () => {
      const index = stagedOntologies.findIndex(item => item.id === button.dataset.removeStaged);
      if (index >= 0) stagedOntologies.splice(index, 1);
      renderStagedOntologies();
    });
  });
  container.querySelectorAll('[data-graph-iri-for]').forEach(input => {
    input.addEventListener('input', () => {
      const item = stagedOntologies.find(candidate => candidate.id === input.dataset.graphIriFor);
      if (item) item.assignedGraphIri = input.value.trim();
    });
  });
  container.querySelectorAll('[data-add-import]').forEach(button => {
    button.addEventListener('click', () => openOntologyFilePicker(button.dataset.addImport));
  });
}

function openOntologyFilePicker(suppliesImport = '') {
  const picker = document.getElementById('ontology-file-picker');
  if (!picker) return;
  picker.dataset.suppliesImport = suppliesImport;
  picker.click();
}

async function loadStagedOntologies() {
  const errors = [];
  const loadedFiles = [];
  for (const item of stagedOntologies) {
    try {
      let statements = item.graph.statements;
      if (!item.namedGraphs.length && item.assignedGraphIri) {
        if (!isAbsoluteIri(item.assignedGraphIri)) {
          throw new Error('Named graph IRI must be an absolute IRI.');
        }
        const target = $rdf.graph();
        const graph = $rdf.sym(item.assignedGraphIri);
        statements.forEach(statement => target.add(
          statement.subject,
          statement.predicate,
          statement.object,
          graph
        ));
        statements = target.statements;
      }
      await storeTriplesInNamedGraph(statements);
      loadedFiles.push({ name: item.file.name, tripleCount: statements.length });
    } catch (error) {
      errors.push(`${item.file.name}: ${error.message || error}`);
    }
  }

  const errorElement = document.getElementById('namedGraphError');
  if (errorElement) errorElement.textContent = errors.join(' | ');
  const totalTriples = loadedFiles.reduce((sum, file) => sum + file.tripleCount, 0);
  const breakdown = loadedFiles
    .map(file => `${file.name}: ${file.tripleCount.toLocaleString()}`)
    .join('; ');
  if (errors.length) {
    showToast(
      `Loaded ${loadedFiles.length} file(s) with ${totalTriples.toLocaleString()} total triples; ${errors.length} failed.${breakdown ? ` ${breakdown}` : ''}`,
      'error',
      { timeout: Math.min(15000, 8000 + loadedFiles.length * 750) }
    );
  } else {
    showToast(
      `Loaded ${loadedFiles.length} file${loadedFiles.length === 1 ? '' : 's'} with ${totalTriples.toLocaleString()} total triples. ${breakdown}`,
      'success',
      { timeout: Math.min(15000, 6500 + loadedFiles.length * 750) }
    );
  }
}

// Event handlers
document.getElementById('run-inference')?.addEventListener('click', runInference);
document.getElementById('save-inferred-to-db')?.addEventListener('click', saveInferredTriplesToDB);
document.getElementById('export-inferred')?.addEventListener('click', async () => {
  await exportInferredOverlay();
});
document.getElementById('output-format')?.addEventListener('change', async () => {
  await updatePreviewFromOverlay();
});

document.getElementById('add-file-row')?.addEventListener('click', () => openOntologyFilePicker());
document.getElementById('add-to-db')?.addEventListener('click', loadStagedOntologies);

const ontologyPicker = document.getElementById('ontology-file-picker');
ontologyPicker?.addEventListener('change', async () => {
  await stageOntologyFiles(ontologyPicker.files, ontologyPicker.dataset.suppliesImport || '');
  ontologyPicker.value = '';
  delete ontologyPicker.dataset.suppliesImport;
});

const ontologyDropZone = document.getElementById('ontology-drop-zone');
ontologyDropZone?.addEventListener('click', () => openOntologyFilePicker());
ontologyDropZone?.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openOntologyFilePicker();
  }
});
for (const eventName of ['dragenter', 'dragover']) {
  ontologyDropZone?.addEventListener(eventName, event => {
    event.preventDefault();
    ontologyDropZone.classList.add('is-dragging');
  });
}
for (const eventName of ['dragleave', 'drop']) {
  ontologyDropZone?.addEventListener(eventName, event => {
    event.preventDefault();
    ontologyDropZone.classList.remove('is-dragging');
  });
}
ontologyDropZone?.addEventListener('drop', event => stageOntologyFiles(event.dataTransfer?.files));

// Call this whenever you switch tabs
function activateTab(panelId, inferenceMode = 'materialize') {
  if (panelId === 'tab-inference') {
    const modeInput = document.getElementById('inference-task-mode');
    if (modeInput && modeInput.value !== inferenceMode) {
      modeInput.value = inferenceMode;
      modeInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  document.querySelectorAll('.tab-btn').forEach(btn => {
    const isRequestedPanel = btn.dataset.tab === panelId;
    const isRequestedMode = panelId !== 'tab-inference'
      || (btn.dataset.inferenceMode || 'materialize') === inferenceMode;
    const isActive = isRequestedPanel && isRequestedMode;
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
    btn.addEventListener('click', () => activateTab(
      btn.dataset.tab,
      btn.dataset.inferenceMode || 'materialize'
    ));
  });

  // Default: first tab or hash
  const initial = location.hash && document.getElementById(location.hash.slice(1))
    ? location.hash.slice(1)
    : btns[0].dataset.tab;

  activateTab(initial);
}

// UI event bindings
window.addEventListener('DOMContentLoaded', () => {
  setInferenceBusy(false);
  initTabs();
  document.getElementById('download-overlay')?.addEventListener('click', () => handleDownloadPreview('text/turtle'));
});

/** 
 * User data management DOM handlers
 */
// Clears data
document.getElementById('clear-active-triples') ?.addEventListener('click', clearActiveTriples);
// Clears queries
document.getElementById('clear-saved-queries') ?.addEventListener('click', clearActiveSavedQueries);
// Clears settings
document.getElementById('clear-active-settings') ?.addEventListener('click', clearActiveSettings);
// Removes databases
document.getElementById('flush-active-workspace') ?.addEventListener('click', flushActiveWorkspace);

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

const stashInferenceDefaultGraphMode = document.getElementById('save-target-default');
const stashInferenceNamedGraphMode = document.getElementById('save-target-named');
const nameSaveTargetEl = document.getElementById('name-save-target');

[stashInferenceDefaultGraphMode, stashInferenceNamedGraphMode].forEach(el=>{
  el?.addEventListener('change', ()=>{
    const namedGraphOptionChosen = stashInferenceNamedGraphMode?.checked;
    if (nameSaveTargetEl) nameSaveTargetEl.style.display = namedGraphOptionChosen ? 'block' : 'none';
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

  // Empty or otherwise unclassified binding arrays are SELECT results.
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

    let html = `<table><thead><tr>${
      vars.map(v => `<th class="query-results-th">${renderQueryCell(v, 40)}</th>`).join('')
    }</tr></thead><tbody>`;

    for (const row of rows) {
      html += `<tr class="query-results-tr">` +
        vars.map(v => `<td class="query-results-td">${renderQueryCell(row[v]?.value ?? '', 75)}</td>`).join('') +
        `</tr>`;
    }
    html += '</tbody></table>';
    return html;
  }

  // ASK
  if (result && result.kind === 'ask') {
    return `<pre>${result.value ? 'true' : 'false'}</pre>`;
  }

  // Graph/Quads
  if (Array.isArray(result) && result[0] && result[0].nt) {
    return `<pre>${escapeHtml(result.map(x => x.nt.value).join('\n'))}</pre>`;
  }

  // Legacy / fallback: previous array-of-bindings shape
  if (Array.isArray(result) && result.length) {
    const vars = Object.keys(result[0]);
    let html = `<table><thead><tr>${
      vars.map(v => `<th class="query-results-th">${renderQueryCell(v, 40)}</th>`).join('')
    }</tr></thead><tbody>`;

    for (const row of result) {
      html += `<tr class="query-results-tr">` +
        vars.map(v => `<td class="query-results-td">${renderQueryCell(row[v]?.value ?? '', 75)}</td>`).join('') +
        `</tr>`;
    }
    html += '</tbody></table>';
    return html;
  }

  return '<em>No results.</em>';
}

document.getElementById('query-results').addEventListener('click', function (event) {
  const cell = event.target.closest('.query-cell');
  if (cell) {
    cell.classList.toggle('is-expanded');
  }
});

async function commitUpdateByMaterialization(updateStr, targetMode = 'default') {
  const result = await applySparqlUpdateToQuadStore(updateStr, {
    runConstructQuery: async (query, { format }) => runConstructPreview(query, format),
    parseConstructResult: async (rdfText, { format }) => parseRdfTextWithAdapters(rdfText, {
      format,
      baseIri: 'http://example.org/',
      runtime: { N3, jsonld: globalThis.jsonld, $rdf: globalThis.$rdf }
    }),
    deleteQuadRows: async (rows) => deleteExactTriples(rows),
    insertQuadRows: async (rows, context) => {
      const store = createStoreFromQuadRows(rows);
      await stashGraphToIndexedDB(store, context.targetMode, context.graphIri || null);
      return rows.length;
    }
  }, {
    targetMode,
    createGraphIri: makeNamedGraphIRI,
    autoGraphBase: 'http://example.org/updated'
  });

  return {
    deleted: result.deleted,
    inserted: result.inserted,
    graphIRI: result.graphIri
  };
}

function createStoreFromQuadRows(rows) {
  const store = new N3.Store();
  for (const row of rows || []) {
    store.addQuad(N3.DataFactory.quad(
      row.subjectType === 'BlankNode' ? N3.DataFactory.blankNode(row.subject) : N3.DataFactory.namedNode(row.subject),
      N3.DataFactory.namedNode(row.predicate),
      createObjectTermFromQuadRow(row),
      row.graph ? N3.DataFactory.namedNode(row.graph) : N3.DataFactory.defaultGraph()
    ));
  }
  return store;
}

function createObjectTermFromQuadRow(row) {
  if (row.objectType === 'NamedNode') return N3.DataFactory.namedNode(row.object);
  if (row.objectType === 'BlankNode') return N3.DataFactory.blankNode(row.object);
  if (row.objectLang) return N3.DataFactory.literal(row.object, row.objectLang);
  if (row.objectDatatype) return N3.DataFactory.literal(row.object, N3.DataFactory.namedNode(row.objectDatatype));
  return N3.DataFactory.literal(row.object);
}
// Display results in the designated div
function displayQueryResults(resultsHtml) {
  const resultsDiv = document.getElementById('query-results');
  resultsDiv.innerHTML = resultsHtml;
}

hydrateActivePrefixes()
  .catch((error) => {
    if (debuggingConsoleEnabled) console.warn('[hydrateActivePrefixes] failed:', error);
  })
  .finally(renderPrefixBar);

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
 * Build one normalized saved-query record from textarea content.
 * @param {string} queryText
 * @returns {{id:string,type:string,value:string,createdAt:string}}
 */
function buildSavedQueryRecord(queryText,queryLabel) {
  return {
    id: `urn:uuid:${createUuid()}`,
    label: String(queryLabel ?? 'Untitled'),
    type: COMMON_NAMESPACE_IRIS.cco2.informationContentEntity,
    value: String(queryText ?? ''),
    createdAt: new Date().toISOString()
  };
}

async function handleSaveQueryForLater() {
  try {
    const textarea = document.getElementById('sparql-query');
    const queryText = textarea?.value ?? '';
    const queryLabelInput = document.getElementById('query-label');
    const queryLabel = queryLabelInput?.value ?? 'Untitled';

    if (!queryText.trim()) {
      showToast('There is no SPARQL query text to save.', 'warning');
      return;
    }
    if (!queryLabel.trim()) {
      showToast('Please provide a name for your query.', 'warning');
      return;
    }

    const record = buildSavedQueryRecord(queryText,queryLabel);
    await saveSavedQuery(record);
    await renderSavedQuerySidebar();

    showToast('Query saved for later.', 'success');
  } catch (err) {
    if (debuggingConsoleEnabled) {
      console.error('[handleSaveQueryForLater] failed:', err);
    }
    showToast(err.message || String(err), 'error');
  }
}

/**
 * Render the saved query list in the sidebar.
 */
async function renderSavedQuerySidebar() {
  const listEl = document.getElementById('saved-query-list');
  if (!listEl) return;

  try {
    const rows = await getAllSavedQueries();
    listEl.innerHTML = '';

    if (!rows.length) {
      listEl.innerHTML = '<li><em>No saved queries yet.</em></li>';
      return;
    }

    for (const row of rows) {
      const li = document.createElement('li');
      li.className = 'saved-query-item';

      const loadBtn = document.createElement('button');
      loadBtn.type = 'button';
      loadBtn.className = 'saved-query-load';
      loadBtn.textContent = summarizeSavedQueryLabel(row);
      loadBtn.title = row.id;
      loadBtn.addEventListener('click', () => {
        const textarea = document.getElementById('sparql-query');
        if (textarea) textarea.value = row.value || '';
        showToast('Saved query loaded into editor.', 'success');
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'saved-query-delete';
      deleteBtn.textContent = '×';
      deleteBtn.title = 'Delete saved query';
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await deleteSavedQuery(row.id);
        await renderSavedQuerySidebar();
        showToast('Saved query deleted.', 'success');
      });

      li.appendChild(loadBtn);
      li.appendChild(deleteBtn);
      listEl.appendChild(li);
    }
  } catch (err) {
    if (debuggingConsoleEnabled) {
      console.error('[renderSavedQuerySidebar] failed:', err);
    }
    listEl.innerHTML = '<li style="color:red;">Failed to load saved queries.</li>';
  }
}

function summarizeSavedQueryLabel(row) {
  const text = String(row.label || '').trim().replace(/\s+/g, ' ');
  if (!text) return '(empty query)';
  return text.length > 80 ? text.slice(0, 80) + '…' : text;
}

async function handleDownloadSavedQueriesJsonLd() {
  try {
    const jsonld = await exportSavedQueriesAsJsonLd();
    downloadTextFile(
      `saved-queries-${Date.now()}.jsonld`,
      JSON.stringify(jsonld, null, 2),
      { mimeType: 'application/ld+json' }
    );
    showToast('Saved queries JSON-LD download started.', 'success');
  } catch (err) {
    if (debuggingConsoleEnabled) {
      console.error('[handleDownloadSavedQueriesJsonLd] failed:', err);
    }
    showToast(err.message || String(err), 'error');
  }
}

async function handleDownloadSavedQueriesCsv() {
  try {
    const csv = await exportSavedQueriesAsCsv();
    downloadTextFile(
      `saved-queries-${Date.now()}.csv`,
      csv,
      { mimeType: 'text/csv' }
    );
    showToast('Saved queries CSV download started.', 'success');
  } catch (err) {
    if (debuggingConsoleEnabled) {
      console.error('[handleDownloadSavedQueriesCsv] failed:', err);
    }
    showToast(err.message || String(err), 'error');
  }
}

async function handleUploadSavedQueriesCsv(file) {
  try {
    if (!file) {
      showToast('No CSV file selected.', 'warning');
      return;
    }

    const text = await readFileAsText(file);
    const result = await importSavedQueriesFromCsv(text);
    await renderSavedQuerySidebar();

    showToast(`Imported ${result.count} saved quer${result.count === 1 ? 'y' : 'ies'}.`, 'success');
  } catch (err) {
    if (debuggingConsoleEnabled) {
      console.error('[handleUploadSavedQueriesCsv] failed:', err);
    }
    showToast(err.message || String(err), 'error');
  }
}

window.addEventListener('DOMContentLoaded', () => {
  syncWorkspaceExportFormatOptions();
  document.getElementById('workspace-export-scope')
    ?.addEventListener('change', syncWorkspaceExportFormatOptions);

  document.getElementById('download-active-workspace')
    ?.addEventListener('click', handleDownloadActiveWorkspace);

  document.getElementById('save-query-for-later')
    ?.addEventListener('click', handleSaveQueryForLater);

  document.getElementById('download-saved-queries-jsonld')
    ?.addEventListener('click', handleDownloadSavedQueriesJsonLd);

  document.getElementById('download-saved-queries-csv')
    ?.addEventListener('click', handleDownloadSavedQueriesCsv);

  document.getElementById('upload-saved-queries-csv')
    ?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      await handleUploadSavedQueriesCsv(file);
      e.target.value = '';
    });

  renderSavedQuerySidebar();
});

window.addEventListener('saved-queries-changed', renderSavedQuerySidebar);

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
    const type = (payload?.store === 'settings') ? 'settings-changed'
              : (payload?.store === 'quadRows') ? 'triples-changed'
              : 'idb-changed';
    window.dispatchEvent(new CustomEvent(type, { detail: payload }));
  } catch {}
}

// Listen for events
// Handle special characters in HTML
function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function abbreviateText(value, maxChars) {
  const text = String(value ?? '');
  if (text.length <= maxChars) return text;

  const slice = text.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(' ');

  if (lastSpace > 20) {
    return slice.slice(0, lastSpace) + '...';
  }

  return slice + '...';
}

function renderQueryCell(value, maxChars = 75) {
  const raw = String(value ?? '');
  const safeFull = escapeHtml(raw);

  if (raw.length <= maxChars) {
    return `<div class="query-cell">${safeFull}</div>`;
  }

  const safeShort = escapeHtml(abbreviateText(raw, maxChars));

  return `
    <details class="query-cell query-cell-details">
      <summary class="query-cell-summary" title="${safeFull}">${safeShort}</summary>
      <div class="query-cell-full">${safeFull}</div>
    </details>
  `;
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

// Utility to get selected output MIME type from dropdown
function getSelectedOutputMime() {
  const sel = document.getElementById('output-format');
  const label = sel?.value || 'Turtle';
  const result = getMimeTypeForFormatKey(label);
  return result.ok ? result.value.mimeType : 'text/turtle';
}

/**
 * Run button handler (Read/Write aware with Preview/Commit for UPDATE).
 * - Builds the final query from active prefixes + editor text.
 * - Validates that the query kind (READ vs UPDATE) matches the chosen UI mode.
 * - READ mode: runs against the browser-local Active Workspace.
 * - WRITE mode:
 *    * If action=Preview -> transforms UPDATE into 1..n CONSTRUCTs, runs each locally, renders serialized RDF.
 *    * If action=Commit -> materializes INSERT/DELETE deltas against IndexedDB and reports counts.
 *
 * Assumptions:
 *   getActivePrefixes(), buildQuery(prefixes, queryText),
 *   runQueryOnLocalDataset(query),
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
    const esc = (s) => String(s ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
    const blocks = sections.map(({ label, text }) =>
      `\n<h4 style="margin:.6em 0;">${esc(label)}</h4>\n<pre style="white-space:pre-wrap">${esc(text)}</pre>`
    );
    return blocks.join('\n');
  };

  try {
    if (debuggingConsoleEnabled) {console.info('[run-query] Start');}
    const prefixes       = getActivePrefixes();
    const queryText      = document.getElementById('sparql-query')?.value ?? '';
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
      if (debuggingConsoleEnabled) {console.info('[run-query] Using Active Workspace for READ');}
      const response = await runQueryOnLocalDataset(query);

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
