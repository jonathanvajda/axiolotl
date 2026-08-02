import {
  assertNonEmptyWorkspaceSerialization,
  createWorkspaceExportStore,
  selectWorkspaceExportQuads,
  serializeWorkspaceExport
} from './axiolotl-workspace-export.js';
import { literal, namedNode, quad } from './shared/rdf-io/index.js';

function createFakeN3Runtime({ emptyWriter = false } = {}) {
  const dataFactory = {
    namedNode: (value) => ({ termType: 'NamedNode', value, __n3Term: true }),
    blankNode: (value) => ({ termType: 'BlankNode', value, __n3Term: true }),
    defaultGraph: () => ({ termType: 'DefaultGraph', value: '', __n3Term: true }),
    literal: (value, languageOrDatatype) => ({
      termType: 'Literal',
      value,
      language: typeof languageOrDatatype === 'string' ? languageOrDatatype : '',
      datatype: typeof languageOrDatatype === 'object' ? languageOrDatatype : undefined,
      __n3Term: true
    }),
    quad: (subject, predicate, object, graph) => ({
      subject,
      predicate,
      object,
      graph,
      __n3Quad: true
    })
  };

  class Store {
    constructor(quads = []) {
      this.items = [...quads];
    }

    addQuads(quads) {
      this.items.push(...quads);
    }

    getQuads(_subject, _predicate, _object, graph) {
      if (!graph) return [...this.items];
      return this.items.filter((item) =>
        item.graph?.termType === graph.termType
        && item.graph?.value === graph.value
      );
    }
  }

  class Writer {
    constructor({ format }) {
      this.format = format;
      this.items = [];
    }

    addQuads(quads) {
      this.items.push(...quads);
    }

    end(callback) {
      if (emptyWriter) {
        callback(null, '');
        return;
      }

      const lines = this.items.map((item) => {
        const graph = item.graph?.termType && item.graph.termType !== 'DefaultGraph'
          ? ` ${termToText(item.graph)}`
          : '';
        return `${termToText(item.subject)} ${termToText(item.predicate)} ${termToText(item.object)}${graph} .`;
      });
      callback(null, `${lines.join('\n')}${lines.length ? '\n' : ''}`);
    }
  }

  return {
    N3: {
      DataFactory: dataFactory,
      Store,
      Writer
    }
  };
}

function termToText(term) {
  if (term.termType === 'Literal') return `"${term.value}"`;
  return `<${term.value}>`;
}

function createWorkspaceStore(runtime) {
  return new runtime.N3.Store([
    quad('http://example.test/default-s', 'http://example.test/p', literal('default')),
    quad('http://example.test/named-s', 'http://example.test/p', namedNode('http://example.test/o'), 'http://example.test/g')
  ]);
}

describe('Axiolotl workspace export helpers', () => {
  test('selects only default graph quads for default graph export', () => {
    const runtime = createFakeN3Runtime();
    const store = createWorkspaceStore(runtime);

    const selected = selectWorkspaceExportQuads(store, 'default', runtime);

    expect(selected).toHaveLength(1);
    expect(selected[0].subject.value).toBe('http://example.test/default-s');
  });

  test('selects only named graph quads for named graph export', () => {
    const runtime = createFakeN3Runtime();
    const store = createWorkspaceStore(runtime);

    const selected = selectWorkspaceExportQuads(store, 'named', runtime);

    expect(selected).toHaveLength(1);
    expect(selected[0].subject.value).toBe('http://example.test/named-s');
  });

  test('serializes default graph Turtle with non-empty output', async () => {
    const runtime = createFakeN3Runtime();
    const store = createWorkspaceExportStore(createWorkspaceStore(runtime), 'default', runtime);

    const result = await serializeWorkspaceExport(store, {
      scope: 'all',
      mimeType: 'text/turtle',
      runtime
    });

    expect(result.count).toBe(1);
    expect(result.text).toContain('<http://example.test/default-s>');
    expect(result.text).not.toContain('<http://example.test/named-s>');
  });

  test('serializes named graph TriG with graph names preserved', async () => {
    const runtime = createFakeN3Runtime();
    const store = createWorkspaceExportStore(createWorkspaceStore(runtime), 'named', runtime);

    const result = await serializeWorkspaceExport(store, {
      scope: 'all',
      mimeType: 'application/trig',
      runtime
    });

    expect(result.count).toBe(1);
    expect(result.text).toContain('<http://example.test/named-s>');
    expect(result.text).toContain('<http://example.test/g>');
  });

  test('serializes named graph Turtle by flattening graph names', async () => {
    const runtime = createFakeN3Runtime();
    const store = createWorkspaceExportStore(createWorkspaceStore(runtime), 'named', runtime);

    const result = await serializeWorkspaceExport(store, {
      scope: 'all',
      mimeType: 'text/turtle',
      runtime
    });

    expect(result.count).toBe(1);
    expect(result.text).toContain('<http://example.test/named-s>');
    expect(result.text).not.toContain('<http://example.test/g>');
  });

  test('all graph export includes default and named graph quads', async () => {
    const runtime = createFakeN3Runtime();

    const result = await serializeWorkspaceExport(createWorkspaceStore(runtime), {
      scope: 'all',
      mimeType: 'application/n-quads',
      runtime
    });

    expect(result.count).toBe(2);
    expect(result.text).toContain('<http://example.test/default-s>');
    expect(result.text).toContain('<http://example.test/named-s>');
  });

  test('throws when a non-empty graph serializes to empty text', () => {
    expect(() => assertNonEmptyWorkspaceSerialization('', {
      count: 2,
      mimeType: 'text/turtle'
    })).toThrow('Serializer returned empty text/turtle output for 2 triples.');
  });
});
