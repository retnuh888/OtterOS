const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");
const os = require("os");
const { execFile } = require("child_process");

const root = __dirname;
const filesRoot = path.join(root, "OtterOS files");
const passwordPath = path.join(root, "password.txt");
const statePath = path.join(root, "otteros-state.json");
const wallpaperDir = path.join(filesRoot, "Wallpaper");
const port = Number(process.env.OTTER_PORT) || 41773;

let cpuSample = null;
let cpuPercent = null;
function sampleCpu() {
  const list = os.cpus() || [];
  let idle = 0;
  let total = 0;
  list.forEach((cpu) => {
    const times = cpu.times || {};
    idle += times.idle || 0;
    total += (times.user || 0) + (times.nice || 0) + (times.sys || 0) + (times.idle || 0) + (times.irq || 0);
  });
  if (cpuSample && total > cpuSample.total) {
    const idleDelta = idle - cpuSample.idle;
    const totalDelta = total - cpuSample.total;
    cpuPercent = Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 100)));
  }
  cpuSample = { idle, total };
  return {
    cpu: cpuPercent,
    cores: list.length,
    model: list[0] ? String(list[0].model || "").trim() : "",
    memoryUsed: os.totalmem() - os.freemem(),
    memoryTotal: os.totalmem(),
    hostname: os.hostname(),
    uptime: Math.round(os.uptime())
  };
}
function diskInfo() {
  try {
    const stat = fs.statfsSync(filesRoot);
    return { diskTotal: stat.blocks * stat.bsize, diskFree: stat.bavail * stat.bsize };
  } catch (error) {
    return { diskTotal: null, diskFree: null };
  }
}
let batteryCache = { at: 0, percent: null, status: null };
let batteryPromise = null;
function readBattery() {
  if (Date.now() - batteryCache.at < 15000) return Promise.resolve(batteryCache);
  if (batteryPromise) return batteryPromise;
  batteryPromise = new Promise((resolve) => {
    execFile("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$b = Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1; if (-not $b) { 'null' } else { @{ percent = [int]$b.EstimatedChargeRemaining; status = [int]$b.BatteryStatus } | ConvertTo-Json -Compress }"
    ], { timeout: 5000, windowsHide: true }, (error, stdout) => {
      let percent = null;
      let status = null;
      const raw = String(stdout || "").trim();
      if (!error && raw && raw !== "null") {
        try {
          const parsed = JSON.parse(raw);
          if (Number.isFinite(parsed.percent)) percent = parsed.percent;
          if (Number.isFinite(parsed.status)) status = parsed.status;
        } catch (err) {}
      }
      batteryCache = { at: Date.now(), percent, status };
      batteryPromise = null;
      resolve(batteryCache);
    });
  });
  return batteryPromise;
}
sampleCpu();
setInterval(sampleCpu, 2000);

const imageExts = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);
const types = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".txt": "text/plain; charset=utf-8",
  ".app": "application/json; charset=utf-8",
};

function normalizeRel(rel) {
  const cleaned = String(rel || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!cleaned) return "";
  const parts = cleaned.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts.join("/");
}

function inside(parent, target) {
  const parentResolved = path.resolve(parent);
  const targetResolved = path.resolve(target);
  return targetResolved === parentResolved || targetResolved.startsWith(parentResolved + path.sep);
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

function listDir(rel) {
  const dir = path.resolve(filesRoot, ...rel.split("/").filter(Boolean));
  if (!inside(filesRoot, dir) || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.name && !entry.name.startsWith("."))
    .map((entry) => ({
      name: entry.name,
      kind: entry.isDirectory() ? "folder" : "file",
    }))
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
  const visible = rel ? entries : entries.filter((entry) => entry.name.toLowerCase() !== "bin");
  const parts = rel ? rel.split("/") : [];
  return {
    path: rel,
    parent: parts.length ? parts.slice(0, -1).join("/") : null,
    entries: visible,
  };
}

function safeFileName(name) {
  const base = path.basename(String(name || "")).replace(/[<>:"/\\|?*\u0000-\u001F]/g, "").trim();
  if (!base || base === "." || base === ".." || base.startsWith(".")) return null;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(base)) return null;
  return base;
}

function uniquePath(dir, name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let candidate = path.join(dir, name);
  let count = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, stem + " (" + count + ")" + ext);
    count += 1;
  }
  return candidate;
}

function saveUpload(req, dest, limit) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(dest);
    let size = 0;
    let failed = false;
    const fail = (error) => {
      if (failed) return;
      failed = true;
      output.destroy();
      fs.rmSync(dest, { force: true });
      reject(error);
    };
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        fail(new Error("too large"));
      }
    });
    req.on("error", fail);
    output.on("error", fail);
    output.on("finish", () => {
      if (!failed) resolve();
    });
    req.pipe(output);
  });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new Error("too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function isTextFile(target) {
  return path.extname(target).toLowerCase() === ".txt";
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function blankPng() {
  const width = 64;
  const height = 64;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const index = row + 1 + x * 4;
      raw[index] = 255;
      raw[index + 1] = 255;
      raw[index + 2] = 255;
      raw[index + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function silentMp3() {
  const frame = Buffer.alloc(417, 0);
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x90;
  frame[3] = 0x00;
  return Buffer.concat(Array.from({ length: 16 }, () => frame));
}

function box(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4);
  return Buffer.concat([head, body]);
}

function blankMp4() {
  const ftyp = box("ftyp", Buffer.concat([
    Buffer.from("isom"),
    Buffer.from([0, 0, 2, 0]),
    Buffer.from("isomiso2mp41"),
  ]));
  return Buffer.concat([ftyp, box("mdat", Buffer.alloc(8))]);
}

function resolveItem(rel) {
  const normal = normalizeRel(rel);
  if (normal === null) return null;
  const target = path.resolve(filesRoot, ...normal.split("/").filter(Boolean));
  if (!inside(filesRoot, target)) return null;
  return { rel: normal, target };
}

const builtInNames = new Set(["apps", "wallpaper", "desktop", "bin"]);

function isBuiltIn(rel) {
  return builtInNames.has(String(rel || "").toLowerCase());
}

function inBin(rel) {
  const lower = String(rel || "").toLowerCase();
  return lower === "bin" || lower.startsWith("bin/");
}

function attachmentName(name) {
  const ascii = name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return "attachment; filename=\"" + ascii + "\"; filename*=UTF-8''" + encodeURIComponent(name);
}

function zipFiles(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  entries.forEach((entry) => {
    const name = Buffer.from(entry.name.replace(/\\/g, "/"), "utf8");
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    parts.push(local, name, entry.data);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(entry.data.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += 30 + name.length + entry.data.length;
  });
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat(parts.concat(centralBuf, end));
}

function collectZip(dir, prefix, entries, budget) {
  const children = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.name && !entry.name.startsWith("."));
  if (!children.length) {
    entries.push({ name: prefix.replace(/\\/g, "/") + "/", data: Buffer.alloc(0) });
    return;
  }
  children.forEach((entry) => {
    const full = path.join(dir, entry.name);
    const relName = prefix + "/" + entry.name;
    if (entry.isDirectory()) collectZip(full, relName, entries, budget);
    else {
      const data = fs.readFileSync(full);
      budget.used += data.length;
      if (budget.used > 200 * 1024 * 1024) throw new Error("too large");
      entries.push({ name: relName.replace(/\\/g, "/"), data });
    }
  });
}

const newItems = {
  folder: { name: "New folder", directory: true },
  txt: { name: "New Text Document.txt", body: Buffer.from("") },
  png: { name: "New PNG Image.png", body: blankPng },
  mp3: { name: "New MP3 Audio.mp3", body: silentMp3 },
  mp4: { name: "New MP4 Video.mp4", body: blankMp4 },
};

function isPrivateAddress(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) {
    const parts = ip.split(".").map(Number);
    if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    return false;
  }
  if (kind === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice(7));
  }
  return false;
}

async function publicWebUrl(raw) {
  let target;
  try {
    target = new URL(String(raw || ""));
  } catch (error) {
    return null;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return null;
  if (target.username || target.password) return null;
  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return null;
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) return null;
    return target.href;
  }
  let records = [];
  try {
    records = await dns.lookup(host, { all: true, verbatim: true });
  } catch (error) {
    return null;
  }
  if (!records.length || records.some((record) => isPrivateAddress(record.address))) return null;
  return target.href;
}

function browsePage(message) {
  return "<!DOCTYPE html><html><body style=\"font-family:Segoe UI,sans-serif;padding:28px;color:#222\"><p>" +
    String(message).replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch])) +
    "</p></body></html>";
}

const browseCookies = new Map();

function storeCookies(hostname, response) {
  const lines = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  if (!lines.length) return;
  if (!browseCookies.has(hostname)) browseCookies.set(hostname, new Map());
  const jar = browseCookies.get(hostname);
  lines.forEach((line) => {
    const parts = line.split(";").map((part) => part.trim());
    const eq = parts[0].indexOf("=");
    if (eq <= 0) return;
    const name = parts[0].slice(0, eq).trim();
    const value = parts[0].slice(eq + 1).trim();
    let cookiePath = "/";
    let expires = 0;
    parts.slice(1).forEach((attr) => {
      const split = attr.indexOf("=");
      const key = (split === -1 ? attr : attr.slice(0, split)).trim().toLowerCase();
      const attrValue = split === -1 ? "" : attr.slice(split + 1).trim();
      if (key === "path" && attrValue) cookiePath = attrValue;
      if (key === "expires") expires = Date.parse(attrValue) || 0;
      if (key === "max-age") expires = Date.now() + Number(attrValue) * 1000;
    });
    if (expires && expires < Date.now()) jar.delete(name);
    else jar.set(name, { value, path: cookiePath, expires });
  });
}

function cookieHeader(target) {
  const jar = browseCookies.get(target.hostname);
  if (!jar) return "";
  const parts = [];
  jar.forEach((cookie, name) => {
    if (cookie.expires && cookie.expires < Date.now()) return;
    const cookiePath = cookie.path || "/";
    if (!target.pathname.startsWith(cookiePath)) return;
    parts.push(name + "=" + cookie.value);
  });
  return parts.join("; ");
}

function browseHook(origin) {
  const originJson = JSON.stringify(origin);
  return "<script>(function(){var OTTER=" + originJson + ";function abs(u){try{return new URL(u,document.baseURI).href}catch(e){return \"\"}}function prox(u){var next=abs(u);if(!/^https?:/i.test(next))return u;if(next.indexOf(OTTER+\"/api/browse\")===0)return next;return OTTER+\"/api/browse?url=\"+encodeURIComponent(next)}var origFetch=window.fetch;if(origFetch){window.fetch=function(input,init){try{var raw=typeof input===\"string\"?input:(input&&input.url)||\"\";var next=prox(raw);if(next!==raw)return origFetch.call(this,next,init)}catch(e){}return origFetch.call(this,input,init)}}var origOpen=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url){var args=[].slice.call(arguments);try{args[1]=prox(url)}catch(e){}return origOpen.apply(this,args)};window.open=function(u){var next=abs(u);if(/^https?:/i.test(next))parent.postMessage({otterBrowse:next,otterTab:true},\"*\");return null};document.addEventListener(\"click\",function(e){var a=e.target.closest&&e.target.closest(\"a[href]\");if(!a)return;var href=a.getAttribute(\"href\")||\"\";if(!href||href.charAt(0)===\"#\"||/^javascript:/i.test(href))return;var next=abs(a.href);if(!/^https?:/i.test(next))return;e.preventDefault();e.stopPropagation();parent.postMessage({otterBrowse:next},\"*\")},true);document.addEventListener(\"submit\",function(e){var form=e.target;if(!form||form.tagName!==\"FORM\")return;e.preventDefault();e.stopPropagation();var action=abs(form.getAttribute(\"action\")||document.baseURI);if(!/^https?:/i.test(action))return;var params=new URLSearchParams();var data=new FormData(form);data.forEach(function(v,k){if(typeof v===\"string\")params.append(k,v)});var method=(form.getAttribute(\"method\")||\"GET\").toUpperCase();if(method!==\"POST\"){var q=params.toString();parent.postMessage({otterBrowse:q?action+(action.indexOf(\"?\")>=0?\"&\":\"?\")+q:action},\"*\");return}parent.postMessage({otterBrowse:action,otterMethod:\"POST\",otterBody:params.toString()},\"*\")},true)})()</script>";
}

function rewritePage(html, pageUrl, origin) {
  const safeUrl = pageUrl.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  let out = String(html).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  out = out.replace(/<script\b[^>]*\/?>/gi, "");
  out = out.replace(/\son[a-z]+\s*=\s*(['"])[\s\S]*?\1/gi, "");
  out = out.replace(/<noscript\b[^>]*>/gi, "<div>").replace(/<\/noscript>/gi, "</div>");
  out = out.replace(/<base\b[^>]*>/gi, "");
  out = out.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?\s*content-security-policy\b[^>]*>/gi, "");
  out = out.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?\s*refresh\b[^>]*>/gi, "");
  const inject = "<base href=\"" + safeUrl + "\">" + browseHook(origin);
  if (/<head\b[^>]*>/i.test(out)) return out.replace(/<head\b[^>]*>/i, (tag) => tag + inject);
  return inject + out;
}

function decodeHtml(payload, type) {
  const match = /charset\s*=\s*"?([^";\s]+)/i.exec(type || "");
  const charset = match ? match[1].trim() : "utf-8";
  try {
    return new TextDecoder(charset).decode(payload);
  } catch (error) {
    return new TextDecoder("utf-8").decode(payload);
  }
}

function browseCors(extra) {
  return Object.assign({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Cache-Control": "no-store",
  }, extra || {});
}

async function readLimited(response, limit) {
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const step = await reader.read();
    if (step.done) break;
    size += step.value.length;
    if (size > limit) {
      reader.cancel();
      throw new Error("large");
    }
    chunks.push(Buffer.from(step.value));
  }
  return Buffer.concat(chunks);
}

async function fetchPublic(targetUrl, method, body, accept, contentType) {
  let current = targetUrl;
  let verb = method || "GET";
  for (let hop = 0; hop < 8; hop += 1) {
    const safe = await publicWebUrl(current);
    if (!safe) throw new Error("blocked");
    const target = new URL(safe);
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept": accept || "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": target.origin + "/",
    };
    const cookie = cookieHeader(target);
    if (cookie) headers.Cookie = cookie;
    if (verb === "POST" && contentType) headers["Content-Type"] = contentType;
    const response = await fetch(safe, {
      method: verb,
      redirect: "manual",
      headers,
      body: verb === "POST" ? body : undefined,
      signal: AbortSignal.timeout(20000),
    });
    storeCookies(target.hostname, response);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (response.body) response.body.cancel();
      if (!location) throw new Error("redirect");
      current = new URL(location, safe).href;
      if (response.status === 303 || response.status === 302) verb = "GET";
      continue;
    }
    return { response, finalUrl: safe };
  }
  throw new Error("redirect");
}

function allowsFrame(xfo, csp) {
  if (xfo && /deny|sameorigin|allow-from/i.test(xfo)) return false;
  const match = String(csp || "").match(/frame-ancestors\s+([^;]+)/i);
  if (!match) return true;
  return match[1].trim().split(/\s+/).includes("*");
}

async function framePolicy(targetUrl) {
  const safe = await publicWebUrl(targetUrl);
  if (!safe) return { frame: false, url: "" };
  const result = await fetchPublic(safe, "GET");
  const frame = allowsFrame(result.response.headers.get("x-frame-options"), result.response.headers.get("content-security-policy"));
  if (result.response.body) result.response.body.cancel();
  return { frame, url: result.finalUrl };
}

async function browse(req, res, targetUrl) {
  const safe = await publicWebUrl(targetUrl);
  if (!safe) {
    req.resume();
    res.writeHead(200, browseCors({ "Content-Type": "text/html; charset=utf-8", "X-Otter-Frame": "0" }));
    res.end(browsePage("That address can't be opened."));
    return;
  }
  let body = null;
  if (req.method === "POST") body = await readBody(req, 1024 * 1024);
  const accept = req.headers.accept;
  const result = await fetchPublic(safe, req.method === "POST" ? "POST" : "GET", body, accept && accept !== "*/*" ? accept : undefined, req.headers["content-type"]);
  const type = result.response.headers.get("content-type") || "application/octet-stream";
  const payload = await readLimited(result.response, 8 * 1024 * 1024);
  const origin = "http://" + (req.headers.host || ("127.0.0.1:" + port));
  const frame = allowsFrame(result.response.headers.get("x-frame-options"), result.response.headers.get("content-security-policy")) ? "1" : "0";
  if (/text\/html|application\/xhtml\+xml/i.test(type)) {
    const html = rewritePage(decodeHtml(payload, type), result.finalUrl, origin);
    res.writeHead(200, browseCors({ "Content-Type": "text/html; charset=utf-8", "X-Otter-Frame": frame }));
    res.end(html);
    return;
  }
  res.writeHead(200, browseCors({ "Content-Type": type.split(";")[0], "X-Otter-Frame": "0" }));
  res.end(payload);
}

function readPassword() {
  try {
    return fs.readFileSync(passwordPath, "utf8").replace(/^\uFEFF/, "").replace(/\r?\n$/, "");
  } catch (error) {
    return "";
  }
}

function sameSecret(a, b) {
  const left = crypto.createHash("sha256").update(String(a), "utf8").digest();
  const right = crypto.createHash("sha256").update(String(b), "utf8").digest();
  return crypto.timingSafeEqual(left, right);
}

function wallpaperInfo() {
  if (!fs.existsSync(wallpaperDir)) return null;
  const images = fs.readdirSync(wallpaperDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && imageExts.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => {
      const full = path.join(wallpaperDir, entry.name);
      return { name: entry.name, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  if (!images.length) return null;
  const newest = images[0];
  return {
    url: "/media/Wallpaper/" + encodeURIComponent(newest.name) + "?v=" + newest.mtime,
  };
}

function handle(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname.startsWith("/api/") && String(req.headers["sec-fetch-site"] || "") === "cross-site") {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("forbidden");
    req.resume();
    return;
  }

  if (url.pathname === "/api/unlock" && req.method === "POST") {
    readBody(req, 4096).then((buf) => {
      let typed = "";
      try {
        typed = String((JSON.parse(buf.toString("utf8")) || {}).password || "");
      } catch (error) {}
      const saved = readPassword();
      sendJson(res, 200, { ok: saved.length > 0 && sameSecret(typed, saved) });
    }).catch(() => {
      if (!res.headersSent) sendJson(res, 400, { ok: false });
    });
    return;
  }

  if (url.pathname === "/api/password" && req.method === "POST") {
    readBody(req, 8192).then((buf) => {
      let data = {};
      try {
        data = JSON.parse(buf.toString("utf8")) || {};
      } catch (error) {}
      const current = String(data.current || "");
      const next = String(data.next || "");
      const saved = readPassword();
      if (!saved || !sameSecret(current, saved)) {
        sendJson(res, 403, { ok: false, error: "wrong" });
        return;
      }
      if (!next || next.length > 200 || /[\r\n]/.test(next)) {
        sendJson(res, 400, { ok: false, error: "bad" });
        return;
      }
      try {
        fs.writeFileSync(passwordPath, next, "utf8");
      } catch (error) {
        sendJson(res, 500, { ok: false, error: "save" });
        return;
      }
      sendJson(res, 200, { ok: true });
    }).catch(() => {
      if (!res.headersSent) sendJson(res, 400, { ok: false });
    });
    return;
  }

  if (url.pathname === "/api/health" && req.method === "GET") {
    const live = sampleCpu();
    readBattery().then((battery) => {
      if (res.headersSent) return;
      sendJson(res, 200, Object.assign(live, diskInfo(), {
        battery: battery.percent,
        batteryStatus: battery.status
      }));
    });
    return;
  }

  if (url.pathname === "/api/state" && req.method === "GET") {
    let data = {};
    try {
      data = JSON.parse(fs.readFileSync(statePath, "utf8"));
    } catch (error) {}
    sendJson(res, 200, data && typeof data === "object" && !Array.isArray(data) ? data : {});
    return;
  }

  if (url.pathname === "/api/state" && req.method === "POST") {
    readBody(req, 2 * 1024 * 1024).then((buf) => {
      let data = {};
      try { data = JSON.parse(buf.toString("utf8")); } catch (error) {}
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        sendJson(res, 400, { error: "bad" });
        return;
      }
      const next = {
        settings: data.settings && typeof data.settings === "object" && !Array.isArray(data.settings) ? data.settings : {},
        profile: data.profile && typeof data.profile === "object" && !Array.isArray(data.profile) ? data.profile : {},
        layout: data.layout && typeof data.layout === "object" && !Array.isArray(data.layout) ? data.layout : {}
      };
      fs.writeFileSync(statePath, JSON.stringify(next));
      sendJson(res, 200, { ok: true });
    }).catch(() => {
      if (!res.headersSent) sendJson(res, 400, { error: "save failed" });
    });
    return;
  }

  if (url.pathname === "/api/shutdown") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("ok");
    setTimeout(() => process.exit(0), 200);
    return;
  }

  if (url.pathname === "/api/list") {
    const rel = normalizeRel(url.searchParams.get("path"));
    if (rel === null) {
      sendJson(res, 400, { error: "bad path" });
      return;
    }
    const listing = listDir(rel);
    if (!listing) {
      sendJson(res, 404, { error: "missing" });
      return;
    }
    sendJson(res, 200, listing);
    return;
  }

  if (url.pathname === "/api/upload" && req.method === "POST") {
    const rel = normalizeRel(url.searchParams.get("path"));
    const name = safeFileName(url.searchParams.get("name"));
    if (rel === null || !name) {
      sendJson(res, 400, { error: "bad path" });
      req.resume();
      return;
    }
    const dir = path.resolve(filesRoot, ...rel.split("/").filter(Boolean));
    const dest = uniquePath(dir, name);
    if (!inside(filesRoot, dir) || !inside(filesRoot, dest) || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      sendJson(res, 404, { error: "missing" });
      req.resume();
      return;
    }
    saveUpload(req, dest, 200 * 1024 * 1024)
      .then(() => sendJson(res, 200, { name: path.basename(dest) }))
      .catch(() => {
        if (!res.headersSent) sendJson(res, 400, { error: "upload failed" });
      });
    return;
  }

  if (url.pathname === "/api/create" && req.method === "POST") {
    const parent = resolveItem(url.searchParams.get("path"));
    const spec = newItems[url.searchParams.get("kind")];
    if (!parent || !spec || !fs.existsSync(parent.target) || !fs.statSync(parent.target).isDirectory()) {
      sendJson(res, 400, { error: "bad path" });
      req.resume();
      return;
    }
    const dest = uniquePath(parent.target, spec.name);
    if (!inside(filesRoot, dest)) {
      sendJson(res, 400, { error: "bad path" });
      req.resume();
      return;
    }
    if (spec.directory) fs.mkdirSync(dest);
    else fs.writeFileSync(dest, typeof spec.body === "function" ? spec.body() : spec.body);
    sendJson(res, 200, { name: path.basename(dest) });
    req.resume();
    return;
  }

  if (url.pathname === "/api/rename" && req.method === "POST") {
    const from = resolveItem(url.searchParams.get("path"));
    const name = safeFileName(url.searchParams.get("name"));
    if (!from || !name || !from.rel || !fs.existsSync(from.target) || isBuiltIn(from.rel)) {
      sendJson(res, isBuiltIn(from && from.rel) ? 403 : 400, { error: isBuiltIn(from && from.rel) ? "protected" : "bad path" });
      req.resume();
      return;
    }
    const dest = path.join(path.dirname(from.target), name);
    if (!inside(filesRoot, dest)) {
      sendJson(res, 400, { error: "bad path" });
      req.resume();
      return;
    }
    if (path.resolve(dest) !== path.resolve(from.target) && fs.existsSync(dest)) {
      sendJson(res, 409, { error: "exists" });
      req.resume();
      return;
    }
    if (path.resolve(dest) !== path.resolve(from.target)) fs.renameSync(from.target, dest);
    sendJson(res, 200, { name });
    req.resume();
    return;
  }

  if (url.pathname === "/api/move" && req.method === "POST") {
    const from = resolveItem(url.searchParams.get("path"));
    const destDir = resolveItem(url.searchParams.get("to"));
    const destReady = destDir && fs.existsSync(destDir.target) && fs.statSync(destDir.target).isDirectory();
    if (!from || !from.rel || !destReady || isBuiltIn(from.rel) || !fs.existsSync(from.target)) {
      sendJson(res, 400, { error: "bad path" });
      req.resume();
      return;
    }
    if (inside(from.target, destDir.target)) {
      sendJson(res, 400, { error: "bad path" });
      req.resume();
      return;
    }
    if (path.resolve(path.dirname(from.target)) === path.resolve(destDir.target)) {
      sendJson(res, 200, { name: path.basename(from.target) });
      req.resume();
      return;
    }
    const dest = uniquePath(destDir.target, path.basename(from.target));
    if (!inside(filesRoot, dest)) {
      sendJson(res, 400, { error: "bad path" });
      req.resume();
      return;
    }
    fs.renameSync(from.target, dest);
    sendJson(res, 200, { name: path.basename(dest) });
    req.resume();
    return;
  }

  if (url.pathname === "/api/delete" && req.method === "POST") {
    const item = resolveItem(url.searchParams.get("path"));
    if (!item || !item.rel || !inside(filesRoot, item.target) || path.resolve(item.target) === path.resolve(filesRoot) || isBuiltIn(item.rel)) {
      sendJson(res, isBuiltIn(item && item.rel) ? 403 : 400, { error: isBuiltIn(item && item.rel) ? "protected" : "bad path" });
      req.resume();
      return;
    }
    const permanent = url.searchParams.get("permanent") === "1" || inBin(item.rel);
    if (permanent) {
      if (fs.existsSync(item.target)) fs.rmSync(item.target, { recursive: true, force: true });
    } else {
      const bin = path.join(filesRoot, "Bin");
      fs.mkdirSync(bin, { recursive: true });
      const dest = uniquePath(bin, path.basename(item.target));
      fs.renameSync(item.target, dest);
    }
    sendJson(res, 200, { ok: true });
    req.resume();
    return;
  }

  if (url.pathname === "/api/bin/clear" && req.method === "POST") {
    const bin = path.join(filesRoot, "Bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.readdirSync(bin).forEach((name) => {
      if (!name || name.startsWith(".")) return;
      fs.rmSync(path.join(bin, name), { recursive: true, force: true });
    });
    sendJson(res, 200, { ok: true });
    req.resume();
    return;
  }

  if (url.pathname === "/api/restore" && req.method === "POST") {
    const item = resolveItem(url.searchParams.get("path"));
    if (!item || !item.rel || !inBin(item.rel) || item.rel.toLowerCase() === "bin" || !fs.existsSync(item.target)) {
      sendJson(res, 400, { error: "bad path" });
      req.resume();
      return;
    }
    const desk = path.join(filesRoot, "desktop");
    fs.mkdirSync(desk, { recursive: true });
    const dest = uniquePath(desk, path.basename(item.target));
    if (!inside(filesRoot, dest)) {
      sendJson(res, 400, { error: "bad path" });
      req.resume();
      return;
    }
    fs.renameSync(item.target, dest);
    sendJson(res, 200, { name: path.basename(dest) });
    req.resume();
    return;
  }

  if (url.pathname === "/api/browse" && req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "600",
    });
    res.end();
    return;
  }

  if (url.pathname === "/api/browse" && req.method === "GET" && url.searchParams.get("meta") === "1") {
    framePolicy(url.searchParams.get("url")).then((info) => {
      if (res.headersSent) return;
      res.writeHead(200, browseCors({ "Content-Type": "application/json; charset=utf-8" }));
      res.end(JSON.stringify(info));
    }).catch(() => {
      if (res.headersSent) return;
      res.writeHead(200, browseCors({ "Content-Type": "application/json; charset=utf-8" }));
      res.end(JSON.stringify({ frame: false, url: "" }));
    });
    return;
  }

  if (url.pathname === "/api/browse" && (req.method === "GET" || req.method === "POST")) {
    browse(req, res, url.searchParams.get("url")).catch((error) => {
      if (res.headersSent) return;
      const message = error && error.message === "large" ? "That page is too big to open here." : "Couldn't open that page.";
      res.writeHead(200, browseCors({ "Content-Type": "text/html; charset=utf-8", "X-Otter-Frame": "0" }));
      res.end(browsePage(message));
    });
    return;
  }

  if (url.pathname === "/api/install" && req.method === "POST") {
    const aliases = { calc: "calculator", note: "notes", cmd: "command", prompt: "command", search: "explorer", google: "explorer", internet: "explorer", game: "games", library: "games", libary: "games", scratch: "games" };
    const asked = String(url.searchParams.get("name") || "").trim().toLowerCase();
    const id = aliases[asked] || asked;
    const catalog = installCatalog();
    if (!id) {
      sendJson(res, 200, {
        apps: Object.entries(catalog).map(([key, spec]) => ({ id: key, title: spec.title, about: spec.about })),
      });
      req.resume();
      return;
    }
    const spec = catalog[id];
    if (!spec) {
      sendJson(res, 404, { error: "unknown" });
      req.resume();
      return;
    }
    const dir = path.join(filesRoot, "Apps");
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, spec.file);
    const already = fs.existsSync(dest);
    if (!already) fs.writeFileSync(dest, JSON.stringify(spec.body, null, 2));
    if (spec.note && !fs.existsSync(path.join(dir, "Notes.txt"))) fs.writeFileSync(path.join(dir, "Notes.txt"), "");
    sendJson(res, 200, { ok: true, already, title: spec.title });
    req.resume();
    return;
  }

  if (url.pathname === "/api/download") {
    const item = resolveItem(url.searchParams.get("path"));
    if (!item || !item.rel || !fs.existsSync(item.target)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const stat = fs.statSync(item.target);
    if (stat.isDirectory()) {
      const entries = [];
      collectZip(item.target, path.basename(item.target), entries, { used: 0 });
      const zip = zipFiles(entries);
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": attachmentName(path.basename(item.target) + ".zip"),
        "Content-Length": zip.length,
        "Cache-Control": "no-store",
      });
      res.end(zip);
      return;
    }
    const ext = path.extname(item.target).toLowerCase();
    res.writeHead(200, {
      "Content-Type": types[ext] || "application/octet-stream",
      "Content-Disposition": attachmentName(path.basename(item.target)),
      "Content-Length": stat.size,
      "Cache-Control": "no-store",
    });
    fs.createReadStream(item.target).pipe(res);
    return;
  }

  if (url.pathname === "/api/text" && req.method === "GET") {
    const item = resolveItem(url.searchParams.get("path"));
    if (!item || !item.rel || !fs.existsSync(item.target) || !fs.statSync(item.target).isFile() || !isTextFile(item.target)) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (fs.statSync(item.target).size > 2 * 1024 * 1024) {
      res.writeHead(413);
      res.end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(fs.readFileSync(item.target));
    return;
  }

  if (url.pathname === "/api/text" && req.method === "POST") {
    const item = resolveItem(url.searchParams.get("path"));
    if (!item || !item.rel || !fs.existsSync(item.target) || !fs.statSync(item.target).isFile() || !isTextFile(item.target)) {
      sendJson(res, 404, { error: "missing" });
      req.resume();
      return;
    }
    readBody(req, 2 * 1024 * 1024)
      .then((body) => {
        fs.writeFileSync(item.target, body);
        sendJson(res, 200, { ok: true });
      })
      .catch(() => {
        if (!res.headersSent) sendJson(res, 400, { error: "save failed" });
      });
    return;
  }

  if (url.pathname === "/api/wallpaper") {
    const wallpaper = wallpaperInfo();
    sendJson(res, 200, { url: wallpaper ? wallpaper.url : null });
    return;
  }

  if (url.pathname.startsWith("/media/")) {
    const rel = normalizeRel(decodeURIComponent(url.pathname.slice("/media/".length)));
    const file = rel === null ? null : path.resolve(filesRoot, ...rel.split("/").filter(Boolean));
    if (!file || !inside(filesRoot, file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": types[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    fs.createReadStream(file).pipe(res);
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    fs.createReadStream(path.join(root, "index.html")).pipe(res);
    return;
  }

  res.writeHead(404);
  res.end();
}

const server = http.createServer((req, res) => {
  try {
    handle(req, res);
  } catch (error) {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") process.exit(0);
  process.exit(1);
});

function installCatalog() {
  return {
    command: { file: "Command Prompt.app", title: "Command Prompt", about: "type # commands", body: { otterApp: "command" } },
    explorer: { file: "Internet Explorer.app", title: "Internet Explorer", about: "browse the web", body: { otterApp: "browser" } },
    calculator: { file: "Calculator.app", title: "Calculator", about: "add, subtract, multiply, divide", body: { otterApp: "calculator" } },
    timer: { file: "Timer.app", title: "Timer", about: "a countdown", body: { otterApp: "timer" } },
    notes: { file: "Notes.app", title: "Notes", about: "a notepad", note: true, body: { otterApp: "notes" } },
    files: { file: "Files.app", title: "Files", about: "your OtterOS files", body: { otterApp: "files" } },
    settings: { file: "Settings.app", title: "Settings", about: "look and feel", body: { otterApp: "settings" } },
    bin: { file: "Bin.app", title: "Bin", about: "opens the Bin", body: { otterApp: "bin" } },
    games: { file: "Game Library.app", title: "Game Library", about: "opens Scratch", body: { otterApp: "games", url: "https://scratch.mit.edu" } },
    stopwatch: { file: "Stopwatch.app", title: "Stopwatch", about: "laps and a running clock", body: { otterApp: "stopwatch" } },
    tasks: { file: "Tasks.app", title: "Tasks", about: "a list of jobs", body: { otterApp: "tasks" } },
    paint: { file: "Paint.app", title: "Paint", about: "draw and save a picture", body: { otterApp: "paint" } },
    converter: { file: "Converter.app", title: "Converter", about: "temperature, length, and weight", body: { otterApp: "converter" } },
    snake: { file: "Snake.app", title: "Snake", about: "eat the dots, don't hit the wall", body: { otterApp: "snake" } },
    mines: { file: "Mines.app", title: "Mines", about: "clear the field", body: { otterApp: "mines" } },
    memory: { file: "Memory.app", title: "Memory", about: "match the pairs", body: { otterApp: "memory" } },
    tiles: { file: "Tiles.app", title: "Tiles", about: "slide tiles together", body: { otterApp: "tiles" } },
    manager: { file: "Task Manager.app", title: "Task Manager", about: "see running apps and end them", body: { otterApp: "manager" } },
  };
}

function ensureApps() {
  const dir = path.join(filesRoot, "Apps");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(filesRoot, "Bin"), { recursive: true });
  fs.mkdirSync(path.join(filesRoot, "desktop"), { recursive: true });
  const oldGoogle = path.join(dir, "Google.app");
  if (fs.existsSync(oldGoogle)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(oldGoogle, "utf8"));
      if (parsed && (parsed.otterApp === "google" || parsed.otterApp === "Internet" || parsed.otterApp === "browser")) fs.rmSync(oldGoogle);
    } catch (error) {}
  }
}

ensureApps();
server.listen(port, "127.0.0.1");
