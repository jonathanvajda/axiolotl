# Consistency fixtures

These public fixtures cover all 11 checks currently registered in
`public/app/axiolotl-inconsistency.js`. `manifest.json` is the machine-readable
inventory for automated tests and a future dashboard. Paths are relative to this
folder. Each fixture is self-contained and uses a fresh store; no imports or
hydration are needed. Load one file at a time for manual testing.

Each check has `positive.ttl`, `control.ttl`, and `after-materialization.ttl`.
Positive means a target finding is expected, not necessarily a contradiction:
the two missing-type heuristics produce warnings in consistent ontologies.
The manifest distinguishes these using `findingKind` and `ontologyInconsistent`.
The latter describes the ontology's semantics, including consequences, rather
than whether a direct query currently exposes the contradiction.

For each stage, assert presence or absence of the target finding, not an exact
row count. Multiple rows or other checks can describe the same underlying
contradiction. Every control is intended to remain consistent and free of
contradiction findings after the declared materialization.

For automated tests:

1. Parse the file into a fresh N3 store in the default graph.
2. Run `checkId` and compare with `expected.beforeMaterialization.targetFinding`.
3. Materialize using `materializationRules`, adding the overlay to the store.
4. Run the check again and compare with the after-materialization expectation.

Use the listed rules to isolate each derivation. Running every rule changes some
expectations: notably `allvaluesfrom` removes missing-filler-type warnings.
`warning-resolved.ttl` explicitly tests that behavior. Disjointness has additional
domain and range fixtures. The AllDifferent derived case uses functional equality
without the `sameas` propagation rule, avoiding the known blank-node convergence
problem while exercising the intended equality consequence.

These TTL files are not automatically executed by Jest. A real N3/Comunica test
runner must load the manifest and files; existing mocked registry tests do not
establish these semantic expectations. Named-graph/cross-graph tests require
additional dataset setup (or TriG), since Turtle does not encode named graphs.

The broader manual fixture remains in
`docs/owl-inconsistency-instance-fixture.ttl`. Unimplemented roadmap checks,
general satisfiability, and synthetic hydration are outside this collection.

Functional-object regression cases cover reverse inequality, both AllDifferent list predicates, equality aliases, and consistent controls. These cases run in Jest using the shipped N3/Comunica bundles.

Datatype/key regression fixtures require `axi:compareValues` from
`datatype-value-comparison.js` in the Comunica context. The normal SELECT runner
registers it. `coverageNotice` expectations identify unsupported/invalid values;
these do not count as detected contradictions. Those cases can be inconsistent
semantically despite zero findings. Jest exercises these files with the shipped
engine; datatype scope and key restrictions are documented in the coverage map.
