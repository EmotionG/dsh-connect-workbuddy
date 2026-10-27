# 与官方 WorkBuddy 应用的 chat 请求对齐（2026-10-27）

本文件记录一次**真机实测**：以本机登录状态直接打网关，测出「哪些请求形状是被接受的」，
并据此把插件的 chat 请求改成与官方应用一致。所有数字都可复现，探针脚本见文末。

## 0. 结论先行

| 项 | 结论 | 证据档位 |
| --- | --- | --- |
| 官方那套「多出来的」请求头 | 网关**全部接受**（两 host、10 种组合全 200） | A 档（真机实测） |
| 请求体的三处改写 | **仍然必需**，不是历史遗留 | A 档 |
| 系统提示词那道门 | **头改不动**，换官方全套头后原始 DSH prompt 依旧 11128 | A 档 |
| `X-No-*` 标记 | app 只在**未登录**端点用，chat 上改用「省略字段」 | A 档 |
| UA / Origin / Referer | app 在 chat 上**都不发**；不发也 200 | A 档 |

一句话：**能对齐的都对齐了，对不齐的不是头的问题。**

## 1. 起因

插件此前长期只发「CLI 通道最小头集」（`CLIENT_UA`、`Origin`/`Referer`、会话三件套、
`X-No-*` 标记）。这是 issue #66 实测出来的**能过网关的最小子集**，但子集的推导只做了
**缺席测试**：

> 把官方多发的每个头依次去掉，发现都不影响 200 ⇒ 于是不发了。

这个推理有个缺口：它证明的是「不发也 200」，从未证明「发了会怎样」。而官方应用**每一次
调用都发全**，所以「与官方一致」其实比「插件自己约定的最小集」证据更足。

## 2. 实测方法与结果

用本机真实凭据（`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`，
经桌面应用的 at-rest key 解密）直连网关。每行 `max_tokens: 1`、一条 system + 一条 `hi`，
成本可忽略。

### 2.1 请求头矩阵（10 行，全部 200）

| 行 | 形状 | `www.workbuddy.cn` | `copilot.tencent.com` |
| --- | --- | --- | --- |
| 1 | 插件旧形状 | 200 | 200 |
| 2 | 官方全形状 | 200 | 200 |
| 3 | 官方，UA 只留 `WorkBuddy/5.8.3` | 200 | — |
| 4 | 官方 − `X-IDE-*`/`X-Private-Data` | 200 | — |
| 5 | 官方 − `X-Agent-Intent`/`Purpose` | 200 | — |
| 6 | 官方 − trace 头 | 200 | — |
| 7 | 官方 − `x-codebuddy-request` | 200 | — |
| 8 | 官方，UA 换成 CLI 形状 | 200 | — |
| 9 | 官方，**不发** UA | 200 | — |
| 10 | 官方 + `Origin`/`Referer` | 200 | — |

**读法**：200 表示「被允许」，不表示「被要求」。所以矩阵是**从最全的一侧做减法**，
而不是从最小集做加法——只有做减法，失败的行才会指出哪一组是承重的。

### 2.2 请求体字段（12 行）

| 行 | 字段 | 结果 |
| --- | --- | --- |
| a | `stream: true` | 200 |
| b | + `temperature: 0` | 200 |
| c | + `max_tokens: 64` | 200 |
| d | + `stream_options.include_usage` | 200 |
| e | `developer` 角色替代 `system` | **400 / 11128** |
| f | `tool_choice: "auto"` + tools | 200 |
| g | `tool_choice` **对象形式** | **400 / 11101** |
| h | `tool_choice: "none"` + tools | 200 |
| i | `reasoning_effort: "off"` | 200 |
| j | `top_p` / `presence` / `frequency` | 200 |
| k | 无 system 头（user 打头） | 200 |
| l | `stream: false` | **400 / 11101**「Non-stream chat request is currently not supported」 |

⇒ `prepareChatBody()` 里 `developer → system`、`tool_choice` 压平、强制 `stream: true`
三条改写**全部保留**，各自都有对应的拒绝码。

### 2.3 系统提示词那道门：与头无关（关键）

| 头 | 提示词 | 结果 |
| --- | --- | --- |
| 插件旧头 | DSH 原始 prompt | **400 / 11128** |
| 插件旧头 | 经 `breakIdentityClauses` 改写 | 200 |
| **官方全套头** | **DSH 原始 prompt** | **400 / 11128** |
| 官方全套头 | 经 `breakIdentityClauses` 改写 | 200 |
| 插件旧头 | 前置 `You are a helpful assistant.` | 200 |
| 官方全套头 | 前置 `You are a helpful assistant.` | 200 |

**这是本次最重要的一条**：换成官方身份头之后，原始 DSH prompt 依然被拒。所以
`11128` 的内容门与请求头身份**相互独立**，`breakIdentityClauses()` 不能因为
「现在头像官方了」而删掉——那样每一个真实会话都会重新开始失败。

### 2.4 `X-No-*` 标记的真实语义

`X-No-User-Id` / `X-No-Enterprise-Id` / `X-No-Department-Info` 确实是官方 bundle 里
的常量（`codebuddy-lite-wb.mjs:7109457`，`HTTP_HEADER_NO_USER_ID` 等），但整个 bundle
里它们**只出现一次**：

```js
'/v2/auth/state?platform=…' with
{ 'X-No-Authorization': 'true', 'X-No-User-Id': 'true', … }
```

即**未登录端点**上的「这条请求不要注入身份」开关。chat 路径相反：`applyGatewayHeaders`
从账号填 `X-User-Id`，而 `applyIOADefaultHeaders()` 的第一行是

```js
if (!this.isIOAEnvironment(i)) return;
```

⇒ 个人账号**根本不发** `X-Enterprise-Id`，不是发一个「没有」的标记。

实测三种写法（标记 / 空串 / 省略）**全部 200**，所以这是保真问题而非闸门问题，
按 app 的写法走：省略字段。

## 3. 改动清单

### `src/upstream.ts`

- 新增 `WorkBuddyWireIdentity.wireIdentity`（默认 **开**）。
- 新增 `traceHeaders()`：W3C `traceparent` + B3 单头/多头 + `X-Trace-ID`，共 7 个头，
  全部同一个 trace id，每请求新生成。
- 新增 `appChannelHeaders()`：`X-Agent-Intent: craft`、`X-Agent-Purpose: conversation`、
  `x-codebuddy-request: 1`、`X-Private-Data: false`、以及 `traceHeaders()`。
- 新增 `identityHeaders()`：app 的写法（省略缺席字段；`X-Department-Info` 恒发送，
  空串兜底）。
- `ideHeaders()`：`wireIdentity` 下 `X-IDE-Type` 为 `WorkBuddy`（此前是 `CLI`）。
- `conversationHeaders()`：`wireIdentity` 也切到 32 位十六进制 UUIDv7 + `X-Request-ID`。
- `chatHeaders()`：开时 `Accept: application/json`、`x-requested-with` 小写形式、
  **不发** `Origin`/`Referer`/`User-Agent`、**不发** `X-No-*`。
- `X-Private-Data` 取值**照抄** app 的反向逻辑（`enabled !== false` → 发 `"false"`）。

### 配置与 UI

- `Config.wireIdentity`（默认 `true`）。
- 卡片新增「用与 WorkBuddy 应用相同的请求头发送」开关；`upstreamSwitchOf` 对
  `wireIdentity` 采用**反向默认**（缺席读作 ON），与三个 opt-in 兄弟开关相反，
  理由写在字段文档里并有专门测试钉住。
- `/__save` 白名单加入 `wireIdentity`。

### 未改动（有意）

- **请求体**：`prepareChatBody()` 一字未动。
- **系统提示词改写**：`breakIdentityClauses()` 保留且仍无条件执行。
- **生图路径**：不跟随 `wireIdentity`（`'image'` 形状参数挡着，2026-10-21 实测过的
  带连字符 v4 保持）。
- **CLI 形状回退**：`wireIdentity: false` 时逐字节还原旧行为，含 `X-No-*` 标记。

## 4. 验证

- 头集合与 app **逐项比对**：多出 0 项，缺少 0 项。
- 变异验证（5 次，均正确变红）：
  - `X-Private-Data` 改成 `"true"` → 1 条红
  - `Accept` 改回通配列表 → 1 条红
  - `appChannelHeaders()` 整体短路 → 3 条红
  - `X-No-Enterprise-Id` 漏回 app 分支 → 1 条红
  - `upstreamSwitchOf` 反向默认退回 `=== true` → 2 条红
- 全量：**144 文件 / 2491 条通过**，`tsc` 双配置 0 错误，`tsdown` 构建通过。

## 5. 复现

```bash
# 凭据可读性（不打印任何 token）
node scripts/wire-get-cred.mjs

# 请求头矩阵
node scripts/wire-probe-chat-headers.mjs

# 请求体字段矩阵（注意：连发会 429 queue.full，行间有间隔）
node scripts/wire-probe-chat-body.mjs

# 系统提示词门 × 头身份（本题核心）
node scripts/wire-probe-prompt-gate.mjs

# UA / Origin 容差
node scripts/wire-probe-ua-origin.mjs

# X-No-* / 空值头容差
node scripts/wire-probe-empty-headers.mjs

# 插件实际发出的头 vs app 的头（逐项比对）
node scripts/wire-verify-plugin-wire.mjs
node scripts/wire-diff-with-app.mjs
```

前置：`pnpm install && pnpm run build`，且本机 WorkBuddy 桌面应用处于登录状态
（凭据用它的 at-rest key 解密）。

## 6. 已知边界

- **只覆盖 CN 区**。国际区（`workbuddy.ai`）本次未测，`wireIdentity` 对它同样生效，
  但证据档位是 C 档。若国际账号出问题，把它关掉即可回到旧形状。
- **`X-Department-Info` 恒为空串**。插件不从凭据里读部门名；加这个字段会扩大卡片的
  隐私契约（当前只承认昵称、掩码 uin、过期时间、积分），而网关只记录这个头。
- **`acp-connection-id` 未加**。它是应用**本机 ACP 传输**的连接标识，不是发往云端的
  业务头；插件没有这种连接，伪造一个既无意义也不诚实。
- **trace 头是真的新生成**，不是从宿主透传。插件没有上游 trace 上下文可继承。
