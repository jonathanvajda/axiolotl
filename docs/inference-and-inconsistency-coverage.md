# Axiolotl inference and inconsistency coverage

Reviewed against the current implementation on 2026-10-07.

For implementation order, architecture diagrams, and the next three milestones,
see the [consistency roadmap](consistency-roadmap.md).

## Scope and interpretation

This feature detects selected contradictions in asserted RDF and materialized
consequences. General class satisfiability is out of scope. No findings means no
contradiction detected within implemented coverage; it is not proof of consistency.
An aborted run is incomplete. Repeated or mirrored rows are evidence, not distinct
contradiction counts. Deterministic execution does not imply complete OWL semantics.

Sources: `public/app/axiolotl-inference.js`, `public/app/axiolotl-inconsistency.js`,
and `public/app/axiolotl-ui.js`. The normal UI materializes first, then checks the
active workspace in memory. It does not currently run an asserted-data precheck.
Checks run against the browser-local Active Workspace.

## Registered checks

The registry contains ten contradiction-pattern checks (some narrowly partial)
and two open-world heuristics. SELECT, ASK, and reporting CONSTRUCT query forms
are generated, but the UI executes SELECT. CONSTRUCT reports require an injected
`applyConstruct` function or the legacy global adapter; query generation alone
is not evidence of a tested reporting pipeline.

| Query ID | Classification | Actual boundary |
| --- | --- | --- |
| `disjointWithTypeOverlap` | Direct contradiction | Available types on both sides of a binary disjointness axiom; includes types inferred from subclass/domain/range rules. |
| `allDisjointClassesTypeOverlap` | Direct contradiction | Available types overlap two members of an RDF disjoint-class list. |
| `complementOfTypeOverlap` | Direct contradiction | Available types include a class and its complement; mirrored rows possible. No general class-expression solver. |
| `datatypeFunctionalPropertyConflict` | Partial contradiction check | Functional property with literal values proven unequal by the bounded exact value comparator. Supports `xsd:string`, `rdf:langString`, `xsd:boolean`, `xsd:decimal`, and the `xsd:integer` family with range validation. Invalid or unsupported values produce incomplete-coverage notices. |
| `objectFunctionalPropertyDifferentFromConflict` | Partial contradiction check | Nonliteral functional fillers linked by `owl:differentFrom` in either direction or an `owl:AllDifferent` list, including aliases reached through bidirectional `owl:sameAs` paths. Distinct names alone do not prove inequality. Equality substitution can create repeated/self-inequality evidence. |
| `negativePropertyAssertionConflict` | Direct contradiction | Positive triple conflicts with a negative assertion using `owl:targetIndividual`. Negative data assertions using `owl:targetValue` are not covered. |
| `sameAsKnownDifferentConflict` | Direct contradiction | Equality via bidirectional `owl:sameAs` paths conflicts with either direction of `owl:differentFrom` or an `owl:AllDifferent` list. Includes self-inequality. Available equality may be asserted or materialized. |
| `allDifferentSameAsConflict` | Direct contradiction | `owl:AllDifferent` `owl:distinctMembers` list contains two syntactically distinct terms connected by bidirectional `owl:sameAs` paths. Equality may be asserted or materialized. |
| `allDisjointPropertiesSharedPair` | Direct contradiction | Same subject/object pair uses two members of an `owl:AllDisjointProperties` list. Binary `owl:propertyDisjointWith` is not covered. |
| `singlePropertyHasKeyDifferentFromConflict` | Partial contradiction check | Named class, exactly one explicitly typed data/object key property, and named individuals. Data values use the shared bounded comparator; object values must be named and may match through `owl:sameAs`. Inequality uses bidirectional `owl:differentFrom` or `owl:AllDifferent` through equality aliases. No multi-property keys or arbitrary class expressions. |
| `disjointUnionMissingMemberHeuristic` | Warning, not contradiction | Union instance lacks a known member type. Missing information is compatible with open-world consistency. |
| `allValuesFromMissingTypeHeuristic` | Warning, not contradiction | Restriction value lacks a known filler type. Warning can disappear after `owl:allValuesFrom` materialization. |

The registry and runtime explicitly distinguish `violation` and `warning`.
The UI displays separate row totals; warnings do not establish a contradiction.
Coverage notices set a separate `incomplete` status. Each finding retains its
check ID, bindings, and RDF context, with the query, scope, and phase recorded at
check level. Reports include all findings, RDF terms with datatype/language tags,
graph identity, and asserted/materialized origin when supplied by the caller.
RDF context is not a minimal proof: it can contain adjacent assertions, and does
not explain every inference step. Missing-type warnings retain the query showing
the absence condition; absence itself is not an asserted RDF triple.
Warning CONSTRUCTs use `axi:ConsistencyWarning`, not `axi:InconsistencyViolation`.
Profiles select subsets; they do not implement complete OWL 2 EL, DL, or Full.

## Materialization actually implemented

| RDF/OWL term | Rule ID | Implementation and limitation |
| --- | --- | --- |
| `rdfs:subClassOf` | `subclassof` | JavaScript subclass closure and type propagation over existing terms. SPARQL fallback is skipped by the fixpoint loop. |
| `rdfs:subPropertyOf` | `subpropertyof` | JavaScript subproperty closure and assertion propagation. SPARQL fallback is skipped by the fixpoint loop. |
| `owl:inverseOf` | `inverse` | Bidirectional JavaScript inverse map plus SPARQL expansion; guards against literal subjects. |
| `owl:SymmetricProperty` | `symmetric` | JavaScript and SPARQL reverse assertions; guards against literal subjects. |
| `owl:TransitiveProperty` | `transitive` | JavaScript queue expansion plus SPARQL transitive assertions. |
| `rdfs:domain` | `domain` | JavaScript and SPARQL derive subject types. |
| `rdfs:range` | `range` | JavaScript and SPARQL derive object types when the object can be an RDF subject. |
| `owl:equivalentClass` | `equivalentclass` | SPARQL type propagation in the asserted axiom direction only; output restricted to named classes. Incomplete equivalence semantics. |
| `owl:equivalentProperty` | `equivalentproperty` | SPARQL assertion propagation in the asserted axiom direction only. Incomplete equivalence semantics. |
| `owl:sameAs` | `sameas` | JavaScript symmetry, transitivity, subject/object substitution preserving blank-node identities. No predicate substitution or full OWL equality implementation. |
| `owl:FunctionalProperty` | `functional` | SPARQL derives `owl:sameAs` between nonliteral fillers. No general datatype solver. |
| `owl:InverseFunctionalProperty` | `inversefunctional` | SPARQL derives `owl:sameAs` between subjects sharing an object. |
| `owl:hasValue` | `hasvalue` | Derives a property assertion for an instance of a class subclassing an `owl:hasValue` restriction. |
| `owl:hasValue` | `hasvalueclass` | Recognizes a named class explicitly equivalent to a matching `owl:hasValue` restriction, in either equivalence direction. Subclass-only restrictions cannot trigger class recognition. |
| `owl:allValuesFrom` | `allvaluesfrom` | Derives named filler types from a direct superclass restriction; can expose disjointness. No general recursive restriction solver. |
| `owl:someValuesFrom` | `somevaluesfromclass` | Recognizes a named class explicitly equivalent to a matching `owl:someValuesFrom` restriction, in either equivalence direction. Subclass-only restrictions cannot trigger class recognition. No ordinary witness creation. |
| `owl:intersectionOf` | `intersectionof` | Recognizes an intersection expression when all listed member types are available. No complete normalization or reverse decomposition. |
| `owl:propertyChainAxiom` | `propertychain` | Exactly two property-chain members. Arbitrary-length chains are unsupported. |

The JavaScript seed/queue stage currently executes its built-in expansions even
when corresponding checkboxes are disabled. Thus custom rule selection does not
fully constrain materialization. Error handling in runRuleOnce logs SPARQL rule
failures and returns no output; a completed run may therefore have skipped rules.
These are limitations requiring correction before claiming reliable preset semantics.

## Graph scope

Check scope `default` queries the default graph; `named` queries a specified graph.
The current `union` helper matches a whole pattern in the default graph or within
one named graph. It is not a merged union allowing arbitrary cross-graph joins.
Some queries use multiple scoped groups, so their cross-graph behavior differs.
JavaScript materialization inspects all graphs for some operations, while SPARQL
and the new equality propagation consume default-graph input. Do not claim
consistent cross-graph reasoning until this behavior is normalized and tested.

## Comparison with HermiT and Pellet

These columns describe expected OWL 2 DL semantic coverage, not measured results,
matching SPARQL rows, performance, or guarantees for arbitrary RDF/OWL Full input.
Use OWL 2 DL compliant fixtures and record reasoner versions/configuration for
actual comparisons. ELK/profile conformance is not benchmarked here.

| Pattern | Axiolotl | HermiT | Pellet |
| --- | --- | --- | --- |
| `owl:disjointWith` type overlap | Available types only | OWL 2 DL reasoning | OWL 2 DL reasoning |
| `owl:AllDisjointClasses` type overlap | Available types and list members | OWL 2 DL reasoning | OWL 2 DL reasoning |
| `owl:complementOf` type overlap | Available types only | OWL 2 DL reasoning | OWL 2 DL reasoning |
| `owl:FunctionalProperty` object-value conflict | Available `owl:differentFrom` or `owl:AllDifferent`, with equality-aware alias matching | OWL 2 DL reasoning | OWL 2 DL reasoning |
| `owl:FunctionalProperty` literal-value conflict | Exact bounded datatype comparison; unsupported/invalid values yield coverage notices | OWL 2 DL reasoning | OWL 2 DL reasoning |
| `owl:NegativePropertyAssertion` object conflict | Direct `owl:targetIndividual` pattern | OWL 2 DL reasoning | OWL 2 DL reasoning |
| `owl:NegativePropertyAssertion` data conflict | `owl:targetValue` unsupported | OWL 2 DL reasoning | OWL 2 DL reasoning |
| `owl:AllDifferent` equality conflict | Available `owl:sameAs` and `owl:distinctMembers` | OWL 2 DL reasoning | OWL 2 DL reasoning |
| `owl:AllDisjointProperties` shared pair | Direct shared subject/object pair | OWL 2 DL reasoning | OWL 2 DL reasoning |
| `owl:hasKey` contradiction | Named-class single-property key; typed property, bounded value equality and equality-aware inequality | OWL 2 DL reasoning | OWL 2 DL reasoning |
| `owl:allValuesFrom` filler proven disjoint | Indirectly via materialized filler type and disjointness | OWL 2 DL reasoning | OWL 2 DL reasoning |
| `owl:sameAs` conflicting with `owl:differentFrom` | `sameAsKnownDifferentConflict`; both directions and equality paths | OWL 2 DL reasoning | OWL 2 DL reasoning |
| `owl:Nothing` membership | No dedicated check | OWL 2 DL reasoning | OWL 2 DL reasoning |
| `owl:minCardinality` | No dedicated check | OWL 2 DL reasoning | OWL 2 DL reasoning |
| `owl:maxCardinality` | No dedicated check | OWL 2 DL reasoning | OWL 2 DL reasoning |
| `owl:cardinality` | No dedicated check | OWL 2 DL reasoning | OWL 2 DL reasoning |
| `owl:minQualifiedCardinality` | No dedicated check | OWL 2 DL reasoning | OWL 2 DL reasoning |
| `owl:maxQualifiedCardinality` | No dedicated check | OWL 2 DL reasoning | OWL 2 DL reasoning |
| `owl:qualifiedCardinality` | No dedicated check | OWL 2 DL reasoning | OWL 2 DL reasoning |
| `owl:IrreflexiveProperty` | No dedicated check | OWL 2 DL reasoning | OWL 2 DL reasoning |
| `owl:AsymmetricProperty` | No dedicated check | OWL 2 DL reasoning | OWL 2 DL reasoning |
| `owl:propertyDisjointWith` | No dedicated check | OWL 2 DL reasoning | OWL 2 DL reasoning |
| `owl:InverseFunctionalProperty` inequality conflict | Materialized equality checked by `sameAsKnownDifferentConflict` | OWL 2 DL reasoning | OWL 2 DL reasoning |
| `owl:disjointUnionOf` missing member type | Heuristic warning | Missing type alone is not a contradiction | Missing type alone is not a contradiction |
| `owl:allValuesFrom` missing filler type | Heuristic warning | Missing type alone is not a contradiction | Missing type alone is not a contradiction |
| Datatype value/range contradictions | Unsupported | Supported datatype semantics | Supported datatype semantics |
| General class satisfiability | Out of scope | Separate reasoning task | Separate reasoning task |

Primary references: [HermiT](https://www.hermit-reasoner.com/index.html),
[Pellet](https://github.com/stardog-union/pellet),
[OWL 2 Direct Semantics](https://www.w3.org/TR/owl2-direct-semantics/),
and [OWL 2 Primer](https://www.w3.org/TR/owl-primer/).
Reasoners establish ontology consistency; they do not necessarily enumerate every
contradiction in an inconsistent ontology or emit Axiolotl-style reports.

## Hydration is separate

`HYDRATION_QUERIES` lives in `axiolotl-inconsistency.js`. `namedClassInstances` seeds
synthetic individuals for named classes; `subclassAndExistentialWitnesses` also
creates shallow existential/intersection witnesses. Normal consistency UI does
not invoke hydration. Seeding every class imposes nonemptiness assumptions and
can introduce contradictions absent from the original ontology. General
satisfiability probing is outside this feature; hydration is not a consistency
proof and should remain isolated from user data.

## Evidence and readiness

`public/test-fixtures/consistency/manifest.json` lists 70 fixtures spanning all 12
registered checks, with controls and stage expectations. Original fixture syntax and 72 stage
expectations were validated with RDFLib and independent derivations, not a full
browser N3/Comunica pipeline. Jest includes a real N3 equality convergence test;
most registry tests use generated query text and mocked engines. Functional-object tests now execute the shipped N3/Comunica bundles against eight positive/control fixtures.

User browser smoke tests found 2 AllDifferent rows on the isolated positive case.
The broad docs/owl-inconsistency-instance-fixture.ttl produced 12 rows across six
checks after materialization: disjointness 2, complement 2, object functional 4,
negative assertion 1, AllDifferent 2, key 1. These are smoke observations, not
HermiT/Pellet comparative benchmark results.

The invalid converse rules have been corrected and tested against the shipped engine.
Before declaring the default consistency workflow reliable: normalize graph scope, and
surface incomplete rule execution. Add actual N3/Comunica fixture execution and
asserted-data prechecks. Satisfiability, query-file extraction, and performance
comparisons remain deferred; see consistency-scope-and-backlog.md.

## Bounded datatype comparison and key update

`datatype-value-comparison.js` compares integer/decimal values exactly using
BigInt rational arithmetic, preserving values beyond JavaScript Number precision.
Integer-derived datatypes enforce their bounds. Boolean lexical aliases and
case-insensitive language tags are handled. `xsd:float`, `xsd:double`, dates/times,
custom datatypes, string-derived datatypes, and full datatype-range reasoning
remain unsupported. No casts between string and numeric value spaces are inferred.

Generated datatype/key queries use `axi:compareValues`, a Comunica extension
function registered by the SELECT runner and built-in CONSTRUCT adapter. They
require this extension context when run elsewhere; they are no longer standalone
portable SPARQL queries. A supplied external CONSTRUCT adapter must register it.
Unsupported comparisons generate coverage notices in SELECT results and the UI,
not contradiction rows; ASK/CONSTRUCT forms do not carry that coverage status.

Fifteen additional public fixtures and real bundled-engine tests cover value
normalization, cross-datatype conflicts, exact large numbers, invalid/unsupported
values, named-individual/object-witness restrictions, equality aliases, and
AllDifferent. Multi-property keys and complete OWL datatype reasoning are deferred.

## General equality conflict coverage

`sameAsKnownDifferentConflict` anchors evidence at the unequal terms and checks
bidirectional `owl:sameAs` reachability. Its zero-length path also catches explicit
self-inequality. `owl:AllDifferent` accepts `owl:distinctMembers` and `owl:members`.
The report includes `?a`, `?b`, optional `?set`, and `?inequalitySource`.
The existing list-specific check now also supports equality paths and both list
predicates. Enabling both checks may report the same underlying contradiction;
row totals are not distinct-contradiction totals. Arbitrary inferred inequality,
malformed OWL validation, and cross-graph joins remain outside this addition.

Thirteen additional fixtures execute before and after selected inference rules
using the shipped engine. They include functionality/inverse-functionality derived
equality, reversed assertions, aliases, self-inequality, and consistent controls.
The earlier broad-fixture row counts above are historical observations taken
before this general check was added, not expectations for the expanded registry.
