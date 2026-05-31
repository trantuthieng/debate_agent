// src/services/codeGenerationService.ts
import type { FileModel } from '../models';

/**
 * Custom error for code generation failures
 */
class CodeGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodeGenerationError';
  }
}

/**
 * Service responsible for generating code from templates and variables
 */
export class CodeGenerationService {
  /**
   * Generates code files based on a template and provided variables
   * @param template - The template name or identifier
   * @param variables - Object containing variables for template substitution
   * @returns Promise resolving to array of generated FileModel objects
   * @throws CodeGenerationError if generation fails
   */
  async generateCode(
    template: string,
    variables: Record<string, unknown>
  ): Promise<FileModel[]> {
    try {
      // Validate inputs
      this.validateInputs(template, variables);

      // Extract prompt with fallback
      const prompt = this.extractPrompt(variables);

      // Generate the base files
      const files = this.generateBaseFiles(template, prompt);

      return files;
    } catch (error) {
      if (error instanceof Error) {
        throw new CodeGenerationError(`Failed to generate code: ${error.message}`);
      }
      throw new CodeGenerationError('Failed to generate code due to unknown error');
    }
  }

  /**
   * Validates the input parameters
   * @param template - Template to validate
   * @param variables - Variables to validate
   * @throws Error if validation fails
   */
  private validateInputs(
    template: string,
    variables: Record<string, unknown>
  ): void {
    if (!template || typeof template !== 'string') {
      throw new Error('Template must be a non-empty string');
    }

    if (!variables || typeof variables !== 'object' || Array.isArray(variables)) {
      throw new Error('Variables must be a non-null object');
    }
  }

  /**
   * Extracts the prompt from variables with a fallback value
   * @param variables - Variables object to extract prompt from
   * @returns Extracted prompt string
   */
  private extractPrompt(variables: Record<string, unknown>): string {
    return typeof variables.prompt === 'string' && variables.prompt.trim() !== ''
      ? variables.prompt
      : 'Generated application';
  }

  /**
   * Generates the base set of files for the application
   * @param template - Template name
   * @param prompt - User prompt
   * @returns Array of FileModel objects
   */
  private generateBaseFiles(template: string, prompt: string): FileModel[] {
    if (template === 'personal-finance-tracker') {
      return this.generatePersonalFinanceTracker(prompt);
    }

    return [
      {
        filePath: 'README.md',
        fileContent: `# Generated App

Template: ${template}

Prompt: ${prompt}
`,
        programmingLanguage: 'markdown',
      },
    ];
  }

  private generatePersonalFinanceTracker(prompt: string): FileModel[] {
    return [
      {
        filePath: 'README.md',
        fileContent: `# Personal Finance Tracker Prototype

Generated from prompt:

${prompt}

## Run

Open \`index.html\` directly in Safari, Chrome, or Edge. The app is a static responsive PWA prototype, so it also works on iPhone/iPad Safari and can be added to the home screen.

## Scope

- Track income and expenses.
- Manage multiple asset types: cash, bank, gold, stocks, foreign currency, and crypto.
- Convert holdings into VND using editable reference prices.
- Example: one gold tael uses the editable gold price and appears in total assets immediately.
- Data is stored in \`localStorage\` on the device.

## Notes

Reference prices are sample values for prototype testing. A production app should connect to trusted pricing APIs and show data timestamps.
`,
        programmingLanguage: 'markdown',
      },
      {
        filePath: 'manifest.webmanifest',
        fileContent: `{
  "name": "Personal Finance Tracker",
  "short_name": "Finance",
  "start_url": "./index.html",
  "display": "standalone",
  "background_color": "#f7f4ed",
  "theme_color": "#1f7a5a",
  "icons": []
}
`,
        programmingLanguage: 'json',
      },
      {
        filePath: 'index.html',
        fileContent: `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#1f7a5a">
  <title>Personal Finance Tracker</title>
  <link rel="manifest" href="manifest.webmanifest">
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <header class="app-header">
    <div>
      <p class="eyebrow">Mac / iOS prototype</p>
      <h1>Theo doi thu chi</h1>
    </div>
    <button id="resetDemo" class="ghost-button" type="button">Nap du lieu mau</button>
  </header>

  <main class="shell">
    <section class="summary-grid" aria-label="Tong quan tai chinh">
      <article class="metric primary">
        <span>Tong tai san</span>
        <strong id="totalAssets">0 VND</strong>
      </article>
      <article class="metric">
        <span>Thu nhap thang</span>
        <strong id="monthIncome">0 VND</strong>
      </article>
      <article class="metric">
        <span>Chi tieu thang</span>
        <strong id="monthExpense">0 VND</strong>
      </article>
      <article class="metric">
        <span>Dong tien rong</span>
        <strong id="netFlow">0 VND</strong>
      </article>
    </section>

    <section class="workspace">
      <form id="assetForm" class="panel">
        <div class="panel-title">
          <h2>Them tai san</h2>
          <span>Tu quy doi theo gia</span>
        </div>
        <label>Ten tai san<input id="assetName" required placeholder="Vi du: Vang SJC"></label>
        <label>Loai tai san
          <select id="assetType">
            <option value="cash">Tien mat</option>
            <option value="bank">Ngan hang</option>
            <option value="gold">Vang</option>
            <option value="stock">Chung khoan</option>
            <option value="fx">Ngoai te</option>
            <option value="crypto">Crypto</option>
          </select>
        </label>
        <div class="two-cols">
          <label>So luong<input id="assetQuantity" type="number" min="0" step="0.0001" required value="1"></label>
          <label>Don vi<input id="assetUnit" required value="tael"></label>
        </div>
        <label>Gia quy doi / don vi (VND)<input id="assetPrice" type="number" min="0" step="1000" required value="87000000"></label>
        <button class="primary-button" type="submit">Them tai san</button>
      </form>

      <form id="transactionForm" class="panel">
        <div class="panel-title">
          <h2>Ghi thu chi</h2>
          <span>Theo doi dong tien</span>
        </div>
        <label>Noi dung<input id="txnTitle" required placeholder="Luong, an uong, tien nha"></label>
        <label>Loai giao dich
          <select id="txnType">
            <option value="income">Thu</option>
            <option value="expense">Chi</option>
          </select>
        </label>
        <label>So tien (VND)<input id="txnAmount" type="number" min="0" step="1000" required></label>
        <button class="primary-button" type="submit">Luu giao dich</button>
      </form>
    </section>

    <section class="content-grid">
      <div class="panel wide">
        <div class="panel-title">
          <h2>Danh muc tai san</h2>
          <span id="assetCount">0 muc</span>
        </div>
        <div id="assetList" class="asset-list"></div>
      </div>

      <div class="panel">
        <div class="panel-title">
          <h2>Phan bo</h2>
          <span>Theo gia tri</span>
        </div>
        <div id="allocationList" class="allocation-list"></div>
      </div>

      <div class="panel wide">
        <div class="panel-title">
          <h2>Giao dich gan day</h2>
          <span id="txnCount">0 muc</span>
        </div>
        <div id="txnList" class="txn-list"></div>
      </div>
    </section>
  </main>

  <script src="app.js"></script>
</body>
</html>
`,
        programmingLanguage: 'html',
      },
      {
        filePath: 'styles.css',
        fileContent: `:root {
  color-scheme: light;
  --paper: #f7f4ed;
  --surface: #fffdf8;
  --ink: #1f2723;
  --muted: #66746d;
  --line: #ded8cc;
  --green: #1f7a5a;
  --green-2: #e5f2eb;
  --gold: #c58a18;
  --red: #b54a45;
  --blue: #2f6f9f;
  --shadow: 0 18px 45px rgba(31, 39, 35, 0.08);
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: var(--paper);
  color: var(--ink);
}

.app-header,
.shell {
  width: min(1180px, calc(100% - 32px));
  margin: 0 auto;
}

.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 28px 0 18px;
}

.eyebrow {
  margin: 0 0 6px;
  color: var(--green);
  font-size: 13px;
  font-weight: 800;
  text-transform: uppercase;
}

h1,
h2,
p {
  margin: 0;
}

h1 {
  font-size: 34px;
  line-height: 1.1;
}

h2 {
  font-size: 18px;
}

button,
input,
select {
  font: inherit;
}

button {
  cursor: pointer;
}

.ghost-button,
.primary-button {
  min-height: 44px;
  border-radius: 8px;
  border: 1px solid var(--line);
  padding: 0 16px;
  font-weight: 800;
}

.ghost-button {
  background: var(--surface);
  color: var(--ink);
}

.primary-button {
  width: 100%;
  background: var(--green);
  border-color: var(--green);
  color: white;
}

.summary-grid,
.workspace,
.content-grid {
  display: grid;
  gap: 16px;
}

.summary-grid {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.metric,
.panel {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: var(--shadow);
}

.metric {
  min-height: 112px;
  padding: 18px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}

.metric span,
.panel-title span {
  color: var(--muted);
  font-size: 13px;
  font-weight: 700;
}

.metric strong {
  font-size: 24px;
  line-height: 1.15;
}

.metric.primary {
  background: var(--green);
  color: white;
  border-color: var(--green);
}

.metric.primary span {
  color: rgba(255, 255, 255, 0.78);
}

.workspace {
  grid-template-columns: 1.1fr 0.9fr;
  margin-top: 16px;
}

.content-grid {
  grid-template-columns: 1.35fr 0.65fr;
  margin: 16px 0 36px;
  align-items: start;
}

.wide {
  min-width: 0;
}

.panel {
  padding: 18px;
}

.panel-title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}

form {
  display: grid;
  gap: 12px;
}

label {
  display: grid;
  gap: 7px;
  color: var(--muted);
  font-size: 13px;
  font-weight: 800;
}

input,
select {
  width: 100%;
  min-height: 44px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: white;
  color: var(--ink);
  padding: 0 12px;
}

.two-cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.asset-list,
.txn-list,
.allocation-list {
  display: grid;
  gap: 10px;
}

.asset-row,
.txn-row,
.allocation-row {
  display: grid;
  gap: 10px;
  align-items: center;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 12px;
  background: white;
}

.asset-row {
  grid-template-columns: 42px 1fr auto;
}

.txn-row,
.allocation-row {
  grid-template-columns: 1fr auto;
}

.icon {
  width: 42px;
  height: 42px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  background: var(--green-2);
  color: var(--green);
  font-weight: 900;
}

.asset-name,
.txn-title {
  font-weight: 900;
}

.asset-meta,
.txn-meta {
  margin-top: 3px;
  color: var(--muted);
  font-size: 13px;
}

.asset-value,
.txn-amount {
  text-align: right;
  font-weight: 900;
}

.expense {
  color: var(--red);
}

.income {
  color: var(--green);
}

.bar {
  height: 9px;
  overflow: hidden;
  border-radius: 99px;
  background: #ebe5d9;
  margin-top: 8px;
}

.bar span {
  display: block;
  height: 100%;
  background: var(--blue);
}

.empty {
  color: var(--muted);
  border: 1px dashed var(--line);
  border-radius: 8px;
  padding: 16px;
}

@media (max-width: 860px) {
  .summary-grid,
  .workspace,
  .content-grid {
    grid-template-columns: 1fr;
  }

  .app-header {
    align-items: flex-start;
    flex-direction: column;
  }

  h1 {
    font-size: 30px;
  }
}

@media (max-width: 560px) {
  .app-header,
  .shell {
    width: min(100% - 20px, 1180px);
  }

  .asset-row,
  .txn-row,
  .allocation-row,
  .two-cols {
    grid-template-columns: 1fr;
  }

  .asset-value,
  .txn-amount {
    text-align: left;
  }
}
`,
        programmingLanguage: 'css',
      },
      {
        filePath: 'app.js',
        fileContent: `const STORAGE_KEY = "finance-tracker-prototype-v1";

function createId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
}

function newDefaultState() {
  return {
    assets: [
      { id: createId(), name: "Tien mat", type: "cash", quantity: 35000000, unit: "VND", price: 1 },
      { id: createId(), name: "Vang SJC", type: "gold", quantity: 1, unit: "tael", price: 87000000 },
      { id: createId(), name: "USD tiet kiem", type: "fx", quantity: 2500, unit: "USD", price: 25500 },
      { id: createId(), name: "AAPL", type: "stock", quantity: 12, unit: "share", price: 4850000 }
    ],
    transactions: [
      { id: createId(), title: "Luong", type: "income", amount: 52000000, date: new Date().toISOString() },
      { id: createId(), title: "Tien nha", type: "expense", amount: 11000000, date: new Date().toISOString() },
      { id: createId(), title: "An uong", type: "expense", amount: 4500000, date: new Date().toISOString() }
    ]
  };
}

let state = loadState();

const typeLabels = {
  cash: "Tien mat",
  bank: "Ngan hang",
  gold: "Vang",
  stock: "Chung khoan",
  fx: "Ngoai te",
  crypto: "Crypto"
};

const typeIcons = {
  cash: "VND",
  bank: "BK",
  gold: "AU",
  stock: "ST",
  fx: "FX",
  crypto: "CR"
};

function loadState() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) {
    return newDefaultState();
  }
  try {
    return JSON.parse(stored);
  } catch {
    return newDefaultState();
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function money(value) {
  return new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: "VND",
    maximumFractionDigits: 0
  }).format(Number(value || 0));
}

function assetValue(asset) {
  return Number(asset.quantity || 0) * Number(asset.price || 0);
}

function render() {
  const totalAssets = state.assets.reduce((sum, asset) => sum + assetValue(asset), 0);
  const income = state.transactions.filter((txn) => txn.type === "income").reduce((sum, txn) => sum + Number(txn.amount || 0), 0);
  const expense = state.transactions.filter((txn) => txn.type === "expense").reduce((sum, txn) => sum + Number(txn.amount || 0), 0);

  document.getElementById("totalAssets").textContent = money(totalAssets);
  document.getElementById("monthIncome").textContent = money(income);
  document.getElementById("monthExpense").textContent = money(expense);
  document.getElementById("netFlow").textContent = money(income - expense);
  document.getElementById("assetCount").textContent = state.assets.length + " muc";
  document.getElementById("txnCount").textContent = state.transactions.length + " muc";

  renderAssets();
  renderAllocation(totalAssets);
  renderTransactions();
}

function renderAssets() {
  const list = document.getElementById("assetList");
  if (state.assets.length === 0) {
    list.innerHTML = '<div class="empty">Chua co tai san.</div>';
    return;
  }

  list.innerHTML = state.assets.map((asset) => {
    const value = assetValue(asset);
    return '<article class="asset-row">' +
      '<div class="icon">' + (typeIcons[asset.type] || "AS") + '</div>' +
      '<div><div class="asset-name">' + escapeHtml(asset.name) + '</div>' +
      '<div class="asset-meta">' + (typeLabels[asset.type] || asset.type) + ' · ' + asset.quantity + ' ' + escapeHtml(asset.unit) + ' · ' + money(asset.price) + '/' + escapeHtml(asset.unit) + '</div></div>' +
      '<div class="asset-value">' + money(value) + '</div>' +
      '</article>';
  }).join("");
}

function renderAllocation(totalAssets) {
  const list = document.getElementById("allocationList");
  const totals = state.assets.reduce((groups, asset) => {
    groups[asset.type] = (groups[asset.type] || 0) + assetValue(asset);
    return groups;
  }, {});

  const rows = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) {
    list.innerHTML = '<div class="empty">Chua co du lieu.</div>';
    return;
  }

  list.innerHTML = rows.map(([type, value]) => {
    const pct = totalAssets === 0 ? 0 : Math.round((value / totalAssets) * 100);
    return '<article class="allocation-row">' +
      '<div><div class="asset-name">' + (typeLabels[type] || type) + '</div>' +
      '<div class="bar"><span style="width:' + pct + '%"></span></div></div>' +
      '<div class="asset-value">' + pct + '%</div>' +
      '</article>';
  }).join("");
}

function renderTransactions() {
  const list = document.getElementById("txnList");
  if (state.transactions.length === 0) {
    list.innerHTML = '<div class="empty">Chua co giao dich.</div>';
    return;
  }

  list.innerHTML = state.transactions.slice().reverse().map((txn) => {
    const sign = txn.type === "expense" ? "-" : "+";
    const date = new Date(txn.date).toLocaleDateString("vi-VN");
    return '<article class="txn-row">' +
      '<div><div class="txn-title">' + escapeHtml(txn.title) + '</div>' +
      '<div class="txn-meta">' + date + ' · ' + (txn.type === "expense" ? "Chi" : "Thu") + '</div></div>' +
      '<div class="txn-amount ' + txn.type + '">' + sign + money(txn.amount) + '</div>' +
      '</article>';
  }).join("");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}

document.getElementById("assetForm").addEventListener("submit", (event) => {
  event.preventDefault();
  state.assets.push({
    id: createId(),
    name: document.getElementById("assetName").value,
    type: document.getElementById("assetType").value,
    quantity: Number(document.getElementById("assetQuantity").value),
    unit: document.getElementById("assetUnit").value,
    price: Number(document.getElementById("assetPrice").value)
  });
  saveState();
  event.target.reset();
  document.getElementById("assetQuantity").value = "1";
  render();
});

document.getElementById("transactionForm").addEventListener("submit", (event) => {
  event.preventDefault();
  state.transactions.push({
    id: createId(),
    title: document.getElementById("txnTitle").value,
    type: document.getElementById("txnType").value,
    amount: Number(document.getElementById("txnAmount").value),
    date: new Date().toISOString()
  });
  saveState();
  event.target.reset();
  render();
});

document.getElementById("resetDemo").addEventListener("click", () => {
  state = newDefaultState();
  saveState();
  render();
});

render();
`,
        programmingLanguage: 'javascript',
      },
    ];
  }
}
