# Feature to add

## AS-IS state Query Manifest
The `axiolotl-inconsistency.js` basically hard-coded with SPARQL queries with the `INCONSISTENCY_QUERIES` object. I recall the decision to accept this in the near term.

It does make it harder to understand how SPARQL is used in the architecture, though, since I checked the SPARQL query folder (where the materialization queries are) and the consistency check queries aren't there as separate files. One might wonder why some queries are distinct files and others are not (but hard-coded in JS), especially for tracking Git history, checking for a full range of coverage, etc.

Example:
```js
const INCONSISTENCY_QUERIES = Object.freeze({
  disjointWithTypeOverlap: makeQueryDefinition({
    id: 'disjointWithTypeOverlap',
    label: 'owl:disjointWith type overlap',
    family: 'class-disjointness',
    description: 'Find individuals typed as both sides of an owl:disjointWith pair.',
    variables: ['x', 'A', 'B'],
    where: options => `
      ${scopedWhere('?A owl:disjointWith ?B .\n?x rdf:type ?A, ?B .', options)}
    `,
  }),

  allDisjointClassesTypeOverlap: makeQueryDefinition({
    id: 'allDisjointClassesTypeOverlap',
    label: 'owl:AllDisjointClasses type overlap',
    family: 'class-disjointness',
    description: 'Find individuals typed as multiple members of an owl:AllDisjointClasses list.',
    variables: ['x', 'set', 'A', 'B'],
    where: options => `
      ${scopedWhere(`
        ?set rdf:type owl:AllDisjointClasses .
        ?set owl:members/rdf:rest*/rdf:first ?A .
        ?set owl:members/rdf:rest*/rdf:first ?B .
        ?x rdf:type ?A, ?B .
      `, options)}
      FILTER(?A != ?B)
    `,
  }),
```


## TO-BE state Query Manifest
Making all of the queries in the object `INCONSISTENCY_QUERIES` to be their own separate `.rq` files and consult a `JSON` manifest that provides the `id`, `label`, `family`, `description`, `variables`, and path to call on them. Let's save this as a note for later.


## AS-IS state N3 pure vs N3+Comunica
Axiolotl currently uses JavaScript over N3 stores for several materialization operations, including taxonomy propagation. The inconsistency checks in axiolotl-inconsistency.js are SPARQL queries executed by Comunica.

N3.js provides RDF storage and indexed triple/quad matching; Comunica can execute SPARQL directly over that same N3 store. They complement each other. N3.js documentation, Comunica RDF/JS integration.

Your proposed pipeline should distinguish these outcomes:
1. Check asserted data. If a sound check finds a contradiction, report it immediately. Offer to continue if the user wants additional findings.
2. If none is found, materialize. “No contradiction detected yet” is the appropriate result from the first stage.
3. Check the expanded data. Report findings, or that no contradiction was detected within implemented coverage.
4. If materialization fails, report an incomplete check. Preserve any earlier findings.

Heuristic checks should produce warnings separately; missing information should not trigger an “inconsistent” verdict.

Class-level checks are useful, but an unsatisfiable class does not necessarily make an ontology inconsistent. For example:
```
A subClassOf B
A subClassOf C
B disjointWith C
```
This makes A impossible to instantiate. The ontology can still be consistent with A empty. An asserted instance of A makes the contradiction concrete. Taxonomy-path checks could therefore report “unsatisfiable class” separately from “inconsistent instance data,” without first materializing every superclass type.

On the implementation choice:
|Direct JavaScript over N3.js|SPARQL through Comunica|
|---|---|
|Good for indexed lookups, reusable closure maps, work queues, and early exit|	Good for declarative joins, property paths, RDF lists, filters, and customizable checks
|You control traversal, deduplication, and blank-node handling|	The engine handles query evaluation and planning
|You implement graph scope and term-comparison semantics|	SPARQL supplies those semantics, provided queries and context are correct|


## TO-BE state N3 pure vs N3+Comunica
JavaScript can implement those same operations; the difference is how much infrastructure you must write and maintain. Replacing SPARQL means taking responsibility for joins, cycle-safe paths, literal comparisons, list traversal, and graph semantics. Neither choice automatically provides complete OWL reasoning.
Direct JavaScript may be faster for repeated, narrowly defined checks that reuse indexes or closures. That is a hypothesis to benchmark against your fixtures and larger ontologies—not a guaranteed advantage. Comunica also supports query-planning optimizations over RDF/JS stores. Comunica optimization documentation.

My recommendation is to introduce a common checker interface that returns findings and evidence, then allow either a JavaScript or SPARQL implementation behind it. Keep the existing query registry, add the asserted-data stage, and move individual checks to JavaScript only when measurements or simpler correctness justify it. Fix the blank-node convergence problem independently; changing execution engines alone does not resolve that semantic issue.