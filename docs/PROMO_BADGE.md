# 上游活动徽标：数据来源与判定规则

> 日期：2026-10-21 · 取证时版本：4.13.1（`upstream/main` = `2c1626b`）
> 取证对象：上游模型目录响应体（`/v3/config` 的 `data`）里的活动字段
> 复核方式：用本机已有的两个区域账号**只读**拉一次目录配置，不消耗任何积分

## 结论

1. **上游在模型目录的同一次响应里下发活动信息**——`data.modelPromotions`（促销）与
   `data.modelTiers`（权益/等级标记）。两者与 `data.models` **同层**，插件读取模型目录时
   顺手就能拿到，**不需要新增任何一次请求**。
2. **全球区实测有 3 条促销 + 1 条等级标记**；**国内区的网关不下发活动字段**，因此国内版的
   模型行不会出现徽标——这是**数据源**问题，不是渲染问题：国内账号的活动确实存在，
   只是上游没有把活动数组下发给插件手里这份凭据（见下文「国内区为何没有」）。
3. 徽标必须按**当前时钟**求值，而不是把解析那一刻的快照冻住；并且要**保留全部候选活动**
   再按优先级挑选——上游会用「同一模型两条互补条目」表达时段，只留一条必然出错。

## 数据来源

| 区域 | 端点 | 结果 |
| --- | --- | --- |
| 全球区 | `GET https://www.workbuddy.ai/v3/config` | `data.modelPromotions` 5 条、`data.modelTiers` 1 条、`data.models` 28 条 |
| 全球区 | `GET https://www.codebuddy.ai/v3/config` | 同上（同一份国际产品配置，换个官方主机） |
| 国内区 | `GET https://www.codebuddy.cn/v3/config` | 18 个键，**无** `modelPromotions` / `modelTiers` |
| 国内区 | `GET https://copilot.tencent.com/v3/config` | 5 个键，同样没有 |
| 国内区 | `GET https://www.workbuddy.cn/v3/config` | 18 个键，同样没有（桌面端自己也是拉这个地址） |
| 国内区 | `GET /v2/enterprises/personal/models` | 7 个键，同样没有 |

插件读全球区走 `/v3/config`（`GLOBAL_CONFIG_PATH`，`src/upstream.ts`），国内区先试
`/v3/config`、失败回落 `/v2/enterprises/personal/models`——两处都是读同一个 `data`，
所以**促销是零新增请求**的副产品。

## 国内区为何没有：上游产品配置的三层合并

上游把「有哪些模型、哪些活动」放在同一份**产品配置文档**里，桌面端再把几层合并成
最终配置。读代码（`app.asar` 的 `main/dev-env-override.js`）能看清这个层次：

| 层 | 优先级 | 来源 |
| --- | --- | --- |
| `ClientProductProvider` | 5 000 | 客户端内置的 `product.json` |
| `CloudProductProvider` | 10 000 | **云端** `GET <endpoint>/v3/config`（`DEFAULT_CONFIG_PATH`） |
| `EnvProductProvider` | 20 000 | 环境变量 `ACC_PRODUCT_CONFIG_V3` / `ACC_PRODUCT_CONFIG_PATH` |

合并结果按账号持久化，并发布给 CLI 子进程（CLI 的 `product.json` 里
`productConfigEnv` / `productConfigPathEnv` 指的就是它）：

- `~/.workbuddy/storage/user-<uid>-personal/scoped/<hash>/wb-product-config.json`
- `~/.workbuddy/cache/acc-product-config-v3.json`（CLI 侧的落地副本）

本机两个账号的快照里都有活动字段——**国内账号 8 条促销 + 1 条等级标记**
（`glm-52-night-discount-202607`、`glm-52-night-discount-daytime-badge-202607`、
`hy3-free-trial-202608`、`hy4-night-discount-badge-202609`、
`hy4-night-discount-daytime-badge-202609`、`ds-discount-daytime-badge-202608`、
`space-bunny-discount-202610`、`step-5-discount-daytime-badge-202610`，等级标记
`tier-standard-2026q3`），标签是中文（「夜间折扣」「限时免费」「订阅优先」），
而且带 `schedule.daily` 墙钟时段（如 `23:00 → 07:50`，跨零点）。

也就是说：**活动数据国内区是有的，插件的解析器也吃得下**（同一套 schema）。拿不到
的原因是上游那一层的下发策略——用插件手里这份凭据去要，`/v3/config` 的答案里就是
没有这两个数组。实测矩阵（全部只读 GET，凭据取自插件自己的凭据库）：

- 主机：`www.workbuddy.cn`、`copilot.tencent.com`、`wb.tencentbuddy.com`、
  `staging.workbuddy.cn`、`www.codebuddy.cn`；
- 路径：`/v3/config`、`/v2/enterprises/personal/models`、`/v3/product-config`、
  `/v3/product/config`、`/v2/product-config`、`/product-config`、`/plugin/v3/config`
  等 14 条；
- 客户端通道：`CLI/2.63.2 CodeBuddy/2.63.2` 与 `WorkBuddy/5.8.3` 两种 UA；
- 头部变体：`X-Product`、`X-Domain`、`X-Device-Id-List`（带本机 qimei36）、
  `X-Custom-Channel-Id`、`__codebuddyProductConfigurationRequest`（头与查询参数两种放法）。

结果：国内区一律 0 条促销、0 条等级标记；同一份凭据去要国际区的
`www.codebuddy.ai/v3/config` 则能拿到 5 条促销 + 1 条等级标记。

因此插件在**全球区**能画徽标、在**国内区**画不出来，是上游的可见性策略决定的，
不是渲染逻辑坏了。插件不去猜：宁可没有徽标，也不给国内用户编一个上游没下发的活动。

## 字段形状（真实样本，2026-10-21 取）

```jsonc
{
  "id": "hy3-free-trial-202608",
  "kind": "discount",
  "enabled": true,
  "priority": 200,
  "modelIds": ["hy3"],
  "badge": { "label": "Free now", "color": "#FF0000", "display": "activeOnly" },
  "discount": { "discountedCredits": "0x", "displayMode": "replace", "factor": 0 },
  "hover": {
    "textZh": "Aug 6 – Oct 31: Free daily use with unlimited credits.",
    "action": { "labelZh": "Use now", "type": "selectModel" }
  },
  "schedule": {
    "timezone": "Asia/Shanghai",
    "validFrom": "2026-07-06T00:00:00+08:00",
    "validUntil": "2026-11-01T00:00:00+08:00"
  }
}
```

等级标记（`modelTiers`）少两个字段：没有 `schedule`（因此**恒定显示**），也没有 `discount`，
但有 `hover.action.type = "upgrade"`：

```jsonc
{
  "id": "gpt-pro-only",
  "badge": { "label": "Pro Only", "labelEn": "Pro Only", "color": "#009273" },
  "hover": {
    "textEn": "Exclusive to Pro subscribers.",
    "textZh": "模型仅面向 Pro 用户开放。",
    "action": { "labelZh": "升级 Pro", "type": "upgrade" }
  },
  "modelIds": ["gpt-6-astra", "gpt-6.1-sol", "…"],
  "priority": 200,
  "requiredUserType": "standard",
  "tier": "standard",
  "trackKey": "gpt_pro_only"
}
```

### 必须丢弃的「污染项」

全球区的 `modelPromotions` 数组里混着**不是活动**的条目：

```jsonc
{ "id": "hy-image-3.5", "name": "HY-Image-3.5", "tags": ["…"] }
{ "id": "kling-video-v3", "name": "kling-video-v3", "videoGeneration": { "…": "…" } }
```

它们**没有 `modelIds` 数组、也没有 `badge`**。判定规则因此很干脆：
**没有 `modelIds` 或没有 `badge` 的条目一律丢弃**（`src/promo.ts` 的
`parseWorkBuddyPromos`）。同理 `enabled === false` 的条目不参与。

## 时间语义

| 字段 | 含义 | 判定 |
| --- | --- | --- |
| `schedule.validFrom` / `validUntil` | 活动绝对生命周期（ISO 8601，带偏移量） | **左闭右开**：`validUntil` 当刻即失效 |
| `schedule.daily[]` | 每日生效的墙钟时段（`'HH:mm'`，配 `schedule.timezone`） | **起点含、终点不含**；`end <= start` 视为**跨零点**（如 `23:00 → 07:50`） |
| `badge.display` | `activeOnly` = 只在活动期显示 | 缺省 = **常驻**徽标（时段只管折扣，不管徽标） |

上游用**两条互补条目**表达一个「夜间活动」：一条带 `discount`、落在夜间时段里；
另一条不带 `discount`、落在白天的互补时段上，只负责把徽标常驻。
所以**必须保留全部候选**再逐条按当前时刻求值——只按「当时选中的那一条」渲染，
夜间加载一次，白天就会继续挂着「夜间折扣」。

## 实现取舍

- **徽标是时钟的函数**：解析只负责结构化，判定发生在渲染时刻（`Date.now()`）。
  卡片展开时每 60s 轮询一次，因此徽标的新鲜度上限是 60s，无需另设定时器。
- **每个模型只画一个徽标**：先取「此刻正在运行」的候选里 `priority` 最高的一条；
  没有正在运行的，再退回「常驻型」（`display !== 'activeOnly'`）里优先级最高的一条。
  同优先级时**促销优先于等级标记**（`source: 'promotion'` 排在 `source: 'tier'` 前面）。
- **常驻徽标仍受绝对窗口约束**：`validUntil` 一到就消失，不做「过期了还挂着」的常驻。
- **文案与颜色用上游的**：上游按区域自带语言（`label` / `labelEn`、`hover.textZh` /
  `hover.textEn`），插件不翻译、不改写；只在 `hover` 之外补上**有效期区间**与
  **每日时段**（含上游声明的时区），让「为什么现在有这枚徽标」一眼可查。
- **颜色只接受 `#rgb` / `#rrggbb`**：上游给的就是这两种写法，其它一律当作没有颜色，
  避免把任意字符串塞进 CSS。

## 未做与边界

- 上游 `hover.action`（`selectModel` / `upgrade`）**没有做成可点击动作**——徽标目前只是
  提示，点它不会替你选模型、也不会跳升级页。
- 上游在**国内版**的产品配置里还会带 **base64 SVG icon**，没有内嵌（体积与安全）；
  徽标用 CSS 胶囊自绘。
- **国内区今天拿不到活动源**，所以国内版模型行不会出现徽标。要支持有三条路：
  (a) 国内区额外去读国际区的官方产品配置（`www.codebuddy.ai/v3/config`，同一份凭据
  可读、同样带活动）——代价是国内用户每次刷新多一次跨境请求，且拿到的不是国内专属
  活动（国内专属的「夜间折扣」那一组仍然拿不到）；
  (b) 读本机 WorkBuddy 桌面端落地的产品配置快照——数据最准（就是国内那 8 条），
  但那是**别的应用的私有存储**，插件不该依赖它；
  (c) 等上游把活动数组下发给国内区的 `/v3/config`。
  本 PR 选 (c) 之前的保守行为：**没有就是没有**。

## 取证方式

只读拉取、逐字段比对，脚本与样本落在本机临时目录（不入库）：
`$env:TEMP\wb-dump-promos.mjs`（全球区促销/等级原始 JSON）、`$env:TEMP\wb-cn-probe.mjs`
（国内区多主机多路径探测）、`$env:TEMP\wb-global-promos.json`（样本留存）。
国内区那一轮追加了：`$env:TEMP\wb-cn-matrix.mjs`（4 主机 × 6 路径 × 2 客户端通道）、
`$env:TEMP\wb-cn-headers.mjs`（头部变体）、`$env:TEMP\wb-official-endpoints.mjs`
（产品配置里列出的全部官方主机）、`$env:TEMP\wb-cn-device.mjs`（设备归属头 +
`__codebuddyProductConfigurationRequest`）、`$env:TEMP\wb-cn-paths2.mjs`（另外 8 条路径）。
上游桌面端那一侧：`$env:TEMP\wb-asar-grep.mjs` / `wb-asar-dump.mjs`（直接读
`app.asar` 里的 `main/dev-env-override.js` 等模块），以及本机
`~/.workbuddy/storage/user-<uid>-personal/scoped/*/wb-product-config.json` 与
`~/.workbuddy/cache/acc-product-config-v3.json` 两个落地的产品配置快照。
凭据取自插件自己的凭据库 `$DSH_HOME/workbuddy-vault/<region>/<accountId>.json`，
**只发 GET**，不触发任何计费动作。
