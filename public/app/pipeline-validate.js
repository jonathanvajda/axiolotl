export function validatePipeline(pipeline, queryManifest) {
  var issues = [];
  var stepIds = new Set();
  var queryIds = new Set((queryManifest.queries || []).map(function (q) {
    return q['@id'];
  }));

  if (!pipeline || !Array.isArray(pipeline.steps)) {
    issues.push({
      severity: 'error',
      message: 'Pipeline must have a steps array.'
    });
    return issues;
  }

  (pipeline.steps || []).forEach(function (step) {
    var stepId = step['@id'];

    if (!stepId) {
      issues.push({
        severity: 'error',
        message: 'A step is missing @id.'
      });
      return;
    }

    if (stepIds.has(stepId)) {
      issues.push({
        severity: 'error',
        message: 'Duplicate step ID: ' + stepId
      });
    } else {
      stepIds.add(stepId);
    }

    if (step.queryId && !queryIds.has(step.queryId)) {
      issues.push({
        severity: 'error',
        message: 'Step ' + stepId + ' references missing queryId: ' + step.queryId
      });
    }

    if (step.queryType === 'ask') {
      if (!step.branches || typeof step.branches.true !== 'string' || typeof step.branches.false !== 'string') {
        issues.push({
          severity: 'error',
          message: 'ASK step ' + stepId + ' must define branches.true and branches.false.'
        });
      }
    }

    if (step.action === 'stop' && step.queryId) {
      issues.push({
        severity: 'warning',
        message: 'Terminal step ' + stepId + ' should not usually define a queryId.'
      });
    }
  });

  if (!pipeline.startStepId) {
    issues.push({
      severity: 'error',
      message: 'Pipeline must define startStepId.'
    });
  } else if (!stepIds.has(pipeline.startStepId)) {
    issues.push({
      severity: 'error',
      message: 'startStepId does not exist in steps: ' + pipeline.startStepId
    });
  }

  (pipeline.steps || []).forEach(function (step) {
    if (step.branches) {
      Object.keys(step.branches).forEach(function (branchKey) {
        var targetId = step.branches[branchKey];
        if (typeof targetId === 'string' && !stepIds.has(targetId)) {
          issues.push({
            severity: 'error',
            message: 'Step ' + step['@id'] + ' points to missing target step: ' + targetId
          });
        }
      });
    }
  });

  return issues;
}