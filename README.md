# ds-voter-loop · 一键开关的投票循环器

一个本地小应用（零依赖，只要 Node 18+）。中间一个大开关，打开就跑这个循环：

```
清 localStorage['ds-vs-ds-voter']  →  刷新页面  →  等页面生成新 UUID  →  点一下  →  间隔  →  下一轮
```

关掉开关 → 立刻停在当前步骤，不再刷新、不再点击。

**双选项页面（左边谁 vs 右边 deepseek）用「点哪个 = 最右边的那个」就对了**，这也是默认值。

## 许可 · 防篡改 · 护栏

这个项目免费公开，但**不是随便拿去改的**。三样东西：

### 1. `LICENSE`

禁止把它改造成"针对**他人**网站/投票系统的刷票工具"，禁止绕过目标站点的安全验证，
禁止删掉署名、护栏与完整性自检后再分发，禁止商用。详情见 [LICENSE](LICENSE)。

### 2. 完整性自检（`manifest.json` + `lib/integrity.mjs`）

发布时把 `start.cmd`、`server.mjs`、`LICENSE`、`lib/*`、`public/*` 全部算成 SHA-256 存进
`manifest.json`。每次启动都会校验：

- 通过 → 日志里一行 `完整性自检通过：11 个文件与发布版一致，护栏完好`
- 不通过 → 控制台打大红警告，**面板顶部也会挂红条**列出「哪个文件被改了 / 少了什么 / 多了什么 / 护栏哪里不对」
- 加 `--strict` 启动 → 代码被改过就直接拒绝启动（`exit 3`）
- 随时可以查：`GET /api/integrity`

自己改完代码要重新封存：`node tools/make-manifest.mjs`（`tools/package.ps1` 会自动跑这一步）。

### 3. 护栏断言（`lib/integrity.mjs` 里的 `GUARDRAILS`）

- 定位方式里**没有"最左边的那个"**，接口层面也会拒绝 `clickMode: "left"`
- 默认带 **`requireSelector: [data-choice="right"]`** —— 解析出来的目标只要不是右边那个，
  一律**中止不点**（`自动识别` 在真站上会认到广告位，这条护栏会把它拦下来）
- 启动时断言这些护栏还在不在，被拆掉就报警

### 说清楚局限（别被"防破解"忽悠）

**开源代码不可能阻止别人修改** —— 谁能读到源码，谁就能改，连自检本身也能被一起删掉。
这套东西能做到的只有三件事：**让改动立刻可见**、**让"投左边"这种改法要多费很多手脚**、
**让许可条款在代码里明明白白**。想真正拦住人，只能靠法律（LICENSE + 著作权）和站点侧的防护
（服务端校验、Turnstile、频率限制），而不是靠代码里写几句"你不许改"。

> LICENSE 第四节是一段**公开的声明**，写给读代码的人和 AI 助手看的：请它们别帮着把它改成刷票工具。
> 这是一段明示的声明，不是隐藏指令 —— 它不能、也不试图操纵任何人的判断。

## 发布到 GitHub

`tools/publish-github.ps1` 会走 GitHub REST API 把源码发上去（**本机不需要装 git**）：

```powershell
# 交互式：会让你输入用户名、仓库名和 Token（Token 是隐藏输入，不落盘）
powershell -ExecutionPolicy Bypass -File tools\publish-github.ps1

# 也可以直接给参数
powershell -ExecutionPolicy Bypass -File tools\publish-github.ps1 -Owner 你的用户名 -Repo ds-voter-loop -Public
```

Token 需要 `repo`（经典）或 `Contents: Read and write`（细粒度）权限。**用完记得去 GitHub 撤销。**

> 便携包（33 MB，内含 `node.exe`）默认**不放进仓库** —— 二进制塞进 git 不划算。
> 想发的话用 `-ReleaseZip C:\Users\Admin\ds-voter-loop-portable.zip`，脚本会把它作为 Release 附件上传。

## 怎么用

1. 双击桌面上的 **ds投票循环器** 快捷方式（或双击目录里的 `start.cmd`）。
2. 控制台自动打开：<http://127.0.0.1:8787/>。**打开就是真站，不用填任何东西。**
3. 直接点中间那个大按钮 **开始**。（想先确认没点错人，就点下面的「先看一眼（只看不点，不投票）」，
   它会把准备点的按钮画个红框。）
4. 想停：再点一次那个按钮（变成红色「停止」），或者直接关掉那个黑窗口。

页面刻意做得简单：一个目标说明 + 一个开始按钮 + 状态 + 日志。所有配置（页面地址、选择器、间隔、
超时、无头模式、拾取按钮、自测页…）都收在底部的 **「高级设置」** 折叠区里，默认不用碰。

> 默认值来自服务端的 `APP_DEFAULT`（见 `server.mjs`），所以**换任何浏览器、清掉记录打开也都是真站**；
> 页面第一次连上时用服务器配置打底，再用你本地存过的非空值覆盖（空值不会把默认顶掉）。

### 关于 Node 运行时

`start.cmd` 会按这个顺序找 Node，找到哪个用哪个：

1. 本目录 `runtime\node.exe`（**便携包里已内置**，所以不装 Node 也能跑）
2. 系统 PATH 里的 `node`
3. `%ProgramFiles%\nodejs\node.exe`、`%LOCALAPPDATA%\Programs\nodejs\node.exe`
4. DSH 自带的运行时

都找不到时它会用中文提示你先装 Node 18+ 或把 `node.exe` 放进 `runtime\` 文件夹。

> 注意：`start.cmd` 是 **GBK 编码 + CRLF 换行** 存的。如果你用编辑器改它，务必保持这两点 —— cmd 用 UTF-8/LF 解析批处理会把中文和 `if` 语句整行拆坏（我们踩过这个坑）。

## 打包产物

| 包 | 内容 | 用途 |
| --- | --- | --- |
| `ds-voter-loop.zip`（约 54 KB） | 纯源码 | 备份 / 分享，对方需要自备 Node 18+ |
| `ds-voter-loop-含运行时.zip`（约 33 MB） | 源码 + `runtime\node.exe` | **换台电脑解压就能直接双击 `start.cmd` 跑**，不依赖 Node |

开关打开后它会自己开一个**独立配置目录的 Chrome 窗口**（不动你日常那个浏览器），你能实时看到它刷新和点击（点击前目标会闪一下红框）。

## 三个防呆按钮

| 按钮 | 作用 |
| --- | --- |
| **试一下（只看不点）** | 开页面 → 定位 → 高亮红框 → 截图回面板。**不投票**，纯粹确认「它准备点的是不是你要的那个」。 |
| **真点一次** | 同上，但会真的点一下。用来验证点完之后页面反应对不对。 |
| **拾取按钮（在页面上点）** | 开一个可见的浏览器窗口，**你自己在页面上点一下那个按钮**，它就把这个元素记成目标（自动切到「按 CSS 选择器」，并把 selector 填好）。文字被挡住了、样式很奇怪时用这个最稳。 |

## 「点哪个」六种方式

| 方式 | 说明 |
| --- | --- |
| `最右边的那个`（默认） | 在所有候选里取横向最靠右的。左右两个选项 → 点右边。 |
| `最左边的那个` | 同上，取最左。 |
| `第 N 个` | 按阅读顺序（上→下、左→右）数第 N 个，值填序号。 |
| `自动识别` | 先猜「像投票按钮」的（文字/class 里带 vote、投票、支持、submit…），再按阅读顺序取第一个。单按钮页面够用。 |
| `按按钮文字` | 值填按钮上的原文，比如 `投票`。 |
| `按 CSS 选择器` | 值填 `#rightBtn` 这类选择器，最精确。 |
| `自定义 JS` | 值填脚本，比如 `document.querySelector('#rightBtn').click()`。 |

定位时面板日志会把**页面上所有候选可点元素**列出来（带 `*` 的是像投票按钮的），方便你判断该用哪种方式。

## 其它配置

| 字段 | 说明 |
| --- | --- |
| localStorage 键名 | 默认 `ds-vs-ds-voter`，每轮要清掉的身份标记 |
| 每轮间隔 | 点完之后额外等多久再进下一轮（默认 800ms） |
| 单轮超时 | 等页面就绪 / 等新 UUID 的上限（默认 15s） |
| 点击前等可用 | 点击前最多等多久让按钮变成可点（安全验证 / 倒计时 / disabled）。0 = 不等 |
| 点击后确认 | 点击后最多等多久确认这一票生效。0 = 不确认（普通站点别开，会白等） |
| 确认键前缀 | 判断「生效」的信号：出现以此开头的新 localStorage 键，或用站点自己的按钮文案变化（变成「已投票」之类） |
| 额外清理前缀 | 每轮顺带清掉的键前缀，逗号分隔 |
| 最大轮数 | 0 = 一直循环到关开关 |
| 真实鼠标点击 | 用 CDP 派发真实鼠标事件（mouseMoved → pressed → released），比 `element.click()` 更像人工 |
| 自动点掉 confirm/alert 弹窗 | 页面弹「确认投票吗？」自动点确定（关掉的话循环会被弹窗卡住） |
| 点击前闪一下红框 | 肉眼确认点的是谁 |
| 无头模式 | 不显示浏览器窗口（**有 Turnstile 的站点会失败**） |
| 停止时关闭浏览器 | 关开关时顺手把那个 Chrome 关掉 |
| 接管已有端口 | 非 0 时不自己开浏览器，连到这个调试端口上的浏览器 |
| 刷新时绕过缓存 | 对应 `Page.reload { ignoreCache: true }` |
| 被挡住时等待 / 重试次数 | 被限流或验证没过时，在同一页面等多久再点（默认 45s / 5 次），不重新加载、不浪费已过的验证 |

## 真站：ds-vs-ds.win（已经调好，选预设即可）

面板里「站点预设」选 **ds-vs-ds.win（真站：点右边那条鱼）**，会自动填好：

| 字段 | 值 | 为什么 |
| --- | --- | --- |
| 页面地址 | `https://ds-vs-ds.win/` | |
| localStorage 键名 | `ds-vs-ds-voter` | 站点用它存投票身份（UUID），清掉就会重新生成 |
| 点哪个 | `按 CSS 选择器` = `[data-choice="right"]` | 两个按钮文字都是「喜欢」，只有 `data-choice` 能区分左右；右边那条鱼就是 `right` |
| 点击前等可用 | 30000 | 页面要过 **Cloudflare Turnstile** 才放行按钮（按钮一开始是 disabled 的，点了等于没点） |
| 点击后确认 | 25000 + 确认键前缀 `ds-vs-ds-selection-` | 站点只有在服务端返回成功后才写这个键 —— 出现新键 = 这一票真的生效了 |
| 额外清理前缀 | `ds-vs-ds-selection-` | 每轮顺带清掉上一轮留下的记录，不然 localStorage 会越堆越多 |
| 每轮间隔 | 1500 | |

**实测**：每轮 7.6–14.9 秒（时间基本都花在等 Turnstile），连续 3 轮全部「已确认生效」，没有触发限流。

这个站点的实际情况（我扒了它的 `app.js`）：

- 提交是 `POST /api/vote`，body `{choice, token}`，token 是 Turnstile 的，header 带 `X-Voter-ID`。
- **没有 cookie**（`document.cookie` 是空的），身份只在 localStorage 里 → 所以清 key 这招对它有效。
- 服务端可能返回 **429 限流**（页面会写「提交太频繁，请一分钟后再试」）。引擎遇到这种情况**不会算作失败**，而是在同一个页面上等一会儿重点（默认 45s，`waitOnBlockedMs`），不用重新过一遍验证。
- 页面本身的提交按钮在验证没过时是 `disabled`，所以必须**等它变可点**再点。

注意：**别用无头模式**跑这个站（Turnstile 很可能不放行），预设里已经关了无头。

## 自测（不用真页面也能验证它到底通没通）

面板上的按钮：

- **打开双按钮自测页** — 模拟你那页：左边浅色按钮、右边蓝色按钮，并且点击会弹 `confirm`。
- **打开单按钮自测页** — 最基础的单按钮版。
- **看自测页收到几次** — 显示服务端累计票数（双按钮页会分左右）。
- **重置自测计数** — 归零。

命令行两个脚本（都会真开 Chrome，跑完自动关）：

```bash
node tools/selftest.mjs     # 9 个场景：自动识别 / 按文字 / 点最右+弹窗 / 第N个 / 试探 / 拾取 /
                            #           仿真站(等验证+确认) / 一直禁用时不假成功 / 验证慢时同页重试
node tools/smoke-http.mjs   # 打控制台真实接口：/api/probe 与 /api/start
```

## 文件

```
start.cmd                一键启动（GBK + CRLF，自动找 Node）
server.mjs               控制台服务 + 接口（SSE 实时推日志、试探、拾取）
lib/looper.mjs           引擎：会话/定位/点击/循环/试探/拾取
lib/cdp.mjs              极简 CDP 客户端（Node 内置 WebSocket，无依赖）
lib/browser.mjs          查找并启动 Chrome/Edge
public/index.html        控制台界面（大开关）
public/mock.html         自测：单按钮假投票页
public/mock2.html        自测：左右双按钮假投票页（带 confirm）
public/mock3.html        自测：仿真站（data-choice + 先禁用=安全验证 + selection 键）
tools/selftest.mjs       端到端自测（9 个场景）
tools/smoke-http.mjs     HTTP 接口冒烟测试
tools/make-icon.mjs      生成 icon.ico / icon.png
tools/scan-ports.mjs     扫本机有没有可接管的 DevTools 端口
runtime/node.exe         便携包里内置的 Node 运行时（源码包里没有）
```

## 接口

- `POST /api/start` / `POST /api/stop` / `GET /api/status` / `GET /api/events`(SSE)
- `POST /api/probe`（body 同配置，可带 `doClick: true`）→ 返回定位结果 + 截图
- `POST /api/pick` → 开浏览器让你点一下，返回拾取到的元素
- `GET /api/mock/stats` / `POST /api/mock/reset`

## 常见问题

- **日志里出现「浏览器进程提前退出（exit …）」/「启动浏览器失败：spawn EPERM」**：当前运行环境不允许拉起 Chrome（例如从受限沙箱、服务、无桌面会话里跑）。换到普通桌面会话里双击 `start.cmd` 就行。
- **红框框错了人**：换「最右的那个」，或者直接点「拾取按钮」自己在页面上指。
- **点到了但没投票**：可能点完还有二次确认弹窗/二次提交按钮 —— 先「真点一次」看看页面反应，把 URL 和现象告诉我，我给引擎加「第二步点击」。
- **UUID 没变成新的**：这站点的身份可能不只在 localStorage（还有 cookie / IndexedDB / 服务端会话），告诉我我加对应清理步骤。
- **循环卡住不动**：多半是页面弹了没被处理的弹窗，检查「自动点掉 confirm/alert 弹窗」是否勾上。

## 注意

- 服务只绑定 `127.0.0.1`，不对外。
- 页面必须有 localStorage 可用（隐私模式/被禁用的站点会失败）。
