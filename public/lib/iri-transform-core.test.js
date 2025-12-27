import {
  parseIriMappingCsv,
  detectInputKind,
  isLikelyR2RML,
  replaceAngleIris,
  replaceIrisInsideLiterals,
  replaceIrisTextual,
  toNTriples,
  toNQuads,
  transformSparqlFile,
  transformRdfFile,
  batchTransform,
} from './iri-replacement-core.js';

const stubAdapter = {
  // "parses" by wrapping text/mime in a JS object
  parse: async (text, mime, baseIRI) => ({ text, mime, baseIRI }),
  // "serializes" by returning either N-Triples/N-Quads identity or echo with a MIME header
  serialize: (graph, mime) => {
    // If we came in as NT/NQ, just echo the original text to simulate idempotence
    if (mime === 'application/n-triples' || mime === 'application/n-quads') return graph.text;
    // Else, wrap to show a conversion happened
    return `# ${mime}\n${graph.text}`;
  },
};

describe('parseIriMappingCsv', () => {
  test('parses CSV with angle brackets', () => {
    const csv = 'old iri,new iri\n<http://old>,<http://new>\n';
    const { map, warnings } = parseIriMappingCsv(csv);
    expect(warnings.length).toBe(0);
    expect(map.get('http://old')).toBe('http://new');
  });

  test('parses TSV and de-duplicates', () => {
    const tsv = 'old iri\tnew iri\nhttp://a\thttp://b\nhttp://a\thttp://b\n';
    const { map } = parseIriMappingCsv(tsv);
    expect(map.size).toBe(1);
  });
});

describe('detectInputKind & isLikelyR2RML', () => {
  const detectRdfMimeByName = (n) => {
    const ext = n.split('.').pop();
    return ({ ttl:'text/turtle', nt:'application/n-triples', trig:'application/trig', rq:'application/sparql-query' }[ext] || 'text/turtle');
  };

  test('classifies SPARQL', () => {
    expect(detectInputKind('q.rq', '', { detectRdfMimeByName })).toBe('sparql');
  });

  test('classifies RDF triples', () => {
    expect(detectInputKind('x.ttl', '', { detectRdfMimeByName })).toBe('rdf-triples');
    expect(detectInputKind('x.nt', '', { detectRdfMimeByName })).toBe('rdf-triples');
  });

  test('classifies RDF quads', () => {
    expect(detectInputKind('x.trig', '', { detectRdfMimeByName })).toBe('rdf-quads');
  });

  test('detects R2RML TTL', () => {
    const peek = '@prefix rr: <http://www.w3.org/ns/r2rml#> . _:m a rr:TriplesMap ; rr:subjectMap [ rr:template "http://old/{id}" ] .';
    expect(isLikelyR2RML(peek)).toBe(true);
    expect(detectInputKind('x.ttl', peek, { detectRdfMimeByName })).toBe('r2rml-ttl');
  });
});

describe('textual replacements', () => {
  const mapping = new Map([['http://old', 'http://new']]);

  test('replaceAngleIris', () => {
    const src = '<http://old> <http://p> <http://old> . "http://old"';
    const out = replaceAngleIris(src, mapping);
    expect(out).toBe('<http://new> <http://p> <http://new> . "http://old"');
  });

  test('replaceIrisInsideLiterals', () => {
    const src = '"Visit http://old today" <http://p> "x" .';
    const out = replaceIrisInsideLiterals(src, mapping);
    expect(out).toBe('"Visit http://new today" <http://p> "x" .');
  });

  test('replaceIrisTextual both', () => {
    const src = '<http://old> "http://old"';
    const out = replaceIrisTextual(src, mapping, { insideLiterals: true });
    expect(out).toBe('<http://new> "http://new"');
  });
});

describe('adapter-driven normalization', () => {
  test('toNTriples is adapter-driven', async () => {
    const src = '<http://s> <http://p> <http://o> .';
    const out = await toNTriples(src, 'text/turtle', stubAdapter);
    expect(out).toBe(src); // stub echoes
  });

  test('toNQuads is adapter-driven', async () => {
    const src = '<http://s> <http://p> <http://o> <http://g> .';
    const out = await toNQuads(src, 'application/trig', stubAdapter);
    expect(out).toBe(src);
  });
});

describe('transformSparqlFile', () => {
  test('transforms SPARQL angle IRIs and literals', () => {
    const mapping = new Map([['http://old', 'http://new']]);
    const input = { name: 'q.rq', text: 'SELECT * WHERE { <http://old> ?p ?o . FILTER(CONTAINS("http://old","old")) }' };
    const { updatedText } = transformSparqlFile(input, { mapping, replaceInsideLiterals: true });
    expect(updatedText).toMatch('<http://new>');
    expect(updatedText).toMatch('"http://new"');
  });
});

describe('transformRdfFile', () => {
  const detectRdfMimeByName = (n) => (n.endsWith('.ttl') ? 'text/turtle' : 'application/n-triples');

  test('triples → NT, replace, re-emit target mime', async () => {
    const mapping = new Map([['http://old', 'http://new']]);
    const input = { name: 'a.ttl', text: '<http://old> <http://p> <http://o> .' };
    const { updatedText } = await transformRdfFile(input, {
      mapping,
      adapter: stubAdapter,
      detectRdfMimeByName,
      targetMime: 'application/n-triples',
    });
    expect(updatedText).toBe('<http://new> <http://p> <http://o> .');
  });
});

describe('batchTransform', () => {
  test('mixed files processed with one mapping CSV', async () => {
    const files = [
      { name: 'a.ttl', text: '<http://old> <http://p> <http://o> .' },
      { name: 'q.rq',  text: 'ASK { <http://old> ?p ?o }' },
    ];
    const out = await batchTransform(files, {
      mappingCsvText: 'old iri,new iri\nhttp://old,http://new\n',
      adapter: stubAdapter,
      detectRdfMimeByName: (n) => (n.endsWith('.rq') ? 'application/sparql-query' : 'text/turtle'),
      replaceInsideLiterals: true,
    });
    expect(out.length).toBe(2);
    expect(out[0].status).toBe('ok');
    expect(out[1].status).toBe('ok');
    expect(out[0].updatedText).toContain('<http://new>');
    expect(out[1].updatedText).toContain('<http://new>');
  });
});
