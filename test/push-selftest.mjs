#!/usr/bin/env node
/**
 * 推送链路自检：起一个本地假端点，让 site-watch 真的推一次，断言收到内容。
 *
 *   node test/push-selftest.mjs
 *
 * 不会碰任何真实机器人：走的是 config 里临时生成的 webhook 渠道（format: raw）。
 * 退出码 0 = 通过。
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const PORT = 18799;

// ★临时文件放仓库内（test/.tmp），不用 os.tmpdir()：
//   实测在 DSH 等沙箱环境里系统临时目录是禁写的（EPERM），会导致自检根本跑不起来。
const TMP = path.join(HERE, ".tmp");
fs.mkdirSync(TMP, { recursive: true });

// 每次跑都生成唯一标题与唯一链接 → 保证「是新条目」→ 一定会真的走推送
// （去重 key 是「源名|URL」，只改标题不改 URL 的话第二次跑就会被去重跳过）
const runId = Date.now();
const marker = `自检条目 ${new Date(runId).toISOString()}`;
const fixture = path.join(TMP, `selftest-${runId}.html`);
fs.writeFileSync(
  fixture,
  `<html><head><meta charset="utf-8"></head><body><ul>
   <li><a href="/info/${runId}/${runId}.htm">${marker}</a><span>2026-10-14</span></li>
   </ul></body></html>`,
  "utf8",
);

const received = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received.push({ url: req.url, body });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
  });
});

const cfgPath = path.join(TMP, `selftest-${Date.now()}.json`);
fs.writeFileSync(
  cfgPath,
  JSON.stringify(
    {
      sources: [{ name: "selftest", url: `file:///${fixture.replace(/\\/g, "/")}`, maxItems: 3 }],
      channels: [
        { name: "fake", type: "webhook", enabled: true, format: "raw", url: `http://127.0.0.1:${PORT}/hook` },
      ],
      options: { maxChunkChars: 1800 },
    },
    null,
    2,
  ),
  "utf8",
);

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const code = await new Promise((resolve) => {
  const child = spawn(
    process.execPath,
    [path.join(ROOT, "site-watch.mjs"), `--config=${cfgPath}`, "--push", "--push-test"],
    { stdio: "inherit", cwd: ROOT },
  );
  child.on("exit", resolve);
});

server.close();

const failures = [];
if (received.length === 0) failures.push("假端点没收到任何请求");
for (const r of received) {
  let parsed;
  try {
    parsed = JSON.parse(r.body);
  } catch {
    failures.push(`请求体不是 JSON：${r.body.slice(0, 120)}`);
    continue;
  }
  if (typeof parsed.text !== "string" || !parsed.text.includes(marker)) {
    failures.push(`推送内容里没有目标条目：${String(parsed.text).slice(0, 160)}`);
  }
  if (r.url !== "/hook") failures.push(`打到了错误路径：${r.url}`);
}
if (code !== 0) failures.push(`site-watch 退出码 ${code}`);

fs.rmSync(fixture, { force: true });
fs.rmSync(cfgPath, { force: true });

if (failures.length) {
  console.error(`\n❌ 推送自检失败（${received.length} 个请求）：`);
  failures.forEach((f) => console.error("   - " + f));
  process.exit(1);
}
console.log(
  `\n✅ 推送自检通过：收到 ${received.length} 个请求，首次分片含目标条目「${marker}」`,
);
