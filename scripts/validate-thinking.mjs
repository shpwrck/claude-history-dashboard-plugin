// Validation harness for the #1927 thinking-token residual estimator (#2006).
// Imports the shipped estimator functions and applies them to raw local
// transcripts so it can measure the NO-THINKING control group (which the
// parser output alone hides, since it sets thinkingTokens=0 there).
//
// Run from the repo root:
//   node --import ./scripts/register-ts.mjs scripts/validate-thinking.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  visibleBlockTokens,
  isThinkingBlock,
  reconstructThinkingTokens,
} from '../src/lib/thinking-tokens.ts';

const ROOT = join(process.env.HOME, '.claude', 'projects');

function* transcripts(dir) {
  for (const d of readdirSync(dir)) {
    const p = join(dir, d);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) yield* transcripts(p);
    else if (p.endsWith('.jsonl')) yield p;
  }
}

// raw char length of a block's visible payload
function visibleChars(b) {
  if (b?.type === 'text') return (b.text ?? '').length;
  if (b?.type === 'tool_use') {
    try { return JSON.stringify(b.input ?? {}).length; } catch { return 0; }
  }
  return 0;
}

const msgs = new Map(); // id -> { out, visEst, visChars, think }
let lines = 0, parseErr = 0;

for (const f of transcripts(ROOT)) {
  let text;
  try { text = readFileSync(f, 'utf8'); } catch { continue; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    lines++;
    let o;
    try { o = JSON.parse(line); } catch { parseErr++; continue; }
    if (o.type !== 'assistant' || !o.message?.usage) continue;
    const id = o.message.id ?? `x-${msgs.size}`;
    const out = o.message.usage.output_tokens ?? 0;
    let visEst = 0, visChars = 0, think = false;
    for (const b of o.message.content ?? []) {
      visEst += visibleBlockTokens(b);
      visChars += visibleChars(b);
      if (isThinkingBlock(b)) think = true;
    }
    const m = msgs.get(id) ?? { out: 0, visEst: 0, visChars: 0, think: false };
    m.out = Math.max(m.out, out);          // usage repeated per line -> max
    m.visEst += visEst;                    // distinct blocks per line -> sum
    m.visChars += visChars;
    m.think = m.think || think;
    msgs.set(id, m);
  }
}

const pct = (xs, p) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

const withT = [], noT = [];
let invariantViolations = 0, billedOut = 0, totalThink = 0;
for (const m of msgs.values()) {
  const t = reconstructThinkingTokens(m.out, m.visEst, m.think);
  billedOut += m.out;
  totalThink += t;
  // Invariant: thinking + visible must never exceed billed output.
  if (t + m.visEst > m.out + 0.5) invariantViolations++;
  if (m.think) withT.push(m);
  else if (m.out > 0) noT.push(m);
}

console.log('=== corpus ===');
console.log('lines scanned:', lines.toLocaleString(), '| JSON parse errors:', parseErr);
console.log('assistant messages:', msgs.size.toLocaleString(),
  '| with thinking block:', withT.length.toLocaleString(),
  '| no thinking (control):', noT.length.toLocaleString());

console.log('\n=== INVARIANT: thinking + visible <= billed output ===');
console.log('violations:', invariantViolations, invariantViolations === 0 ? '(PASS -- anchoring holds)' : '(FAIL)');

console.log('\n=== CALIBRATION on the no-thinking control group ===');
console.log('(residual = billed_output - est_visible; should center on ~0)');
const resid = noT.map((m) => m.out - m.visEst);
console.log('residual tokens/msg  mean:', Math.round(mean(resid)),
  '| p50:', pct(resid, 50), '| p90:', pct(resid, 90), '| p99:', pct(resid, 99),
  '| max:', Math.max(...resid));
// implied true chars/token: billed_output vs visible chars
const implied = noT.filter((m) => m.out > 50).map((m) => m.visChars / m.out);
console.log('implied chars/token  median:', pct(implied, 50).toFixed(2),
  '| mean:', mean(implied).toFixed(2), '(calibrated: text=2.6, tool_use=1.7)');
// fraction of control messages the estimator gets within +/-20%
const wellCal = noT.filter((m) => m.out > 0 && Math.abs(m.out - m.visEst) / m.out <= 0.2).length;
console.log('control msgs estimated within +/-20% of billed:',
  ((100 * wellCal) / Math.max(1, noT.length)).toFixed(1) + '%');
// over-estimates: cases where our visible estimate EXCEEDS billed output
const over = noT.filter((m) => m.visEst > m.out).length;
console.log('control msgs where est_visible > billed (over-count):',
  over, '(' + ((100 * over) / Math.max(1, noT.length)).toFixed(1) + '%)');

console.log('\n=== thinking-share on thinking messages ===');
const shares = withT.filter((m) => m.out > 0).map((m) => (m.out - m.visEst > 0 ? (m.out - m.visEst) / m.out : 0));
console.log('thinking share of output  p10:', pct(shares, 10).toFixed(2),
  '| p50:', pct(shares, 50).toFixed(2), '| p90:', pct(shares, 90).toFixed(2));
console.log('corpus aggregate: thinking', totalThink.toLocaleString(),
  'of output', billedOut.toLocaleString(),
  '(' + ((100 * totalThink) / Math.max(1, billedOut)).toFixed(1) + '%)');
