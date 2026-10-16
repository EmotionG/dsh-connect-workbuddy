# 推理强度（Reasoning Effort）调查记录

> 记录日期：2026-08-30
> 状态：**已修复**（2026-09-17，issue #7，随 2.0.10 发布）
> 触发：用户报告 DSH 中「思考开关只有 deepseek 有，其他都没有」；进一步指出 deepseek 实际支持多档位，「只有一个强度是不对的」。

> **本文件是调查当时的快照（2026-08-30），部分结论已被后续实测推翻。**
> 修复见 `4c39645`「解析单数 effort 形态的推理声明，单数模型不再注册为非推理」：
> `parseReasoning` 现同时解析两态，单数形态经 `singularEffortLadder` 折叠为复数
> （`supportedEfforts` 展开全阶梯 `low/medium/high/xhigh/max`、单数值折入
> `defaultEffort`、`canDisableThinking` 视为 `true`），adapter / 卡片 / 持久化零改动即生效。
> **下文凡与「已修复」冲突处，均已就地标注「⚠️ 已过期」——保留原文以存证当时的推理路径。**

---

## 一、问题现象

DSH 模型选择器里，各 WorkBuddy 模型的推理强度档位表现不一致，大量模型没有可选档位。用户观察到：

- deepseek 有一个「思考」相关状态
- glm 系模型「没开关但有三个选项」
- 其他模型（kimi / minimax / hy3 等）完全没有档位

---

## 二、上游 `/models` 端点数据（纯上游，实测 16 个 cli 模型）

上游 `reasoning` 字段有两种形态，且每个模型都带顶层 `supportsReasoning` / `onlyReasoning`：

### 形态 A：`supportedEfforts` 数组（可选手动档位）

| 模型 | supportedEfforts | defaultEffort | canDisableThinking |
|---|---|---|---|
| glm-5.3 | low, high, xhigh | high | true |
| glm-5.3-flash | low, high, max | high | true |
| hy3-x | low, high | high | false |
| hy4-preview | high | high | false |
| hy4-preview-x | high | high | false |

### 形态 B：`effort` 单值（固定档位，无 supportedEfforts）

| 模型 | effort | 备注 |
|---|---|---|
| deepseek-v4-flash | high | 仅推理（onlyReasoning:true） |
| deepseek-v4-pro | high | 仅推理 |
| hy3 | high | 仅推理 |
| auto | high | 仅推理，默认模型 |
| glm-5.2 | medium | 仅推理 |
| glm-5.1 | medium | 仅推理 |
| glm-5v-turbo | medium | 仅推理 |
| kimi-k3-1 | medium | 仅推理 |
| kimi-k2.7 | medium | 仅推理 |
| kimi-k2.6 | medium | 仅推理 |
| minimax-m3 | medium | 仅推理 |

> 所有 16 个 cli 模型 `supportsReasoning` 与 `onlyReasoning` 均为 `true`。

---

## 三、当前代码问题（根因）

> ⚠️ **已过期（2026-09-17 修复）**：以下是当时（2.0.9 及以前）的代码形态，现已是两态解析。保留以说明问题成因。

`src/upstream.ts` 的 `parseReasoning` 当时**只解析形态 A**：

```ts
const supportedEfforts = Array.isArray(raw['supportedEfforts']) ? ... : undefined
const defaultEffort = typeof raw['defaultEffort'] === 'string' ? ... : undefined
const canDisableThinking = typeof raw['canDisableThinking'] === 'boolean' ? ... : undefined
if (supportedEfforts === undefined && defaultEffort === undefined && canDisableThinking === undefined) {
  return undefined   // ← 形态 B（只有 effort）走到这里，返回 undefined
}
```

**后果**：形态 B 的 11 个 cli 模型（deepseek-v4-flash/pro、hy3、auto、glm-5.1/5.2、glm-5v-turbo、kimi-k3-1/k2.7/k2.6、minimax-m3）的 `reasoning` 被整体丢弃，`WorkBuddyModelInfo.reasoning` 为 `undefined`。

---

## 四、DSH 链路：无档位时强度怎么定

> ⚠️ **本节末尾的推断已被推翻（2026-09-17 实测）**：原文推断「上游收到无 `reasoning_effort` 的请求时按模型默认 `effort` 运行，即这些模型一直以 high/medium 在思考」。修复时的两网关实测结论相反——**不发 `reasoning_effort` 时上游返回 0 思考字符，默认即思考关闭**。因此当时这些模型的真实症状不是「一直以默认强度思考」，而是**根本没有思考**。保留下文原文以存证当时的推断路径。

当模型 `reasoning` 为 falsy（当时 deepseek 等）时，DSH 侧（`@deepseek-ai/dsh-llm-pi-ai` 的 `reasoningInfo`）返回**空对象**——不显示任何档位；请求时 `resolveReasoningLevel` 返回 `undefined`，**请求体不含 `reasoning_effort`**。

shim 原样透传（`prepareChatBody` 不处理 effort）。当时**推断**：WorkBuddy 上游收到无 `reasoning_effort` 的请求时，按模型默认 `reasoning.effort` 运行：

- deepseek → 固定用 **high**，且无法调整
- kimi / minimax / glm-5.1/5.2 / hy3 → 固定用 **medium**，且无法调整

即（原推断）：这些模型**实际一直在思考，但用户无法选择强度**。这解释了用户「deepseek 有思考但只有 fixed」的观察。

> 上述两条推断**均已被推翻**，见本节顶部提示。

---

## 五、实测 chat 接口：模型实际接受的档位

> 注意：以下是通过向 `/v2/chat/completions` 发带不同 `reasoning_effort` 的请求实测（HTTP 200 = 被接受）。**「被接受」不等同于「档位产生不同行为」**，且此探测会消耗积分，未覆盖全部模型×全部档位组合。

> ✅ **本节结论被修复采用**（第五节是本文件中被实证采纳的一节）。2026-09-17 的修复复测追加了两条关键事实：单数形态模型对全阶梯档位返回各异的 `reasoning_content`，且**不发 `reasoning_effort` 时零思考**——后者正是「单数 `effort` 是默认档而非唯一档」的直接依据。

| 模型 | 实测接受档位 |
|---|---|
| deepseek-v4-flash | low, medium, high, max |
| deepseek-v4-pro | minimal, low, medium, high, xhigh, max（全部） |
| hy3 / auto / hy3-x / hy4-preview | minimal, low, medium, high, xhigh, max（全部，前 4 个模型完整探测） |
| kimi-k3-1 | low, medium, high, max |
| minimax-m3 | low, medium, high |

> 关键结论：**上游 `/models` 端点只标了 `effort` 默认档位，但模型实际接受多个甚至全部档位。** 上游端点数据不完整。

未完整实测：glm-5.3 / glm-5.3-flash / glm-5.2 / glm-5.1 / glm-5v-turbo / kimi-k2.7 / kimi-k2.6 / hy4-preview-x / deepseek 是否接受 minimal/xhigh。

---

## 六、DSH 侧档位契约（pi-ai）

`@earendil-works/pi-ai` 的 `ThinkingLevel`：`minimal | low | medium | high | xhigh | max`；`ModelThinkingLevel` 追加 `off`。

- `getSupportedThinkingLevels(model)`：`!model.reasoning` → 返回 `["off"]`
- `thinkingLevelMap`：`Partial<Record<ModelThinkingLevel, string | null>>`；缺失键用 provider 默认，`null` 表示该档位不支持
- `workBuddyThinkingLevelMap`（`src/adapter.ts`）：**未改动**——只从 `supportedEfforts` 建档位，且 `canDisableThinking !== true` 时 `off` 置 `null`。修复选择在**解析层**折叠而非改 adapter，因此这里照旧即可自动生效；`minimal` 不在 `SINGULAR_EFFORT_LADDER` 内（两网关复数载荷从未出现该档），故未被展开。

---

## 七、待决策（修复方向）

> ✅ **已决策（2026-09-17）**：采纳「结合实测」一路。修复把单数形态在解析层折叠为全阶梯（`low/medium/high/xhigh/max`），**不是**只显示声明的那一档。理由是实测证据：`effort` 是默认档、且各档 `reasoning_content` 确有差异。`minimal` 因从未在任何复数载荷中出现而不予展开。

用户要求**只依据上游 `/models` 端点**的信息梳理。基于该端点：

- **严格按上游**：形态 B 模型修复后是「固定档位」（deepseek=high，kimi=medium…），DSH 只显示该档位或标为 fixed，不开放其他档位。
- **结合实测**：deepseek 等实际接受多档位，可补一组档位（需用户确认每个模型真实档位）。← **最终采纳**

**当时的讨论状态：未决定。** 后由 issue #7 的实测结论定案。

---

## 八、按纯上游数据的信息增强清单（对应 `parseUpstreamModel`）

| 字段 | 当前 | 修复后 | 影响模型 | 落地情况 |
|---|---|---|---|---|
| `reasoning.effort` | 不解析（丢弃） | 解析并保留 | 11 个形态 B 模型 | ✅ 已落地（折叠为全阶梯 + 默认档） |
| `supportsReasoning` | 不解析 | 解析 | 全部 16 个 | ❌ 未落地（`thinkingLevelMap` 已够用，未采纳） |
| `onlyReasoning` | 不解析 | 解析 | 全部 16 个 | ❌ 未落地（同上） |
| `disabledMultimodal` | 不解析（图片已改手动） | 作为 `supportsImages` 的一票否决 | 见下（实测无矛盾条目） | ✅ 已落地（2.2.0，随图片默认勾选一起解析） |

> 后三行是**当时拟议的增强**，非缺陷——`reasoning` 档位已由 `parseReasoning` 全权决定，`supportsReasoning` / `onlyReasoning` 至今确实未被解析（全库 grep 无引用），这不影响档位呈现。
>
> **更正注（2.2.0）**：末行的「未采纳」已过期。图片输入改为「刷新时用上游 `supportsImages` 覆盖默认勾选」后，`disabledMultimodal` 已被解析为**一票否决**。该否决是**防御性**的：2026-09-29 只读实测 CN 的 30 个条目，仅 12 个带该字段、6 个为 `true`（均为不在 CLI 名册内的旧模型如 `glm-5.0` / `glm-4.7` / `hunyuan-*`），而 `supportsImages: true && disabledMultimodal: true` 的矛盾条目为 **0**——即「两个标记矛盾」并非实测结论，只是冲突时的取向。

---

## 九、影响文件

- `src/upstream.ts`：`WorkBuddyReasoning` 接口 + `parseReasoning` + `parseUpstreamModel` —— ✅ **已修改**（新增 `SINGULAR_EFFORT_LADDER` 与 `singularEffortLadder`，`parseReasoning` 改为两态）
- `src/adapter.ts`：`workBuddyThinkingLevelMap` —— ⬜ **未修改**（刻意：解析层折叠后自动生效）
- `src/client/WorkBuddyCard.tsx` + `locales.ts` —— ⬜ **未修改**（同上）
- `src/catalog.ts`：fallback 静态目录 —— ⬜ **未修改**（同上）

> 本文件记录的调查结论已由 `4c39645` 落地（随 **2.0.10** 发布），测试新增 6 例覆盖单数折叠、混合形态优先级与线上载荷集成。

---

## 十、issue #59 追问：「reasoning 在不在 body 里」与「上游忽不忽略它」是两回事（2026-10-16）

> 本节**不改动**上面任何历史结论，只回答一个被混为一谈的问题。触发：#59 的 body 报告探针实际跑完（本机 `~/.dsh/body-reports/cn.jsonl`，**685 条**真实捕获）后，出现两种互相矛盾的自测结论。

### 10.1 两个命题必须分开

| 命题 | 判据 | 实测 |
| --- | --- | --- |
| (i) `reasoning` **在不在** body 里 | 报告里的 `reasoning` 桶是否非空 | **在**（本机 77/685 条含 reasoning 块） |
| (ii) 上游**忽不忽略**它 | 同一份 body 在两个网关的计费/行为对照 | **尚未测定** |

**这两条互不蕴含。** 一条 body 里有 reasoning 块，既不能推出上游会按它计费，也不能推出上游会忽略它 —— 后者要拿**同一份 body**去两个网关各发一次才知道。(i) 为真**不构成**对 (ii) 的任何证据。

### 10.2 为什么「77/685」与「0/35」都对

同一个文件、同一个探针，两个人都没错 —— 他们量的是**两个不同的群体**：

- 报告者那一版的汇总（`cn-summary.json`）覆盖**一次会话窗的 35 条**记录，该窗内 `reasoningBucket: "ABSENT (0 occurrences)"`；
- 全文件 **685 条**跨**多个会话**，其中 **77 条**含 reasoning。

**原因不是随机，而是 body 有两种互斥形态**（见 10.3）：reasoning 只出现在其中一种，另一种为 0。按「全部 685 条」统计得 77/685，按「一次会话的 35 条」统计得 0/35 —— **分母不同，不是矛盾**。

### 10.3 真正区分两种 body 的是「有没有重放历史」，不是 reasoning

本机 685 条按 `messageCount` 天然分成两群：

| 形态 | `messageCount` | 条数 | 平均字符 | 含 reasoning |
| --- | --- | --- | --- | --- |
| 大 body | > 700 | 219 | 912,284 | **77 / 219** |
| 小 body | < 500 | 273 | 453,698 | **0 / 273** |

两者**逐条交替出现**（同一轮内先大后小，间隔常在 1–15 秒），字符数比 **1.992**、messageCount 比约 2× —— 即**同一轮对话被送了两次**：一次带完整重放历史，一次只带当前上下文。

**reasoning 块只出现在「带重放历史」的那一次**，且全部挂在 `role: "assistant"` 上（`reasoning: {assistant: 644}`，无其它角色）。这与第 4 节的代码追踪**一致而非冲突**：pi-ai 不把 `thinking` 当**新**内容发出去，但**历史里已有的** assistant 消息会原样重放 —— 于是它出现在 body 里，却**不是本次请求新增的计费内容**。

### 10.4 对 #59 的结论

- **判据 (a)「两份 body 是否本来就不同」已成立，且不需要再去国际侧抓对照。** 两份 body 的差异是**结构性的**：字符数稳定相差约 **2×**，源于「带不带重放历史」，与区域无关。报告者的 **1.94×** 与本节实测的 **1.992×** 是同一个量。
- **「上游忽略 reasoning」这个命题仍未测定，且已不再是 #59 的关键路径。** 1.94× 的量级由一个**不含 reasoning 也成立**的结构差解释完了（大/小 body 的字符比本身就是 2.011，reasoning 只贡献其中一小部分）。继续追 (ii) 不会改变 #59 的归属。
- **两种形态为什么会同时出现**（谁在同一轮里发了两次、分别带不带历史）是**下一步**要查的，且是**本插件侧**可查的：这是请求组装问题，不是上游计费问题。**在它定案前不要动上游计费假设。**

### 10.5 方法学教训（写给后人）

**「同一个数字、两个分母」比「两个人算错」常见得多。** 探针输出的是 JSON Lines，天然是「全文件」与「当前会话窗」两个群体的混合；报数时必须连**分母及其构成**一起报（这里：`77/685` 与 `0/35` 分别是全库与会话窗），否则两个人会各自确信对方在拿另一个群体说事，而真相是两句话都对。这与本仓库在 `docs/WINDOWS.md` §2 反复强调的证据分级是同一件事：**先钉住样本边界，再谈结论。**
