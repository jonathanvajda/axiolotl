import {
  listInconsistencyQueries,
  runInconsistencySelect,
} from './axiolotl-inconsistency.js';

const CONSISTENCY_PROFILES = Object.freeze({
  axiolotl: {
    label: 'Axiolotl maximum',
    help: 'Runs every implemented Axiolotl check, including heuristic checks that flag modeling smells rather than formal OWL inconsistency proofs.',
    editable: true,
    checks: 'all',
  },
  'owl2-el': {
    label: 'OWL2 EL',
    help: 'ELK-like preset. Uses implemented checks that fit common OWL 2 EL consistency coverage, mainly class/property disjointness over available materialized types.',
    editable: false,
    checks: [
      'disjointWithTypeOverlap',
      'allDisjointClassesTypeOverlap',
      'allDisjointPropertiesSharedPair',
    ],
  },
  'owl2-dl': {
    label: 'OWL2 full',
    help: 'Pellet/HermiT-like preset. Axiolotl still runs only its implemented direct checks; it is not a complete OWL 2 DL reasoner.',
    editable: false,
    checks: [
      'disjointWithTypeOverlap',
      'allDisjointClassesTypeOverlap',
      'complementOfTypeOverlap',
      'datatypeFunctionalPropertyConflict',
      'objectFunctionalPropertyDifferentFromConflict',
      'negativePropertyAssertionConflict',
      'allDifferentSameAsConflict',
      'allDisjointPropertiesSharedPair',
      'singlePropertyHasKeyDifferentFromConflict',
    ],
  },
  'direct-abox': {
    label: 'Direct ABox only',
    help: 'Runs direct asserted-data contradiction checks and skips open-world missing-type heuristics.',
    editable: false,
    checks: [
      'disjointWithTypeOverlap',
      'allDisjointClassesTypeOverlap',
      'complementOfTypeOverlap',
      'datatypeFunctionalPropertyConflict',
      'objectFunctionalPropertyDifferentFromConflict',
      'negativePropertyAssertionConflict',
      'allDifferentSameAsConflict',
      'allDisjointPropertiesSharedPair',
    ],
  },
});

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', initAxiolotlInferenceUi);
}

function initAxiolotlInferenceUi() {
  const modeSelect = document.getElementById('inference-task-mode');
  const profileSelect = document.getElementById('consistency-profile');
  const runButton = document.getElementById('run-inference');

  renderConsistencyOptions();
  syncInferenceTaskUi();

  modeSelect?.addEventListener('change', syncInferenceTaskUi);
  profileSelect?.addEventListener('change', syncInferenceTaskUi);
  runButton?.addEventListener('click', handleConsistencyRunClick, true);
}

function syncInferenceTaskUi() {
  const mode = getInferenceTaskMode();
  const isConsistency = mode === 'consistency';
  const profile = getConsistencyProfile();
  const profileConfig = CONSISTENCY_PROFILES[profile] || CONSISTENCY_PROFILES.axiolotl;

  setHidden('materialization-rule-panel', isConsistency);
  setHidden('consistency-rule-panel', !isConsistency);
  setText('inference-task-heading', isConsistency ? 'Inference Engine: Consistency Checks' : 'Inference Engine: Forward-Chain Reasoning');
  setText('run-inference', isConsistency ? 'Check Consistency' : 'Run Inference');
  setText('inference-output-label', isConsistency ? 'Consistency report:' : 'Output preview:');
  setHelpText(profileConfig.help);
  syncConsistencyCheckboxes(profileConfig);
}

function renderConsistencyOptions() {
  const container = document.getElementById('consistency-rule-options');
  if (!container) return;

  const queries = listInconsistencyQueries().filter(query => query.supported);
  const items = queries.map(query => `
    <li>
      <label title="${escapeHtml(query.description)}">
        <input type="checkbox" name="consistency-rule" value="${escapeHtml(query.id)}" checked>
        ${escapeHtml(query.label)}
      </label>
    </li>
  `);

  container.innerHTML = `
    <div id="consistency-rule-hint" class="sidebar-note"></div>
    <ul id="consistency-rule-list" style="list-style: none; padding-left: 0; margin: 5px 5px;">
      ${items.join('')}
    </ul>
  `;
}

function syncConsistencyCheckboxes(profileConfig) {
  const checkboxes = Array.from(document.querySelectorAll('input[name="consistency-rule"]'));
  const enabledIds = new Set(profileConfig.checks === 'all'
    ? checkboxes.map(input => input.value)
    : profileConfig.checks);

  for (const checkbox of checkboxes) {
    checkbox.checked = enabledIds.has(checkbox.value);
    checkbox.disabled = !profileConfig.editable;
    checkbox.closest('label')?.classList.toggle('is-disabled', checkbox.disabled);
  }

  setText(
    'consistency-rule-hint',
    profileConfig.editable
      ? 'Toggle the Axiolotl checks to run. For best results, materialize type-producing rules before checking.'
      : 'This profile uses a fixed preset. Switch to Axiolotl maximum to toggle individual checks.'
  );
}

async function handleConsistencyRunClick(event) {
  if (getInferenceTaskMode() !== 'consistency') return;

  event.preventDefault();
  event.stopImmediatePropagation();

  try {
    clearInferenceConsole?.();
    setInferenceBusy?.(true);
    appendInferenceConsoleLine?.('[checkConsistency] Starting consistency checks...');

    if (document.getElementById('reasoner-source-endpoint')?.checked) {
      throw new Error('Consistency checks currently run against the Active Workspace only.');
    }

    if (typeof loadGraphFromIndexedDB !== 'function') {
      throw new Error('loadGraphFromIndexedDB is not available.');
    }

    const selectedChecks = getSelectedConsistencyChecks();
    if (!selectedChecks.length) {
      throw new Error('No consistency checks selected.');
    }

    const rdfjsStore = await loadGraphFromIndexedDB();
    const results = [];

    for (const id of selectedChecks) {
      const result = await runInconsistencySelect(id, rdfjsStore);
      results.push(result);
      appendInferenceConsoleLine?.(`[checkConsistency] ${id}: ${result.rows.length} violation row(s).`);
    }

    const report = formatConsistencyReport(results);
    const preview = document.getElementById('rdf-preview');
    if (preview) preview.value = report;

    const violationCount = results.reduce((sum, result) => sum + result.rows.length, 0);
    const message = violationCount
      ? `Consistency checks found ${violationCount} violation row${violationCount === 1 ? '' : 's'}.`
      : 'Consistency checks found no violation rows.';

    showToast?.(message, violationCount ? 'warning' : 'success');
    appendInferenceConsoleLine?.(`[checkConsistency] Complete. ${message}`);
  } catch (error) {
    console.error('[checkConsistency] failed', error);
    appendInferenceConsoleLine?.(`ERROR: ${error.message || error}`);
    showToast?.(`Consistency check error: ${error.message || error}`, 'error');
  } finally {
    setInferenceBusy?.(false);
  }
}

function getSelectedConsistencyChecks() {
  return Array.from(document.querySelectorAll('input[name="consistency-rule"]:checked'))
    .map(input => input.value);
}

function formatConsistencyReport(results) {
  const lines = [
    'Axiolotl consistency report',
    `Generated: ${new Date().toISOString()}`,
    '',
  ];

  for (const result of results) {
    lines.push(`${result.id}: ${result.rows.length} violation row(s)`);
    result.rows.slice(0, 25).forEach((row, index) => {
      lines.push(`  ${index + 1}. ${formatBindingRow(row)}`);
    });
    if (result.rows.length > 25) {
      lines.push(`  ... ${result.rows.length - 25} additional row(s) omitted from preview`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function formatBindingRow(row) {
  const entries = Object.entries(row);
  if (!entries.length) return '(no bindings)';
  return entries
    .map(([key, value]) => `${key}=${formatTerm(value)}`)
    .join(', ');
}

function formatTerm(term) {
  if (!term) return '';
  if (typeof term === 'string') return term;
  if (term.termType === 'Literal') return JSON.stringify(term.value);
  return term.value || String(term);
}

function getInferenceTaskMode() {
  return document.getElementById('inference-task-mode')?.value || 'materialize';
}

function getConsistencyProfile() {
  return document.getElementById('consistency-profile')?.value || 'axiolotl';
}

function setHidden(id, hidden) {
  const element = document.getElementById(id);
  if (element) element.hidden = !!hidden;
}

function setText(id, text) {
  const element = document.getElementById(id);
  if (element) element.textContent = text;
}

function setHelpText(text) {
  const help = document.getElementById('consistency-profile-help');
  if (!help) return;
  help.title = text;
  help.setAttribute('aria-label', text);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
