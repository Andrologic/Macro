import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const directory = new URL('./', import.meta.url);
const read = name => readFileSync(new URL(name, directory));
const schema = JSON.parse(read('schema.json'));
export const metricUnits = Object.fromEntries(schema.$defs.metric.allOf.map(rule => [rule.if.properties.metric.const, rule.then.properties.unit.const]));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const shape = ajv.compile(schema);
export const contractHashes = () => Object.fromEntries(['schema', 'profiles'].map(name =>
  [`${name}_sha256`, createHash('sha256').update(read(`${name}.json`)).digest('hex')]));

/** Shape, metric semantics and exact imported contract identity. This validates
 * declarations, not whether an instrument actually executed its stated method. */
export function validateReport(report) {
  if (!shape(report)) return { valid: false, errors: structuredClone(shape.errors) };
  const errors = [];
  const hashes = contractHashes();
  for (const name of Object.keys(hashes)) {
    if (report.provenance[name] !== hashes[name]) errors.push(`contract hash mismatch: ${name}`);
  }
  for (const run of report.runs) {
    const keys = new Set();
    for (const metric of run.metrics) {
      const key = [metric.metric, metric.role, metric.scope, metric.target ?? ''].join('/');
      if (keys.has(key)) errors.push(`duplicate metric: ${key}`);
      keys.add(key);
      if (metric.summary && !(metric.summary.p50 <= metric.summary.p95 && metric.summary.p95 <= metric.summary.max)) {
        errors.push(`unordered percentiles: ${key}`);
      }
      if (metric.evidence === 'not-measured' && metric.recipe !== run.scenario) errors.push('wrong missing-measurement recipe');
      if (metric.metric === 'native_rss_bytes' && (metric.role !== 'native' || metric.scope !== 'process')) errors.push('RSS requires native process scope');
      if (metric.metric === 'heap_bytes' && metric.scope !== 'process') errors.push('heap requires process scope');
      if (metric.evidence === 'measured' && ['native_read_ms', 'native_write_ms'].includes(metric.metric)) {
        if (!run.binary_sha256 || metric.role !== 'native') errors.push('native measurement needs verified binary and native role');
      }
      if (metric.evidence === 'measured' && ['native_rss_bytes', 'heap_bytes'].includes(metric.metric) && report.limits.includes(metric.metric === 'heap_bytes' ? 'no-heap' : 'no-rss')) errors.push('measured memory contradicts limits');
    }
  }
  const scenarios = JSON.parse(read('profiles.json')).scenarios;
  for (const scenario of Object.keys(scenarios)) {
    if (!report.runs.some(run => run.scenario === scenario)) errors.push(`missing scenario: ${scenario}`);
  }
  for (const run of report.runs) {
    for (const metric of Object.keys(metricUnits)) {
      if (!run.metrics.some(entry => entry.metric === metric)) errors.push(`missing metric: ${metric}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

/** Missing, estimated and simulated values cannot pass a real measurement gate.
 * A caller must also compare fixture, runtime, source and operation boundaries. */
export function compareMetric(reference, candidate, maxRatio = 1) {
  if (!Number.isFinite(maxRatio) || maxRatio < 1) throw new Error('Invalid policy ratio');
  if (reference.evidence !== 'measured' || candidate.evidence !== 'measured') return { verdict: 'not-comparable' };
  if (['metric', 'unit', 'method', 'role', 'scope', 'target'].some(key => reference[key] !== candidate[key])) return { verdict: 'not-comparable' };
  for (const entry of [reference, candidate]) {
    if (!entry.summary || !Number.isInteger(entry.summary.count) || entry.summary.count < 1 ||
      ![entry.summary.p50, entry.summary.p95, entry.summary.max].every(value => Number.isFinite(value) && value >= 0) ||
      entry.summary.p50 > entry.summary.p95 || entry.summary.p95 > entry.summary.max) throw new Error('Invalid measurement summary');
  }
  return { verdict: candidate.summary.p95 <= reference.summary.p95 * maxRatio ? 'within-policy' : 'regression' };
}
