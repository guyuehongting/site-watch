# site-watch

盯**学校的通知公告页**（以及任何列表型网页），只把**新出现的条目**抓出来 → 落库 → 推送到**多个机器人**。

> 零第三方依赖，一个 Node 脚本；同时是 [DeepSeek Harness](https://github.com/deepseek-ai) 的 Skill，装进 `skills/` 就能让 agent 直接调用。

```
列表页 → 自动嗅探编码(GBK/UTF-8) → 自动挑条目 → 去重 → out/ 落库 → 多平台推送
```

## 为什么不用 RSS / 现成聚合器

学校的通知页**几乎都没有 RSS**，而且大量站点是 GBK、链接是相对路径、列表里混着导航和 PDF 附件。本项目就为这种"没有接口的列表页"设计：

- **编码自动嗅探**：响应头 → `<meta charset>` → UTF-8 试探，GBK/GB2312/GB18030 自动按 `gb18030` 解，中文不乱码
- **条目自动识别**：标题长度 + 链接形态过滤，默认就能滤掉导航、页脚、`javascript:`、图片和附件
- **相对链接自动转绝对**：`./info/1.htm`、`/info/1.htm`、`../notice/1.html` 都能还原
- **只推新的**：`state/seen.json` 按 `源名|URL` 去重，重启/重跑不会重复烦你
- **记录两份**：`out/YYYY-MM-DD.md`（人看）+ `out/items.jsonl`（机器用）

## 快速开始

需要 Node 18+（自带 `fetch` 和 `TextDecoder`）。

```bash
git clone https://github.com/<you>/site-watch.git
cd site-watch

# 1) 只抓取、不推送（默认就是安全模式）
node site-watch.mjs --plain

# 2) 看结果：仓库自带 UTF-8 和 GBK 两个测试页，应该各抓到 6/7 条
# 3) 换成你的站点：编辑 config.json 的 sources
# 4) 配好渠道后推送
node site-watch.mjs --push
```

### 装成 DSH Skill（可选）

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

默认用**目录联接**把本仓库挂到 `%APPDATA%\dsh-desktop\harness\skills\site-watch`，源文件仍在本仓库里，改完即生效；加 `-Copy` 则改为复制一份。

## 配置

`config.json` 三块：`sources`（抓什么）、`channels`（推到哪）、`options`。

### sources —— 加一个站点最小只要两行

```json
{ "name": "school", "url": "https://www.example.edu.cn/tzgg.htm", "maxItems": 20 }
```

默认走**自动模式**：整页 `<a>` 里挑"标题 8–90 字、链接不是图片/PDF/JS"的，按文档顺序（列表页通常最新在上），并从标题附近 400 字符内抠日期。

抓到导航/页脚垃圾时加过滤：

| 字段 | 作用 |
| --- | --- |
| `hrefInclude` | 链接必须匹配（如 `"(info|content|tzgg)"`） |
| `hrefExclude` | 链接不能匹配（默认已排除图片/附件/JS） |
| `titleInclude` | 标题必须匹配（如 `"通知|公示"`） |
| `minTitleLen` / `maxTitleLen` | 标题长度窗口 |
| `maxItems` | 单次最多取几条 |
| `itemPattern` | 精确模式：带 `url` / `title` 命名组的正则，覆盖自动模式 |
| `timeoutMs` | 单源超时（默认 20000） |

JS 渲染的页面自动模式抓不到，此时用 `itemPattern` 匹配它请求的 JSON，或直接写 `url` 指向那个 JSON 接口。

### channels —— 只有 `enabled: true` 的会发

| type | 覆盖 | 需要填 |
| --- | --- | --- |
| `dshim` | **一条接口覆盖九个渠道**：微信 / 飞书 / 钉钉 / 企业微信 / QQ / Slack / Telegram / Discord / WhatsApp | `botId` + `targetId`（从 Dsh-IM 的「设置 → IM机器人 → 齿轮」复制），`baseUrl` 默认 `http://127.0.0.1:3080` |
| `qq` | QQ 开放平台直连（不依赖 Dsh-IM 在跑） | `appId` + `secrets.env` 的 `QQ_APP_SECRET` + `target.userOpenId` / `target.groupOpenId` |
| `webhook` | 飞书 / 钉钉 / 企业微信 / Slack / Discord 群机器人 | `format` + `urlEnv`（指向 `secrets.env` 里的键） |
| `telegram` | Telegram Bot API | `tokenEnv` + `chatIdEnv` |
| `webhook` + `format: "raw"` | 任何自定义接口，body 用 `bodyTemplate` 里的 `{{text}}` 占位 | `url` / `urlEnv` |

密钥写在 `secrets.env`（从 `secrets.env.example` 复制），**脚本只读不打印**，报错信息自动打码。

## 命令行

| 需求 | 命令 |
| --- | --- |
| 抓取不推送（默认） | `node site-watch.mjs --plain` |
| 抓取并推送 | `node site-watch.mjs --push` |
| 只推前 2 条验证链路 | `node site-watch.mjs --push --test` |
| 只推指定渠道 | `node site-watch.mjs --push --channels=dsh-im,feishu` |
| 只跑某个源 | `node site-watch.mjs --source=school` |
| 连历史条目一起输出 | `node site-watch.mjs --all` |
| 结构化输出 | `node site-watch.mjs --json` |
| 单次条数覆盖 | `node site-watch.mjs --limit=30` |
| 看已启用渠道 | `node site-watch.mjs --list-channels` |
| 指定别的配置文件 | `node site-watch.mjs --config=D:\my.json` |

退出码：`0` 正常 / `2` 用法或配置错 / `3` 推送全失败 / `4` 所有源抓取失败。

## 自测

```bash
npm test          # 起本地假端点，真发一次推送并断言内容（不碰任何真实机器人）
```

仓库自带两个固件页用来回归：`test/fixture-utf8.html`（UTF-8）、`test/fixture-gbk.html`（真 GBK 编码，含一条独有条目）。

## 定时

脚本只负责"跑一次"，定时交给外部调度：

- **DSH**：Qoder Automations / 自建 cron
- **Windows**：任务计划程序 `node E:\path\site-watch.mjs --push`
- **Linux/macOS**：`*/30 * * * * cd /path/site-watch && node site-watch.mjs --push`

## 边界

- 只适合**公开、无需登录**的页面；遇到验证码或登录墙请停手，本项目不做绕过。
- 抓取频率由你的调度决定，请自行控制在站点能承受的范围（默认单源一次请求）。
- `--push` 会消耗目标平台的主动消息频次，调试请用 `--push --test`。
- Dsh-IM 的投递接口**无鉴权**，只应在本机使用，不要把它暴露到公网。

## License

MIT
