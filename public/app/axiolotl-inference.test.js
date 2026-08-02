import { jest } from '@jest/globals';

const namedNode = (value) => ({ termType: 'NamedNode', value });
const blankNode = (value) => ({ termType: 'BlankNode', value });
const literal = (value) => ({
  termType: 'Literal',
  value,
  language: '',
  datatype: namedNode('http://www.w3.org/2001/XMLSchema#string')
});
const defaultGraph = () => ({ termType: 'DefaultGraph', value: '' });
const quad = (subject, predicate, object, graph = defaultGraph()) => ({
  subject,
  predicate,
  object,
  graph
});

beforeAll(() => {
  globalThis.Comunica = {
    QueryEngine: class {
      queryQuads() {
        throw new Error('queryQuads is not used by these inference unit tests.');
      }
    }
  };
  globalThis.N3 = {
    DataFactory: {
      namedNode,
      blankNode,
      literal,
      defaultGraph,
      quad
    },
    Store: class {
      constructor(items = []) {
        this.items = [...items];
      }

      getQuads() {
        return [...this.items];
      }
    }
  };
  globalThis.document = {
    querySelectorAll: () => [],
    getElementById: () => null
  };
});

describe('Axiolotl inference rule safety', () => {
  test('range CONSTRUCT guards against literal objects becoming subjects', async () => {
    const { getConstructQueryForRule } = await import('./axiolotl-inference.js');

    const query = getConstructQueryForRule('range');

    expect(query).toContain('CONSTRUCT { ?y rdf:type ?range }');
    expect(query).toContain('FILTER(isIRI(?y) || isBlank(?y))');
  });

  test('inverse and symmetric CONSTRUCT rules guard subject-position variables', async () => {
    const { getConstructQueryForRule } = await import('./axiolotl-inference.js');

    expect(getConstructQueryForRule('inverse').match(/FILTER\(isIRI\(\?y\) \|\| isBlank\(\?y\)\)/g)).toHaveLength(2);
    expect(getConstructQueryForRule('symmetric')).toContain('FILTER(isIRI(?y) || isBlank(?y))');
  });

  test('selectSerializableInferenceQuads removes invalid literal-subject quads', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { selectSerializableInferenceQuads } = await import('./axiolotl-inference.js');
    const valid = quad(
      namedNode('http://example.test/s'),
      namedNode('http://example.test/p'),
      literal('value')
    );
    const invalid = quad(
      literal('literal subject'),
      namedNode('http://example.test/p'),
      namedNode('http://example.test/o')
    );

    expect(selectSerializableInferenceQuads([valid, invalid], 'test')).toEqual([valid]);
    warn.mockRestore();
  });
});
