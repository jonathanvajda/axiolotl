import {
  constructInconsistencyReport,
  getAllInconsistencySelectQueries,
  getHydrationConstructQuery,
  getInconsistencyQuery,
  hasInconsistencyQuery,
  listHydrationQueries,
  listInconsistencyCoverage,
  listInconsistencyQueries,
  normalizeQueryOptions,
  scopedWhere,
} from './axiolotl-inconsistency.js';

describe('axiolotl-inconsistency query registry', () => {
  test('registers the expected low-hanging-fruit checks', () => {
    const ids = listInconsistencyQueries().map(query => query.id);

    expect(ids).toEqual(expect.arrayContaining([
      'disjointWithTypeOverlap',
      'allDisjointClassesTypeOverlap',
      'complementOfTypeOverlap',
      'datatypeFunctionalPropertyConflict',
      'objectFunctionalPropertyDifferentFromConflict',
      'negativePropertyAssertionConflict',
      'allDifferentSameAsConflict',
      'allDisjointPropertiesSharedPair',
      'disjointUnionMissingMemberHeuristic',
      'allValuesFromMissingTypeHeuristic',
      'singlePropertyHasKeyDifferentFromConflict',
    ]));
  });

  test('builds SELECT, ASK, and CONSTRUCT forms', () => {
    expect(getInconsistencyQuery('disjointWithTypeOverlap')).toContain('SELECT DISTINCT ?x ?A ?B');
    expect(getInconsistencyQuery('disjointWithTypeOverlap', { resultForm: 'ask' })).toContain('ASK WHERE');
    expect(getInconsistencyQuery('disjointWithTypeOverlap', { resultForm: 'construct' })).toContain('axi:InconsistencyViolation');
  });

  test('builds all supported SELECT queries', () => {
    const queries = getAllInconsistencySelectQueries();

    expect(queries.length).toBe(listInconsistencyQueries().filter(query => query.supported).length);
    expect(queries.every(item => item.query.includes('SELECT DISTINCT'))).toBe(true);
  });

  test('identifies query ids without throwing', () => {
    expect(hasInconsistencyQuery('disjointWithTypeOverlap')).toBe(true);
    expect(hasInconsistencyQuery('missing')).toBe(false);
  });
});

describe('graph scoping', () => {
  test('normalizes default options', () => {
    expect(normalizeQueryOptions()).toEqual({
      scope: 'union',
      graphIri: null,
      resultForm: 'select',
    });
  });

  test('requires a graph IRI for named scope', () => {
    expect(() => normalizeQueryOptions({ scope: 'named' })).toThrow('graphIri');
  });

  test('wraps union scope with default and named graph alternatives', () => {
    const body = scopedWhere('?s ?p ?o .', { scope: 'union' });

    expect(body).toContain('?s ?p ?o .');
    expect(body).toContain('GRAPH ?axiolotlGraph');
  });

  test('wraps named scope with a concrete graph IRI', () => {
    const query = getInconsistencyQuery('negativePropertyAssertionConflict', {
      scope: 'named',
      graphIri: 'http://example.org/graph',
    });

    expect(query).toContain('GRAPH <http://example.org/graph>');
    expect(query).toContain('owl:NegativePropertyAssertion');
  });
});

describe('hydration queries', () => {
  test('lists hydration query metadata', () => {
    const ids = listHydrationQueries().map(item => item.id);

    expect(ids).toEqual(expect.arrayContaining([
      'namedClassInstances',
      'subclassAndExistentialWitnesses',
    ]));
  });

  test('builds deterministic named class instance hydration by default', () => {
    const query = getHydrationConstructQuery('namedClassInstances', {
      runIri: 'http://example.org/run/1',
    });

    expect(query).toContain('CONSTRUCT');
    expect(query).toContain('hyd:hydratedFromClass');
    expect(query).toContain('http://example.org/hydration/node/');
    expect(query).toContain('<http://example.org/run/1>');
  });

  test('can build uuid-backed hydration nodes', () => {
    const query = getHydrationConstructQuery('namedClassInstances', {
      deterministicIris: false,
    });

    expect(query).toContain('STRUUID()');
  });
});

describe('coverage documentation and construct adapter', () => {
  test('documents supported, partial, and unsupported areas', () => {
    const support = new Set(listInconsistencyCoverage().map(item => item.support));

    expect(support.has('supported')).toBe(true);
    expect(support.has('partial')).toBe(true);
    expect(support.has('unsupported')).toBe(true);
  });

  test('constructInconsistencyReport delegates to the supplied construct function', async () => {
    const calls = [];
    const quads = [{ subject: 's' }];
    const result = await constructInconsistencyReport('disjointWithTypeOverlap', {}, {
      applyConstruct: async (query, store) => {
        calls.push({ query, store });
        return quads;
      },
    });

    expect(result).toBe(quads);
    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain('axi:InconsistencyViolation');
  });
});

