export function summarizeConsistencyResults(results) {
  const violations = results.filter(r => r.findingKind === 'violation').reduce((n, r) => n + r.rows.length, 0);
  const warnings = results.filter(r => r.findingKind === 'warning').reduce((n, r) => n + r.rows.length, 0);
  const incomplete = results.some(r => r.status === 'incomplete');
  return { violations, warnings, status: incomplete ? 'incomplete' : 'complete',
    verdict: violations ? 'Contradictions detected' : incomplete ? 'No contradictions detected; check incomplete' : 'No contradictions detected within implemented coverage' };
}

export function formatTerm(term) {
  if (!term) return '(unbound)';
  if (typeof term === 'string') return term;
  if (term.termType === 'DefaultGraph') return 'default graph';
  if (term.termType === 'BlankNode' || term.type === 'bnode') return '_:' + term.value;
  if (term.termType === 'Literal' || term.type === 'literal' || term.type === 'typed-literal') {
    const language = term.language || term['xml:lang'];
    const datatype = term.datatype?.value || term.datatype;
    return JSON.stringify(term.value) + (language ? '@' + language : datatype ? '^^<' + datatype + '>' : '');
  }
  return '<' + term.value + '>';
}

export function formatConsistencyReport(results) {
  const summary = summarizeConsistencyResults(results);
  const lines = ['Axiolotl consistency report', `Generated: ${new Date().toISOString()}`,
    `Status: ${summary.status}`, summary.verdict,
    `Violation rows: ${summary.violations}`, `Warning rows: ${summary.warnings}`,
    'Rows may describe the same contradiction more than once.',
    'Evidence below is RDF context, not a minimal proof or full derivation trace.', ''];
  for (const result of results) {
    lines.push(`${result.id}: ${result.rows.length} ${result.findingKind} row(s)`,
      `  Phase: ${result.phase}; scope: ${result.scope}${result.graphIri ? ' <' + result.graphIri + '>' : ''}; status: ${result.status}`);
    if (result.findingKind === 'warning') lines.push('  Missing information is a modeling warning, not proof of contradiction.');
    for (const notice of result.notices || []) lines.push('  COVERAGE NOTICE: ' + notice);
    for (const finding of result.findings) {
      lines.push(`  Finding ${finding.id} [${finding.kind}]`);
      for (const [key, value] of Object.entries(finding.bindings)) lines.push(`    ?${key} = ${formatTerm(value)}`);
      for (const { quad, origin } of finding.evidence) lines.push(`    [${origin}; ${formatTerm(quad.graph)}] ${formatTerm(quad.subject)} ${formatTerm(quad.predicate)} ${formatTerm(quad.object)} .`);
      if (!finding.evidence.length) lines.push('    RDF context unavailable; inspect bindings and query below.');
    }
    lines.push('  Query (requires Axiolotl extension functions where used):', result.query, '');
  }
  return lines.join('\n');
}
