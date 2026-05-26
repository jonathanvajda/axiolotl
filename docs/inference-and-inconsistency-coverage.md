# Axiolotl Inference and Inconsistency Coverage

This document describes the current coverage of Axiolotl's browser-side inference and inconsistency tooling. It is intended as a living benchmark map: a future contributor should be able to add a row, add a query, and compare Axiolotl coverage against ELK, Pellet, HermiT, or another OWL reasoner.

## Scope

Axiolotl currently provides lightweight materialization and inconsistency checks over RDF/JS stores using JavaScript and SPARQL queries. It is not currently a complete OWL 2 DL reasoner.

Current implementation sources:

- `public/app/axiolotl-inference.js`: materialization rules and `applyConstructWithComunica`.
- `public/app/axiolotl-inconsistency.js`: inconsistency query registry, violation CONSTRUCTs, hydration queries, and coverage metadata.

Reasoner comparison columns are profile-level guidance, not benchmark results.

- ELK is treated as OWL 2 EL-oriented coverage.
- Pellet is treated as OWL-DL / SROIQ-style tableau reasoner coverage.
- HermiT is treated as OWL 2 DL direct-semantics coverage.

## Legend

| Value | Meaning |
| --- | --- |
| Yes | Covered directly enough to rely on for that row's stated pattern. |
| Partial | Some cases are covered, but important semantic cases are missing. |
| Heuristic | Useful signal, but not a sound/complete inconsistency proof under OWL open-world semantics. |
| No | Not currently covered. |
| Profile no | Outside the relevant OWL profile, even if another reasoner may support it. |
| N/A | Not applicable to that tool or row. |

## Current Materialization Coverage

These rules are implemented in `axiolotl-inference.js`.

| Pattern | Axiolotl materializes | Axiolotl approach | ELK | Pellet | HermiT | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `rdfs:subClassOf+` type propagation | Yes | JS transitive closure over subclass edges, plus SPARQL rule fallback still present | Yes | Yes | Yes | `x rdf:type A`, `A rdfs:subClassOf+ B` yields `x rdf:type B`. Blank-node class expressions are not interpreted as DL restrictions here. |
| `rdfs:subPropertyOf+` property propagation | Yes | JS transitive closure over subproperty edges, plus SPARQL rule fallback still present | Yes | Yes | Yes | `x p y`, `p rdfs:subPropertyOf+ q` yields `x q y`. |
| `owl:inverseOf` | Yes | Bidirectional map in JS and SPARQL CONSTRUCT rule | Profile no | Yes | Yes | OWL 2 EL does not support inverse object property expressions. Axiolotl supports direct named inverse property assertions. |
| `owl:SymmetricProperty` | Yes | JS expansion and SPARQL CONSTRUCT rule | Profile no / limited | Yes | Yes | Axiolotl materializes `y p x` from `x p y`. |
| `owl:TransitiveProperty` | Yes | JS queue expansion and SPARQL CONSTRUCT rule | Yes | Yes | Yes | Axiolotl computes new edges from existing edges in the same graph context. |
| `rdfs:domain` | Yes | JS map and SPARQL CONSTRUCT rule | Yes | Yes | Yes | `x p y`, `p rdfs:domain C` yields `x rdf:type C`. |
| `rdfs:range` | Yes | JS map and SPARQL CONSTRUCT rule | Yes | Yes | Yes | Only materializes object types when the object can be a subject. |
| `owl:equivalentClass` | No | Not currently expanded | Yes, for EL class expressions | Yes | Yes | Could be added by reducing named equivalence to two subclass edges, then relying on subclass closure. |
| `owl:equivalentProperty` | No | Not currently expanded | Yes, for EL property expressions | Yes | Yes | Could be added by reducing to two subproperty edges. |
| `owl:sameAs` equality closure | No | Not currently expanded | Partial | Yes | Yes | Current violation checks can consume explicit `owl:sameAs`, but do not compute equality closure. |
| `owl:differentFrom` closure | No | Not currently expanded | Partial | Yes | Yes | Current functional-property checks consume explicit `owl:differentFrom`. |
| `owl:someValuesFrom` existential witness creation | Partial | New hydration query can create shallow synthetic witnesses | Yes, in OWL 2 EL | Yes | Yes | Axiolotl hydration is opt-in and heuristic; normal inference does not materialize witnesses. |
| `owl:intersectionOf` class-expression reasoning | Partial | Hydration supports shallow intersection parts inside someValuesFrom fillers | Yes, in OWL 2 EL | Yes | Yes | No general recursive class-expression normalization yet. |
| `owl:allValuesFrom` / "only values from" | No for materialization | Not currently materialized | Profile no | Yes | Yes | OWL RDF uses `owl:allValuesFrom`; "OnlyValuesFrom" is common Manchester-style wording. |
| Cardinality restrictions | No | Not currently materialized | Profile no, except limited functional data property support in EL profile syntax | Yes | Yes | Current checks only detect simple conflicts from explicit data/object values. |
| Property chains | No | Not currently materialized | Yes, with OWL 2 EL restrictions | Yes | Yes | Axiolotl has transitive properties but no general chain expansion. |
| Datatype reasoning | No | Literal inequality uses SPARQL `!=`; no datatype satisfiability reasoning | Limited profile datatypes | Yes | Yes | Axiolotl does not normalize lexical forms or detect datatype-range contradictions. |

## Current Axiom Violation Detection

These checks are registered in `axiolotl-inconsistency.js`. Each query can be rendered as `SELECT`, `ASK`, or a violation-reporting `CONSTRUCT`.

| Violation pattern | Axiolotl detects | Query id | ELK | Pellet | HermiT | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Individual typed as both sides of `owl:disjointWith` | Yes | `disjointWithTypeOverlap` | Yes | Yes | Yes | Depends on available `rdf:type` assertions. Run materialization first for subclass/domain/range-derived types. |
| Individual typed as two members of `owl:AllDisjointClasses` | Yes | `allDisjointClassesTypeOverlap` | Yes | Yes | Yes | Expands RDF lists with `rdf:rest*/rdf:first`. |
| Individual typed as class and complement class | Yes | `complementOfTypeOverlap` | Profile no | Yes | Yes | Detects explicit type overlap only; no general complement satisfiability reasoning. |
| Functional property with two unequal literal values | Yes | `datatypeFunctionalPropertyConflict` | Partial | Yes | Yes | Uses SPARQL literal inequality. Does not perform full datatype canonicalization. |
| Functional object property with values known `owl:differentFrom` | Yes | `objectFunctionalPropertyDifferentFromConflict` | Partial | Yes | Yes | Requires explicit inequality; does not infer inequality or same/different closure. |
| Asserted triple contradicts `owl:NegativePropertyAssertion` | Yes | `negativePropertyAssertionConflict` | Profile no / limited | Yes | Yes | Direct ABox contradiction check. |
| Members of `owl:AllDifferent` also related by `owl:sameAs` | Yes | `allDifferentSameAsConflict` | Partial | Yes | Yes | Requires explicit `owl:sameAs`; no equality closure yet. |
| Same subject/object pair uses two `owl:AllDisjointProperties` members | Yes | `allDisjointPropertiesSharedPair` | Partial / profile-dependent | Yes | Yes | Direct property-disjointness conflict. |
| Instance of `owl:disjointUnionOf` class lacks any member type | Heuristic | `disjointUnionMissingMemberHeuristic` | Profile no | Yes | Yes | Under open-world semantics, missing a known member type is not by itself an inconsistency. This is a modeling smell check. |
| Value of `owl:allValuesFrom` restriction lacks known filler type | Heuristic | `allValuesFromMissingTypeHeuristic` | Profile no | Yes | Yes | Missing a type is not a contradiction in OWL. A stricter check needs proof that the value cannot be in the filler class. |
| Single-property `owl:hasKey` collision plus `owl:differentFrom` | Partial | `singlePropertyHasKeyDifferentFromConflict` | Yes, profile allows keys | Yes | Yes | Single-property key only. Multi-property key joins are not implemented. |

## Complex Axiom Pattern Coverage

This table is the main roadmap for expanding beyond low-hanging ABox conflicts.

| Complex pattern | Axiolotl current support | ELK | Pellet | HermiT | What is missing in Axiolotl |
| --- | --- | --- | --- | --- | --- |
| Named subclass chain: `A subClassOf B subClassOf C` | Yes | Yes | Yes | Yes | Already covered. |
| Named class instance plus named superclass | Yes | Yes | Yes | Yes | Already covered. |
| `A subClassOf [ owl:onProperty p ; owl:someValuesFrom F ]` | Partial hydration | Yes | Yes | Yes | Hydration can create a synthetic `p` witness typed as `F`; normal inference does not derive it automatically. |
| Nested existential in intersection filler | Partial hydration | Yes, if in OWL 2 EL grammar | Yes | Yes | Current hydration handles one nested pattern: filler intersection part that is itself a `someValuesFrom` restriction. Needs recursive traversal and cycle protection. |
| Arbitrary-depth nested `owl:Restriction` | No | Partial, only EL-supported constructs | Yes | Yes | Need recursive class-expression walker and bounded/unbounded strategy for witness generation. |
| `owl:intersectionOf` on named class equivalence | Partial | Yes | Yes | Yes | Current support is mostly inside hydration witness fillers. No full normalization of `EquivalentClasses(A ObjectIntersectionOf(...))`. |
| `owl:unionOf` | No | Profile no | Yes | Yes | Need branching semantics. Materializing all branches would be unsound; inconsistency checks require DL reasoning or careful query patterns. |
| `owl:complementOf` satisfiability | Partial direct conflict | Profile no | Yes | Yes | Only explicit type overlap is checked. No proof that a class is unsatisfiable because it is subclass of its complement or disjoint constraints. |
| `owl:allValuesFrom` / only-values restriction | Heuristic only | Profile no | Yes | Yes | Need sound check: `x type R`, `x p y`, and `y` proven disjoint with or impossible to be `C`, not merely missing type `C`. |
| `owl:hasValue` | No | Yes | Yes | Yes | Could add materialization from `x type restriction` to `x p value`, and violation checks involving disjoint property/class consequences. |
| `owl:minCardinality`, `owl:maxCardinality`, exact cardinality | No | Profile no | Yes | Yes | Need counting plus equality semantics. SPARQL can catch explicit max-cardinality conflicts when fillers are known different. |
| Qualified cardinality restrictions | No | Profile no | Yes | Yes | Similar to cardinality, but scoped to filler class membership and disjointness. |
| `owl:FunctionalProperty` as max-cardinality-one | Partial violation detection | Partial | Yes | Yes | Axiolotl detects obvious literal conflicts and explicit `differentFrom` object conflicts, but does not derive `sameAs`. |
| `owl:InverseFunctionalProperty` | No | Profile no | Yes | Yes | Could detect two subjects with same object and explicit `differentFrom`; could materialize `sameAs` heuristically only with care. |
| `owl:IrreflexiveProperty` | No | Profile no | Yes | Yes | Easy direct check: `p a owl:IrreflexiveProperty` and `x p x`. |
| `owl:AsymmetricProperty` | No | Profile no | Yes | Yes | Easy direct check: `x p y` and `y p x`. |
| `owl:propertyDisjointWith` | No | Profile-dependent | Yes | Yes | Existing `AllDisjointProperties` check can be adapted to binary disjoint properties. |
| Property chains | No | Yes, with EL restrictions | Yes | Yes | Need chain-list expansion and materialization rule generation. |
| Negative class assertions | No | Profile-dependent | Yes | Yes | Need RDF mapping support for negative class assertion patterns, where present. |
| Datatype range contradictions | No | Limited | Yes | Yes | Need datatype parser/canonicalizer or external reasoner integration. |
| OWL 2 DL global restrictions / profile validation | No | N/A | Partial operationally | Partial operationally | Need a profile validator or OWL API/ROBOT-style external validation path. |

## Hydration Coverage

Hydration is not proof by itself. It is a strategy for creating synthetic individuals that exercise class axioms so subsequent materialization and violation checks can expose latent contradictions.

| Hydration query | Current behavior | Intended use | Limitation |
| --- | --- | --- | --- |
| `namedClassInstances` | Creates one synthetic instance for each named `owl:Class`, excluding `owl:Thing` and `owl:Nothing`. | Seed a model with representative class instances. | Does not satisfy restrictions or complex superclass expressions by itself. |
| `subclassAndExistentialWitnesses` | Creates a synthetic instance for each named class, adds named superclass types, creates shallow `someValuesFrom` witnesses, and handles one nested existential inside an intersection filler. | Exercise OWL 2 EL-style existential patterns like CCO/BFO subclass restrictions. | Not recursive, no `allValuesFrom`, no union/complement/cardinality semantics, and deterministic witness IRIs may merge across runs unless run IRIs are managed. |

## Suggested Expansion Backlog

| Priority | Addition | Why it helps | Likely implementation path |
| --- | --- | --- | --- |
| 1 | Binary `owl:propertyDisjointWith` violation query | Complements existing `AllDisjointProperties` support | Add SPARQL SELECT/ASK/CONSTRUCT pattern. |
| 1 | `owl:IrreflexiveProperty` and `owl:AsymmetricProperty` checks | Easy direct ABox contradictions | Add two query definitions. |
| 1 | `owl:equivalentClass` and `owl:equivalentProperty` materialization | Common ontology pattern | Reduce named equivalence to subclass/subproperty pairs or add closure maps. |
| 2 | Multi-property `owl:hasKey` conflicts | Current key coverage is intentionally narrow | Generate joins for RDF key lists, initially bounded by key length. |
| 2 | Sounder `allValuesFrom` contradiction query | Replaces missing-type heuristic with real inconsistency evidence | Look for `y rdf:type D` where `D` is disjoint with `C`, or `y` is typed as complement of `C`. |
| 2 | Recursive EL hydration | Better implicit inconsistency exposure for EL ontologies | Build a bounded recursive class-expression expander for `intersectionOf` and `someValuesFrom`. |
| 3 | Property-chain materialization | Important OWL 2 EL/RL feature | Expand RDF lists in `owl:propertyChainAxiom` and construct chain consequences. |
| 3 | Datatype contradiction checks | Needed for data-heavy KGs | Add datatype normalization or delegate to a reasoner/library. |
| 3 | External reasoner benchmark harness | Enables Axiolotl vs ELK/Pellet/HermiT comparison | Define fixtures, expected entailments, expected inconsistencies, and timing metrics. |

## Benchmark Notes

For fair benchmark comparisons:

1. Separate materialization benchmarks from consistency-checking benchmarks.
2. Record graph scope: default graph, named graph, or default-plus-named union.
3. Run Axiolotl in phases: base load, optional hydration, materialization, violation detection.
4. Track both runtime and coverage:
   - triples materialized,
   - violation rows found,
   - false positives from heuristics,
   - expected contradictions missed,
   - memory usage when available.
5. Keep open-world semantics visible. A missing type is not the same as a contradiction.

## Sources for Reasoner/Profile Columns

- W3C OWL 2 Profiles: OWL 2 EL supports `ObjectIntersectionOf` and `ObjectSomeValuesFrom`, disallows inverse object property expressions, and disallows `DisjointUnion` in the EL profile. See https://www.w3.org/TR/owl2-profiles/
- ELK project page: ELK's stated goal is support for the OWL 2 EL profile. See https://liveontologies.github.io/elk-reasoner/
- HermiT system description: HermiT is described as fully compliant with OWL 2 Direct Semantics and supports standard OWL 2 reasoning tasks including entailment, class classification, and property classification. See https://ora.ox.ac.uk/objects/uuid:e719ebc8-ff8b-4efa-a14f-7da8478ff0ed
- Pellet system description: Pellet is described as a complete OWL-DL reasoner with consistency checking, individual reasoning, datatype support, and extensions toward OWL 1.1/SROIQ-era features. See https://doi.org/10.1016/j.websem.2007.03.004

