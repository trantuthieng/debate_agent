import * as vm from 'vm';
import type { BrowserInteraction, InteractionCheck, PageDriver } from './browserSmokeService';

/**
 * An acceptance walk-through written by the planning agents before any code
 * exists, then locked. Coders build to it; the final checks replay it in a real
 * browser. The author is not the builder, and the builder cannot edit it, so a
 * product cannot pass by weakening its own test (ECC generator/evaluator split).
 *
 * The contract is declarative data interpreted here. Model-written JavaScript
 * only ever runs inside the product's page, never in the extension's process.
 */
export type AcceptanceStep =
  | { do: 'press'; key: string; holdMs?: number }
  | { do: 'click'; selector?: string; x?: number; y?: number }
  | { do: 'type'; selector?: string; text: string }
  | { do: 'wait'; ms: number }
  | { do: 'reload' }
  | { do: 'dialog'; accept: boolean }
  | { do: 'remember'; name: string; expression: string }
  | { do: 'expect'; label: string; expression: string; timeoutMs?: number }
  | { do: 'screenshot'; name: string };

export interface AcceptanceContract {
  version: 1;
  applicable: boolean;
  reason?: string;
  steps: AcceptanceStep[];
}

const MAX_STEPS = 60;
const MIN_EXPECTATIONS = 3;
const MAX_TOTAL_MS = 180_000;
const DEFAULT_EXPECT_MS = 3_000;
const INPUT_STEPS = new Set(['press', 'click', 'type']);

export function parseAcceptanceContract(raw: unknown): { contract?: AcceptanceContract; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return { errors: ['The contract must be a JSON object.'] }; }
  const value = raw as Record<string, unknown>;
  if (value.applicable === false) {
    const reason = typeof value.reason === 'string' ? value.reason.trim().slice(0, 300) : '';
    if (!reason) { return { errors: ['A non-applicable contract must give a reason.'] }; }
    return { contract: { version: 1, applicable: false, reason, steps: [] }, errors };
  }
  if (!Array.isArray(value.steps) || value.steps.length === 0) { return { errors: ['"steps" must be a non-empty array.'] }; }
  if (value.steps.length > MAX_STEPS) { errors.push(`At most ${MAX_STEPS} steps are allowed (got ${value.steps.length}).`); }

  const steps: AcceptanceStep[] = [];
  const remembered = new Set<string>();
  let budgetMs = 0;
  let sawInput = false;
  let behaviouralExpectations = 0;
  value.steps.slice(0, MAX_STEPS).forEach((item, index) => {
    const where = `Step ${index + 1}`;
    const step = parseStep(item, where, errors, remembered);
    if (!step) { return; }
    steps.push(step);
    if (INPUT_STEPS.has(step.do)) { sawInput = true; }
    if (step.do === 'wait') { budgetMs += step.ms; }
    if (step.do === 'press') { budgetMs += step.holdMs ?? 50; }
    if (step.do === 'reload') { budgetMs += 15_000; }
    if (step.do === 'expect') {
      budgetMs += step.timeoutMs ?? DEFAULT_EXPECT_MS;
      if (sawInput) { behaviouralExpectations += 1; }
    }
  });
  const expectations = steps.filter(step => step.do === 'expect').length;
  if (expectations < MIN_EXPECTATIONS) { errors.push(`At least ${MIN_EXPECTATIONS} "expect" steps are required (got ${expectations}).`); }
  if (behaviouralExpectations === 0) {
    errors.push('At least one "expect" must follow a user input step (press, click, or type); page-load checks alone do not show the product works.');
  }
  if (budgetMs > MAX_TOTAL_MS) { errors.push(`Waits and timeouts add up to ${Math.round(budgetMs / 1000)}s; keep the walk-through under ${MAX_TOTAL_MS / 1000}s.`); }
  return errors.length ? { errors } : { contract: { version: 1, applicable: true, steps }, errors };
}

function parseStep(item: unknown, where: string, errors: string[], remembered: Set<string>): AcceptanceStep | undefined {
  if (!item || typeof item !== 'object' || Array.isArray(item)) { errors.push(`${where}: must be an object.`); return undefined; }
  const step = item as Record<string, unknown>;
  const str = (key: string, max: number, required = true): string | undefined => {
    const v = step[key];
    if (v === undefined && !required) { return undefined; }
    if (typeof v !== 'string' || !v.trim() || v.length > max) {
      errors.push(`${where}: "${key}" must be a non-empty string of at most ${max} characters.`);
      return undefined;
    }
    return v;
  };
  const num = (key: string, max: number, required = true): number | undefined => {
    const v = step[key];
    if (v === undefined && !required) { return undefined; }
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max) {
      errors.push(`${where}: "${key}" must be a number from 0 to ${max}.`);
      return undefined;
    }
    return v;
  };
  const expression = (key: string): string | undefined => {
    const text = str(key, 600);
    if (text === undefined) { return undefined; }
    const problem = expressionSyntaxError(text);
    if (problem) { errors.push(`${where}: "${key}" is not a valid JavaScript expression (${problem}).`); return undefined; }
    for (const [, name] of text.matchAll(/\bmemo\.([A-Za-z_]\w*)/g)) {
      if (!remembered.has(name)) { errors.push(`${where}: memo.${name} is used before a "remember" step defines it.`); return undefined; }
    }
    return text;
  };
  switch (step.do) {
    case 'press': {
      const key = str('key', 20);
      const holdMs = num('holdMs', 3_000, false);
      return key === undefined ? undefined : { do: 'press', key, ...(holdMs !== undefined ? { holdMs } : {}) };
    }
    case 'click': {
      const selector = str('selector', 200, false);
      const x = num('x', 4_000, false);
      const y = num('y', 4_000, false);
      if (selector === undefined && (x === undefined || y === undefined)) {
        errors.push(`${where}: a click needs a "selector" or both "x" and "y".`);
        return undefined;
      }
      return selector !== undefined ? { do: 'click', selector } : { do: 'click', x, y };
    }
    case 'type': {
      const text = str('text', 500);
      const selector = str('selector', 200, false);
      return text === undefined ? undefined : { do: 'type', text, ...(selector !== undefined ? { selector } : {}) };
    }
    case 'wait': {
      const ms = num('ms', 10_000);
      return ms === undefined ? undefined : { do: 'wait', ms };
    }
    case 'reload':
      return { do: 'reload' };
    case 'dialog':
      if (typeof step.accept !== 'boolean') { errors.push(`${where}: "accept" must be true or false.`); return undefined; }
      return { do: 'dialog', accept: step.accept };
    case 'remember': {
      const name = str('name', 40);
      if (name !== undefined && !/^[A-Za-z_]\w*$/.test(name)) { errors.push(`${where}: "name" must be an identifier.`); return undefined; }
      const expr = expression('expression');
      if (name === undefined || expr === undefined) { return undefined; }
      remembered.add(name);
      return { do: 'remember', name, expression: expr };
    }
    case 'expect': {
      const label = str('label', 160);
      const expr = expression('expression');
      const timeoutMs = num('timeoutMs', 20_000, false);
      if (label === undefined || expr === undefined) { return undefined; }
      return { do: 'expect', label, expression: expr, ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
    }
    case 'screenshot': {
      const name = str('name', 40);
      return name === undefined ? undefined : { do: 'screenshot', name };
    }
    default:
      errors.push(`${where}: unknown "do" value ${JSON.stringify(step.do)}; use press, click, type, wait, reload, dialog, remember, expect, or screenshot.`);
      return undefined;
  }
}

/** Compiles without running; returns the syntax error message, if any. */
function expressionSyntaxError(text: string): string | undefined {
  try {
    new vm.Script(`(async () => (${text}))`);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** One line per step, for briefs and fix prompts. */
export function describeAcceptanceContract(contract: AcceptanceContract): string[] {
  if (!contract.applicable) { return [`No browser walk-through applies: ${contract.reason ?? 'no reason given'}`]; }
  return contract.steps.map((step, index) => `${index + 1}. ${describeStep(step)}`);
}

function describeStep(step: AcceptanceStep): string {
  switch (step.do) {
    case 'press': return `press ${step.key}${step.holdMs ? ` for ${step.holdMs}ms` : ''}`;
    case 'click': return step.selector ? `click ${step.selector}` : `click at (${step.x}, ${step.y})`;
    case 'type': return `type ${JSON.stringify(step.text)}${step.selector ? ` into ${step.selector}` : ''}`;
    case 'wait': return `wait ${step.ms}ms`;
    case 'reload': return 'reload the page';
    case 'dialog': return `${step.accept ? 'accept' : 'dismiss'} later confirm/alert dialogs`;
    case 'remember': return `remember memo.${step.name} = ${step.expression}`;
    case 'expect': return `EXPECT ${step.label}: ${step.expression}`;
    case 'screenshot': return `screenshot ${step.name}`;
  }
}

/** Replays the contract with trusted input; stops at the first failed step. */
export function acceptanceContractInteraction(contract: AcceptanceContract): BrowserInteraction {
  return async (page: PageDriver): Promise<InteractionCheck[]> => {
    const checks: InteractionCheck[] = [];
    const memo: Record<string, unknown> = {};
    const inPage = (expression: string) => `(async () => { const memo = ${JSON.stringify(memo)}; return (${expression}); })()`;
    const expectations = contract.steps.filter(step => step.do === 'expect').length;
    let checked = 0;
    for (const [index, step] of contract.steps.entries()) {
      const where = `step ${index + 1} (${describeStep(step)})`;
      try {
        if (step.do === 'press') { await page.press(step.key, step.holdMs); }
        if (step.do === 'click') {
          const point = step.selector ? await locate(page, step.selector) : { x: step.x!, y: step.y! };
          await page.click(point.x, point.y);
        }
        if (step.do === 'type') {
          if (step.selector) {
            const point = await locate(page, step.selector);
            await page.click(point.x, point.y);
          }
          await page.type(step.text);
        }
        if (step.do === 'wait') { await page.wait(step.ms); }
        if (step.do === 'reload') { await page.reload(); }
        if (step.do === 'dialog') { page.setDialogResponse(step.accept); }
        if (step.do === 'screenshot') { await page.screenshot(step.name); }
        if (step.do === 'remember') { memo[step.name] = await page.evaluate(inPage(step.expression)); }
        if (step.do === 'expect') {
          checked += 1;
          const outcome = await poll(page, inPage(step.expression), step.timeoutMs ?? DEFAULT_EXPECT_MS);
          checks.push({ label: step.label, passed: outcome.passed, detail: outcome.passed ? undefined : `${where}: ${outcome.detail}` });
          if (!outcome.passed) { break; }
        }
      } catch (err) {
        checks.push({ label: `acceptance ${where}`, passed: false, detail: err instanceof Error ? err.message : String(err) });
        break;
      }
    }
    if (checked < expectations && checks.some(check => !check.passed)) {
      checks.push({ label: `${expectations - checked} later expectation(s) not reached`, passed: false,
        detail: 'The walk-through stops at the first failure; fix it to see the rest.' });
    }
    return checks;
  };
}

async function locate(page: PageDriver, selector: string): Promise<{ x: number; y: number }> {
  const point = await page.evaluate<{ x: number; y: number; visible: boolean } | null>(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) { return null; }
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, visible: r.width > 0 && r.height > 0 };
  })()`);
  if (!point) { throw new Error(`No element matches ${selector}.`); }
  if (!point.visible) { throw new Error(`${selector} exists but has no visible size, so a user cannot click it.`); }
  return point;
}

async function poll(page: PageDriver, expression: string, timeoutMs: number): Promise<{ passed: boolean; detail: string }> {
  const deadline = Date.now() + timeoutMs;
  let detail = '';
  for (;;) {
    try {
      const value = await page.evaluate(expression);
      if (value) { return { passed: true, detail: '' }; }
      detail = `evaluated to ${JSON.stringify(value) ?? 'undefined'} after ${timeoutMs}ms`;
    } catch (err) {
      detail = `threw ${err instanceof Error ? err.message : String(err)}`;
    }
    if (Date.now() >= deadline) { return { passed: false, detail }; }
    await page.wait(Math.min(100, Math.max(0, deadline - Date.now())));
  }
}
