export function mergePipelineManifests(builtinManifest, userManifest) {
  var builtinPipelines = Array.isArray(builtinManifest && builtinManifest.pipelines)
    ? builtinManifest.pipelines
    : [];

  var userPipelines = Array.isArray(userManifest && userManifest.pipelines)
    ? userManifest.pipelines
    : [];

  var merged = [];
  var seen = new Set();

  builtinPipelines.concat(userPipelines).forEach(function (pipelineDef) {
    var id = pipelineDef['@id'];
    if (!id) return;

    if (!seen.has(id)) {
      seen.add(id);
      merged.push(pipelineDef);
    }
  });

  return {
    version: '1.0.0',
    pipelines: merged
  };
}

export function getPipelineById(pipelineManifest, pipelineId) {
  return (pipelineManifest.pipelines || []).find(function (pipelineDef) {
    return pipelineDef['@id'] === pipelineId;
  }) || null;
}