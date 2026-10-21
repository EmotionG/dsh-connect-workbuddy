# 上游活动徽标：数据来源与判定规则

> 日期：2026-10-21 · 取证时版本：4.13.1（`upstream/main` = `2c1626b`）
> 取证对象：上游模型目录响应体（`/v3/config` 的 `data`）里的活动字段
> 复核方式：用本机已有的两个区域账号**只读**拉一次目录配置，不消耗任何积分

## 结论

1. **上游在模型目录的同一次响应里下发活动信息**——`data.modelPromotions`（促销）与
   `data.modelTiers`（权益/等级标记）。两者与 `data.models` **同层**，插件读取模型目录时
   顺手就能拿到，**不需要新增任何一次请求**。
2. **全球区实测有 3 条促销 + 1 条等级标记**；**国内区当前没有活动字段**，因此国内版的
   模型行不会出现徽标（见下文「国内区为何没有」）。
3. 徽标必须按**当前时钟**求值，而不是把解析那一刻的快照冻住；并且要**保留全部候选活动**
   再按优先级挑选——上游会用「同一模型两条互补条目」表达时段，只留一条必然出错。

## 数据来源

| 区域 | 端点 | 结果 |
| --- | --- | --- |
| 全球区 | `GET https://www.workbuddy.ai/v3/config` | `data.modelPromotions` 5 条、`data.modelTiers` 1 条、`data.models` 28 条 |
| 国内区 | `GET https://www.codebuddy.cn/v3/config` | 18 个键，**无** `modelPromotions` / `modelTiers` |
| 国内区 | `GET https://copilot.tencent.com/v3/config` | 5 个键，同样没有 |
| 国内区 | `GET /v2/enterprises/personal/models` | 7 个键，同样没有 |

插件读全球区走 `/v3/config`（`GLOBAL_CONFIG_PATH`，`src/upstream.ts`），国内区先试
`/v3/config`、失败回落 `/v2/enterprises/personal/models`——两处都是读同一个 `data`，
所以**促销是零新增请求**的副产品。

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
- **国内区今天没有活动源**，所以国内版模型行不会出现徽标；要支持只能等上游下发，
  或另找数据源（上游的桌面/CLI 产品配置缓存里有中文促销条目，但那是本机缓存、
  插件拿不到，也不适合进上游 PR）。

## 取证方式

只读拉取、逐字段比对，脚本与样本落在本机临时目录（不入库）：
`$env:TEMP\wb-dump-promos.mjs`（全球区促销/等级原始 JSON）、`$env:TEMP\wb-cn-probe.mjs`
（国内区多主机多路径探测）、`$env:TEMP\wb-global-promos.json`（样本留存）。
凭据取自插件自己的凭据库 `$DSH_HOME/workbuddy-vault/<region>/<accountId>.json`，
**只发 GET**，不触发任何计费动作。
