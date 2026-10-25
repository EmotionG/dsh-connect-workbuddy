# 视频生成工具：`workbuddy_draw_video`

> 日期：2026-10-25 取证 + 联调设计 · 取证版本：4.13.2（`upstream/main` = `dfe7ab3`）
> 工具名：`workbuddy_draw_video` · 国内区与国际区都能注册（逐区打开「允许模型自主生视频」）
> 真实成本：花积分的**异步任务**——提交一次只扣「任务受理」，真正扣积分发生在任务
> `completed` 时（见「上游协议 / 计费」）；时长越长、分辨率越高，实扣越多。

## 结论

1. **WorkBuddy 的视频能力是官方 CLI 的一等能力，端点是异步任务，不是同步请求。**
   `POST {chatBase}/v2/videos/generations` 只返回一个任务 id（`data.id`）；真正的视频
   要再 `POST {chatBase}/v2/videos/tasks` 带着 `{task_id}` 轮询，直到
   `status === 'completed'`（或 `failed`），再从 `data.videos[].url` 把每条视频
   `GET` 下来。**它和生图（一次同步请求拿 `url`）是两套完全不同的执行模型**，本插件
   的生图代码**不能直接复用**，必须另写一段「提交 → 轮询 → 下载」的异步流程。
2. **视频是花钱的异步任务，所以按「异步花钱任务」对待。** 缺省即**独占执行**
   （不声明 `isConcurrencySafe`），失败后 **60 秒冷却**，工具描述里写明这是异步任务、
   可能要等几十秒到几分钟。**冷却只看「请求是否真的发出去了」**：读目录失败、参数写错、
   未登录、图片读不到都没花钱，不冷却；而 `submitVideo` 失败（已受理任务、已花钱）、
   `pollVideoTask` 失败、`downloadVideo` 失败都视为已花钱，进冷却。
3. **两个区都有视频模型，但同样是两个不同的模型目录。** 国内区 `/v3/config` 里
   `kling-video-v3` 与 `minimax-video-h3` 各带 `text-to-video` 与 `image-to-video`；
   国际区 `kling-video-v3` **同时**带这两个标签。工具**两个区都注册**，用哪个区由
   「哪个区既启用了供应商、又打开了「允许模型自主生视频」」决定，两区都符合时**优先国内区**
   （向后兼容：本功能此前只走国内区）。两区的媒体模型目录**完全不重叠**，积分池也各自独立。
4. **模型目录要多读一次同一份文档，和生图走同一条只读链路。** 视频工具需要
   `data.models` 里的媒体标签，而聊天目录投影时会把它们丢掉，所以它另外发一次只读
   `GET /v3/config`，工具侧做 5 分钟缓存（`VIDEO_MODEL_TTL_MS = 5 * 60_000`）。
   它只读、不花积分，但每次冷缓存多一次请求——如实记在这里。
5. **视频模型带 `videoGeneration` 模型级配置**（`resolutions[]` / `defaultResolution` /
   `defaultSeconds` / `minSeconds` / `maxSeconds`），与图片模型不同。时长必须落在
   该模型的 `[minSeconds, maxSeconds]` 内，分辨率必须在 `resolutions[]` 内（否则回落
   默认并告警）。**拿不到这份配置时不做盲拒**——原样透传用户给的时长/分辨率，让上游去判，
   因为目录里不一定每条都带 `videoGeneration`。
6. **模式由「有没有给 `image`」唯一决定，不新增 `mode` 参数**（与生图一致）。给图是
   图生视频（`image-to-video`，带 `image_url` / `last_image_url`，比例由输入图决定、
   不传 `aspect_ratio`）；不给图是文生视频（`text-to-video`，可传 `aspect_ratio`）。

## 工具契约

| 项 | 值 |
| --- | --- |
| 名称 | `workbuddy_draw_video` |
| 参数 | `prompt`（必填，非空字符串、≤2500 字）、`image`（可选，见「图生视频」）、`model`（可选）、`seconds`（可选，默认 5、须在模型 `[min,max]` 内）、`resolution`（可选，须在模型 `resolutions` 内）、`aspect_ratio`（可选，仅文生视频，`16:9`/`9:16`/`1:1`）、`negative_prompt`（可选，≤2500 字）、`enable_audio`（可选，默认 true） |
| 输出 | `videos`（本地 `file://` 路径数组）、`mode`、`model`、`prompt`、`seconds`、`resolution`、`hint` 必填；`credit` 可选 |
| 超时 | 600 000 ms（`VIDEO_TOOL_TIMEOUT_MS`；实测单条视频从提交到下载可能要几十秒到几分钟，留足余量） |
| 执行模式 | 独占（不声明 `isConcurrencySafe`） |
| 注册条件 | 宿主有 `tools` 服务，且**至少一个区**既启用了供应商（`regionEnabled`）又打开了该区的「允许模型自主生视频」；两区都符合时取国内区 |

`model` 的取值顺序是 **显式参数 → 用户在卡片上给这个模式钉住的偏好 → 该区目录里这个
标签组的第一个**。显式参数填了但目录里没有（或不在当次模式的标签组里）时**直接报错**并列出
可用模型，不会把不存在的 / 不匹配的模型 id 发上去换一个上游 404——那样报错只会是
「route config not found」，读者无从知道是名字写错了。卡片上的偏好则是**软约束**：钉住的模型
已从目录里消失时静默回落到组内第一个，不让一条过期的偏好卡住一次生成（见「卡片上按模式
钉住模型」）。

## 约束与默认值

| 约束 | 值 / 处理 |
| --- | --- |
| `prompt` 长度 | ≤ 2500 字符，超出报 `INVALID_ARGS` |
| `negative_prompt` 长度 | ≤ 2500 字符，超出报 `INVALID_ARGS` |
| `aspect_ratio`（仅文生视频） | 只接受 `16:9` / `9:16` / `1:1`，非法报 `INVALID_ARGS`；图生视频不校验、且不传该字段 |
| `seconds` | 默认 `DEFAULT_VIDEO_SECONDS = 5`；拿到模型 `minSeconds`/`maxSeconds` 时越界报 `INVALID_ARGS`，否则原样透传 |
| `resolution` | 不在模型 `resolutions[]` 内时回落 `defaultResolution` 并给 `warnings`，在列内则原样采纳 |
| `enable_audio` | 默认 `DEFAULT_VIDEO_ENABLE_AUDIO = true` |
| `watermark` | 提交时**固定 `true`**（照抄官方 CLI `submitTask`） |

## 图生视频（image-to-video）

和生图一样，同一个工具、同一条命令，**给不给 `image` 决定模式**：

| 传了 `image`？ | 模式 | 选模型用的标签 | 额外字段 |
| --- | --- | --- | --- |
| 否 | 文生视频 | `text-to-video` | `aspect_ratio`（可选） |
| 是 | 图生视频 | `image-to-video` | `image_url` / `last_image_url`（首尾帧）；比例由输入图决定，**不传 `aspect_ratio`** |

`model` 的校验按当次模式的标签组做：拿文生视频模型去图生视频会直接报
「目录里没有图生视频模型「xxx」。可用：…」，不会把不匹配的 id 发上去换一个上游 404。

### `image` 收哪几种形态

与生图输入图一致：本地绝对路径 / `file://` URL / `http(s)` URL（宿主侧下载，
`VIDEO_INPUT_TIMEOUT_MS = 30_000`）/ data URL / 裸 base64。一律先归一成可访问的
URL 或本地路径（**不读成 base64**——视频上游接受的是 `image_url`，不是 base64），
做 HEAD 校验或本地可读校验，**不做缩放、裁剪、格式转换**：用户给什么就用什么。

### 输入图的失败不进冷却

读不到文件、下载失败、格式不对——这些**请求一次都没发出去**，一分钱没花，统一走
`INVALID_ARGS`，不触发冷却。紧接着再调一次仍然能立刻执行。

## 卡片上按模式钉住模型

两个区今天每个视频标签组有 1–2 个模型（国内区 `kling-video-v3` / `minimax-video-h3`，
国际区只有 `kling-video-v3`）。卡片仍显示「这区有哪些媒体模型、各带什么标签」的只读清单
（`media-models` 端点，只读免费，宿主侧缓存 5 分钟）；**图像那几行只读，视频那几行可钉**。

钉住解决的是一个具体问题：国内区每个视频标签组都有 2 个模型，调用方多半省掉 `model`，
于是永远拿到目录里的第一个。口头说一次不持久，所以在卡片上按模式钉住：

- **按区、按标签存**：`regions.<区>.preferredVideoModels` 是 `{ [tag]: modelId }`。
  两种模式可能由不同模型提供，且**模型 id 不跨区**（国内区的 `minimax-video-h3` 在国际区
  不存在），所以不能只存一个 id。
- **软约束，与显式参数分工明确**：显式 `model` 是调用方为**这一次**写的，写错就报错；偏好是
  用户**以前**写的，失效就静默回落。两条规则方向相反，各自都在 `tests/video-tool.spec.ts`
  里钉住。
- **清空 = 删 key**，不是写空串：读取侧 `''` 与缺省是同一件事，写入侧也只留一种表示。
- **读值先问 Host**：与视频开关一样，`statusByRegion` 的答案优先，浏览器里的配置快照只作
  回落（0.1.7 上该 namespace 的镜像是 stale 的）。
- 钉住的 id 若已不在目录里，选择框显示「默认（组内第一个）」那一行——因为工具正是这么回落的。
- 选择框只在「该区启用 + 该区视频工具已勾上 + 目录已读到」时出现；写入走与开关同一条
  「写后回读校验」的路径（`writeRegionPreferredVideoModels`），不是裸 `scope.set`。

## 上游协议

请求头与生图同一条 `imageHeaders()`（`src/upstream.ts`）：`Authorization: Bearer`、
`Accept`、`Content-Type: application/json`、`User-Agent`、`X-Product: SaaS` 等；
**刻意不带 `Origin` / `Referer`**（与生图取证结论一致）。

### 提交（`submitVideo` → `POST /v2/videos/generations`）

请求体**完全照抄官方 CLI 的 `submitTask`**（`buildVideoBody()`）：

- 公共：`{prompt, model, seconds, negative_prompt, watermark: true}`
- 图生视频：额外 `image_url`（或 `last_image_url`）——**不传 `aspect_ratio`**
- `extra_parameters`：`{resolution, enable_audio}`；**仅文生视频**附带 `aspect_ratio`

响应解析（`parseVideoSubmission()`）：先看信封 `code`（HTTP 200 也可能 `code !== 0`），
再取 `data.id` 作 `taskId`。无 `id` 或 `code !== 0` 报 `EMPTY_RESULT` / `UPSTREAM`。

### 轮询（`pollVideoTask` → `POST /v2/videos/tasks`，体 `{task_id}`）

循环 POST 直到 `status` 终态，间隔 `VIDEO_POLL_INTERVAL_MS = 5_000`、整体上限
`VIDEO_POLL_TIMEOUT_MS = 600_000`（超时抛 `POLL_TIMEOUT`）。状态机（`parseVideoTask()`）：

- `status === 'completed'`：取 `data.videos[].url` 与 `data.credit`（实扣积分）；
  若空 `videos` 当作未完成、继续轮询；上层在循环结束仍无视频时报 `EMPTY_RESULT`。
- `status === 'failed'`：返回 failed，上层抛 `TASK_FAILED`。
- 其它（含 `pending` / `running` / 未知值）：当成未完成，继续轮询。

### 下载（`downloadVideo` → `GET <video url>`）

逐条 `GET` 视频 URL，落到系统临时目录下的 `workbuddy-video-gen/`
（`os.tmpdir()` 派生；Windows 是 `%TEMP%`），文件名 `<model>-<时间戳>.mp4`，
返回 `file://` URL 与本地绝对路径——不让视频二进制直接灌进对话。下载超时
`VIDEO_DOWNLOAD_TIMEOUT_MS = 120_000`。

### 计费

积分**不是提交时扣**，而是任务 `completed` 后由 `data.credit` 给出实扣值（在
`pollVideoTask` 阶段才拿到）。所以「计费失败」的边界是：`submitVideo` 收到受理
即视为已花钱（受理失败按 `AUTH`/`RATE_LIMIT`/`NO_ROUTE`/`UPSTREAM` 进冷却）、
`pollVideoTask` 失败 / 超时、`downloadVideo` 失败都视为已花钱（进冷却）。

## 失败分类与冷却

| 阶段 | HTTP | code | 说法 |
| --- | --- | --- | --- |
| 提交 | 401 / 403 | `AUTH` | 提示重新登录 |
| 提交 | 404 | `NO_ROUTE` | 提示该区没有视频路由 |
| 提交 | 429 | `RATE_LIMIT` | 提示限流 |
| 提交 | 其它 | `UPSTREAM` | 抽信封里的 `msg` |
| 轮询 | — | `POLL_TIMEOUT` | 超出 `VIDEO_POLL_TIMEOUT_MS` 仍非终态 |
| 轮询 | — | `TASK_FAILED` | 上游任务本身 failed |
| 提交/轮询 | — | `EMPTY_RESULT` | 无 taskId / 终态却无视频 |

冷却只对**真的发过请求**的失败生效（`AUTH` / `RATE_LIMIT` / `NO_ROUTE` /
`UPSTREAM` / `EMPTY_RESULT` / `TASK_FAILED` / `POLL_TIMEOUT`，以及非本模块的异常）。
参数写错（`INVALID_ARGS`）、未登录（`NOT_LOGGED_IN`）、目录里没模型（`NO_VIDEO_MODEL`）、
图片读不到这四类**不进冷却**——它们一分钱没花。

## 安全

- **凭据不出宿主进程**：工具在宿主侧执行，token 只用于这一次 `fetch`，不进对话上下文、
  不进页面。与生图、积分读数链路边界一致。
- **桌面 App 的认证文件始终只读**：`WORKBUDDY_AUTH_FILE` 只在测试里用，生产读插件自己的凭据库。
- **产物落本地临时目录**：视频是二进制，不进对话体，只回 `file://` 路径 + 渲染成链接。

## 与「只接一次 submitVideo()」的旧说法对账

旧 `IMAGE_GEN.md` 的「没做的事」一节写过：「工具已把四类媒体标签都读进目录，
**加视频只是接一次 `submitVideo()`**」。这句**少说了轮询 + 下载两段**，在此纠正：
视频是异步任务，`submitVideo()` 只拿到一个 `taskId`，必须再 `pollVideoTask()`
轮询到 `completed`、再 `downloadVideo()` 把视频拉到本地，才算完成一次调用。参数层与
选模型层（`MEDIA_TAGS`、`VIDEO_TAG_*`、卡片只读清单、`fetchMediaModels`）确实可复用，
但**执行层是全新异步代码，不是同步生图的改写**。

## 测试

- `tests/video-gen.spec.ts` 35 条：模型筛选与双 video 标签、`pickVideoModel` 按标签组
  校验（含「拿文生视频模型去图生视频」的报错文案）、`buildVideoBody` 文/图两分支
  （`watermark` / `extra_parameters` / 仅文生视频带 `aspect_ratio`）、
  `resolveVideoParams` 的 2500 上限 / `aspect_ratio` 非法 / 时长透传与越界 /
  分辨率回落与告警 / 图生视频 `aspectRatio = undefined`、`parseVideoSubmission` /
  `parseVideoTask`（含未知 status 当未完成）、`describeVideoFailure` 401/403/404/429/
  JSON / 非 JSON。
- `tests/video-tool.spec.ts` 7 条：偏好的解析顺序与它的边界——都没钉、都没传时取组内
  第一个；只钉了偏好时用它（并断言问的标签是 `text-to-video`，不是写死一个）；偏好已不在
  目录里时回落第一个（不报错）；显式参数压过偏好；显式参数在手时**根本不读**偏好；显式参数
  不在组里时仍抛 `NO_VIDEO_MODEL`；`seconds` 的描述说的是「越界报错」而不是「夹回默认值」
  （`resolveVideoParams` 确实是抛 `INVALID_ARGS`）。
- `tests/video-tool-optin.spec.ts` 19 条：`regionVideoToolEnabledOf` 仅显式 true、
  `nextRegionVideoToolEnabled` 仅改单 flag、配置默认 OFF、`videoToolRegionOf` 两区优先级、
  「区关着时勾选不算授权」、卡片含 `dsm-workbuddy-video-tool-check` 视频开关与按模式
  picker、`regionPreferredVideoModelsOf`（畸形值收敛为 `{}`、只留非空字符串、按区隔离）、
  `nextRegionPreferredVideoModels`（钉一个不动另一个、`undefined` 与 `''` 都删 key、
  round-trip）。
