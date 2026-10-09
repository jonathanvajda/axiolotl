import { readFileSync } from 'node:fs';
import { compareDatatypeValues } from './datatype-value-comparison.js';
import { getInconsistencyQuery } from './axiolotl-inconsistency.js';
import { inspectOntologyDataset } from './shared/ontology-metadata/index.js';
import {
  COMMON_NAMESPACE_IRIS,
  COMMON_NAMESPACE_REGISTRY,
  namespacePrefixMapFromRegistry
} from './shared/namespace-registry/index.js';

const namedNode = (value) => ({ termType: 'NamedNode', value });
const defaultGraph = () => ({ termType: 'DefaultGraph', value: '' });
const quad = (subject, predicate, object, graph = defaultGraph()) => ({
  subject: namedNode(subject),
  predicate: namedNode(predicate),
  object: namedNode(object),
  graph
});

describe('shared SDK alignment', () => {
  test('consistency queries obtain standard prefixes from the namespace registry', () => {
    const prefixes = namespacePrefixMapFromRegistry();
    const query = getInconsistencyQuery('disjointWithTypeOverlap');

    for (const prefix of ['rdf', 'rdfs', 'owl', 'xsd']) {
      expect(query).toContain(`PREFIX ${prefix}: <${prefixes[prefix]}>`);
    }
    expect(query).toContain('PREFIX axi: <http://example.org/axiolotl/inconsistency/>');
    expect(query).toContain('PREFIX hyd: <http://example.org/axiolotl/hydration/>');
  });

  test('datatype comparison follows registry-managed RDF and XSD identifiers', () => {
    const literal = (value, datatype, language = '') => ({
      termType: 'Literal',
      value,
      language,
      datatype: namedNode(datatype)
    });

    expect(compareDatatypeValues(
      literal('01', COMMON_NAMESPACE_IRIS.xsd.integer),
      literal('1', COMMON_NAMESPACE_IRIS.xsd.integer)
    )).toBe('equal');
    expect(compareDatatypeValues(
      literal('hello', COMMON_NAMESPACE_IRIS.rdf.langString, 'EN'),
      literal('hello', COMMON_NAMESPACE_IRIS.rdf.langString, 'en')
    )).toBe('equal');
  });

  test('ontology staging inspection is owned by ontology-metadata and uses registry IRIs', () => {
    const ontologyIri = 'https://example.test/ontology';
    const versionIri = 'https://example.test/ontology/1';
    const importIri = 'https://example.test/imported';
    const graph = namedNode('https://example.test/graph');
    const inspection = inspectOntologyDataset([
      quad(ontologyIri, COMMON_NAMESPACE_IRIS.rdf.type, COMMON_NAMESPACE_IRIS.owl.Ontology, graph),
      quad(ontologyIri, COMMON_NAMESPACE_IRIS.owl.versionIRI, versionIri, graph),
      quad(ontologyIri, COMMON_NAMESPACE_IRIS.owl.imports, importIri, graph)
    ]);

    expect(inspection).toEqual({
      imports: [importIri],
      namedGraphs: [graph.value],
      ontologyIris: [ontologyIri, versionIri],
      tripleCount: 3
    });
  });

  test('feature modules do not redeclare shared W3C namespace strings', () => {
    const files = [
      './axiolotl-inconsistency.js',
      './datatype-value-comparison.js',
      './axiolotl-query.js'
    ];

    for (const relativePath of files) {
      const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
      expect(source).not.toContain(COMMON_NAMESPACE_REGISTRY.rdf.namespaceIri);
      expect(source).not.toContain(COMMON_NAMESPACE_REGISTRY.rdfs.namespaceIri);
      expect(source).not.toContain(COMMON_NAMESPACE_REGISTRY.owl.namespaceIri);
      expect(source).not.toContain(COMMON_NAMESPACE_REGISTRY.xsd.namespaceIri);
    }
  });

  test('staging and inference delegate MIME and SPARQL parsing to shared utilities', () => {
    const stagingSource = readFileSync(new URL('./axiolotl-query.js', import.meta.url), 'utf8');
    const inferenceSource = readFileSync(new URL('./axiolotl-inference.js', import.meta.url), 'utf8');

    expect(stagingSource).toContain('getRdfAdapterDescriptorForMimeType');
    expect(stagingSource).toContain('rdfSerializationPreservesNamedGraphs');
    expect(stagingSource).toContain('inspectOntologyDataset');
    expect(stagingSource).not.toContain('STAGEABLE_RDF_MIMES');
    expect(inferenceSource).toContain('splitSparqlPrologueFromBody');
    expect(inferenceSource).not.toContain('function stripSparqlPrologue');
  });
});
