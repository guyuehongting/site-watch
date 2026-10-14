#!/usr/bin/env node
/**
 * site-watch — 盯学校的通知/公告页：抓取新条目 → 落库 → 推送到多个机器人
 *
 * 设计目标（对齐 hot-brief 的风格）：
 *   · 零第三方依赖，Node 18+ 自带 fetch / TextDecoder
 *   · 站点未知也能用：自动嗅探编码（GBK/UTF-8）、自动在列表页里挑"像是通知条目"的链接
 *   · 出问题能覆盖：每个源可写 regex（itemPattern / hrefInclude / hrefExclude / titleInclude）
 *   · 只推新的：state/seen.json 去重；落库 out/YYYY-MM-DD.md + out/items.jsonl
 *   · 推送多平台：dsh-im（一条 HTTP 覆盖九个渠道）/ QQ 开放平台 / 群机器人 webhook / Telegram / 自定义
 *
 * 用法：
 *   node site-watch.mjs                          # 抓取 + 落库，不推送
 *   node site-watch.mjs --plain                  # 输出一整段文本（适合直接回复）
 *   node site-watch.mjs --json                   # 结构化输出
 *   node site-watch.mjs --push                   # 抓取 + 落库 + 推送到所有已配置渠道
 *   node site-watch.mjs --push --test            # 只推前 2 条（验证链路）
 *   node site-watch.mjs --source=school          # 只跑某个源
 *   node site-watch.mjs --channels=dshim,qq      # 只推指定渠道
 *   node site-watch.mjs --all                    # 连"以前见过的"也一起输出（仍只推新的）
 *   node site-watch.mjs --list-channels          # 看配置了哪些渠道
 *
 * 退出码：0 正常；2 用法/配置错；3 推送失败；4 全部源抓取失败。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(HERE, "config.json");
const STATE_DIR = path.join(HERE, "state");
const OUT_DIR = path.join(HERE, "out");
const SEEN_PATH = path.join(STATE_DIR, "seen.json");
const JSONL_PATH = path.join(OUT_DIR, "items.jsonl");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 site-watch/1.0";

/* ------------------------------------------------------------------ 参数 */

function parseArgs(argv) {
  const flags = { _: [] };
  for (const a of argv) {
    if (!a.startsWith("--")) {
      flags._.push(a);
      continue;
    }
    const [k, v] = a.slice(2).split("=");
    flags[k] = v === undefined ? true : v;
  }
  return flags;
}

const args = parseArgs(process.argv.slice(2));
const wantPush = args.push === true || args.push === "true";
const pushTest = args.test === true;
const showAll = args.all === true;
const asJson = args.json === true;
const asPlain = args.plain === true;
const onlySource = typeof args.source === "string" ? args.source : undefined;
const onlyChannels =
  typeof args.channels === "string"
    ? args.channels.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
const limitOverride = args.limit !== undefined ? Number(args.limit) : undefined;
/* 批量相关：--probe 只探测不落库；--urls=a,b,c 临时试一串网址；--delay-ms 控制源之间的间隔 */
const probeOnly = args.probe === true || args.check === true;
const adhocUrls =
  typeof args.urls === "string"
    ? args.urls.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
const delayMs = args["delay-ms"] !== undefined ? Number(args["delay-ms"]) : 300;

/* ------------------------------------------------------------------ 工具 */

function loadEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

const secrets = {
  ...loadEnvFile(path.join(HERE, "secrets.env")),
  ...process.env,
};

function secretOf(key) {
  if (!key) return "";
  return secrets[key] !== undefined ? String(secrets[key]) : "";
}

/** 把已知密钥从任意文本里抠掉，避免写进日志。 */
function redact(text, ...values) {
  let s = String(text);
  for (const v of values) {
    if (v && v.length >= 8) s = s.split(v).join("***");
  }
  return s;
}

function ensureDirs() {
  for (const d of [STATE_DIR, OUT_DIR]) fs.mkdirSync(d, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function nowIso() {
  return new Date().toISOString();
}

function log(line) {
  process.stderr.write(`[site-watch] ${line}\n`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

/** URL → 自动短名（没写名字的批量源用），例如 https://jwc.abc.edu.cn/tzgg.htm → jwc-tzgg */
function autoName(url) {
  const slug = (s) => (s || "source").replace(/\.(html?|php|aspx?|jsp|asp)$/i, "").replace(/[^A-Za-z0-9._-]/g, "");
  if (!/^https?:\/\//i.test(url)) {
    // 本地路径（测试固件）：用文件名当名字
    return slug(path.basename(url).replace(/\.(html?|php)$/i, "")) || "source";
  }
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").filter(Boolean).pop() || "index";
    const host = u.hostname.replace(/^www\./, "").split(".")[0];
    return `${slug(host)}-${slug(seg)}`.slice(0, 40) || "source";
  } catch {
    return "source";
  }
}

/**
 * 汇总来源：config.json 的 sources + sources.txt（批量，一行一个网址）+ --urls=
 * sources.txt 每行：`网址` 或 `名字 | 网址`（也接受 Tab/空格分隔），# 开头是注释。
 * 同一 URL 只保留第一次出现的那条（config.json 优先）。
 */
function buildSourceList(config, configPath) {
  // --urls= 一旦给出就是"独立试这一串"：不要再和 config/sources.txt 混在一起，
  // 否则重复 URL 会在去重时把临时源挤掉（曾经的实际 bug）。
  if (adhocUrls.length) {
    const uniq = [...new Set(adhocUrls)];
    return uniq.map((url) => ({ name: autoName(url), url, adhoc: true }));
  }

  const list = [...(config.sources || [])];
  const seenUrls = new Set(list.map((s) => s.url));

  const file = config.sourcesFile
    ? path.resolve(path.dirname(configPath), config.sourcesFile)
    : undefined;
  if (file && fs.existsSync(file)) {
    for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      let name;
      let url = line;
      const m = line.match(/^(.+?)\s*[|\t]\s*(https?:\/\/\S+)$/);
      if (m) {
        name = m[1].trim();
        url = m[2].trim();
      }
      if (!/^https?:\/\//i.test(url) && !/^[./]/.test(url) && !/^[A-Za-z]:[\\/]/.test(url)) continue;
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      list.push({ name: name || autoName(url), url, fromListFile: true });
    }
  }

  for (const url of adhocUrls) {
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);
    list.push({ name: autoName(url), url, adhoc: true });
  }
  return list;
}

/** --probe：只探测每个源能识别出什么，不写 state/out，用来批量筛网址 */
async function runProbe(sources) {
  const rows = [];
  for (const s of sources) {
    const t0 = Date.now();
    try {
      const doc = await fetchDocument(s.url, s.timeoutMs);
      const items = collectItems(doc.html, s);
      rows.push({
        name: s.name,
        url: s.url,
        ok: true,
        charset: doc.charset,
        ms: Date.now() - t0,
        items,
      });
    } catch (err) {
      rows.push({ name: s.name, url: s.url, ok: false, error: redact(err.message), ms: Date.now() - t0, items: [] });
    }
    await sleep(delayMs);
  }

  process.stdout.write(`探测 ${rows.length} 个源（--probe，不落库、不推送）\n\n`);
  for (const r of rows) {
    if (!r.ok) {
      process.stdout.write(`❌ 失败   ${r.name}\n   ${r.url}\n   ${r.error}\n\n`);
      continue;
    }
    const mark = r.items.length === 0 ? "⚠ 0 条 " : r.items.length < 3 ? "⚠ 偏少" : "✅ 可用";
    process.stdout.write(
      `${mark}  ${r.name}   [${r.charset} ${r.ms}ms] 识别到 ${r.items.length} 条\n   ${r.url}\n`,
    );
    r.items.slice(0, 3).forEach((it, i) =>
      process.stdout.write(`     ${i + 1}. ${it.title.slice(0, 62)}\n        ${it.url.slice(0, 92)}\n`),
    );
    process.stdout.write("\n");
  }
  const good = rows.filter((r) => r.ok && r.items.length > 0).length;
  const zero = rows.filter((r) => r.ok && r.items.length === 0).length;
  const bad = rows.filter((r) => !r.ok).length;
  process.stdout.write(`汇总：可用 ${good} / 识别不到 ${zero} / 抓取失败 ${bad}\n`);
  if (zero || bad) {
    process.stdout.write(
      "建议：识别不到的源多半是 JS 渲染或非列表页 —— 把那条列表项的 HTML 片段发我写 itemPattern；抓取失败的多半是网址写错或站点暂时不通。\n",
    );
  }
  process.exit(bad === rows.length ? 4 : 0);
}

/* ------------------------------------------------------------------ 抓取 */

/** 从响应头或 HTML 前 2KB 里嗅探编码标签。 */
function sniffCharset(buf, contentType) {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType || "");
  if (fromHeader) return fromHeader[1].toLowerCase();
  const head = buf.subarray(0, 2048).toString("latin1");
  const fromMeta =
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(head) ||
    /<\?xml[^>]+encoding=["']([\w-]+)/i.exec(head);
  if (fromMeta) return fromMeta[1].toLowerCase();
  // 没有声明时：能按 UTF-8 解出替换字符就说明不是 UTF-8
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  return utf8.includes("\uFFFD") ? "gbk" : "utf-8";
}

function decodeBody(buf, contentType) {
  const label = sniffCharset(buf, contentType);
  const normalized = /^(gb2312|gbk|gb18030)$/.test(label) ? "gb18030" : label;
  try {
    return { html: new TextDecoder(normalized).decode(buf), charset: normalized };
  } catch {
    return { html: new TextDecoder("utf-8").decode(buf), charset: "utf-8(fallback)" };
  }
}

async function fetchDocument(url, timeoutMs = 20000) {
  // 非 http(s)：当本地文件读（调试存档页 / 仓库自带的测试固件）。
  // 相对路径按"脚本所在目录"解析，方便配置里写 "./test/fixture-utf8.html"。
  if (!/^https?:\/\//i.test(url)) {
    const p = url.startsWith("file://") ? fileURLToPath(url) : path.resolve(HERE, url);
    const buf = fs.readFileSync(p);
    const { html, charset } = decodeBody(buf, "");
    return { html, charset, status: 200, finalUrl: url };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const { html, charset } = decodeBody(buf, res.headers.get("content-type"));
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return { html, charset, status: res.status, finalUrl: res.url || url };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ 解析 */

function stripTags(s) {
  return String(s)
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 把 source.url 变成可作为 URL 基址的绝对形式。
 * ★必需：配置里写 "./test/x.html" 这类相对路径时，new URL(href, 相对路径) 会抛错，
 *   导致所有条目被静默丢弃（只改编码嗅探不改这里就会踩）。
 */
function resolveBase(url) {
  if (/^https?:\/\//i.test(url) || url.startsWith("file://")) return url;
  return pathToFileURL(path.resolve(HERE, url)).href;
}

function toAbsolute(href, base) {
  try {
    return new URL(href, base).href;
  } catch {
    return undefined;
  }
}

/** 自动模式：在整页 <a> 里挑"像通知条目"的。 */
function extractAuto(html, source) {
  const minTitle = source.minTitleLen ?? 8;
  const maxTitle = source.maxTitleLen ?? 90;
  const hrefInclude = source.hrefInclude ? new RegExp(source.hrefInclude, "i") : undefined;
  const hrefExclude = source.hrefExclude
    ? new RegExp(source.hrefExclude, "i")
    : /(javascript:|^#|mailto:|\.(jpg|jpeg|png|gif|zip|rar|doc|docx|xls|xlsx|pdf)$)/i;
  const titleInclude = source.titleInclude ? new RegExp(source.titleInclude) : undefined;

  const items = [];
  const seenTitle = new Set();
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1];
    const hrefMatch = /href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    if (!hrefMatch) continue;
    const href = hrefMatch[2] ?? hrefMatch[3] ?? hrefMatch[4] ?? "";
    if (!href) continue;
    if (hrefExclude && hrefExclude.test(href)) continue;
    if (hrefInclude && !hrefInclude.test(href)) continue;

    const title = stripTags(m[2]);
    if (title.length < minTitle || title.length > maxTitle) continue;
    if (titleInclude && !titleInclude.test(title)) continue;
    if (seenTitle.has(title)) continue;

    const url = toAbsolute(href, resolveBase(source.url));
    if (!url) continue;

    // 标题附近 120 字符内找日期（多数学校站点列表项带 2026-10-13 / 2026/10/13）
    const around = stripTags(html.slice(m.index, m.index + 400));
    const dm =
      /(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/.exec(around) ||
      /(\d{1,2})[-/](\d{1,2})\s/.exec(around);
    let date;
    if (dm) {
      date =
        dm.length === 4
          ? `${dm[1]}-${String(dm[2]).padStart(2, "0")}-${String(dm[3]).padStart(2, "0")}`
          : `${new Date().getFullYear()}-${String(dm[1]).padStart(2, "0")}-${String(dm[2]).padStart(2, "0")}`;
    }

    seenTitle.add(title);
    items.push({ title, url, date, source: source.name });
  }
  return items;
}

/** regex 模式：用 source.itemPattern 精确抓（分组名 url / title，或第 1/2 组）。 */
function extractRegex(html, source) {
  const re = new RegExp(source.itemPattern, "gi");
  const items = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(html)) !== null) {
    const g = m.groups || {};
    const url = g.url ?? m[1];
    const title = stripTags(g.title ?? m[2] ?? "");
    if (!url || !title) continue;
    // 重叠匹配保护
    if (m[0].length === 0) re.lastIndex += 1;
    const abs = toAbsolute(url, resolveBase(source.url));
    if (!abs || seen.has(abs)) continue;
    if (source.titleInclude && !new RegExp(source.titleInclude).test(title)) continue;
    seen.add(abs);
    items.push({ title, url: abs, date: g.date ?? undefined, source: source.name });
  }
  return items;
}

function collectItems(html, source) {
  const items = source.itemPattern
    ? extractRegex(html, source)
    : extractAuto(html, source);
  const max = limitOverride ?? source.maxItems ?? 20;
  return items.slice(0, Math.max(1, max));
}

/* ------------------------------------------------------------------ 存储 */

function loadSeen() {
  return readJson(SEEN_PATH, {});
}

function saveSeen(seen, keep = 5000) {
  const keys = Object.keys(seen);
  if (keys.length > keep) {
    keys
      .sort((a, b) => String(seen[a]).localeCompare(String(seen[b])))
      .slice(0, keys.length - keep)
      .forEach((k) => delete seen[k]);
  }
  writeJson(SEEN_PATH, seen);
}

function archive(items, meta) {
  if (items.length === 0) return;
  const file = path.join(OUT_DIR, `${today()}.md`);
  const lines = [`## ${meta.title}（${meta.time}）`, ""];
  items.forEach((it, i) => {
    lines.push(`${i + 1}. ${it.title}${it.date ? `（${it.date}）` : ""}`);
    lines.push(`   ${it.url}`);
  });
  lines.push("");
  const header = fs.existsSync(file) ? "" : `# 站点监控 ${today()}\n\n`;
  fs.appendFileSync(file, header + lines.join("\n"), "utf8");
  fs.appendFileSync(
    JSONL_PATH,
    items.map((it) => JSON.stringify({ ...it, at: nowIso() })).join("\n") + "\n",
    "utf8",
  );
}

/* ------------------------------------------------------------------ 推送 */

function chunkText(text, maxChars) {
  const blocks = text.split("\n");
  const chunks = [];
  let cur = [];
  let len = 0;
  for (const b of blocks) {
    if (len + b.length + 1 > maxChars && cur.length) {
      chunks.push(cur.join("\n"));
      cur = [];
      len = 0;
    }
    cur.push(b);
    len += b.length + 1;
  }
  if (cur.length) chunks.push(cur.join("\n"));
  return chunks.length ? chunks : [text];
}

async function postJson(url, body, headers = {}, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    const text = (await res.text()).slice(0, 400);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/* --- ① dsh-im：一条接口覆盖九个渠道（微信/飞书/钉钉/企微/QQ/Slack/Telegram/Discord/WhatsApp） --- */
async function sendDshIm(ch, text) {
  const base = ch.baseUrl || secretOf("DSH_IM_BASE") || "http://127.0.0.1:3080";
  const url = `${base.replace(/\/$/, "")}/api/dsh-im/delivery/messages`;
  const out = await postJson(url, {
    botId: ch.botId || secretOf(ch.botIdEnv || ""),
    targetId: ch.targetId,
    text,
  });
  if (!/"sent"\s*:\s*true/.test(out)) throw new Error(`返回未确认发送: ${out}`);
  return out;
}

/* --- ② QQ 开放平台（自带一条链路，不依赖 dsh-im 是否在跑） --- */
const qqTokenCache = { token: "", expiresAt: 0 };
async function qqAccessToken(appId, secret) {
  if (qqTokenCache.token && qqTokenCache.expiresAt > Date.now() + 5 * 60 * 1000) {
    return qqTokenCache.token;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch("https://bots.qq.com/app/getAppAccessToken", {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: String(appId), clientSecret: secret }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`取 token HTTP ${res.status}：${redact(text, secret).slice(0, 120)}`);
    const body = JSON.parse(text);
    if (!body.access_token) {
      throw new Error(`取 token 失败：${redact(text, secret).slice(0, 160)}`);
    }
    qqTokenCache.token = body.access_token;
    qqTokenCache.expiresAt = Date.now() + (Number(body.expires_in ?? 7200) - 60) * 1000;
    return qqTokenCache.token;
  } finally {
    clearTimeout(timer);
  }
}

async function sendQQ(ch, text) {
  const appId = ch.appId || secretOf(ch.appIdEnv || "");
  const secret = ch.secret || secretOf(ch.secretEnv || "QQ_APP_SECRET");
  if (!appId || !secret) throw new Error("缺 AppID 或 AppSecret");
  const token = await qqAccessToken(appId, secret);
  const base = "https://api.sgroup.qq.com";
  const target = ch.target || {};
  const url =
    target.kind === "group"
      ? `${base}/v2/groups/${encodeURIComponent(target.groupOpenId)}/messages`
      : `${base}/v2/users/${encodeURIComponent(target.userOpenId)}/messages`;
  return postJson(
    url,
    { content: text, msg_type: 0, msg_seq: (ch._seq = (ch._seq || 0) + 1) },
    { Authorization: `QQBot ${token}` },
  );
}

/* --- ③ 群机器人 webhook（飞书/钉钉/企微/Slack/Discord）与 Telegram/自定义 --- */
function webhookBody(format, text, ch) {
  switch (format) {
    case "feishu":
      return { msg_type: "text", content: { text } };
    case "dingtalk":
      return { msgtype: "text", text: { content: text } };
    case "wecom":
      return { msgtype: "text", text: { content: text } };
    case "slack":
      return { text };
    case "discord":
      return { content: text };
    default:
      return ch.bodyTemplate
        ? JSON.parse(String(ch.bodyTemplate).replaceAll("{{text}}", JSON.stringify(text).slice(1, -1)))
        : { text };
  }
}

async function sendWebhook(ch, text) {
  const url = ch.url || secretOf(ch.urlEnv || "");
  if (!url) throw new Error("缺 webhook url");
  return postJson(url, webhookBody(ch.format || "raw", text, ch));
}

async function sendTelegram(ch, text) {
  const token = ch.token || secretOf(ch.tokenEnv || "TELEGRAM_BOT_TOKEN");
  const chatId = ch.chatId || secretOf(ch.chatIdEnv || "");
  if (!token || !chatId) throw new Error("缺 bot token 或 chatId");
  return postJson(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  });
}

async function pushToChannel(ch, text) {
  switch (ch.type) {
    case "dshim":
      return sendDshIm(ch, text);
    case "qq":
      return sendQQ(ch, text);
    case "webhook":
      return sendWebhook(ch, text);
    case "telegram":
      return sendTelegram(ch, text);
    default:
      throw new Error(`未知渠道类型 ${ch.type}`);
  }
}

function channelLabel(ch) {
  if (ch.type === "dshim") return `dshim(${ch.name || ch.targetId})`;
  if (ch.type === "qq") return `qq(${ch.name || ch.target?.kind || "user"})`;
  if (ch.type === "webhook") return `webhook(${ch.name || ch.format})`;
  if (ch.type === "telegram") return `telegram(${ch.name || ch.chatId})`;
  return ch.type;
}

/* ------------------------------------------------------------------ 主流程 */

function renderPlain(groups, allCount) {
  const lines = [`📌 站点新通知 ${today()}（共 ${allCount} 条）`];
  for (const g of groups) {
    if (g.items.length === 0) continue;
    lines.push("", `【${g.source}】`);
    g.items.forEach((it, i) => {
      lines.push(`${i + 1}. ${it.title}${it.date ? `（${it.date}）` : ""}`);
      lines.push(`   ${it.url}`);
    });
  }
  return lines.join("\n");
}

async function main() {
  ensureDirs();
  const configPath =
    typeof args.config === "string" ? path.resolve(args.config) : CONFIG_PATH;
  const config = readJson(configPath, undefined);
  if (!config) {
    log(`读不到配置：${configPath}`);
    process.exit(2);
  }
  // 来源 = config.json 的 sources + sources.txt（批量）+ --urls=
  const allSources = buildSourceList(config, configPath);
  if (allSources.length === 0) {
    log("没有任何来源：config.json 的 sources 为空，也没有可读的 sources.txt / --urls=");
    process.exit(2);
  }
  // --urls= 给了就只跑这几个（"试试这串"）；否则 --source 点名 > --probe 全看 > 默认只跑启用的
  const sources = allSources.filter((s) => {
    if (adhocUrls.length) return s.adhoc === true;
    if (onlySource) return s.name === onlySource;
    if (probeOnly) return true;
    return s.enabled !== false;
  });
  if (sources.length === 0) {
    log(onlySource ? `没有名为 ${onlySource} 的源` : "没有启用的源");
    process.exit(2);
  }
  if (probeOnly) {
    await runProbe(sources);
    return;
  }

  const channels = (config.channels || [])
    .filter((c) => c.enabled !== false)
    .filter((c) => !onlyChannels || onlyChannels.includes(c.name || c.type));
  if (args["list-channels"]) {
    if (channels.length === 0) log("没有配置渠道");
    channels.forEach((c) => log(`渠道 ${channelLabel(c)}`));
    process.exit(0);
  }

  const seen = loadSeen();
  const results = [];
  const fresh = [];
  let failed = 0;
  let total = 0;

  for (const source of sources) {
    const started = nowIso();
    try {
      const doc = await fetchDocument(source.url, source.timeoutMs);
      const items = collectItems(doc.html, source).map((it) => ({
        ...it,
        key: `${source.name}|${it.url}`,
      }));
      total += items.length;
      const newItems = items.filter((it) => !seen[it.key]);
      for (const it of newItems) seen[it.key] = nowIso();
      fresh.push(...newItems);
      results.push({
        source: source.name,
        url: source.finalUrl || source.url,
        charset: doc.charset,
        found: items.length,
        fresh: newItems.length,
        items: showAll ? items : newItems,
        newItems,
        ok: true,
      });
      log(`${source.name}: 抓到 ${items.length} 条，其中新的 ${newItems.length} 条（编码 ${doc.charset}）`);
    } catch (err) {
      failed += 1;
      results.push({
        source: source.name,
        url: source.url,
        ok: false,
        error: redact(err.message),
        items: [],
        newItems: [],
      });
      log(`${source.name}: 抓取失败 — ${redact(err.message)}`);
    }
    results[results.length - 1].startedAt = started;
    await sleep(delayMs); // 源之间留间隔：几十个源时别把对方站点打疼
  }

  saveSeen(seen);

  // 落库：只存"新条目"，避免重复膨胀
  for (const r of results) {
    if (r.newItems.length) {
      archive(r.newItems, { title: r.source, time: nowIso().slice(11, 16) });
    }
  }

  if (asJson) {
    process.stdout.write(
      JSON.stringify(
        { date: today(), sources: results, freshTotal: fresh.length, total },
        null,
        2,
      ) + "\n",
    );
  } else {
    const groups = results.map((r) => ({ source: r.source, items: r.items }));
    const text = renderPlain(groups, fresh.length);
    process.stdout.write(text + "\n");
  }

  if (!wantPush) return;

  if (channels.length === 0) {
    log("--push 给了，但没说配置任何渠道（config.json 的 channels）");
    process.exit(2);
  }
  if (fresh.length === 0) {
    log("没有新条目，跳过推送");
    return;
  }

  const pushItems = pushTest ? fresh.slice(0, 2) : fresh;
  const body = renderPlain(
    [{ source: pushTest ? "链路测试（只发前 2 条）" : "新通知", items: pushItems }],
    pushItems.length,
  );
  const maxChars = config.options?.maxChunkChars ?? 1800;
  const chunks = chunkText(body, maxChars);

  let pushFailed = 0;
  for (const ch of channels) {
    const label = channelLabel(ch);
    try {
      for (let i = 0; i < chunks.length; i += 1) {
        const suffix = chunks.length > 1 ? `\n（${i + 1}/${chunks.length}）` : "";
        await pushToChannel(ch, chunks[i] + suffix);
      }
      log(`推送成功 → ${label}（${chunks.length} 条消息）`);
    } catch (err) {
      pushFailed += 1;
      log(`推送失败 → ${label}：${redact(err.message)}`);
    }
  }

  if (pushFailed === channels.length) process.exit(3);
  if (failed === sources.length) process.exit(4);
}

main().catch((err) => {
  log(`未预期错误：${redact(err.stack || err.message)}`);
  process.exit(1);
});
