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
const detailEnabled = args["no-detail"] !== true;

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

/** 深合并：对象递归合并；数组与标量由 override 直接替换 */
function deepMerge(base, override) {
  if (override === undefined) return base;
  const bothObjects =
    base && override && typeof base === "object" && typeof override === "object" &&
    !Array.isArray(base) && !Array.isArray(override);
  if (!bothObjects) return override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

/**
 * 读配置；若同目录存在 <名字>.local.json 就叠加上去。
 * 例：config.json → config.local.json（本地私有覆盖，写进 .gitignore，不进仓库）
 */
function loadConfig(configPath) {
  const base = readJson(configPath, undefined);
  if (!base) return { config: undefined };
  const ext = path.extname(configPath);
  const localPath = `${configPath.slice(0, configPath.length - ext.length)}.local${ext}`;
  const local = readJson(localPath, undefined);
  if (!local) return { config: base };
  return { config: deepMerge(base, local), localPath };
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
function extractAutoOnce(html, source, useHrefInclude) {
  const minTitle = source.minTitleLen ?? 8;
  const maxTitle = source.maxTitleLen ?? 90;
  const hrefInclude =
    useHrefInclude && source.hrefInclude ? new RegExp(source.hrefInclude, "i") : undefined;
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

    let title = stripTags(m[2]);
    // 有些列表把日期/序号拼进了链接文本（如 "052026-06 【通知公告】…"），去掉这种前导噪声
    title = title.replace(/^\d{1,2}\s*20\d{2}[-/.]\d{1,2}([-/.]\d{1,2})?\s*/, "").trim();
    if (title.length < minTitle || title.length > maxTitle) continue;
    if (titleInclude && !titleInclude.test(title)) continue;
    if (seenTitle.has(title)) continue;

    const url = toAbsolute(href, resolveBase(source.url));
    if (!url) continue;

    // 日期：★必须往前也看——实测 cxcyxy 的 <span class="sspan">2026-05-26</span> 在 <a> **之前**；
    //        jxgc 更是拆开写：<span>11</span><br>2026-06（日在前、年-月在后）
    const around = stripTags(html.slice(Math.max(0, m.index - 250), m.index + 400));
    let date;
    const full = /(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/.exec(around); // 年-月-日
    const dSplit = /(\d{1,2})\D{0,24}(20\d{2})[-/.年](\d{1,2})/.exec(around); // 日 … 年-月
    const md = /(\d{1,2})[-/](\d{1,2})\s/.exec(around); // 月-日（无年份）
    let y;
    let mo;
    let dd;
    if (full) {
      [, y, mo, dd] = full.map(Number);
    } else if (dSplit) {
      const m1 = dSplit.map(Number);
      dd = m1[1];
      y = m1[2];
      mo = m1[3];
    } else if (md) {
      const m2 = md.map(Number);
      y = new Date().getFullYear();
      mo = m2[1];
      dd = m2[2];
    }
    // ★校验：实测抓到过 2026-26-06 这种非法日期（页面里别的数字被误配），宁可不出日期也不出错日期
    if (y && mo >= 1 && mo <= 12 && dd >= 1 && dd <= 31) {
      date = `${y}-${String(mo).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    }

    seenTitle.add(title);
    items.push({ title, url, date, source: source.name });
  }
  return items;
}

/**
 * hrefInclude 是"提纯"手段，但有些站点的真通知并不在指定路径下（实测：教务处通知公告、
 * 校团委创新创业）。所以先按 hrefInclude 抽一遍，**抽不到就退回不过滤**并告警，
 * 避免一条规则把整个源打死。
 */
function extractAuto(html, source) {
  if (!source.hrefInclude) return extractAutoOnce(html, source, false);
  const strict = extractAutoOnce(html, source, true);
  if (strict.length > 0) return strict;
  const loose = extractAutoOnce(html, source, false);
  if (loose.length > 0) {
    log(`  ↳ ${source.name}: hrefInclude=${source.hrefInclude} 一条都没匹配上，已退回不过滤（共 ${loose.length} 条）`);
  }
  return loose;
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

/** 关键词规格 → 正则：数组按"任一命中"转义拼接，字符串直接当正则 */
function matcherFrom(spec) {
  if (!spec) return undefined;
  if (Array.isArray(spec)) {
    const parts = spec.filter(Boolean).map((s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return parts.length ? new RegExp(parts.join("|"), "i") : undefined;
  }
  return new RegExp(String(spec), "i");
}

function collectItems(html, source) {
  const items = source.itemPattern
    ? extractRegex(html, source)
    : extractAuto(html, source);
  // 关键词过滤（在两种抽取模式之后统一做）：include 任一命中才留，exclude 命中就丢
  const inc = matcherFrom(source.includeKeywords || source.includePattern);
  const exc = matcherFrom(source.excludeKeywords || source.excludePattern);
  let out = items;
  if (inc) out = out.filter((it) => inc.test(it.title));
  if (exc) out = out.filter((it) => !exc.test(it.title));
  // 只保留带日期的条目：通知公告类栏目里混着的导航项（学院名/办公室名）通常没有日期
  if (source.requireDate) out = out.filter((it) => it.date);
  // 时效窗口：首次接入时别把几年前的旧闻当"新通知"推出去
  if (source.maxAgeDays) {
    const cutoff = Date.now() - Number(source.maxAgeDays) * 86400000;
    out = out.filter((it) => !it.date || Date.parse(`${it.date}T00:00:00`) >= cutoff);
  }
  const max = limitOverride ?? source.maxItems ?? 20;
  return out.slice(0, Math.max(1, max));
}

/* ---- 详情页：正文摘要 + 附件（学校通知的价值常在附件里）---- */

/**
 * 从详情页里抠正文摘要。
 * ★实测教训：学校 CMS 的 class="content/news/main" 经常套的是**导航菜单**，
 *   直接按容器抓会得到"首页 机构设置 部门介绍…"；标题精确 indexOf 又常因标题被
 *   标签拆开/空格差异而失败，退化成整页文本还是导航。
 *   所以：① 先整块删掉 ul/ol/nav/header/footer/select（菜单几乎都在这里）
 *        ② 用标题前缀做模糊锚定（整串 → 24 → 16 → 10 字）
 *        ③ 兜底锚在"发布时间/来源/日期"这类标记之后
 *        ④ 截到"上一条/分享到/版权所有"这类尾部标记之前
 */
/**
 * ★实测踩过的坑：很多学校 CMS（ASP.NET/织梦系）用一个 <form> 或一个大 <ul> **包住整个文档**，
 *   所以清理必须分开做：
 *     · script/style：可以无限剥（内联脚本可能很长）
 *     · nav/header/footer/select/ul/ol：**限量剥**（只剥 3000 字符以内的块 = 菜单），
 *       避免把"包住全页的大 ul/form"一起吞掉（曾导致整页文本只剩 141 字，摘要全空）
 *     · form：不剥（它经常就是全页容器）
 */
const STRIP_SCRIPT = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;
const STRIP_MENU = /<(nav|header|footer|select|ul|ol)\b[^>]*>[\s\S]{0,3000}?<\/\1>/gi;

/** 去掉所有空白，同时保留"压缩串下标 → 原串下标"的映射（标题被标签/空格拆开也能对上） */
function compactWithMap(s) {
  const chars = [];
  const map = [];
  for (let i = 0; i < s.length; i += 1) {
    if (!/[\s\u00a0]/.test(s[i])) {
      chars.push(s[i]);
      map.push(i);
    }
  }
  return { str: chars.join(""), map };
}

function extractSummary(html, title, maxChars) {
  const text = stripTags(
    String(html).replace(STRIP_SCRIPT, " ").replace(STRIP_MENU, " "),
  )
    .replace(/&nbsp;|\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // 典型导航/侧栏词：用来给候选正文打分（越少越像正文）
  const NAV_WORDS = [
    "首页", "部门介绍", "岗位职责", "管理机构", "设为首页", "收藏本站", "院系网站",
    "版权所有", "友情链接", "联系我们", "党群工作", "师资队伍", "教学工作", "学生工作",
    "资料下载", "办事流程", "信息库", "当前位置", "打印本页", "微信扫描", "学校主页", "网站首页",
  ];
  const navHits = (s) => NAV_WORDS.filter((w) => s.slice(0, 140).includes(w)).length;

  const TAILS = ["上一条", "下一条", "上一篇", "下一篇", "分享到", "分享：", "关闭窗口", "版权所有", "相关附件", "附件下载", "友情链接", "对外交流", "人才招聘"];
  // 开头常见的"标题尾巴 + 发布元信息"：反复剥，直到剩下的像正文
  const LEAD = [
    /^[\s:：、,，\-|>»]+/,
    /^\[[^\]]{1,14}\]\s*/,
    /^(发布时间|发布日期|信息来源|信息源|来源|点击量|浏览次数|浏览人次|点击|查看|作者|时间|日期|编辑|审核|供稿|一审|二审|三审)[\s:：]*/,
    // 审稿人名单形态："李新琼 二审 胡庆 三审 李敏 职称 学历 学院" —— 名字夹在标签之间
    /^[\u4e00-\u9fa5]{2,4}\s*(一审|二审|三审)\s*/,
    /^(姓名|职称|学历|学院|部门|单位|次|人次)\s*/,
    /^20\d{2}\s*[-/.年]\s*\d{1,2}\s*([-/月.]\s*\d{1,2}\s*日?)?/,
    /^\d{1,2}\s*[-/月.]\s*\d{1,2}\s*日?/,
  ];
  const clean = (s) => {
    let b = s;
    // 开头若是"列表标题的尾巴"（列表标题与页内 <h1> 被标签拆开时的常见现象），先切掉
    // ★上限要够大：实测有 30+ 字的标题尾巴（如"5年度国家级、省级大学生创业训练项目…的通知"），
    //   上限设 24 会切不掉，于是摘要前面挂着一截标题。
    const ctitle = compact(title);
    if (ctitle && b) {
      const { str: cb, map: bmap } = compactWithMap(b);
      for (let n = Math.min(60, cb.length); n >= 3; n -= 1) {
        if (ctitle.endsWith(cb.slice(0, n))) {
          const at = bmap[n - 1];
          if (at !== undefined) b = b.slice(at + 1);
          break;
        }
      }
    }
    for (let guard = 0, changed = true; changed && guard < 14; guard += 1) {
      changed = false;
      for (const re of LEAD) {
        const m = re.exec(b);
        if (m && m[0]) {
          b = b.slice(m[0].length);
          changed = true;
          break;
        }
      }
    }
    let end = b.length;
    for (const m of TAILS) {
      const i = b.indexOf(m);
      if (i >= 20 && i < end) end = i;
    }
    return b.slice(0, end).replace(/\s+/g, " ").trim();
  };

  // ① 收集候选起点：标题（或其前缀）在页面里的**所有**出现位置
  //   ★两个坑都踩过：只取第一次会落在导航/相关阅读上；用"去空白标题"比对"带空格正文"会漏掉真正的标题。
  //   所以：整页压成无空白串 + 位置映射，所有出现位置都收进来，逐个生成候选再挑。
  const compact = (s) => String(s || "").replace(/[\s\u00a0]+/g, "");
  const t = compact(title);
  const { str: ctext, map } = compactWithMap(text);
  const starts = [];
  const seenStart = new Set();
  if (t) {
    for (const n of [t.length, 28, 20, 14, 10]) {
      const frag = t.slice(0, n);
      if (frag.length < 8) continue;
      let i = ctext.indexOf(frag);
      while (i >= 0 && starts.length < 20) {
        const at = map[i + frag.length - 1];
        if (at !== undefined) {
          const s0 = at + 1;
          if (!seenStart.has(s0)) {
            seenStart.add(s0);
            starts.push(s0);
          }
        }
        i = ctext.indexOf(frag, i + 1);
      }
    }
  }
  // ② 兜底起点：最后一个"发布/来源"类标记之后
  const MARKS = ["发布时间", "发布日期", "发布者", "供稿", "来源：", "来源:", "审核：", "编辑：", "点击：", "日期："];
  let mi = -1;
  for (const m of MARKS) {
    const i = text.lastIndexOf(m);
    if (i > mi) mi = i;
  }
  if (mi >= 0) starts.push(mi);
  if (starts.length === 0) return "";

  // ③ 每个候选清洗后打分：导航词少者优，其次长者为优
  const cands = starts.map((s) => clean(text.slice(s))).filter((b) => b.length >= 10);
  if (args["summary-debug"] === true) {
    process.stderr.write(
      `[summary] 文本=${text.length} 压缩=${ctext.length} 标题命中位置=${starts.length} 候选=${cands.length}\n`,
    );
    cands.slice(0, 5).forEach((c, i) =>
      process.stderr.write(`  cand${i} nav=${navHits(c)} len=${c.length} :: ${c.slice(0, 70)}\n`),
    );
  }
  if (cands.length === 0) return "";
  cands.sort((a, b) => navHits(a) - navHits(b) || b.length - a.length);
  const best = cands[0];
  // ④ 最好的候选仍然是导航（≥2 个导航词）→ 留空，不发垃圾
  if (navHits(best) >= 2) return "";
  return best.slice(0, maxChars);
}

async function fetchDetail(item, source, cfg) {
  const timeout = cfg.timeoutMs ?? 8000;
  const maxChars = cfg.maxChars ?? 220;
  try {
    const doc = await fetchDocument(item.url, timeout);
    const summary = extractSummary(doc.html, item.title, maxChars);

    const attachments = [];
    const re = /<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
    let a;
    while ((a = re.exec(doc.html)) !== null) {
      const href = a[2] ?? a[3] ?? a[4] ?? "";
      const text = stripTags(a[5]);
      const isFile = /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z)(\?|#|$)/i.test(href);
      const filePath = /(upload|attach|ueditor|file|download|_upload)/i.test(href);
      // 只认"附件N/报名表/申报书…"这类**并且链接像文件**的，避免把"资料下载""下载中心"当成附件
      const isAttach =
        /附件\s*[【\d一二三四五六七八九十：:、.]/.test(text) ||
        /报名表|申报书|承诺书|汇总表|登记表|报名汇总/.test(text);
      if (!isFile && !(isAttach && filePath)) continue;
      const abs = toAbsolute(href, doc.finalUrl || item.url);
      if (!abs || attachments.some((x) => x.url === abs)) continue;
      attachments.push({ name: (text || abs.split("/").pop()).slice(0, 40), url: abs });
      if (attachments.length >= (cfg.maxAttachments ?? 5)) break;
    }
    return { summary, attachments, charset: doc.charset };
  } catch (err) {
    return { summary: "", attachments: [], error: redact(err.message) };
  }
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

/** 按时间倒序（新的在前）；没有日期的排最后 */
function sortByTime(items) {
  return [...items].sort((a, b) => {
    if (a.date && b.date) return a.date === b.date ? 0 : a.date < b.date ? 1 : -1;
    if (a.date) return -1;
    if (b.date) return 1;
    return 0;
  });
}

/** 时间倒序的扁平清单（每条带完整原网址）——默认输出与推送格式 */
function renderTimeline(items, title) {
  const list = sortByTime(items);
  const lines = [`📌 ${title || "站点新通知"} ${today()}（共 ${list.length} 条，按时间倒序）`];
  for (const it of list) {
    lines.push("");
    lines.push(`${it.date || "日期未知"}  【${it.source}】`);
    lines.push(it.title);
    lines.push(it.url);
    if (it.summary) lines.push(`摘要：${it.summary}`);
    for (const a of it.attachments || []) lines.push(`📎 ${a.name}\n${a.url}`);
  }
  return lines.join("\n");
}

/** 归档：时间倒序写进 out/YYYY-MM-DD.md，并追加 out/items.jsonl */
function archiveTimeline(items, meta = {}) {
  if (items.length === 0) return;
  const list = sortByTime(items);
  const file = path.join(OUT_DIR, `${today()}.md`);
  const lines = [`## ${meta.title || "新通知"}（${meta.time || nowIso().slice(11, 16)}）`, ""];
  for (const it of list) {
    lines.push(`- **${it.date || "日期未知"}**  [${it.source}] ${it.title}`);
    lines.push(`  ${it.url}`);
    if (it.summary) lines.push(`  > ${it.summary}`);
    for (const a of it.attachments || []) lines.push(`  - 📎 ${a.name}：${a.url}`);
  }
  lines.push("");
  const header = fs.existsSync(file) ? "" : `# 站点监控 ${today()}\n\n`;
  fs.appendFileSync(file, header + lines.join("\n"), "utf8");
  fs.appendFileSync(
    JSONL_PATH,
    list.map((it) => JSON.stringify({ ...it, at: nowIso() })).join("\n") + "\n",
    "utf8",
  );
}

/** 按源分组的旧格式（--sort=source 时用） */
function archive(items, meta) {
  if (items.length === 0) return;
  const file = path.join(OUT_DIR, `${today()}.md`);
  const lines = [`## ${meta.title}（${meta.time}）`, ""];
  items.forEach((it, i) => {
    lines.push(`${i + 1}. ${it.title}${it.date ? `（${it.date}）` : ""}`);
    lines.push(`   ${it.url}`);
    if (it.summary) lines.push(`   摘要：${it.summary}`);
    (it.attachments || []).forEach((a) => lines.push(`   📎 ${a.name} → ${a.url}`));
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
// ★实测坑：桌面端每次启动动态分配 web 端口（profile 里的 `ctx.webStartup.port ?? 3080`），
//   而且**不落到任何配置文件**里，所以 baseUrl 不能硬编码——写死 3080 在桌面端环境下推不出去。
//   这里先按配置/env 试，再扫一小段常见端口，用"契约签名"确认是不是 dsh-im：
//   空 body 会被它判成 bad-request（而不是 404/HTML/401），这就是指纹。
const DSHIM_PROBE_BASES = ["http://127.0.0.1:3080"];
for (let p = 43120; p <= 43140; p += 1) DSHIM_PROBE_BASES.push(`http://127.0.0.1:${p}`);
let dshimBaseCache = "";

async function probeDshIm(base, timeoutMs = 1200) {
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/api/dsh-im/delivery/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const txt = await res.text();
    return /Invalid delivery request|unknown-bot/.test(txt);
  } catch {
    return false;
  }
}

async function resolveDshImBase(ch) {
  if (dshimBaseCache) return dshimBaseCache;
  const preferred = [ch.baseUrl, secretOf("DSH_IM_BASE")].filter(Boolean);
  for (const base of preferred) {
    if (await probeDshIm(base)) {
      dshimBaseCache = base;
      return base;
    }
  }
  for (const base of DSHIM_PROBE_BASES) {
    if (preferred.includes(base)) continue;
    if (await probeDshIm(base)) {
      log(`  ↳ dsh-im 端口自动发现：${base}（配置里的 ${preferred[0] || "默认 3080"} 没响应）`);
      dshimBaseCache = base;
      return base;
    }
  }
  throw new Error(
    `找不到 dsh-im 投递服务（试过 ${preferred.length + DSHIM_PROBE_BASES.length} 个地址）。` +
      `用 DSH_IM_BASE 环境变量或 channels[].baseUrl 指定，地址在 DSH Desktop 的界面 URL 里能看到。`,
  );
}

async function sendDshIm(ch, text) {
  const base = await resolveDshImBase(ch);
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
      if (it.summary) lines.push(`   ${it.summary}`);
      (it.attachments || []).forEach((a) => lines.push(`   📎 ${a.name}\n      ${a.url}`));
    });
  }
  return lines.join("\n");
}

async function main() {
  ensureDirs();
  const configPath =
    typeof args.config === "string" ? path.resolve(args.config) : CONFIG_PATH;
  const { config, localPath } = loadConfig(configPath);
  if (!config) {
    log(`读不到配置：${configPath}`);
    process.exit(2);
  }
  if (localPath) log(`已叠加本地私有覆盖：${path.basename(localPath)}`);
  // 来源 = config.json 的 sources + sources.txt（批量）+ --urls=
  // config.defaults 对每个源生效（如 includeKeywords / detail / delay）；
  // config.sourceOverrides["源名"] 再按源覆盖（写成 null 可关掉某项，例如本来就全是竞赛的栏目）；
  // 最后源自身的字段优先。
  const allSources = buildSourceList(config, configPath).map((s) => ({
    ...(config.defaults || {}),
    ...((config.sourceOverrides || {})[s.name] || {}),
    ...s,
  }));
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

  // --summary=<url>：直接在某个真实文章页上验证「正文摘要 + 附件」抽取（调试用）
  if (typeof args.summary === "string") {
    const url = args.summary;
    const cfg = { ...(config.detail || {}), maxChars: Number(args["max-chars"] || 400) };
    const d = await fetchDetail({ url, title: args.title || "" }, { name: "summary" }, cfg);
    process.stdout.write(`URL   : ${url}\n摘要  : ${d.summary || "(空)"}\n附件  : ${(d.attachments || []).map((a) => a.name).join(" | ") || "(无)"}\n`);
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
  const globalUrlSeen = new Set(); // 跨源去重：同一通知常同时出现在父栏目和子栏目里
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
      const newItemsRaw = items.filter((it) => !seen[it.key]);
      for (const it of newItemsRaw) seen[it.key] = nowIso();
      // ★跨源去重：同一条通知被两个栏目同时抓到（实测教务处两个栏目完全重合）只推一次
      const newItems = [];
      let dupSkipped = 0;
      for (const it of newItemsRaw) {
        if (globalUrlSeen.has(it.url)) {
          dupSkipped += 1;
          continue;
        }
        globalUrlSeen.add(it.url);
        newItems.push(it);
      }

      // 详情页：给新条目补正文摘要与附件（只对 http(s)，有预算上限，失败不影响主流程）
      const detailCfg = { ...(config.detail || {}), ...(source.detail || {}) };
      let detailCount = 0;
      if (detailEnabled && detailCfg.enabled !== false && newItems.length) {
        const budget = Math.max(0, Number(detailCfg.maxPerRun ?? 8));
        for (const it of newItems) {
          if (detailCount >= budget) break;
          if (!/^https?:\/\//i.test(it.url)) continue; // 本地测试固件没有详情页
          const d = await fetchDetail(it, source, detailCfg);
          detailCount += 1;
          if (d.summary) it.summary = d.summary;
          if (d.attachments && d.attachments.length) it.attachments = d.attachments;
          await sleep(Number(detailCfg.delayMs ?? 150));
        }
      }

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
      log(
        `${source.name}: 抓到 ${items.length} 条，其中新的 ${newItems.length} 条（编码 ${doc.charset}）` +
          (dupSkipped ? `，跨源重复跳过 ${dupSkipped} 条` : "") +
          (detailCount ? `，取详情 ${detailCount} 条` : ""),
      );
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

  const sortMode = String(args.sort || config.options?.sort || "time").toLowerCase();

  // 落库：只存"新条目"；默认按时间倒序写成一份扁平清单（每条带原网址）
  if (fresh.length) {
    if (sortMode === "source") {
      for (const r of results) {
        if (r.newItems.length) archive(r.newItems, { title: r.source, time: nowIso().slice(11, 16) });
      }
    } else {
      archiveTimeline(fresh, { title: "新通知", time: nowIso().slice(11, 16) });
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
  } else if (sortMode === "source") {
    const groups = results.map((r) => ({ source: r.source, items: r.items }));
    process.stdout.write(renderPlain(groups, fresh.length) + "\n");
  } else {
    process.stdout.write(
      renderTimeline(results.flatMap((r) => r.items), "站点新通知") + "\n",
    );
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
  const body = renderTimeline(pushItems, pushTest ? "链路测试（只发前 2 条）" : "新通知");
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
