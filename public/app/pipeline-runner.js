import { getStepById } from './workflow-model.js';
import { getQueryById } from './query-registry.js';

export async function runPipeline(pipeline, queryManifest, executeQuery) {
  var trace = [];
  var currentStepId = pipeline.startStepId;
  var visited = new Set();

  while (currentStepId) {
    if (visited.has(currentStepId)) {
      trace.push({
        stepId: currentStepId,
        status: 'error',
        message: 'Cycle detected. Stopping execution.'
      });
      break;
    }

    visited.add(currentStepId);

    var step = getStepById(pipeline, currentStepId);
    if (!step) {
      trace.push({
        stepId: currentStepId,
        status: 'error',
        message: 'Missing step.'
      });
      break;
    }

    if (step.action === 'stop') {
      trace.push({
        stepId: currentStepId,
        status: 'stop',
        result: step.result || null,
        message: step.comment || ''
      });
      break;
    }

    var queryDef = getQueryById(queryManifest, step.queryId);
    if (!queryDef) {
      trace.push({
        stepId: currentStepId,
        status: 'error',
        message: 'Missing query definition for queryId ' + step.queryId
      });
      break;
    }

    try {
      var result = await executeQuery(queryDef, step);

      trace.push({
        stepId: currentStepId,
        queryId: step.queryId,
        queryType: step.queryType,
        status: 'success',
        result: result
      });

      if (step.queryType === 'ask') {
        currentStepId = result === true
          ? step.branches.true
          : step.branches.false;
      } else {
        trace.push({
          stepId: currentStepId,
          status: 'error',
          message: 'This test runner currently only supports ASK.'
        });
        break;
      }
    } catch (err) {
      trace.push({
        stepId: currentStepId,
        queryId: step.queryId,
        status: 'error',
        message: err && err.message ? err.message : String(err)
      });

      if (step.onError && step.onError.action === 'goto' && step.onError.targetStepId) {
        currentStepId = step.onError.targetStepId;
      } else {
        break;
      }
    }
  }

  return trace;
}