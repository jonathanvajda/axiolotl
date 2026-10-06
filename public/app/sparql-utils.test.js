import {
  applySparqlUpdateToQuadStore,
  buildSparqlUpdatePreviewConstructs,
  classifySparqlOperationFamily,
  readBalancedSparqlBraceBlock,
  splitSparqlPrologueFromBody,
  stripSparqlLineComments
} from './shared/sparql-utils/index.js';

describe('shared SPARQL utilities used by Axiolotl', () => {
  test('classifies query/update text after prologue and comments', () => {
    expect(classifySparqlOperationFamily([
      'PREFIX ex: <http://example.org/>',
      '# comment',
      'SELECT * WHERE { ?s ?p ?o }'
    ].join('\n'))).toBe('READ');

    expect(classifySparqlOperationFamily([
      'PREFIX ex: <http://example.org/>',
      'INSERT { ?s ex:p ?o } WHERE { ?s ex:q ?o }'
    ].join('\n'))).toBe('UPDATE');
  });

  test('supports update-preview parsing primitives without damaging strings', () => {
    const text = [
      'PREFIX ex: <http://example.org/>',
      'INSERT { ?s ex:p "{not a brace}" } WHERE { ?s ex:q ?o } # trailing comment'
    ].join('\n');
    const cleaned = stripSparqlLineComments(text);
    const split = splitSparqlPrologueFromBody(cleaned);
    const insertStart = split.bodyText.indexOf('{');
    const block = readBalancedSparqlBraceBlock(split.bodyText, insertStart);

    expect(split.prologueText).toBe('PREFIX ex: <http://example.org/>');
    expect(block.ok).toBe(true);
    expect(block.content).toContain('"{not a brace}"');
    expect(cleaned).not.toContain('trailing comment');
  });

  test('builds update preview CONSTRUCT queries for DELETE/INSERT WHERE', () => {
    const previews = buildSparqlUpdatePreviewConstructs([
      'PREFIX ex: <http://example.org/>',
      'DELETE { ?s ex:old ?o }',
      'INSERT { ?s ex:new ?o }',
      'WHERE { ?s ex:old ?o }'
    ].join('\n'));

    expect(previews).toHaveLength(2);
    expect(previews[0].label).toBe('Triples that would be deleted');
    expect(previews[1].label).toBe('Triples that would be inserted');
    expect(previews[1].query).toContain('CONSTRUCT');
    expect(previews[1].query).toContain('?s ex:new ?o');
  });

  test('applies update materialization through injected quad-store adapters', async () => {
    const inserted = [];
    const deleted = [];
    const result = await applySparqlUpdateToQuadStore([
      'PREFIX ex: <http://example.org/>',
      'DELETE { ?s ex:old ?o }',
      'INSERT { ?s ex:new ?o }',
      'WHERE { ?s ex:old ?o }'
    ].join('\n'), {
      runConstructQuery: async (_query, { operation }) => operation,
      parseConstructResult: async (_text, { operation }) => ({
        quads: [{
          subject: { termType: 'NamedNode', value: 'http://example.org/s' },
          predicate: { termType: 'NamedNode', value: operation === 'delete' ? 'http://example.org/old' : 'http://example.org/new' },
          object: {
            termType: 'Literal',
            value: 'literal with spaces',
            language: '',
            datatype: { termType: 'NamedNode', value: 'http://www.w3.org/2001/XMLSchema#string' }
          },
          graph: { termType: 'DefaultGraph', value: '' }
        }]
      }),
      deleteQuadRows: async (rows) => {
        deleted.push(...rows);
        return rows.length;
      },
      insertQuadRows: async (rows) => {
        inserted.push(...rows);
        return rows.length;
      }
    });

    expect(result).toMatchObject({ deleted: 1, inserted: 1 });
    expect(deleted[0]).toMatchObject({ predicate: 'http://example.org/old', object: 'literal with spaces' });
    expect(inserted[0]).toMatchObject({ predicate: 'http://example.org/new', objectDatatype: 'http://www.w3.org/2001/XMLSchema#string' });
  });
});
