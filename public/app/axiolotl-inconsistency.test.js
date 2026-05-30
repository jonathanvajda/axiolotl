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
  runInconsistencySelect,
  scopedWhere,
} from './axiolotl-inconsistency.js';
import { Readable } from 'node:stream';
import { jest } from '@jest/globals';

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

describe('Comunica select runner compatibility', () => {
  test('supports engines that expose query and resultToString instead of queryBindings', async () => {
    const json = JSON.stringify({
      head: { vars: ['x'] },
      results: { bindings: [{ x: { type: 'uri', value: 'http://example.org/x' } }] },
    });
    const engine = {
      query: jest.fn(async () => ({ type: 'bindings' })),
      resultToString: jest.fn(async () => ({ data: Readable.from([json]) })),
    };

    const result = await runInconsistencySelect('disjointWithTypeOverlap', {}, { engine });

    expect(result.rows).toEqual([{ x: { type: 'uri', value: 'http://example.org/x' } }]);
    expect(engine.query).toHaveBeenCalledTimes(1);
    expect(engine.resultToString).toHaveBeenCalledWith({ type: 'bindings' }, 'application/sparql-results+json');
  });

  test('creates a browser Comunica QueryEngine when no global engine is exposed', async () => {
    const originalComunica = globalThis.Comunica;
    const originalEngine = globalThis.engine;
    const json = JSON.stringify({ head: { vars: [] }, results: { bindings: [] } });
    const query = jest.fn(async () => ({ type: 'bindings' }));
    const resultToString = jest.fn(async () => ({ data: Readable.from([json]) }));

    try {
      delete globalThis.engine;
      globalThis.Comunica = {
        QueryEngine: jest.fn(() => ({ query, resultToString })),
      };

      const result = await runInconsistencySelect('disjointWithTypeOverlap', {});

      expect(result.rows).toEqual([]);
      expect(globalThis.Comunica.QueryEngine).toHaveBeenCalledTimes(1);
      expect(query).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.Comunica = originalComunica;
      if (originalEngine === undefined) delete globalThis.engine;
      else globalThis.engine = originalEngine;
    }
  });
});
