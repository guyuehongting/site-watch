---
name: site-watch
description: 盯学校/机构的通知公告页，抓新条目并推送到多个机器人（dsh-im、QQ、飞书、钉钉、企业微信、Telegram 等）。用户要"监控某个网址的新通知""把公告推到 QQ/群里""加一个学校站点订阅""改推送渠道/条数"时使用。不要用于抓需要登录的页面、绕过验证码，或抓取指定账号的隐私数据。
license: MIT
metadata:
  author: "tangkarina"
  version: "0.1.0"
  compatibility: "本机 Node 18+（自带 fetch/TextDecoder，GBK 靠 ICU）。零第三方依赖，不需要 npm install。"
---

# 站点监控 → 多机器人推送

抓取配置里的网站列表页，找出**没见过的**新条目，落库，然后按配置推给多个机器人。

## 工作流程

1. 在本 Skill 目录执行（**默认只抓取、不推送**）：

   ```bash
   node site-watch.mjs --plain
   ```

   `node` 不在 PATH 时用绝对路径 `E:/agent/node.js/node.exe`。

2. 除非用户明确说"推送"，否则**不要加 `--push`**：主动推送会消耗对应平台的频次，而且需要先在「设置 → IM机器人」里配好目标。
3. 回复用户时直接用脚本输出，**不要自己重写标题或缩短链接**。

## 常用参数

| 需求 | 命令 |
| --- | --- |
| 只抓某个源 | `node site-watch.mjs --source=school --plain` |
| 源很多时先探测一遍（不落库不推送） | `node site-watch.mjs --probe` |
| 临时探测一串网址、不动配置 | `node site-watch.mjs --probe --urls=https://a/x.htm,https://b/y.htm` |
| 抓取+落库+推送 | `node site-watch.mjs --push` |
| 只推前 2 条验证链路 | `node site-watch.mjs --push --test` |
| 只推指定渠道 | `node site-watch.mjs --push --channels=qq-im,feishu` |
| 连历史条目一起输出（仍只推新的） | `node site-watch.mjs --all --plain` |
| 结构化数据 | `node site-watch.mjs --json` |
| 看配置了哪些渠道 | `node site-watch.mjs --list-channels` |
| 单次抓取条数覆盖 | `node site-watch.mjs --limit=30` |

退出码：`0` 正常 / `2` 用法或配置错 / `3` 推送全失败 / `4` 所有源抓取失败。

## 记录在哪

- `out/YYYY-MM-DD.md` —— 当天新条目（人类可读，追加写）
- `out/items.jsonl` —— 结构化流水（每条一行 JSON，含标题/URL/来源/发现时间）
- `state/seen.json` —— 去重表（key 是 `源名|URL`，保留最近 5000 条）

## 加一个新站点

**一个站点**：编辑 `config.json` 的 `sources`，最小只需两行。

**一堆站点**（常见：教务处/研究生院/学院/图书馆各一个栏目页）：写进 `sources.txt`，一行一个网址，可选 `名字 | 网址`；`config.json` 的 `sourcesFile` 已指向它。同一 URL 只算一个源，没起名的按域名自动生成短名。加完先 `--probe` 过一遍，确认每个源都能识别，再交给定时任务。

```json
{ "name": "school", "url": "https://xxx.edu.cn/tzgg.htm", "maxItems": 20 }
```

默认走**自动模式**：在整页 `<a>` 里挑"标题 8–90 字、链接不是图片/PDF/javascript"的，按文档顺序（列表页通常最新在上），并从附近文本里抠日期。

学校站点常见情况与对策：

| 现象 | 配置项 |
| --- | --- |
| 抓到导航/页脚垃圾 | `hrefInclude: "(info\|content\|detail\|tzgg)"` 或 `titleInclude` |
| 页面是 GBK | 不用管，脚本自动嗅探（响应头 → `<meta charset>` → UTF-8 试探） |
| 列表是 JS 渲染的 | 自动模式抓不到，需要写 `itemPattern`，或改用它的 JSON 接口 |
| 标题里带"【】"等前缀 | `titleInclude` 过滤，或后续在回复里说明 |
| 一条通知分页/多个栏目 | 配多个 `sources`，各自 `name` 不同即可（去重按"源名+URL"，互不干扰） |

要精确控制时用 regex 模式：

```json
{
  "name": "school",
  "url": "https://xxx.edu.cn/tzgg.htm",
  "itemPattern": "<a[^>]+href=\"(?<url>[^\"]+)\"[^>]*>(?<title>[^<]{8,90})</a>",
  "titleInclude": "通知|公告|公示"
}
```

## 推送渠道（config.json 的 `channels`，只有 `enabled: true` 的会发）

| type | 覆盖 | 需要填 |
| --- | --- | --- |
| `dshim` | **一条接口覆盖九个渠道**：微信/飞书/钉钉/企业微信/QQ/Slack/Telegram/Discord/WhatsApp | `botId` + `targetId`（从「设置 → IM机器人 → 齿轮 → 调用标识 / 复制调用参数」拿） |
| `qq` | QQ 开放平台直连（不依赖 dsh-im 在跑） | `appId` + `secrets.env` 的 `QQ_APP_SECRET` + `target.userOpenId` / `target.groupOpenId` |
| `webhook` | 飞书/钉钉/企业微信/Slack/Discord 群机器人 | `format` + `urlEnv` 指向 `secrets.env` 里的键 |
| `telegram` | Telegram Bot API | `tokenEnv` + `chatIdEnv` |
| `webhook`+`format:"raw"` | 任何自定义接口（`bodyTemplate` 里用 `{{text}}` 占位） | `url`/`urlEnv` |

推送会按 `options.maxChunkChars`（默认 1800）自动分片，多片时每条结尾标 `（1/2）`。

**dsh-im 那条接口是 `POST /api/dsh-im/delivery/messages`**，body 严格只有 `{botId,targetId,text}`，成功返回 `{"sent":true}`；它复用当前 Host 的 WebServer（Web profile 默认 `http://127.0.0.1:3080`，实际端口以 Host 启动时显示的地址为准，改 `config.json` 的 `baseUrl` 或 `secrets.env` 的 `DSH_IM_BASE`），**无鉴权、只应在本机用**。

## 边界与禁忌

- **不要在回复里打印 `secrets.env` 的值**，也不要把它读进上下文；报错信息已经自动打码。
- **不要读 `<DSH_HOME>/.credentials.yaml`**，也不要为了拿 QQ 标识去翻 `integrations/dsh-qq/config.json`——需要 openid 就让用户在设置页复制。
- 页面需要登录、有验证码、或明确禁止抓取时，**如实说明并停下**，不要尝试绕过。
- 抓取失败时按源区分报告：单源失败要说清是"这个源挂了"，不要把其它源的结果说成全部。
- 定时由外部调度负责（Qoder Automations 或 dsh-bot 的 manifest）；本 Skill 只负责"跑一次"。
