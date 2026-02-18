const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const https = require("https");
const os = require("os");
const crypto = require("crypto");

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
let lastDebugData = null;

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

// Backup files are keyed by account number only — email is NOT part of the key.
function readBackupCreds(num) {
  try {
    const raw = fs.readFileSync(path.join(CREDENTIALS_DIR, `.creds-${num}.enc`), "utf8");
    return Buffer.from(raw, "base64").toString("utf8");
  } catch { return null; }
}

function writeBackupCreds(num, text) {
  ensureDir(CREDENTIALS_DIR);
  const file = path.join(CREDENTIALS_DIR, `.creds-${num}.enc`);
  fs.writeFileSync(file, Buffer.from(text, "utf8").toString("base64"), "utf8");
  try { fs.chmodSync(file, 0o600); } catch {}
}

function readBackupConfig(num) {
  try {
    return fs.readFileSync(path.join(CONFIGS_DIR, `.claude-config-${num}.json`), "utf8");
  } catch { return null; }
}

function writeBackupConfig(num, text) {
  ensureDir(CONFIGS_DIR);
  const file = path.join(CONFIGS_DIR, `.claude-config-${num}.json`);
  fs.writeFileSync(file, text, "utf8");
  try { fs.chmodSync(file, 0o600); } catch {}
}

// ─── Migration: rename old email-keyed backup files to num-only names ─────────

function migrateBackupFilenames(data) {
  if (!data?.accounts) return;
  for (const [num, info] of Object.entries(data.accounts)) {
    if (!info.email) continue;
    const oldCreds = path.join(CREDENTIALS_DIR, `.creds-${num}-${info.email}.enc`);
    const newCreds = path.join(CREDENTIALS_DIR, `.creds-${num}.enc`);
    if (fs.existsSync(oldCreds) && !fs.existsSync(newCreds)) {
      try { fs.renameSync(oldCreds, newCreds); } catch {}
    }
    const oldConfig = path.join(CONFIGS_DIR, `.claude-config-${num}-${info.email}.json`);
    const newConfig = path.join(CONFIGS_DIR, `.claude-config-${num}.json`);
    if (fs.existsSync(oldConfig) && !fs.existsSync(newConfig)) {
      try { fs.renameSync(oldConfig, newConfig); } catch {}
    }
  }
}

// ─── Claude config helpers ───────────────────────────────────────────────────

function getConfigPath() {
  const d = readJSON(CLAUDE_CONFIG_PRIMARY);
  return (d && d.oauthAccount) ? CLAUDE_CONFIG_PRIMARY : CLAUDE_CONFIG_FALLBACK;
}

// ─── JWT / token helpers ─────────────────────────────────────────────────────

function decodeJwtPayload(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch { return null; }
}

function maskToken(token) {
  if (!token) return null;
  return token.slice(0, 8) + "…" + token.slice(-4);
}

// Returns a stable identity string for the account.
// Prefers the JWT `sub` claim; falls back to a SHA-256 fingerprint of the
// token itself when the token is opaque (not a JWT).
function getSubFromCreds(credsText) {
  try {
    const token = getToken(credsText);
    if (!token) return null;
    const sub = decodeJwtPayload(token)?.sub;
    if (sub) return sub;
    return "fp-" + crypto.createHash("sha256").update(token).digest("hex").slice(0, 24);
  } catch { return null; }
}

// Email is unreliable (Claude bug) — treat as a display hint only.
// Try idToken first (standard OIDC), then access token payload.
function getEmailHintFromCreds(credsText) {
  try {
    const oauth = JSON.parse(credsText)?.claudeAiOauth;
    if (!oauth) return null;
    if (oauth.idToken) {
      const p = decodeJwtPayload(oauth.idToken);
      if (p?.email) return p.email;
    }
    const p = decodeJwtPayload(oauth.accessToken);
    return p?.email ?? null;
  } catch { return null; }
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

// Identity is keyed by `sub` (stable JWT subject), not email.
function isSaved(data, sub) {
  if (!data || !sub) return false;
  return Object.values(data.accounts || {}).some(a => a.sub === sub);
}

function nextNum(data) {
  const nums = Object.keys(data.accounts || {}).map(Number);
  return nums.length ? Math.max(...nums) + 1 : 1;
}

// ─── Cleanup helpers ─────────────────────────────────────────────────────────

function cleanupOrphanedBackups(data) {
  if (!data?.accounts) return;
  const validCreds = new Set();
  const validConfigs = new Set();
  for (const num of Object.keys(data.accounts)) {
    validCreds.add(`.creds-${num}.enc`);
    validConfigs.add(`.claude-config-${num}.json`);
  }
  try {
    for (const f of fs.readdirSync(CREDENTIALS_DIR)) {
      if (f.startsWith(".creds-") && !validCreds.has(f)) {
        fs.unlinkSync(path.join(CREDENTIALS_DIR, f));
      }
    }
  } catch {}
  try {
    for (const f of fs.readdirSync(CONFIGS_DIR)) {
      if (f.startsWith(".claude-config-") && !validConfigs.has(f)) {
        fs.unlinkSync(path.join(CONFIGS_DIR, f));
      }
    }
  } catch {}
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
  const credsText = readCurrentCredentials();
  if (!credsText) throw new Error("Failed to read credentials");

  const token = getToken(credsText);
  if (!token) throw new Error("No active credential token found");

  const sub = getSubFromCreds(credsText);
  if (!sub) throw new Error("Could not determine account identity from token");

  const data = getSeqData();
  if (isSaved(data, sub)) throw new Error("This account is already saved");

  const num = nextNum(data);
  const configPath = getConfigPath();
  const configText = fs.readFileSync(configPath, "utf8");

  // Duplicate check by sub (token identity), not email
  const dup = Object.entries(data.accounts || {}).find(([, a]) => a.sub && a.sub === sub);
  if (dup) {
    throw new Error(`Account-${dup[0]} has the same token identity. This appears to be the same account.`);
  }

  writeBackupCreds(String(num), credsText);
  writeBackupConfig(String(num), configText);

  // Email is stored as a display hint only — it may be incorrect
  const email = getEmailHintFromCreds(credsText) || "(unknown)";
  data.accounts[String(num)] = { email, sub, added: getTimestamp() };
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

  // Detect active account by sub (token identity), not email
  const currentCredsText = readCurrentCredentials();
  const currentSub = currentCredsText ? getSubFromCreds(currentCredsText) : null;
  let currentNum = String(data.activeAccountNumber);
  if (currentSub) {
    const match = Object.entries(data.accounts).find(([, a]) => a.sub === currentSub);
    if (match) currentNum = match[0];
  }

  // Back up current account before switching
  if (data.accounts[currentNum]) {
    const cc = readCurrentCredentials();
    const cf = fs.readFileSync(configPath, "utf8");
    if (cc) writeBackupCreds(currentNum, cc);
    writeBackupConfig(currentNum, cf);
  }

  const tc = readBackupCreds(tStr);
  const tf = readBackupConfig(tStr);
  if (!tc || !tf) throw new Error(`Missing backup data for Account-${targetNum}`);

  writeCurrentCredentials(tc);

  const tfData = JSON.parse(tf);
  const oauth = tfData.oauthAccount;
  if (!oauth) throw new Error("Invalid backup config: missing oauthAccount");

  // Restore oauthAccount as-is — we don't force-correct email since it may be wrong
  const currentCfg = readJSON(configPath) || {};
  currentCfg.oauthAccount = oauth;
  writeJSON(configPath, currentCfg);

  data.activeAccountNumber = targetNum;
  data.lastUpdated = getTimestamp();
  writeJSON(SEQUENCE_FILE, data);

  cleanupOrphanedBackups(data);
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

function accountBlockHtml(num, email, maskedToken, isActive, usage) {
  const h5 = usage?.five_hour?.utilization ?? null;
  const d7 = usage?.seven_day?.utilization ?? null;
  const p5 = h5 !== null ? Math.round(h5) : null;
  const p7 = d7 !== null ? Math.round(d7) : null;

  const borderLeft = isActive
    ? `border-left:3px solid #0078d4;`
    : `border-left:3px solid rgba(127,127,127,0.25);`;

  const actionLine = isActive
    ? `<div style="font-size:0.78em;margin-top:3px;color:#4da3ff;opacity:0.8">&#10003; active</div>`
    : `<div style="font-size:0.78em;margin-top:3px">`
      + `<a href="${cmdUri("claudeUsage.switchTo", [num])}" style="opacity:0.65">Switch to this account</a>`
      + `</div>`;

  let block = `<div style="margin-bottom:8px;border-radius:5px;overflow:hidden;${borderLeft}">`;

  block += `<div style="padding:5px 10px 5px 8px;`
    + (isActive ? `background:rgba(0,120,212,0.13)` : `background:rgba(127,127,127,0.07)`)
    + `">`;

  // Token is the reliable identity — always show it prominently
  if (maskedToken) {
    block += `<div style="font-family:monospace;font-size:0.88em;`
      + (isActive ? `color:#4da3ff;font-weight:700` : `opacity:0.85;font-weight:600`)
      + `">${maskedToken}</div>`;
  }
  // Email is a hint only — may be incorrect
  if (email) {
    block += `<div style="font-size:0.78em;opacity:0.5;margin-top:1px">${email}</div>`;
  }
  block += actionLine;
  block += `</div>`;

  // Usage bars
  block += `<div style="padding:4px 8px 5px 8px">`;
  block += `<table style="border-collapse:collapse;width:100%">`;
  block += usageRowHtml("5h", p5, usage?.five_hour?.resets_at);
  block += usageRowHtml("7d", p7, usage?.seven_day?.resets_at);
  block += `</table></div>`;

  block += `</div>`;
  return block;
}

function buildTooltip(accounts, currentSaved) {
  const tip = new vscode.MarkdownString();
  tip.isTrusted = true;
  tip.supportHtml = true;
  tip.supportThemeIcons = true;

  const divider = `<div style="font-size:0.82em;opacity:0.3;letter-spacing:2px;margin:6px 0">──────────────────────</div>`;

  let html = `<div style="padding:2px 0 4px 0"><strong>$(cloud) Claude Accounts</strong></div>`;
  html += divider;

  // Save banner — shown when current account is not yet managed
  if (!currentSaved) {
    const uri = cmdUri("claudeUsage.saveAccount", []);
    html += `<div style="margin-bottom:8px;padding:5px 8px;border-radius:5px;`
      + `background:rgba(200,150,0,0.12);border:1px solid rgba(200,150,0,0.35);font-size:0.9em">`
      + `Current account not saved &nbsp;<a href="${uri}"><strong>Save Account</strong></a>`
      + `</div>`;
  }

  if (accounts.length === 0) {
    html += `<div style="opacity:0.5;font-style:italic;font-size:0.9em">No managed accounts yet.</div>`;
  }

  const active = accounts.filter(a => a.isActive);
  const others = accounts.filter(a => !a.isActive);

  for (const { num, email, maskedToken, isActive, usage } of active) {
    html += accountBlockHtml(num, email, maskedToken, isActive, usage);
  }

  if (active.length > 0 && others.length > 0) {
    html += `<div style="font-size:0.82em;opacity:0.3;letter-spacing:2px;margin:8px 0">──────────────────────</div>`;
  }

  for (const { num, email, maskedToken, isActive, usage } of others) {
    html += accountBlockHtml(num, email, maskedToken, isActive, usage);
  }

  html += divider;

  html += `<div style="opacity:0.4;font-size:0.82em">`
    + `<a href="${cmdUri("claudeUsage.refresh", [])}">$(refresh) Refresh</a>`
    + `&nbsp;&nbsp;<a href="${cmdUri("claudeUsage.showDebug", [])}">$(bug) Debug</a>`
    + `</div>`;

  tip.appendMarkdown(html);
  return tip;
}

// ─── Debug data builder ──────────────────────────────────────────────────────

function buildDebugData(rows) {
  const files = {
    CREDS_FILE: { path: CREDS_FILE, exists: fs.existsSync(CREDS_FILE) },
    CLAUDE_CONFIG_PRIMARY: { path: CLAUDE_CONFIG_PRIMARY, exists: fs.existsSync(CLAUDE_CONFIG_PRIMARY) },
    CLAUDE_CONFIG_FALLBACK: { path: CLAUDE_CONFIG_FALLBACK, exists: fs.existsSync(CLAUDE_CONFIG_FALLBACK) },
    SEQUENCE_FILE: { path: SEQUENCE_FILE, exists: fs.existsSync(SEQUENCE_FILE) },
  };

  const accounts = rows.map(({ num, email, sub, maskedToken, isActive, usage, tokenSource }) => {
    const credsText = isActive ? readCurrentCredentials() : readBackupCreds(String(num));
    const token = credsText ? getToken(credsText) : null;
    const jwtPayload = token ? decodeJwtPayload(token) : null;
    return {
      num,
      isActive,
      tokenSource: tokenSource ?? null,
      token: maskedToken ?? maskToken(token),
      sub: sub ?? null,
      jwtPayload: jwtPayload ?? null,
      emailHint: email ?? null,    // display-only, may be wrong
      usage: usage ?? null,
    };
  });

  return { fetchedAt: new Date().toISOString(), files, accounts };
}

// ─── Main refresh ────────────────────────────────────────────────────────────

async function refreshAll() {
  const seqData = getSeqData();
  const rows = [];

  // Determine identity of currently-active account from the token itself
  const currentCredsText = readCurrentCredentials();
  const currentSub = currentCredsText ? getSubFromCreds(currentCredsText) : null;

  if (seqData && seqData.accounts) {
    // Detect active account by sub, not by email
    let activeNum = seqData.activeAccountNumber;
    if (currentSub) {
      const match = Object.entries(seqData.accounts).find(([, a]) => a.sub === currentSub);
      if (match) activeNum = Number(match[0]);
    }

    await Promise.all((seqData.sequence || []).map(async num => {
      const info = seqData.accounts[String(num)];
      if (!info) return;
      const isActive = num === activeNum;
      const credsText = isActive ? readCurrentCredentials() : readBackupCreds(String(num));
      const token = credsText ? getToken(credsText) : null;
      const usage = token ? await fetchUsage(token) : null;
      const email = info.email || null;   // hint only
      const sub = info.sub ?? getSubFromCreds(credsText) ?? null;
      const maskedToken = maskToken(token);
      const tokenSource = isActive ? CREDS_FILE : path.join(CREDENTIALS_DIR, `.creds-${num}.enc`);
      rows.push({ num, email, sub, maskedToken, isActive, usage, tokenSource });
    }));

    const seq = seqData.sequence || [];
    rows.sort((a, b) => seq.indexOf(a.num) - seq.indexOf(b.num));
  }

  const currentSaved = isSaved(seqData, currentSub);

  const current = rows.find(r => r.isActive);
  const h5 = current?.usage?.five_hour?.utilization ?? null;
  const d7 = current?.usage?.seven_day?.utilization ?? null;

  if (h5 === null && d7 === null) {
    // No managed accounts yet — fall back to fetching current user directly
    const token = currentCredsText ? getToken(currentCredsText) : null;
    if (token) {
      const usage = await fetchUsage(token);
      if (usage) {
        const fh = usage.five_hour?.utilization ?? 0;
        const sd = usage.seven_day?.utilization ?? 0;
        statusBarItem.text = `$(cloud) 5h ${Math.round(fh)}% 7d ${Math.round(sd)}%`;
        const emailHint = currentCredsText ? getEmailHintFromCreds(currentCredsText) : null;
        const singleRow = [{
          num: 0,
          email: emailHint,
          sub: currentSub,
          maskedToken: maskToken(token),
          isActive: true,
          usage,
          tokenSource: CREDS_FILE,
        }];
        statusBarItem.tooltip = buildTooltip(singleRow, currentSaved);
        lastDebugData = buildDebugData(singleRow);
        return;
      }
    }
    statusBarItem.text = "$(cloud) --";
    statusBarItem.tooltip = buildTooltip([], currentSaved);
    lastDebugData = buildDebugData([]);
    return;
  }

  statusBarItem.text = `$(cloud) 5h ${h5 !== null ? Math.round(h5) : "--"}% 7d ${d7 !== null ? Math.round(d7) : "--"}%`;
  statusBarItem.tooltip = buildTooltip(rows, currentSaved);
  lastDebugData = buildDebugData(rows);
}

// ─── Extension lifecycle ──────────────────────────────────────────────────────

function activate(context) {
  // Migrate old email-keyed backup files to num-only naming on first run
  migrateBackupFilenames(getSeqData());

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
    vscode.commands.registerCommand("claudeUsage.showDebug", async () => {
      const data = lastDebugData || { error: "No debug data yet — try refreshing first." };
      const doc = await vscode.workspace.openTextDocument({
        language: "json",
        content: JSON.stringify(data, null, 2),
      });
      await vscode.window.showTextDocument(doc, { preview: true });
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
