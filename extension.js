const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const https = require("https");
const os = require("os");

const POLL_MS = 60_000;
const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, ".claude");
const CREDS_FILE = path.join(CLAUDE_DIR, ".credentials.json");
const CLAUDE_CONFIG_PRIMARY = path.join(CLAUDE_DIR, ".claude.json");
const CLAUDE_CONFIG_FALLBACK = path.join(HOME, ".claude.json");
const SWAP_DIR = path.join(HOME, ".claude-swap-backup");
const SEQUENCE_FILE = path.join(SWAP_DIR, "sequence.json");
const CONFIGS_DIR = path.join(SWAP_DIR, "configs");
const CREDENTIALS_DIR = path.join(SWAP_DIR, "credentials");

let statusBarItem;
let timer;
let panel = null;

// ─── File helpers ───────────────────────────────────────────────────────────

function readJSON(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch { return null; }
}

function writeJSON(filePath, data) {
  const tmp = filePath + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

// ─── Credential helpers ─────────────────────────────────────────────────────

function readCurrentCredentials() {
  try { return fs.readFileSync(CREDS_FILE, "utf8"); }
  catch { return null; }
}

function writeCurrentCredentials(text) {
  fs.writeFileSync(CREDS_FILE, text, "utf8");
  try { fs.chmodSync(CREDS_FILE, 0o600); } catch {}
}

function getToken(credsText) {
  try { return JSON.parse(credsText)?.claudeAiOauth?.accessToken || null; }
  catch { return null; }
}

function readBackupCreds(num, email) {
  try {
    const raw = fs.readFileSync(
      path.join(CREDENTIALS_DIR, `.creds-${num}-${email}.enc`), "utf8"
    );
    return Buffer.from(raw, "base64").toString("utf8");
  } catch { return null; }
}

function writeBackupCreds(num, email, text) {
  ensureDir(CREDENTIALS_DIR);
  const file = path.join(CREDENTIALS_DIR, `.creds-${num}-${email}.enc`);
  fs.writeFileSync(file, Buffer.from(text, "utf8").toString("base64"), "utf8");
  try { fs.chmodSync(file, 0o600); } catch {}
}

function readBackupConfig(num, email) {
  try {
    return fs.readFileSync(
      path.join(CONFIGS_DIR, `.claude-config-${num}-${email}.json`), "utf8"
    );
  } catch { return null; }
}

function writeBackupConfig(num, email, text) {
  ensureDir(CONFIGS_DIR);
  const file = path.join(CONFIGS_DIR, `.claude-config-${num}-${email}.json`);
  fs.writeFileSync(file, text, "utf8");
  try { fs.chmodSync(file, 0o600); } catch {}
}

// ─── Claude config helpers ──────────────────────────────────────────────────

function getConfigPath() {
  const d = readJSON(CLAUDE_CONFIG_PRIMARY);
  return (d && d.oauthAccount) ? CLAUDE_CONFIG_PRIMARY : CLAUDE_CONFIG_FALLBACK;
}

function getCurrentEmail() {
  return readJSON(getConfigPath())?.oauthAccount?.emailAddress || null;
}

// ─── Sequence file helpers ──────────────────────────────────────────────────

function getTimestamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function initSequenceFile() {
  if (!fs.existsSync(SEQUENCE_FILE)) {
    ensureDir(SWAP_DIR);
    writeJSON(SEQUENCE_FILE, {
      activeAccountNumber: null,
      lastUpdated: getTimestamp(),
      sequence: [],
      accounts: {}
    });
  }
}

function getSeqData() { return readJSON(SEQUENCE_FILE); }

function isSaved(data, email) {
  if (!data || !email) return false;
  return Object.values(data.accounts || {}).some(a => a.email === email);
}

function nextNum(data) {
  const nums = Object.keys(data.accounts || {}).map(Number);
  return nums.length ? Math.max(...nums) + 1 : 1;
}

// ─── API helpers ────────────────────────────────────────────────────────────

function apiGet(token, url) {
  return new Promise(resolve => {
    const req = https.get(url, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json"
      }
    }, res => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
  });
}

function fetchUsage(token) {
  return apiGet(token, "https://api.anthropic.com/api/oauth/usage");
}

// ─── Account management ─────────────────────────────────────────────────────

async function saveCurrentAccount() {
  initSequenceFile();
  const email = getCurrentEmail();
  if (!email) throw new Error("No active Claude account found");

  const data = getSeqData();
  if (isSaved(data, email)) throw new Error(`${email} is already saved`);

  const num = nextNum(data);
  const credsText = readCurrentCredentials();
  if (!credsText) throw new Error("Failed to read credentials");

  const configPath = getConfigPath();
  const configText = fs.readFileSync(configPath, "utf8");
  const uuid = readJSON(configPath)?.oauthAccount?.accountUuid || "";

  writeBackupCreds(String(num), email, credsText);
  writeBackupConfig(String(num), email, configText);

  data.accounts[String(num)] = { email, uuid, added: getTimestamp() };
  data.sequence.push(num);
  data.activeAccountNumber = num;
  data.lastUpdated = getTimestamp();
  writeJSON(SEQUENCE_FILE, data);
  return num;
}

async function switchToAccount(targetNum) {
  const data = getSeqData();
  if (!data) throw new Error("No managed accounts");

  const tStr = String(targetNum);
  const tInfo = data.accounts[tStr];
  if (!tInfo) throw new Error(`Account-${targetNum} not found`);

  const configPath = getConfigPath();
  const currentEmail = getCurrentEmail();
  const currentNum = String(data.activeAccountNumber);

  // Backup current account before switching
  if (currentEmail) {
    const cc = readCurrentCredentials();
    const cf = fs.readFileSync(configPath, "utf8");
    if (cc) writeBackupCreds(currentNum, currentEmail, cc);
    writeBackupConfig(currentNum, currentEmail, cf);
  }

  // Restore target credentials and config
  const tc = readBackupCreds(tStr, tInfo.email);
  const tf = readBackupConfig(tStr, tInfo.email);
  if (!tc || !tf) throw new Error(`Missing backup data for Account-${targetNum}`);

  writeCurrentCredentials(tc);

  const tfData = JSON.parse(tf);
  const oauth = tfData.oauthAccount;
  if (!oauth) throw new Error("Invalid backup config: missing oauthAccount");

  const currentCfg = readJSON(configPath) || {};
  currentCfg.oauthAccount = oauth;
  writeJSON(configPath, currentCfg);

  data.activeAccountNumber = targetNum;
  data.lastUpdated = getTimestamp();
  writeJSON(SEQUENCE_FILE, data);
}

// ─── Status bar ─────────────────────────────────────────────────────────────

async function refreshStatus() {
  const ct = readCurrentCredentials();
  const token = ct ? getToken(ct) : null;
  if (!token) {
    statusBarItem.text = "$(cloud) --";
    statusBarItem.tooltip = "Not logged in to Claude";
    return;
  }
  const usage = await fetchUsage(token);
  if (!usage) {
    statusBarItem.text = "$(cloud) --";
    statusBarItem.tooltip = "Failed to fetch usage";
    return;
  }
  const h5 = usage.five_hour?.utilization ?? 0;
  const d7 = usage.seven_day?.utilization ?? 0;
  statusBarItem.text = `$(cloud) 5h ${Math.round(h5)}% 7d ${Math.round(d7)}%`;
  statusBarItem.tooltip = "Click to manage Claude accounts";
}

// ─── Webview helpers ─────────────────────────────────────────────────────────

function timeUntil(iso) {
  if (!iso) return "?";
  const ms = new Date(iso) - Date.now();
  if (ms <= 0) return "now";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function barColor(p) {
  return p >= 90 ? "#e45649" : p >= 70 ? "#e5a11c" : "#50a14f";
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function usageRow(label, pct, resetsAt) {
  const c = pct !== null ? barColor(pct) : "#888";
  const w = pct !== null ? Math.min(pct, 100) : 0;
  const txt = pct !== null ? pct + "%" : "?";
  return `<div class="urow">
    <span class="lbl">${label}</span>
    <div class="bar-track"><div class="bar-fill" style="width:${w}%;background:${c}"></div></div>
    <span class="pct" style="color:${c}">${txt}</span>
    <span class="rst">&#8635; ${timeUntil(resetsAt)}</span>
  </div>`;
}

function buildHtml(accounts, currentEmail, currentSaved) {
  const cards = accounts.map(({ num, email, isActive, usage }) => {
    const h5 = usage?.five_hour?.utilization ?? null;
    const d7 = usage?.seven_day?.utilization ?? null;
    const p5 = h5 !== null ? Math.round(h5) : null;
    const p7 = d7 !== null ? Math.round(d7) : null;
    const action = !isActive
      ? `<button class="btn-switch" onclick="switchTo(${num})">Switch</button>`
      : `<span class="badge">active</span>`;
    return `<div class="card ${isActive ? "card-active" : ""}">
  <div class="card-hdr">
    <span class="email">${esc(email)}</span>
    ${action}
  </div>
  ${usageRow("5h", p5, usage?.five_hour?.resets_at)}
  ${usageRow("7d", p7, usage?.seven_day?.resets_at)}
</div>`;
  }).join("");

  const saveBanner = (currentEmail && !currentSaved) ? `<div class="banner">
  <span>Current account <strong>${esc(currentEmail)}</strong> is not saved</span>
  <button class="btn-save" onclick="saveAccount()">Save Account</button>
</div>` : "";

  const emptyNote = accounts.length === 0
    ? `<p class="empty">No managed accounts yet.</p>` : "";

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
*{box-sizing:border-box}
body{font-family:var(--vscode-font-family,sans-serif);font-size:13px;color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:14px 16px;margin:0}
h2{font-size:14px;font-weight:600;margin:0 0 12px}
.banner{display:flex;align-items:center;justify-content:space-between;gap:10px;background:var(--vscode-inputValidation-warningBackground,rgba(200,150,0,.12));border:1px solid var(--vscode-inputValidation-warningBorder,rgba(200,150,0,.4));border-radius:6px;padding:8px 12px;margin-bottom:10px;font-size:12px}
.btn-save{padding:3px 10px;font-size:12px;cursor:pointer;border:none;border-radius:4px;background:var(--vscode-button-background,#0078d4);color:var(--vscode-button-foreground,#fff);white-space:nowrap}
.btn-save:hover{background:var(--vscode-button-hoverBackground,#026ec1)}
.btn-switch{padding:3px 10px;font-size:12px;cursor:pointer;border:none;border-radius:4px;background:var(--vscode-button-secondaryBackground,rgba(127,127,127,.18));color:var(--vscode-button-secondaryForeground,var(--vscode-foreground));white-space:nowrap}
.btn-switch:hover{background:var(--vscode-button-secondaryHoverBackground,rgba(127,127,127,.28))}
.card{border:1px solid var(--vscode-widget-border,rgba(127,127,127,.2));border-radius:7px;padding:10px 12px;margin-bottom:8px}
.card-active{border-color:var(--vscode-focusBorder,#0078d4);background:rgba(0,120,212,.05)}
.card-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;gap:8px}
.badge{font-size:10px;background:var(--vscode-focusBorder,#0078d4);color:#fff;padding:2px 7px;border-radius:10px;white-space:nowrap}
.email{font-weight:600;font-size:12px;word-break:break-all}
.urow{display:flex;align-items:center;gap:7px;margin-bottom:3px}
.lbl{font-size:11px;opacity:.6;width:16px;text-align:right;flex-shrink:0}
.bar-track{flex:1;height:6px;border-radius:3px;background:rgba(127,127,127,.18);overflow:hidden;min-width:80px}
.bar-fill{height:100%;border-radius:3px}
.pct{font-size:11px;font-weight:600;width:30px;text-align:right;flex-shrink:0}
.rst{font-size:10px;opacity:.5;width:54px;flex-shrink:0}
.empty{opacity:.5;font-style:italic;font-size:12px;padding:4px 0}
</style></head><body>
<h2>&#9729; Claude Accounts</h2>
${saveBanner}
${cards}
${emptyNote}
<script>
const vscode = acquireVsCodeApi();
function switchTo(n) { vscode.postMessage({ command: "switch", num: n }); }
function saveAccount() { vscode.postMessage({ command: "save" }); }
</script>
</body></html>`;
}

// ─── Panel data gathering ────────────────────────────────────────────────────

async function gatherPanelData() {
  const currentEmail = getCurrentEmail();
  const seqData = getSeqData();
  const rows = [];

  if (seqData && seqData.accounts) {
    await Promise.all((seqData.sequence || []).map(async num => {
      const info = seqData.accounts[String(num)];
      if (!info) return;
      const { email } = info;
      const isActive = email === currentEmail;
      const credsText = isActive
        ? readCurrentCredentials()
        : readBackupCreds(String(num), email);
      const token = credsText ? getToken(credsText) : null;
      const usage = token ? await fetchUsage(token) : null;
      rows.push({ num, email, isActive, usage });
    }));
    // Restore sequence order (Promise.all may resolve out of order)
    const seq = seqData.sequence || [];
    rows.sort((a, b) => seq.indexOf(a.num) - seq.indexOf(b.num));
  }

  return {
    accounts: rows,
    currentEmail,
    currentSaved: isSaved(seqData, currentEmail)
  };
}

// ─── Webview panel lifecycle ─────────────────────────────────────────────────

function loadingHtml() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>body{font-family:var(--vscode-font-family,sans-serif);padding:20px;color:var(--vscode-foreground);background:var(--vscode-editor-background)}</style>
</head><body><p>Loading accounts&hellip;</p></body></html>`;
}

async function reloadPanel() {
  if (!panel) return;
  panel.webview.html = loadingHtml();
  const d = await gatherPanelData();
  if (panel) panel.webview.html = buildHtml(d.accounts, d.currentEmail, d.currentSaved);
}

async function openAccountPanel(ctx) {
  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      "claudeAccounts",
      "Claude Accounts",
      vscode.ViewColumn.Beside,
      { enableScripts: true }
    );
    panel.onDidDispose(() => { panel = null; }, null, ctx.subscriptions);
    panel.webview.onDidReceiveMessage(async msg => {
      if (msg.command === "switch") {
        try {
          await switchToAccount(msg.num);
          vscode.window.showInformationMessage(
            `Switched to Account-${msg.num}. Restart Claude Code to apply.`
          );
          refreshStatus();
          await reloadPanel();
        } catch (e) {
          vscode.window.showErrorMessage(`Switch failed: ${e.message}`);
        }
      } else if (msg.command === "save") {
        try {
          const n = await saveCurrentAccount();
          vscode.window.showInformationMessage(`Account saved as Account-${n}.`);
          await reloadPanel();
        } catch (e) {
          vscode.window.showErrorMessage(`Save failed: ${e.message}`);
        }
      }
    }, null, ctx.subscriptions);
  } else {
    panel.reveal(vscode.ViewColumn.Beside);
  }

  await reloadPanel();
}

// ─── Extension lifecycle ─────────────────────────────────────────────────────

function activate(context) {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  statusBarItem.command = "claudeUsage.showPanel";
  statusBarItem.text = "$(cloud) ...";
  statusBarItem.show();

  context.subscriptions.push(
    statusBarItem,
    vscode.commands.registerCommand("claudeUsage.refresh", refreshStatus),
    vscode.commands.registerCommand("claudeUsage.showPanel", () => openAccountPanel(context)),
    { dispose: () => clearInterval(timer) }
  );

  refreshStatus();
  timer = setInterval(refreshStatus, POLL_MS);
}

function deactivate() {
  if (timer) clearInterval(timer);
  if (panel) { panel.dispose(); panel = null; }
}

module.exports = { activate, deactivate };
