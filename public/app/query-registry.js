export function mergeQueryManifests(builtinManifest, userManifest) {
  var builtinQueries = Array.isArray(builtinManifest && builtinManifest.queries)
    ? builtinManifest.queries
    : [];

  var userQueries = Array.isArray(userManifest && userManifest.queries)
    ? userManifest.queries
    : [];

  var merged = [];
  var seen = new Set();

  builtinQueries.concat(userQueries).forEach(function (queryDef) {
    var id = queryDef['@id'];
    if (!id) return;

    if (!seen.has(id)) {
      seen.add(id);
      merged.push(queryDef);
    }
  });

  return {
    version: '1.0.0',
    queries: merged
  };
}

export function getQueryById(queryManifest, queryId) {
  return (queryManifest.queries || []).find(function (queryDef) {
    return queryDef['@id'] === queryId;
  }) || null;
}

export function listQueriesByType(queryManifest, queryType) {
  return (queryManifest.queries || []).filter(function (queryDef) {
    return queryDef.type === queryType;
  });
}