
var BUILTIN_QUERY_MANIFEST = {
  version: '1.0.0',
  queries: [
    {
      '@id': 'query:q_ontology_has_dcterms_license_with_url',
      name: 'Check Ontology for Valid License',
      fileName: 'q_ontology-has-dcterms-license-with-url.rq',
      location: './queries/q_ontology-has-dcterms-license-with-url.rq',
      type: 'ask',
      description: 'Returns true when the ontology has a dcterms:license value that is a valid URL/IRI.',
      builtin: true
    },
    {
      '@id': 'query:q_class_has_skos_definition',
      name: 'Check Classes for skos:definition',
      fileName: 'q_class-has-skos-definition.rq',
      location: './queries/q_class-has-skos-definition.rq',
      type: 'select',
      description: 'Returns all classes where definition condition is satisfied.',
      builtin: true
    },
    {
      '@id': 'query:q_ontology_has_dcterms_accessRights',
      name: 'Check Ontology for accessRights',
      fileName: 'q_ontology-has-dcterms-accessRights.rq',
      location: './queries/q_ontology-has-dcterms-accessRights.rq',
      type: 'ask',
      description: 'Returns true when the ontology has dcterms:accessRights.',
      builtin: true
    }
  ]
};

var BUILTIN_PIPELINE_MANIFEST = {
  version: '1.0.0',
  pipelines: [
    {
      '@id': 'pipeline:ontology_metadata_review_basic',
      name: 'Ontology Metadata Review - Basic',
      description: 'Checks license, then definitions, then access rights.',
      builtin: true,
      startStepId: 'Event001',
      steps: [
        {
          '@id': 'Event001',
          label: 'Check Ontology for Valid License',
          queryId: 'query:q_ontology_has_dcterms_license_with_url',
          queryType: 'ask',
          comment: 'Top-level license check.',
          branches: { true: 'Event002', false: 'Event003' },
          onError: { action: 'stop' }
        },
        {
          '@id': 'Event002',
          label: 'Check Classes for skos:definition',
          queryId: 'query:q_class_has_skos_definition',
          queryType: 'select',
          comment: 'Continue here if license check passed.',
          branches: { true: 'Event004', false: 'Event005' },
          onError: { action: 'stop' }
        },
        {
          '@id': 'Event003',
          label: 'Check Ontology for accessRights',
          queryId: 'query:q_ontology_has_dcterms_accessRights',
          queryType: 'ask',
          comment: 'Alternative branch after license failure.',
          branches: { true: 'Event004', false: 'Event006' },
          onError: { action: 'stop' }
        },
        {
          '@id': 'Event004',
          label: 'Workflow Passed',
          action: 'stop',
          result: 'pass',
          comment: 'Sufficient metadata conditions satisfied.'
        },
        {
          '@id': 'Event005',
          label: 'Definition Issue Found',
          action: 'stop',
          result: 'fail',
          comment: 'Class definition criteria failed.'
        },
        {
          '@id': 'Event006',
          label: 'Metadata Issue Found',
          action: 'stop',
          result: 'fail',
          comment: 'License and accessRights branch failed.'
        }
      ]
    }
  ]
};

var state = {
  queryManifest: BUILTIN_QUERY_MANIFEST,
  pipelineManifest: BUILTIN_PIPELINE_MANIFEST,
  activePipelineId: BUILTIN_PIPELINE_MANIFEST.pipelines[0]['@id'],
  selectedStepId: null,
  view: 'validation'
};

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getActivePipeline() {
  return state.pipelineManifest.pipelines.find(function (pipeline) {
    return pipeline['@id'] === state.activePipelineId;
  }) || null;
}

function getStepById(pipeline, stepId) {
  return (pipeline.steps || []).find(function (step) {
    return step['@id'] === stepId;
  }) || null;
}

function getQueryById(queryId) {
  return (state.queryManifest.queries || []).find(function (queryDef) {
    return queryDef['@id'] === queryId;
  }) || null;
}

function createDefaultStep() {
  var firstQuery = state.queryManifest.queries[0] || null;
  return {
    '@id': 'Event' + String(Date.now()).slice(-6),
    label: 'New Step',
    queryId: firstQuery ? firstQuery['@id'] : '',
    queryType: firstQuery ? firstQuery.type : '',
    comment: '',
    branches: firstQuery && firstQuery.type === 'ask' ? { true: '', false: '' } : {},
    onError: { action: 'stop' }
  };
}

function createDefaultPipeline() {
  return {
    '@id': 'pipeline:' + String(Date.now()),
    name: 'New Pipeline',
    description: '',
    builtin: false,
    startStepId: '',
    steps: []
  };
}

function replaceActivePipeline(nextPipeline) {
  state.pipelineManifest.pipelines = state.pipelineManifest.pipelines.map(function (pipeline) {
    return pipeline['@id'] === nextPipeline['@id'] ? nextPipeline : pipeline;
  });
}

function render() {
  renderPipelineList();
  renderStepList();
  renderInspector();
  renderValidation();
  renderPipelineJson();
  renderQueryRegistry();
}

function renderPipelineList() {
  var host = document.getElementById('pipelineList');
  var activePipeline = getActivePipeline();
  host.innerHTML = '';

  (state.pipelineManifest.pipelines || []).forEach(function (pipeline) {
    var item = document.createElement('div');
    item.className = 'step';
    item.style.cursor = 'pointer';
    item.style.borderStyle = pipeline['@id'] === state.activePipelineId ? 'solid' : 'dashed';
    item.innerHTML = '<strong>' + escapeHtml(pipeline.name) + '</strong><div class="muted" style="margin-top:4px;">' +
      escapeHtml(pipeline['@id']) + '</div>';
    item.addEventListener('click', function () {
      state.activePipelineId = pipeline['@id'];
      state.selectedStepId = null;
      render();
    });
    host.appendChild(item);
  });

  if (activePipeline) {
    document.getElementById('activePipelineTitle').textContent = activePipeline.name || 'Workflow Steps';
    document.getElementById('activePipelineMeta').textContent =
      'Start: ' + (activePipeline.startStepId || '(unset)') + ' · Steps: ' + (activePipeline.steps || []).length;
  }
}

function renderStepList() {
  var pipeline = getActivePipeline();
  var host = document.getElementById('stepList');
  host.innerHTML = '';

  if (!pipeline) return;

  if (!pipeline.steps || pipeline.steps.length === 0) {
    host.innerHTML = '<div class="muted">No steps yet. Add a first step.</div>';
    return;
  }

  (pipeline.steps || []).forEach(function (step, index) {
    var queryDef = step.queryId ? getQueryById(step.queryId) : null;
    var card = document.createElement('div');
    card.className = 'step';
    card.style.cursor = 'pointer';
    card.style.borderStyle = step['@id'] === state.selectedStepId ? 'solid' : 'dashed';

    var branchSummary = '';
    if (step.action === 'stop') {
      branchSummary = 'Terminal · result=' + (step.result || 'n/a');
    } else if (step.queryType === 'ask') {
      branchSummary = 'true → ' + (step.branches && step.branches.true ? step.branches.true : '(unset)') +
        ' · false → ' + (step.branches && step.branches.false ? step.branches.false : '(unset)');
    } else {
      branchSummary = 'Branches configured';
    }

    card.innerHTML = '' +
      '<div style="display:flex; justify-content:space-between; gap:8px; align-items:flex-start;">' +
        '<div>' +
          '<strong>' + escapeHtml(step['@id']) + '</strong> · ' + escapeHtml(step.label || '(untitled)') +
          '<div class="muted" style="margin-top:4px;">' +
            escapeHtml(step.action === 'stop' ? 'STOP' : ((queryDef && queryDef.name) || step.queryId || '(no query)')) +
          '</div>' +
        '</div>' +
        '<div class="muted">' + (index === 0 && pipeline.startStepId === step['@id'] ? 'START' : '') + '</div>' +
      '</div>' +
      '<div class="muted" style="margin-top:8px;">' + escapeHtml(branchSummary) + '</div>' +
      '<div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px;">' +
        '<button data-action="select" data-step-id="' + escapeHtml(step['@id']) + '">Edit</button>' +
        '<button data-action="start" data-step-id="' + escapeHtml(step['@id']) + '">Set Start</button>' +
      '</div>';

    host.appendChild(card);
  });

  host.querySelectorAll('button[data-action="select"]').forEach(function (button) {
    button.addEventListener('click', function (event) {
      event.stopPropagation();
      state.selectedStepId = button.getAttribute('data-step-id');
      renderInspector();
      renderStepList();
    });
  });

  host.querySelectorAll('button[data-action="start"]').forEach(function (button) {
    button.addEventListener('click', function (event) {
      event.stopPropagation();
      var pipelineCopy = deepClone(pipeline);
      pipelineCopy.startStepId = button.getAttribute('data-step-id');
      replaceActivePipeline(pipelineCopy);
      render();
    });
  });
}

function renderInspector() {
  var pipeline = getActivePipeline();
  var inspector = document.getElementById('inspector');
  if (!pipeline || !state.selectedStepId) {
    inspector.classList.add('hidden');
    return;
  }

  var step = getStepById(pipeline, state.selectedStepId);
  if (!step) {
    inspector.classList.add('hidden');
    return;
  }

  inspector.classList.remove('hidden');

  var stepIdInput = document.getElementById('stepIdInput');
  var stepLabelInput = document.getElementById('stepLabelInput');
  var stepQuerySelect = document.getElementById('stepQuerySelect');
  var stepQueryTypeInput = document.getElementById('stepQueryTypeInput');
  var stepCommentInput = document.getElementById('stepCommentInput');
  var branchEditor = document.getElementById('branchEditor');
  var branchTrueSelect = document.getElementById('branchTrueSelect');
  var branchFalseSelect = document.getElementById('branchFalseSelect');
  var branchTrueLabel = document.getElementById('branchTrueLabel');
  var branchFalseLabel = document.getElementById('branchFalseLabel');
  var onErrorActionSelect = document.getElementById('onErrorActionSelect');
  var onErrorTargetWrap = document.getElementById('onErrorTargetWrap');
  var onErrorTargetSelect = document.getElementById('onErrorTargetSelect');

  stepIdInput.value = step['@id'] || '';
  stepLabelInput.value = step.label || '';
  stepCommentInput.value = step.comment || '';

  populateQueryOptions(stepQuerySelect, step.queryId || '');
  stepQueryTypeInput.value = step.queryType || '';

  populateStepTargetOptions(branchTrueSelect, pipeline, step['@id'], step.branches && step.branches.true ? step.branches.true : '');
  populateStepTargetOptions(branchFalseSelect, pipeline, step['@id'], step.branches && step.branches.false ? step.branches.false : '');
  populateStepTargetOptions(onErrorTargetSelect, pipeline, step['@id'], step.onError && step.onError.targetStepId ? step.onError.targetStepId : '');

  onErrorActionSelect.value = step.onError && step.onError.action ? step.onError.action : 'stop';
  onErrorTargetWrap.classList.toggle('hidden', onErrorActionSelect.value !== 'goto');

  if (step.action === 'stop') {
    branchEditor.classList.add('hidden');
    stepQuerySelect.disabled = true;
    stepQueryTypeInput.value = 'terminal';
  } else {
    stepQuerySelect.disabled = false;
    if (step.queryType === 'ask') {
      branchTrueLabel.textContent = 'True branch';
      branchFalseLabel.textContent = 'False branch';
      branchEditor.classList.remove('hidden');
    } else {
      branchTrueLabel.textContent = 'Primary branch';
      branchFalseLabel.textContent = 'Secondary branch';
      branchEditor.classList.remove('hidden');
    }
  }
}

function populateQueryOptions(selectEl, selectedValue) {
  selectEl.innerHTML = '';
  (state.queryManifest.queries || []).forEach(function (queryDef) {
    var option = document.createElement('option');
    option.value = queryDef['@id'];
    option.textContent = queryDef.name + ' (' + queryDef.type.toUpperCase() + ')';
    option.selected = queryDef['@id'] === selectedValue;
    selectEl.appendChild(option);
  });
}

function populateStepTargetOptions(selectEl, pipeline, currentStepId, selectedValue) {
  selectEl.innerHTML = '';

  var blank = document.createElement('option');
  blank.value = '';
  blank.textContent = '(unset)';
  selectEl.appendChild(blank);

  (pipeline.steps || []).forEach(function (step) {
    if (step['@id'] === currentStepId) return;
    var option = document.createElement('option');
    option.value = step['@id'];
    option.textContent = step['@id'] + ' · ' + (step.label || '(untitled)');
    option.selected = step['@id'] === selectedValue;
    selectEl.appendChild(option);
  });
}

function renderValidation() {
  var panel = document.getElementById('validationPanel');
  var issues = validatePipeline(getActivePipeline(), state.queryManifest);
  panel.innerHTML = '';

  if (!issues.length) {
    panel.innerHTML = '<div class="muted">No validation issues.</div>';
    return;
  }

  issues.forEach(function (issue) {
    var row = document.createElement('div');
    row.style.marginBottom = '8px';
    row.innerHTML = '<strong>' + escapeHtml(issue.severity.toUpperCase()) + '</strong> · ' + escapeHtml(issue.message);
    panel.appendChild(row);
  });
}

function renderPipelineJson() {
  document.getElementById('pipelineJsonPanel').textContent = JSON.stringify(getActivePipeline(), null, 2);
}

function renderQueryRegistry() {
  var host = document.getElementById('queryRegistryList');
  host.innerHTML = '';
  (state.queryManifest.queries || []).forEach(function (queryDef) {
    var item = document.createElement('div');
    item.className = 'step';
    item.innerHTML = '<strong>' + escapeHtml(queryDef.name) + '</strong><div class="muted" style="margin-top:4px;">' +
      escapeHtml(queryDef['@id']) + ' · ' + escapeHtml(queryDef.type.toUpperCase()) + '</div>' +
      '<div class="muted" style="margin-top:4px;">' + escapeHtml(queryDef.location || '') + '</div>';
    host.appendChild(item);
  });
}

function validatePipeline(pipeline, queryManifest) {
  var issues = [];
  if (!pipeline) {
    issues.push({ severity: 'error', message: 'No active pipeline.' });
    return issues;
  }

  var stepIds = new Set();
  var queryIds = new Set((queryManifest.queries || []).map(function (q) { return q['@id']; }));

  if (!pipeline.startStepId) {
    issues.push({ severity: 'warning', message: 'Pipeline startStepId is not set.' });
  }

  (pipeline.steps || []).forEach(function (step) {
    if (!step['@id']) {
      issues.push({ severity: 'error', message: 'A step is missing @id.' });
      return;
    }

    if (stepIds.has(step['@id'])) {
      issues.push({ severity: 'error', message: 'Duplicate step ID: ' + step['@id'] });
    } else {
      stepIds.add(step['@id']);
    }

    if (step.action !== 'stop' && step.queryId && !queryIds.has(step.queryId)) {
      issues.push({ severity: 'error', message: 'Missing query reference for step ' + step['@id'] + ': ' + step.queryId });
    }

    if (step.queryType === 'ask' && step.action !== 'stop') {
      if (!step.branches || typeof step.branches.true !== 'string' || typeof step.branches.false !== 'string') {
        issues.push({ severity: 'error', message: 'ASK step ' + step['@id'] + ' must define true and false branches.' });
      }
    }

    if (step.onError && step.onError.action === 'goto' && !step.onError.targetStepId) {
      issues.push({ severity: 'warning', message: 'Step ' + step['@id'] + ' has goto onError without targetStepId.' });
    }
  });

  if (pipeline.startStepId && !stepIds.has(pipeline.startStepId)) {
    issues.push({ severity: 'error', message: 'startStepId does not exist: ' + pipeline.startStepId });
  }

  (pipeline.steps || []).forEach(function (step) {
    if (step.branches) {
      Object.keys(step.branches).forEach(function (key) {
        var targetId = step.branches[key];
        if (targetId && !stepIds.has(targetId)) {
          issues.push({ severity: 'error', message: 'Step ' + step['@id'] + ' points to missing step: ' + targetId });
        }
      });
    }
    if (step.onError && step.onError.action === 'goto' && step.onError.targetStepId && !stepIds.has(step.onError.targetStepId)) {
      issues.push({ severity: 'error', message: 'onError target missing for step ' + step['@id'] + ': ' + step.onError.targetStepId });
    }
  });

  return issues;
}

function saveSelectedStep() {
  var pipeline = deepClone(getActivePipeline());
  if (!pipeline || !state.selectedStepId) return;

  var stepIndex = (pipeline.steps || []).findIndex(function (step) {
    return step['@id'] === state.selectedStepId;
  });
  if (stepIndex < 0) return;

  var existingStep = pipeline.steps[stepIndex];
  var queryId = existingStep.action === 'stop' ? '' : document.getElementById('stepQuerySelect').value;
  var queryDef = queryId ? getQueryById(queryId) : null;

  var updatedStep = deepClone(existingStep);
  updatedStep['@id'] = document.getElementById('stepIdInput').value.trim();
  updatedStep.label = document.getElementById('stepLabelInput').value.trim();
  updatedStep.comment = document.getElementById('stepCommentInput').value.trim();

  if (updatedStep.action !== 'stop') {
    updatedStep.queryId = queryId;
    updatedStep.queryType = queryDef ? queryDef.type : '';
    updatedStep.branches = updatedStep.branches || {};
    updatedStep.branches.true = document.getElementById('branchTrueSelect').value;
    updatedStep.branches.false = document.getElementById('branchFalseSelect').value;
  }

  var onErrorAction = document.getElementById('onErrorActionSelect').value;
  updatedStep.onError = { action: onErrorAction };
  if (onErrorAction === 'goto') {
    updatedStep.onError.targetStepId = document.getElementById('onErrorTargetSelect').value;
  }

  pipeline.steps[stepIndex] = updatedStep;

  if (pipeline.startStepId === state.selectedStepId) {
    pipeline.startStepId = updatedStep['@id'];
  }

  (pipeline.steps || []).forEach(function (step) {
    if (step.branches) {
      Object.keys(step.branches).forEach(function (key) {
        if (step.branches[key] === state.selectedStepId) {
          step.branches[key] = updatedStep['@id'];
        }
      });
    }
    if (step.onError && step.onError.targetStepId === state.selectedStepId) {
      step.onError.targetStepId = updatedStep['@id'];
    }
  });

  replaceActivePipeline(pipeline);
  state.selectedStepId = updatedStep['@id'];
  render();
}

function deleteSelectedStep() {
  var pipeline = deepClone(getActivePipeline());
  if (!pipeline || !state.selectedStepId) return;

  pipeline.steps = (pipeline.steps || []).filter(function (step) {
    return step['@id'] !== state.selectedStepId;
  });

  (pipeline.steps || []).forEach(function (step) {
    if (step.branches) {
      Object.keys(step.branches).forEach(function (key) {
        if (step.branches[key] === state.selectedStepId) {
          step.branches[key] = '';
        }
      });
    }
    if (step.onError && step.onError.targetStepId === state.selectedStepId) {
      step.onError.targetStepId = '';
    }
  });

  if (pipeline.startStepId === state.selectedStepId) {
    pipeline.startStepId = pipeline.steps[0] ? pipeline.steps[0]['@id'] : '';
  }

  replaceActivePipeline(pipeline);
  state.selectedStepId = null;
  render();
}

function addStepToActivePipeline() {
  var pipeline = deepClone(getActivePipeline());
  if (!pipeline) return;

  var newStep = createDefaultStep();
  pipeline.steps = (pipeline.steps || []).concat([newStep]);

  if (!pipeline.startStepId) {
    pipeline.startStepId = newStep['@id'];
  }

  replaceActivePipeline(pipeline);
  state.selectedStepId = newStep['@id'];
  render();
}

function addNewPipeline() {
  var pipeline = createDefaultPipeline();
  state.pipelineManifest.pipelines = state.pipelineManifest.pipelines.concat([pipeline]);
  state.activePipelineId = pipeline['@id'];
  state.selectedStepId = null;
  render();
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function initTabs() {
  document.querySelectorAll('.tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      var targetId = tab.getAttribute('data-tab');
      document.querySelectorAll('.tab-content').forEach(function (content) {
        content.classList.add('hidden');
      });
      document.getElementById(targetId).classList.remove('hidden');
      document.querySelectorAll('.tab').forEach(function (item) {
        item.classList.remove('active');
      });
      tab.classList.add('active');
    });
  });
}

function initEvents() {
  document.getElementById('newPipelineBtn').addEventListener('click', addNewPipeline);
  document.getElementById('addStepBtn').addEventListener('click', addStepToActivePipeline);
  document.getElementById('saveStepBtn').addEventListener('click', saveSelectedStep);
  document.getElementById('deleteStepBtn').addEventListener('click', deleteSelectedStep);
  document.getElementById('closeInspectorBtn').addEventListener('click', function () {
    state.selectedStepId = null;
    renderInspector();
    renderStepList();
  });

  document.getElementById('stepQuerySelect').addEventListener('change', function () {
    var queryDef = getQueryById(document.getElementById('stepQuerySelect').value);
    document.getElementById('stepQueryTypeInput').value = queryDef ? queryDef.type : '';
  });

  document.getElementById('onErrorActionSelect').addEventListener('change', function () {
    document.getElementById('onErrorTargetWrap').classList.toggle('hidden', this.value !== 'goto');
  });

  document.getElementById('validatePipelineBtn').addEventListener('click', function () {
    state.view = 'validation';
    document.getElementById('validationPanel').classList.remove('hidden');
    document.getElementById('pipelineJsonPanel').classList.add('hidden');
    renderValidation();
  });

  document.getElementById('showValidationBtn').addEventListener('click', function () {
    state.view = 'validation';
    document.getElementById('validationPanel').classList.remove('hidden');
    document.getElementById('pipelineJsonPanel').classList.add('hidden');
  });

  document.getElementById('showPipelineJsonBtn').addEventListener('click', function () {
    state.view = 'json';
    document.getElementById('validationPanel').classList.add('hidden');
    document.getElementById('pipelineJsonPanel').classList.remove('hidden');
    renderPipelineJson();
  });

  document.getElementById('exportPipelineBtn').addEventListener('click', function () {
    var blob = new Blob([JSON.stringify(getActivePipeline(), null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = 'pipeline.json';
    link.click();
    URL.revokeObjectURL(url);
  });
}

initTabs();
initEvents();
render();