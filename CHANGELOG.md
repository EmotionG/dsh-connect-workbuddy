# Changelog

## 未发布

### 改进

- **额度提示：把占用的 `shell.quota-notice` 座位还回去 —— 左上角那个「本来没有」的方框就是这个插件画的**（issue #63 的第二次后续；维护者看截图后的判定）
  - **维护者看到的**：窗口**左上角**出现一个带边框的方框，内容正是宿主那句「当前请求的额度已用尽」加一句括号，而且不走。维护者说「这个本来没有的啊」—— **判断是对的，那确实是本插件画的。**
  - **它是怎么来的（根因）**：上一版为了「接着宿主那句话补一句」，注册进了 `shell.quota-notice` 这条链。链的契约写得很清楚：**认领该 code 的条目是「接管整个界面」（take over the surface），不是给宿主界面加装饰** —— 全拒时宿主才渲染它自带的 `Toast`。于是：宿主的 `Toast`（`position:fixed; top:40px; left:50%`，会自动淡出）**根本没被渲染**，顶替它的却是个 `display:inline` 的 `span` —— 没有定位、没有居中、没有背景、不会淡出。它落在 `shell.overlay`（`AppFrame` 里一个 `absolute; inset:0` 的层）的**左上角**，一直留着。**「本来没有」是真的：那个坐标上原本是宿主的 Toast，被换掉之后就成了一个没人见过的盒子。**
  - **改了什么**：`select` 由「认领 `QUOTA`」改为**一律返回 `null`**（新增导出 `selectQuotaNoticeClaim`，规则只有一处、只有一个测试）。全拒让链回到宿主自己的 `Toast`，**插件不再往 `shell.overlay` 里画任何东西**。组件本身只留那句括号：不再重绘宿主那句（上一版重绘它，才在对话里造出**第二份**同一句话），`-head` 类与 `quotaNotice.fallbackHead` 的渲染一并去掉 —— 宿主自己那句仍然一字未改地由宿主画。
  - **为什么不改成「只加样式、不接管」**：做不到。链只有「接管」与「不接管」两种结果，没有「叠加」；想让那条括号跟着宿主的 Toast 走，就必须接管，接管就必然失去 Toast 的定位与淡出。所以选择归还座位，括号去**对话里**补 —— 那本来就是用户失败时真正在看的地方。
  - **文案与样式**：`quotaNotice.supplement` 不变（`（部分模型另有每日额度，与积分无关）`）；`.dsm-workbuddy-quota-notice` 仍是 `display:inline` 且**不许画盒子**；`.dsm-workbuddy-quota-notice-head` 删除（它存在的唯一理由是给被接管的那句话上色）。
  - **守卫**：`tests/issue63-quota-notice.spec.tsx` 重写为 6 例，其中**两例是形态/决策守卫**：`selectQuotaNoticeClaim` 对任何 owner 都必须返回 `null`（**这条是本次修复的核心**），根节点必须是 `span`、**一个 `button` 都没有**、**恰好一个子节点**（第二个子节点就是宿主那句话又溜回来了）、且**不存在** `.dsm-workbuddy-quota-notice-head`。**变异验证**（逐个改回、各自变红）：① 让 `select` 重新认领 `QUOTA` → 红；② 把宿主句子重新渲染进组件 → 红（连红 3 例）；③ 加回 `-head` 类 → 红。**注意**：上一版的文案守卫**全部**在出问题的版本上照样绿 —— 文案对、形态错，这就是那个方框能发出去的原因。
  - **产物**：`docs/assets/quota-notice-inline-mock.html` + 同名 PNG 重做，新增「v2 占用 overlay 后的真实落点」一栏，用 `absolute; inset:0` 的容器**复刻**出维护者截图里那个左上角落点，并并排给出「归还座位后宿主 Toast 回来」的样子。

