import { compiler } from './config.js';
const output = { mode: location.pathname.split('/')[1], userAgent: navigator.userAgent, workers: [], csp: [], cases: [], failures: [] };
const post = () => window.webkit.messageHandlers.qa.postMessage(JSON.stringify(output));
const OriginalWorker = window.Worker;
document.addEventListener('securitypolicyviolation', e => output.csp.push({ directive: e.violatedDirective, blocked: e.blockedURI }));
if (OriginalWorker) window.Worker = class ObservedWorker extends OriginalWorker {
  constructor(url, options) {
    super(url, options);
    const event = { url: String(url), type: options?.type, messages: 0, errors: 0, terminated: false };
    output.workers.push(event);
    this.addEventListener('message', () => event.messages++);
    this.addEventListener('error', () => event.errors++);
    this.addEventListener('messageerror', () => event.errors++);
    this.__qaEvent = event;
  }
  terminate() { this.__qaEvent.terminated = true; return super.terminate(); }
};
const ensure = (test, message) => { if (!test) throw new Error(message); };
const timeout = (promise, ms = 15000) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('QA timeout')), ms))]);
const valid = '{"contract":"agsdl-0.3.0","id":"valid","agents":{}}';
const warning = '{"contract":"agsdl-0.3.0","id":"warn","agents":{"worker":{"harness":"unknown","permissions":"full"}}}';
const error = '{"contract":"agsdl-0.3.0","id":"error","agents":{},"flow":{"entry":"missing","steps":{}}}';
const exact = n => `{"contract":"agsdl-0.3.0","id":"exact","agents":{"a":{"harness":"codex","permissions":"read-only","maxCorrections":${n}}}}`;
try {
  ensure(typeof OriginalWorker === 'function', 'Worker API unavailable');
  const { _ : validateDocument } = await import(compiler);
  ensure(typeof validateDocument === 'function', 'built validateDocument export missing');
  if (output.mode !== 'normal') {
    let rejected = false;
    try { await timeout(validateDocument(valid), 8000); } catch (e) { rejected = true; output.error = String(e); }
    ensure(rejected && output.error !== 'Error: QA timeout', 'worker failure was not reported by validateDocument');
    await new Promise(resolve => setTimeout(resolve, 100));
    ensure(output.workers.length > 0 && output.workers.every(w => w.terminated === true), 'failed worker did not terminate');
    if (output.mode === 'blocked') ensure(output.csp.some(e => e.directive.startsWith('worker-src')), 'no observed worker-src CSP violation');
  } else {
    for (const [name, source, verdict, rule] of [
      ['valid', valid, 'pass', null], ['warning', warning, 'pass', 'HARNESS_UNVERIFIED'],
      ['error', error, 'fail', 'REFERENCE'], ['integer', exact('9007199254740993'), 'pass', null],
      ['fraction', exact('9007199254740993.5'), 'fail', 'SHAPE'],
    ]) {
      const [report] = await timeout(validateDocument(source));
      const result = report.results[0];
      ensure(result.verdict === verdict, `${name}: wrong verdict`);
      if (rule) ensure(result.findings.some(f => f.rule === rule), `${name}: missing ${rule}`);
      output.cases.push({name, verdict: result.verdict, findings: result.findings.map(f => ({rule:f.rule,severity:f.severity,pointer:f.location.pointer}))});
    }
    const compositions = {};
    for (let i = 0; i < 1000; i++) compositions[`c${i}`] = {entry:'s',outputs:['done'],steps:{s:i===999 ?
      {type:'agent',agent:'a',next:{output:'done'}} : {type:'compose',composition:`c${i+1}`,next:{done:{output:'done'}}}}};
    const deep = JSON.stringify({contract:'agsdl-0.3.0',id:'deep',agents:{a:{harness:'unknown',permissions:'full'}},flow:{entry:'s',steps:{s:{type:'compose',composition:'c0',next:{done:[]}}}},compositions});
    let complete = false, version = 1, published = null;
    const start = performance.now();
    const old = validateDocument(deep).then(r => { complete = true; if (version === 1) published = r; return r; });
    const tick = await new Promise(resolve => setTimeout(() => resolve({ms:performance.now()-start, stillRunning:!complete}), 10));
    ensure(tick.stillRunning, 'validation completed before the responsiveness tick; no overlap proven');
    version = 2;
    const newer = validateDocument(error).then(r => { if (version === 2) published = r; return r; });
    const [newResult, oldResult] = await timeout(Promise.all([newer, old]), 60000);
    ensure(newResult[0].results[0].verdict === 'fail' && oldResult[0].results[0].verdict === 'pass', 'revision outcomes differ');
    ensure(published === newResult, 'stale revision overwritten newer result');
    output.revisions = {tick, completionMs:performance.now()-start, deepBytes:new TextEncoder().encode(deep).length, newest:'error', staleIgnored:true, scope:'test-level version guard, not useAgsdlStore'};
    ensure(output.workers.length === 7 && output.workers.every(w => w.messages === 1 && w.terminated && w.type === 'module'), 'real worker creation or completion not observed for every call');
    ensure(output.csp.length === 0, 'unexpected CSP violation');
  }
} catch (e) { output.failures.push(String(e)); }
post();
