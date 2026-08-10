import {
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
});
