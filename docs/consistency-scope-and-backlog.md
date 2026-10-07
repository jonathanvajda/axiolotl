# Consistency scope and deferred work

Recorded 2026-10-07.

## Current scope

This feature targets inconsistency detection over asserted RDF and supported
materialized consequences. General class satisfiability checking is out of scope.
No findings means no contradiction detected within implemented coverage, not a
proof of consistency. An aborted materialization means the check is incomplete.
Missing-type heuristics should be warnings, separate from contradiction findings.

Run direct checks before materialization so existing contradictions can be reported
even if materialization subsequently fails. If no contradiction is detected,
materialize and check again. Continuing after an early contradiction can collect
additional findings.

## Deferred query-file extraction

Move the `INCONSISTENCY_QUERIES` definitions currently in
`public/app/axiolotl-inconsistency.js` into separate `.rq` files, with a JSON manifest
containing `id`, `label`, `family`, `description`, `variables`, and query `path`.
Preserve graph scope, SELECT/ASK/reporting CONSTRUCT behavior, supported status,
and the distinction between heuristics and sound checks. Decide explicitly whether
query forms use separate files or a shared template. This is future work, not part
of the immediate correctness repair.

## Deferred performance research

Benchmark direct JavaScript over N3 stores against SPARQL through Comunica over
the same stores, using equivalent semantics, datasets, graph scope, expected
findings, and materialization rules. Measure execution time and memory separately
from coverage. No execution-engine rewrite is currently planned.

## Hydration boundary

`HYDRATION_QUERIES` also lives in `axiolotl-inconsistency.js`. Existing materialization
derives assertions about existing terms; hydration seeds synthetic individuals
and existential witnesses. Creating an instance for every named class imposes
nonemptiness assumptions and may make a consistent ontology inconsistent.
Keep synthetic probing separate from ordinary consistency checking and user data.
Witness generation for existing instances is a different operation but needs a
sound strategy, stable identities, and termination controls.

## Fixture and implementation priorities

Preserve `owl-inconsistency-instance-fixture.ttl` as a broad integration/roadmap
fixture, rather than changing it solely to satisfy current implementation gaps.
Add isolated positive cases and consistent controls for every implemented check,
with explicit expectations before and after materialization. Cover subclass,
domain, and range derived conflicts and graph scope. Keep future coverage cases
and heuristic warnings distinguishable from current contradiction checks.

The broad fixture currently lacks dedicated cases for AllDisjointClasses,
functional datatype values, AllDisjointProperties, and the disjointUnion
missing-member heuristic. Its allValuesFrom example becomes a disjoint-type
conflict after materialization; its missing-type warning should then disappear.

Repair the sameAs/blank-node convergence failure and incomplete-run reporting
before expanding detection coverage. Reconcile
`inference-and-inconsistency-coverage.md` with the current code: several entries
still say no support for materialization rules that now exist. Validate semantic
correctness before upgrading those entries to supported.
