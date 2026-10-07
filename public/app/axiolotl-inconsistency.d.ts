export type AxiolotlGraphScope = 'default' | 'named' | 'union';
export type AxiolotlResultForm = 'select' | 'ask' | 'construct';

export interface AxiolotlQueryOptions {
  scope?: AxiolotlGraphScope;
  graphIri?: string | null;
  resultForm?: AxiolotlResultForm;
}

export interface AxiolotlRuntimeOptions extends AxiolotlQueryOptions {
  engine?: unknown;
  baseIRI?: string;
  phase?: string;
  materializedStore?: { has(quad: unknown): boolean };
}

export interface AxiolotlConstructOptions extends AxiolotlQueryOptions {
  applyConstruct?: (constructQuery: string, rdfjsStore: unknown) => Promise<unknown[]>;
}

export interface AxiolotlHydrationOptions extends AxiolotlConstructOptions {
  runIri?: string;
  deterministicIris?: boolean;
}

export interface AxiolotlCoverageItem {
  id: string;
  label: string;
  family: string;
  owlProfile: string;
  support: string;
  notes: string;
}

export interface AxiolotlQueryDefinition {
  id: string;
  label: string;
  description: string;
  family: string;
  supported: boolean;
  findingKind: 'violation' | 'warning';
  select: (options?: AxiolotlQueryOptions) => string;
  ask: (options?: AxiolotlQueryOptions) => string;
  construct: (options?: AxiolotlQueryOptions) => string;
}

export interface AxiolotlHydrationDefinition {
  id: string;
  label: string;
  description: string;
}

export interface AxiolotlCheckResult {
  id: string;
  rows: Array<Record<string, unknown>>;
  findingKind: 'violation' | 'warning';
  status: 'complete' | 'incomplete';
  query: string;
  scope: AxiolotlGraphScope;
  graphIri: string | null;
  phase: string;
  notices?: string[];
  findings: Array<{
    id: string;
    checkId: string;
    kind: 'violation' | 'warning';
    bindings: Record<string, unknown>;
    evidence: Array<{ quad: unknown; origin: 'asserted' | 'materialized' | 'dataset' }>;
  }>;
}

export function normalizeQueryOptions(options?: AxiolotlQueryOptions): Required<AxiolotlQueryOptions>;
export function scopedWhere(body: string, options?: AxiolotlQueryOptions): string;
export function hasInconsistencyQuery(id: string): boolean;
export function listInconsistencyQueries(): AxiolotlQueryDefinition[];
export function getInconsistencyQuery(id: string, options?: AxiolotlQueryOptions): string;
export function getAllInconsistencySelectQueries(options?: AxiolotlQueryOptions): Array<{ id: string; label: string; query: string }>;
export function runInconsistencySelect(id: string, rdfjsStore: unknown, options?: AxiolotlRuntimeOptions): Promise<AxiolotlCheckResult>;
export function runAllInconsistencySelects(rdfjsStore: unknown, options?: AxiolotlRuntimeOptions): Promise<AxiolotlCheckResult[]>;
export function constructInconsistencyReport(id: string, rdfjsStore: unknown, options?: AxiolotlConstructOptions): Promise<unknown[]>;
export function listInconsistencyCoverage(): AxiolotlCoverageItem[];
export function listHydrationQueries(): AxiolotlHydrationDefinition[];
export function getHydrationConstructQuery(id: string, options?: AxiolotlHydrationOptions): string;
export function applyHydrationConstruct(id: string, rdfjsStore: unknown, options?: AxiolotlHydrationOptions): Promise<unknown[]>;

