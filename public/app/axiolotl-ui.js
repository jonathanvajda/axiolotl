import { formatConsistencyReport, summarizeConsistencyResults } from './consistency-report.js';
import {
  listInconsistencyQueries,
  runInconsistencySelect,
} from './axiolotl-inconsistency.js';
import {
  appendInferenceConsoleLine,
  clearInferenceConsole,
  inferUntilStable,
  setInferenceBusy,
} from './axiolotl-inference.js';
import { loadGraphFromIndexedDB } from './comunica-indexeddb-bridge.js';
import { showToast } from './semantic-core.js';

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
      'sameAsKnownDifferentConflict',
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
      'sameAsKnownDifferentConflict',
      'allDisjointPropertiesSharedPair',
    ],
  },
});

const MATERIALIZATION_PROFILES = Object.freeze({
  'axiolotl-rl-core': {
    label: 'Axiolotl RL-style core',
    help: 'Forward-chaining materialization over useful RDFS/OWL RL-style rules. Recursive to fixpoint. Still not complete OWL 2 RL: datatype validation, inconsistency rules, arbitrary-length property chains, and some list/cardinality cases remain outside this materialization profile.',
    editable: false,
    rules: [
      'inverse',
      'symmetric',
      'subpropertyof',
      'transitive',
      'domain',
      'range',
      'subclassof',
      'equivalentclass',
      'equivalentproperty',
      'sameas',
      'functional',
      'inversefunctional',
      'hasvalue',
      'hasvalueclass',
      'allvaluesfrom',
      'somevaluesfromclass',
      'intersectionof',
      'propertychain',
    ],
  },
  custom: {
    label: 'Custom rules',
    help: 'Choose exactly which materialization rules to run. This is useful for targeted debugging and performance experiments.',
    editable: true,
    rules: 'preserve',
  },
});

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', initAxiolotlInferenceUi);
}

function initAxiolotlInferenceUi() {
  const modeSelect = document.getElementById('inference-task-mode');
  const materializationProfileSelect = document.getElementById('materialization-profile');
  const profileSelect = document.getElementById('consistency-profile');
  const runButton = document.getElementById('run-inference');

  renderConsistencyOptions();
  syncInferenceTaskUi();

  modeSelect?.addEventListener('change', syncInferenceTaskUi);
  materializationProfileSelect?.addEventListener('change', syncInferenceTaskUi);
  profileSelect?.addEventListener('change', syncInferenceTaskUi);
  runButton?.addEventListener('click', handleConsistencyRunClick, true);
}

function syncInferenceTaskUi() {
  const mode = getInferenceTaskMode();
  const isConsistency = mode === 'consistency';
  const materializationProfile = getMaterializationProfile();
  const materializationProfileConfig = MATERIALIZATION_PROFILES[materializationProfile] || MATERIALIZATION_PROFILES['axiolotl-rl-core'];
  const profile = getConsistencyProfile();
  const profileConfig = CONSISTENCY_PROFILES[profile] || CONSISTENCY_PROFILES.axiolotl;

  setHidden('materialization-rule-panel', isConsistency);
  setHidden('consistency-rule-panel', !isConsistency);
  setHidden('inference-right-sidebar', isConsistency);
  setText('inference-task-heading', isConsistency ? 'Check Logical Model' : 'Materialize Inferrable Triples');
  setText('run-inference', isConsistency ? 'Check Logical Model' : 'Materialize Triples');
  setText('inference-output-label', isConsistency ? 'Consistency report:' : 'Output preview:');
  setMaterializationHelpText(materializationProfileConfig.help);
  setConsistencyHelpText(profileConfig.help);
  syncMaterializationCheckboxes(materializationProfileConfig);
  syncConsistencyCheckboxes(profileConfig);
}

function syncMaterializationCheckboxes(profileConfig) {
  const checkboxes = Array.from(document.querySelectorAll('input[name="inference-rule"]'));
  const enabledIds = profileConfig.rules === 'preserve'
    ? null
    : new Set(profileConfig.rules);

  for (const checkbox of checkboxes) {
    if (enabledIds) checkbox.checked = enabledIds.has(checkbox.value);
    checkbox.disabled = !profileConfig.editable;
    checkbox.closest('label')?.classList.toggle('is-disabled', checkbox.disabled);
  }

  setText(
    'materialization-rule-hint',
    profileConfig.editable
      ? 'Toggle rules for a custom materialization pass.'
      : 'This profile locks the currently implemented RL-style materialization subset.'
  );
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
      ? 'Toggle the Axiolotl checks to run. The selected materialization profile runs in memory before these checks.'
      : 'This profile uses a fixed preset. The selected materialization profile runs in memory before these checks.'
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

    if (typeof loadGraphFromIndexedDB !== 'function') {
      throw new Error('loadGraphFromIndexedDB is not available.');
    }

    const selectedChecks = getSelectedConsistencyChecks();
    if (!selectedChecks.length) {
      throw new Error('No consistency checks selected.');
    }

    const materializationRules = getSelectedMaterializationRules();
    appendInferenceConsoleLine?.(
      `[checkConsistency] Materializing first with ${materializationRules.length} rule(s): ${materializationRules.join(', ')}`
    );

    const { overlayGraph, metrics } = await materializeForConsistency(materializationRules);
    appendInferenceConsoleLine?.(
      `[checkConsistency] Materialization complete. Added ${metrics.totalAdded} triple(s) over ${metrics.passes} pass(es).`
    );

    const rdfjsStore = await loadGraphFromIndexedDB();
    addOverlayQuadsToStore(rdfjsStore, overlayGraph);

    const results = [];

    for (const id of selectedChecks) {
      const result = await runInconsistencySelect(id, rdfjsStore, { phase: 'after-materialization', materializedStore: overlayGraph });
      results.push(result);
      appendInferenceConsoleLine?.(`[checkConsistency] ${id}: ${result.rows.length} ${result.findingKind} row(s).`);
    }

    const report = formatConsistencyReport(results);
    const preview = document.getElementById('rdf-preview');
    if (preview) preview.value = report;

    const summary = summarizeConsistencyResults(results);
    const message = `${summary.verdict}. ${summary.violations} violation row(s), ${summary.warnings} warning row(s).`;
    showToast?.(message, summary.status === 'incomplete' || summary.violations || summary.warnings ? 'warning' : 'success');
    appendInferenceConsoleLine?.(`[checkConsistency] ${summary.status}. ${message}`);
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

function getSelectedMaterializationRules() {
  return Array.from(document.querySelectorAll('input[name="inference-rule"]:checked'))
    .map(input => input.value);
}

async function materializeForConsistency(rules) {
  if (typeof inferUntilStable !== 'function') {
    throw new Error('inferUntilStable is not available for consistency pre-materialization.');
  }

  return await inferUntilStable(rules);
}

function addOverlayQuadsToStore(store, overlayGraph) {
  if (!store || typeof store.addQuad !== 'function') return;
  if (!overlayGraph || typeof overlayGraph.getQuads !== 'function') return;

  for (const quad of overlayGraph.getQuads(null, null, null, null)) {
    store.addQuad(quad);
  }
}

function getInferenceTaskMode() {
  return document.getElementById('inference-task-mode')?.value || 'materialize';
}

function getConsistencyProfile() {
  return document.getElementById('consistency-profile')?.value || 'axiolotl';
}

function getMaterializationProfile() {
  return document.getElementById('materialization-profile')?.value || 'axiolotl-rl-core';
}

function setHidden(id, hidden) {
  const element = document.getElementById(id);
  if (element) element.hidden = !!hidden;
}

function setText(id, text) {
  const element = document.getElementById(id);
  if (element) element.textContent = text;
}

function setConsistencyHelpText(text) {
  const help = document.getElementById('consistency-profile-help');
  if (!help) return;
  help.title = text;
  help.setAttribute('aria-label', text);
}

function setMaterializationHelpText(text) {
  const help = document.getElementById('materialization-profile-help');
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
