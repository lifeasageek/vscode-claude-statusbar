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

// ─── File helpers ────────────────────────────────────────────────────────────

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

// ─── Credential helpers ──────────────────────────────────────────────────────

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

// ─── Claude config helpers ───────────────────────────────────────────────────

function getConfigPath() {
  const d = readJSON(CLAUDE_CONFIG_PRIMARY);
  return (d && d.oauthAccount) ? CLAUDE_CONFIG_PRIMARY : CLAUDE_CONFIG_FALLBACK;
}

function getCurrentEmail() {
  return readJSON(getConfigPath())?.oauthAccount?.emailAddress || null;
}

// ─── Sequence helpers ────────────────────────────────────────────────────────

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

// ─── API helpers ─────────────────────────────────────────────────────────────

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

// ─── Account management ──────────────────────────────────────────────────────

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

  if (currentEmail) {
    const cc = readCurrentCredentials();
    const cf = fs.readFileSync(configPath, "utf8");
    if (cc) writeBackupCreds(currentNum, currentEmail, cc);
    writeBackupConfig(currentNum, currentEmail, cf);
  }

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

// ─── Tooltip builder ─────────────────────────────────────────────────────────

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
  return p >= 90 ? "#e45649" : p >= 80 ? "#e5a11c" : "#50a14f";
}

function barTrack() { return "rgba(127,127,127,0.18)"; }

function usageRowHtml(label, pct, resetsAt) {
  const c = pct !== null ? barColor(pct) : "#888";
  const p = pct !== null ? Math.min(Math.round(pct), 100) : 0;
  const txt = pct !== null ? Math.round(pct) + "%" : "?";
  return `<tr>`
    + `<td style="padding:2px 6px 2px 16px;white-space:nowrap;opacity:0.7;font-size:0.9em">${label}</td>`
    + `<td style="padding:2px 0;width:120px">`
    +   `<div style="background:${barTrack()};border-radius:4px;height:6px;width:120px">`
    +     `<div style="background:${c};height:100%;width:${p}%;border-radius:4px"></div>`
    +   `</div>`
    + `</td>`
    + `<td style="padding:2px 6px;white-space:nowrap;font-weight:600;color:${c};text-align:right;font-size:0.9em">${txt}</td>`
    + `<td style="padding:2px 0;white-space:nowrap;opacity:0.5;font-size:0.85em">\u21bb ${timeUntil(resetsAt)}</td>`
    + `</tr>`;
}

function cmdUri(command, args) {
  return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
}

function accountBlockHtml(num, email, isActive, usage) {
  const h5 = usage?.five_hour?.utilization ?? null;
  const d7 = usage?.seven_day?.utilization ?? null;
  const p5 = h5 !== null ? Math.round(h5) : null;
  const p7 = d7 !== null ? Math.round(d7) : null;

  const borderLeft = isActive
    ? `border-left:3px solid #0078d4;`
    : `border-left:3px solid rgba(127,127,127,0.25);`;

  const emailColor = isActive
    ? `color:#4da3ff;font-weight:700;font-size:0.95em`
    : `opacity:0.8;font-weight:600;font-size:0.95em`;

  const actionLine = isActive
    ? `<div style="font-size:0.78em;margin-top:3px;color:#4da3ff;opacity:0.8">&#10003; active</div>`
    : `<div style="font-size:0.78em;margin-top:3px">`
      + `<a href="${cmdUri("claudeUsage.switchTo", [num])}" style="opacity:0.65">Switch to this account</a>`
      + `</div>`;

  let block = `<div style="margin-bottom:8px;border-radius:5px;overflow:hidden;${borderLeft}">`;

  // Header: email on its own line, action label below
  block += `<div style="padding:5px 10px 5px 8px;`
    + (isActive ? `background:rgba(0,120,212,0.13)` : `background:rgba(127,127,127,0.07)`)
    + `">`
    + `<div style="${emailColor}">${email}</div>`
    + actionLine
    + `</div>`;

  // Usage bars
  block += `<div style="padding:4px 8px 5px 8px">`;
  block += `<table style="border-collapse:collapse;width:100%">`;
  block += usageRowHtml("5h", p5, usage?.five_hour?.resets_at);
  block += usageRowHtml("7d", p7, usage?.seven_day?.resets_at);
  block += `</table></div>`;

  block += `</div>`;
  return block;
}

function buildTooltip(accounts, currentEmail, currentSaved) {
  const tip = new vscode.MarkdownString();
  tip.isTrusted = true;
  tip.supportHtml = true;
  tip.supportThemeIcons = true;

  const divider = `<div style="font-size:0.82em;opacity:0.3;letter-spacing:2px;margin:6px 0">──────────────────────</div>`;

  let html = `<div style="padding:2px 0 4px 0"><strong>$(cloud) Claude Accounts</strong></div>`;
  html += divider;

  // Save banner
  if (currentEmail && !currentSaved) {
    const uri = cmdUri("claudeUsage.saveAccount", []);
    html += `<div style="margin-bottom:8px;padding:5px 8px;border-radius:5px;`
      + `background:rgba(200,150,0,0.12);border:1px solid rgba(200,150,0,0.35);font-size:0.9em">`
      + `Current account not saved &nbsp;<a href="${uri}"><strong>Save Account</strong></a>`
      + `</div>`;
  }

  if (accounts.length === 0) {
    html += `<div style="opacity:0.5;font-style:italic;font-size:0.9em">No managed accounts yet.</div>`;
  }

  // Active account first, then others with a divider
  const active = accounts.filter(a => a.isActive);
  const others = accounts.filter(a => !a.isActive);

  for (const { num, email, isActive, usage } of active) {
    html += accountBlockHtml(num, email, isActive, usage);
  }

  if (active.length > 0 && others.length > 0) {
    html += `<div style="font-size:0.82em;opacity:0.3;letter-spacing:2px;margin:8px 0">──────────────────────</div>`;
  }

  for (const { num, email, isActive, usage } of others) {
    html += accountBlockHtml(num, email, isActive, usage);
  }

  html += divider;

  // Refresh link at bottom
  html += `<div style="opacity:0.4;font-size:0.82em">`
    + `<a href="${cmdUri("claudeUsage.refresh", [])}">$(refresh) Refresh</a>`
    + `</div>`;

  tip.appendMarkdown(html);
  return tip;
}

// ─── Main refresh ────────────────────────────────────────────────────────────

async function refreshAll() {
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
    const seq = seqData.sequence || [];
    rows.sort((a, b) => seq.indexOf(a.num) - seq.indexOf(b.num));
  }

  const currentSaved = isSaved(seqData, currentEmail);

  // Update status bar text from current user's usage
  const current = rows.find(r => r.isActive);
  const h5 = current?.usage?.five_hour?.utilization ?? null;
  const d7 = current?.usage?.seven_day?.utilization ?? null;

  if (h5 === null && d7 === null) {
    // No managed accounts yet — fall back to fetching current user directly
    const ct = readCurrentCredentials();
    const token = ct ? getToken(ct) : null;
    if (token) {
      const usage = await fetchUsage(token);
      if (usage) {
        const fh = usage.five_hour?.utilization ?? 0;
        const sd = usage.seven_day?.utilization ?? 0;
        statusBarItem.text = `$(cloud) 5h ${Math.round(fh)}% 7d ${Math.round(sd)}%`;
        // Build a minimal tooltip for unsaved user
        const singleRow = [{
          num: 0,
          email: currentEmail || "unknown",
          isActive: true,
          usage
        }];
        statusBarItem.tooltip = buildTooltip(singleRow, currentEmail, currentSaved);
        return;
      }
    }
    statusBarItem.text = "$(cloud) --";
    statusBarItem.tooltip = buildTooltip([], currentEmail, currentSaved);
    return;
  }

  statusBarItem.text = `$(cloud) 5h ${h5 !== null ? Math.round(h5) : "--"}% 7d ${d7 !== null ? Math.round(d7) : "--"}%`;
  statusBarItem.tooltip = buildTooltip(rows, currentEmail, currentSaved);
}

// ─── Extension lifecycle ──────────────────────────────────────────────────────

function activate(context) {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  statusBarItem.command = "claudeUsage.refresh";
  statusBarItem.text = "$(cloud) ...";
  statusBarItem.show();

  context.subscriptions.push(
    statusBarItem,
    vscode.commands.registerCommand("claudeUsage.refresh", () => refreshAll()),
    vscode.commands.registerCommand("claudeUsage.switchTo", async (num) => {
      try {
        await switchToAccount(num);
        vscode.window.showInformationMessage(
          `Switched to Account-${num}. Restart Claude Code to apply.`
        );
        await refreshAll();
      } catch (e) {
        vscode.window.showErrorMessage(`Switch failed: ${e.message}`);
      }
    }),
    vscode.commands.registerCommand("claudeUsage.saveAccount", async () => {
      try {
        const n = await saveCurrentAccount();
        vscode.window.showInformationMessage(`Account saved as Account-${n}.`);
        await refreshAll();
      } catch (e) {
        vscode.window.showErrorMessage(`Save failed: ${e.message}`);
      }
    }),
    { dispose: () => clearInterval(timer) }
  );

  refreshAll();
  timer = setInterval(refreshAll, POLL_MS);
}

function deactivate() {
  if (timer) clearInterval(timer);
}

module.exports = { activate, deactivate };
