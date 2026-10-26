# 家族树 · 多配偶与主从呈现 · 讨论稿

> 状态：讨论中，未开始编码。核心结论：**数据层无需改动，问题在布局与呈现**。

## 一、现状诊断（已核实代码）

`src/core/family/layout.ts` 的 `buildDescendant`：

```ts
const withChildren = families.find((f) => (maps.childrenByFamily.get(f.id) ?? []).length > 0);
const chosen = withChildren ?? families[0];               // 只取一个家庭
const spouseId = chosen === undefined ? null : ...;        // 只画一个配偶
const kids = maps.childrenByFamily.get(chosen.id) ?? [];   // 只遍历这一房
```

| 情形 | 现状 |
| --- | --- |
| 再娶，两位配偶 | 只显示一位 |
| 第一位无子女、第二位有子女 | 第一位配偶消失 |
| 两位都有子女 | **第二位配偶的子女在树中完全不存在** |
| 离婚再娶 | 前段婚姻的子女丢失 |

对比：详情面板 `spousesOf` / `childrenOf` 是全量的 → **数据正确，是渲染丢数据**。

**结论：schema 不动。** GEDCOM 家庭单元已完整支持多配偶、离婚、入赘，
`familiesOf` 返回全部家庭（`ORDER BY created_at`）。

## 二、主人判定规则

不做「按性别猜」，改用血缘：

> **主人 = 血亲链上的那个人；配偶 = 因婚姻加入者。**
> 普通婚姻：血亲是男方 → 男为主。入赘（`family.kind='uxorilocal'`）：血亲是女方 → 女为主。

理由：规则统一、不依赖性别猜测、天然处理入赘，且与"谁传世系"这一族谱本意一致。

## 三、布局方案对比

### 方案 A：房支分列（推荐）

```
[示例祖辈甲]──┬──[配 示例祖辈乙]        [继配 示例父辈乙]
          │        │                  │
          │    [示例父辈甲]           [示例父辈丙]
```

- 主人只出现一次，位于最左侧
- 配偶按婚次（初婚/继配/侧室）向右排列，各占一个列块
- **每房子女挂在自己生母正下方**，房支归属一目了然
- 主人底边引出水平总线，分短竖线连到各配偶（婚线）
- 宽度随房支数增长，可缩放平移

### 方案 B：婚次节点（国际族谱软件式）

主人为根，每次婚姻是一个菱形「婚次节点」，配偶挂在其旁，子女挂在其下。
层级最严谨、扩展性最好；但「配偶依附在主人旁边」的直观感较弱。

### 方案 C：主人重复（纸质族谱式）

每次婚姻画一组「主人 + 配偶」，主人在各房下重复出现并标注「复见」。
最贴近纸质族谱排版；现代交互上会觉得同一人重复。

**推荐 A**：既满足「配偶依附主人」的传统视觉，又把房支归属表达清楚，且不重复主人。

## 四、呈现规则（三方案通用）

| 元素 | 规则 |
| --- | --- |
| 主人 | 框实心、描边加粗、姓名为主字号 |
| 配偶 | 框更小、浅色、紧贴主人右侧；姓名前加「配 / 继配 / 侧室」 |
| 婚线 | 主人与配偶之间实线；**离婚为虚线 + 「离」标记** |
| 子女归属 | 按 `family_child.family_id` 挂到对应婚姻下 |
| 入赘 | 女方为主、男方依附；婚线标注「赘」 |
| 世次 | 配偶随主（已实现）；子女 = 主人世次 + 1（已实现） |

## 五、待决定

1. **布局方案**：A 房支分列 / B 婚次节点 / C 主人重复
2. **女系展开**：只展开本姓男性后裔（传统，女儿记「适某」）/ 男女都展开 / 可切换
3. **离婚呈现**：虚线 + 「离」标记 / 灰显 / 不画
4. **配偶节点**：可点击看详情（推荐）/ 纯依附文字标签

## 六、改动范围预估（选定后）

- `layout.ts`：`buildDescendant` 改为「主人 + N 个婚姻单元」，宽度计算与连线重写（约 150 行）
- `index.tsx` 的 `TreeView`：主人/配偶差异化渲染、婚线样式、离婚标记（约 60 行）
- 详情面板：增加「添加婚姻」入口（同一人多位配偶）（约 20 行）
- `verify-family.mjs`：新增多配偶用例（再娶 + 两房子女 + 离婚），断言两房子女都出现
- 数据层与 schema：**无改动**
---

## 七、实施结果（已完成）

按决定实施：**方案 B（婚次节点）+ 传统女系默认（可展开）+ 离异虚线 + 配偶可点击**。

### 改动内容

| 位置 | 改动 |
| --- | --- |
| `layout.ts` | 重写后裔布局：主人 → 每个婚次一个菱形节点 → 该婚次的配偶 + 子女。**遍历全部家庭**，不再只取一个 |
| `layout.ts` | 无配偶的家庭不画菱形，子女直接挂主人（避免单亲家庭多一个无意义节点） |
| `layout.ts` | 女系规则：男性后裔始终展开；女儿默认只显示本人（传统「适某」），除非开启开关或该女为入赘血亲 |
| `index.tsx` | 主人实心、配偶圆角浅色加粗差异；菱形标「离」与婚配方式；婚线实线/虚线 |
| `index.tsx` | 配偶行增加「子女」（加进该婚次）与「离异/复婚」切换 |
| `repository.ts` | 新增 `setDivorced()`；**再娶默认 `subsequent`（继配）** |
| `setting` | `family.expandFemale` 持久化女系开关 |

### 修复的核心 bug

旧实现 `const chosen = withChildren ?? families[0]` 只取一个家庭，
导致**第二位配偶的子女从未被遍历**——不是画错，是数据在视图里消失。
现在 `for (const family of families)` 遍历全部婚次。

### 验证（族谱套件 24 → 30 项）

新增用例全部通过：

```
PASS  second spouse drawn as its own marriage
PASS  two marriage nodes drawn
PASS  child of the second marriage is present (was silently dropped before)
PASS  both houses visible at once
PASS  divorced marriage drawn as a dashed tie with 离
PASS  list shows all six members
PASS  tree restored after a full browser restart   (6 nodes)
```

三套件合计：族谱 30 + 主功能 35 + 双标签页 9 = **74 项**。
