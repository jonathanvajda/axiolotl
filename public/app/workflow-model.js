export function createEmptyPipeline() {
  return {
    '@id': '',
    name: '',
    description: '',
    builtin: false,
    startStepId: '',
    steps: []
  };
}

export function createStep(stepId, queryId, queryType) {
  return {
    '@id': stepId,
    label: '',
    queryId: queryId || '',
    queryType: queryType || '',
    comment: '',
    branches: {},
    onError: { action: 'stop' }
  };
}

export function createTerminalStep(stepId, resultValue) {
  return {
    '@id': stepId,
    label: '',
    action: 'stop',
    result: resultValue || 'pass',
    comment: ''
  };
}

export function getStepById(pipeline, stepId) {
  return (pipeline.steps || []).find(function (step) {
    return step['@id'] === stepId;
  }) || null;
}

export function updateStep(pipeline, updatedStep) {
  return {
    ...pipeline,
    steps: (pipeline.steps || []).map(function (step) {
      return step['@id'] === updatedStep['@id'] ? updatedStep : step;
    })
  };
}

export function addStep(pipeline, step) {
  return {
    ...pipeline,
    steps: (pipeline.steps || []).concat([step])
  };
}

export function removeStep(pipeline, stepId) {
  return {
    ...pipeline,
    steps: (pipeline.steps || []).filter(function (step) {
      return step['@id'] !== stepId;
    })
  };
}