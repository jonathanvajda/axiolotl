import { serializeRdfDatasetWithN3 } from './n3-adapter.js';
import { defaultGraph, literal, namedNode, quad } from './rdf-model.js';

function createStrictFakeN3Runtime() {
  const written = [];
  const dataFactory = {
    fromQuad: () => {
      throw new Error('fromQuad should not be used for plain normalized RDF/JS quads');
    },
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

  class Writer {
    addQuads(quads) {
      written.push(...quads);
    }

    end(callback) {
      const allConverted = written.every((item) =>
        item.__n3Quad
        && item.subject.__n3Term
        && item.predicate.__n3Term
        && item.object.__n3Term
        && item.graph.__n3Term
      );
      callback(null, allConverted ? '<http://example.test/s> <http://example.test/p> "value" .\n' : '');
    }
  }

  return {
    DataFactory: dataFactory,
    Writer
  };
}

describe('serializeRdfDatasetWithN3', () => {
  test('converts normalized RDF/JS quads through the N3 DataFactory before writing Turtle', async () => {
    const dataset = [
      quad(
        namedNode('http://example.test/s'),
        namedNode('http://example.test/p'),
        literal('value'),
        defaultGraph()
      )
    ];

    const result = await serializeRdfDatasetWithN3(dataset, {
      format: 'text/turtle',
      runtime: { N3: createStrictFakeN3Runtime() }
    });

    expect(result).toContain('<http://example.test/s>');
  });
});
