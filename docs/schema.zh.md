# 字段说明与填写规则

结构定义在 `schema/`（英文字段名），内容用中文写。本文件说明每个字段该填什么、不该填什么，以及校验器会拦下什么。

## 0. 三层结构

```
registry（共享）           dossier（一期一份）
  artists  画家              period         时期
  works    作品 + IIIF       lineage        师从与影响
  sources  来源 + 等级        comparison     对比与创新
                            material       材料
                            composition    画面构成（五个固定子项）
                            subject_matter 题材
```

一份 dossier 里的 `claims` 是原子单位：**一句话 + 证据**。问答层检索的就是 claim，不是 dossier。

---

## 1. claim（原子结论）

| 字段 | 必填 | 规则 |
|---|---|---|
| `medium` | ✓ | 画种，数组，可多值：`oil` / `oil_on_panel` / `watercolor` / `colored_on_paper` / `drawing_on_paper` / `print`。时期维度的 claim 只能写 `period_level` |
| `statement_zh` | ✓（不适用条目除外） | 一句话，6–160 字，可证伪。**句号之后不能再有句子**；需要两句就拆成两条 claim |
| `evidence` | ✓ | 至少 1 条，每条 = 来源 id + locator + 原文引句 |
| `not_applicable` | | 该维度对此画种不适用时写 `true`，此时**不能写** `statement_zh` |
| `reason_zh` | 不适用时必填 | 为什么这一维对该画种不适用（≥10 字），"不适用"三个字不算理由 |
| `iiif_evidence` | | 指到作品的具体区域（`region`）；**所引作品的画种必须在这条 claim 的 `medium` 里** |
| `confidence` | signed 时必填 | `high` / `medium` / `low`；证据全是 C 级时必须 `low` |
| `status` | ✓ | `draft`（抽出来）→ `verified`（查过来源）→ `signed`（人签字）→ `deprecated` |
| `signed_by` | `signed` 时必填 | 签字人 + 日期（不能是未来日期，允许 1 天时区偏差） |
| `note_zh` | C 级证据必填 | 说明这条的局限、争议、或它不覆盖什么 |

**不要写的**：带"可能""或许""一定程度上"的模糊句；两条结论合成一句；把解读写成事实；**一条跨画种的结论却不列画种**。

**示例**

```yaml
- statement_zh: 他的识别特征是"一笔到底"：轮廓不重描，错误留在画面上。
  evidence:
    - source: src.kallir.1990
      locator: "p. 24（待核验 → 换成真实页码）"
      quote: "Schiele rarely corrected a contour; the first line stays visible as the final line."
      quote_lang: en
      translation_zh: "席勒很少修改轮廓，第一根线就作为最终的线留在画面上。"
  iiif_evidence:
    - work: work.schiele.1912.die-eremiten
      region: pct:10,20,40,60
      note_zh: 看两人之间的空隙：轮廓单线，无复线修补。
  confidence: high
  status: signed
  signed_by:
    reviewer: your-name
    role: author
    date: "2026-10-25"
```

---

## 2. evidence（证据）

| 字段 | 规则 |
|---|---|
| `source` | 必须是 `data/registry/sources.yaml` 里存在的 id |
| `locator` | 页码、图版号、图录编号、章节标题。**写"（待核验）"的条目一律不许签字** |
| `quote` | 原文原句，不许转述。照片/图版就写"图版说明：……" |
| `quote_lang` | `zh` / `en` / `de` / … |
| `translation_zh` | 非中文原文时必填 |

一条 claim 两条独立来源 = 可信；只有一条 = 可签但会被警告；全是 C 级 = 必须降级为 `low` 并写 `note_zh`。

---

## 3. 六维各自该写什么

> 先记住一条：**除时期外，每一条 claim 都要标明画种**。同一年里油画与纸上素描往往是两套手法，不标画种就是把两件事混进一句。

### period 时期
- claim 的 `medium` 只能写 `period_level`：分期判断高于画种，不能挂到单一画种上。
- `basis_zh` **必填**：为什么切在这里而不是别处。分期依据不能是"某年某展览"这种行政事件，必须是**技法或观看方式的变化**。
- `anchors`：可定年的事件（迁居、展览、被捕、去世、委托），带日期与证据。
- 反例：「1909–1911 因为他参加了分离派」——这是履历，不是技法分期。

### lineage 师从与影响
- `counterpart`：人/群组/流派/机构/作品，`type` 选一。有 registry 人物就填 `registry_ref`，否则填 `external_authority`（ULAN / Wikidata）。
- `transmitted_elements` **必填且不能空**：到底传过来的是哪一维（`color`、`brushwork`、`framing`…）。
- 反例：「受克林姆影响很大」——没有轴、没有元素，等于没说。
- 自指也算一条：`relation: self_prior_period`，用来写"他从自己上一期继承了什么"。

### comparison 对比与创新
- 结构固定四件套：`counterpart` + `axis` + `their_practice_zh`（他在做什么）+ `his_difference_zh`（席勒多做了什么）。
- 对照对象可以是：别的画家（`artist`）、群组/流派、他自己的上一期（`self_prior_period`），或者**他自己的另一个画种**（`self_other_medium`）——后者专门放"同期油画 vs 纸上素描"这类差异，别处没有位置放它。
- 这一维**没有现成资料可爬**，只能从图录里读出来。它是全库最贵的部分，也是别人抄不走的部分。
- 反例：「比柯克施卡更内敛」——"更内敛"不是技法差异，落在哪一维上要写明。

### material 材料
- `supports`：paper / cardboard / canvas / wood_panel …
- `mediums`：graphite / pencil / watercolor / gouache / oil …
- `process_zh`：**工序顺序**，先什么后什么，哪里留空。这一项比"用了水彩"有价值得多。

### composition 画面构成（五个子项全部必填）
| 子项 | 写什么 | 不写什么 |
|---|---|---|
| `structure_proportion` | 比例怎么改、重心移到哪、解剖怎么夸张 | "造型夸张"（无指向） |
| `color` | 色域范围、饱和度分布、主色与点缀 | "色彩强烈"（无信息） |
| `framing` | 取景距离、裁切位置、视点高度 | "构图独特"（无信息） |
| `light_shadow` | 明暗是靠线还是靠颜料层次、有无过渡 | "光影处理得当" |
| `brushwork` | 线条硬度、一笔还是复线、笔触是否承担表现 | "笔法精湛" |

**这五项任何一个空着，校验器直接报错**——"空白区"就是本库存在的理由。

如果某一项对某个画种真的不适用（例如黑白素描的「颜色」），不要留空，写一条不适用条目：

```yaml
- medium: [drawing_on_paper]
  not_applicable: true
  reason_zh: 此期纸上素描一律为黑白，不存在色彩处理可写，因此颜色一项对素描不适用。
  evidence:
    - source: src.albertina.schiele
      locator: "graphic works, 1911–1914 holdings"
      quote: "Die Zeichnungen dieser Jahre sind durchgehend schwarzweiß gearbeitet."
  status: draft
```

校验器会把它算作"该画种在这一维已作答"，但空白仍然是错误。**「不适用」不是空白，它必须带理由和证据。**

### subject_matter 题材
- `motifs` 从枚举里选（`self_portrait`、`double_portrait`、`nude`、`figure_study`…）。
- `rationale_zh`：为什么是这个时期画这些，而不是别的。
- 反例：只列题材不解释来源（比如孕妇与病床题材来自 von Graff 的诊所见闻，这层因果必须写出来）。

---

## 4. 来源分级

| 等级 | 范围 | 典型 |
|---|---|---|
| A | 学术 | catalogue raisonné、专著、同行评审论文、馆方研究文档 |
| B | 机构 | 馆藏对象页、官方藏品数据库、档案记录 |
| C | 次级 | 展览专题页、媒体报道、访谈、纪录片 |

等级由**来源本身的性质**决定，不由"这条结论我多喜欢"决定。展览页再权威也还是 C。

写进 sources.yaml 时同时填 `rights.quotation_basis_zh`：说明为什么可以引用（学术性短引、开放许可、公有领域）。

---

## 5. 作品与图像

- 每件作品必须标 `medium_category`（画种）：`oil` / `oil_on_panel` / `watercolor` / `colored_on_paper` / `drawing_on_paper` / `print`。
- claim 的 `iiif_evidence` 只能指向**同画种**的作品。说"纸上作品的工序"却把局部指到布面油画上，校验器会报 `iiif_evidence points at a oil work`。
- `attribution` 必须是 `autograph`。**仿作、临摹、"after Schiele"一律不能作为证据**，校验器会直接报错。
- 不存图片。`iiif.status` 三态：`pending` / `resolved` / `not_available`；`resolved` 时必须给 `manifest`。
- 局部引用写在 claim 的 `iiif_evidence.region`，用 `pct:x,y,w,h` 或像素坐标。

---

## 5b. 画种覆盖率

`dossier` 顶部的 `media_covered` 声明这份 dossier 覆盖哪些画种；不写则由 claim 自动推导。声明了就必须**每一维都有答案**（时期除外，时期是 `period_level`）：

```
画种 coverage      lineage comparison material c.structure c.color c.framing c.light c.brushwork subject
oil                ●       ●          ●        ●           ●       ●         ●       ●           ●
drawing_on_paper   ●       ●          ●        ●           ●(n/a)  ●         ●       ●           ●
```

`npm run validate` 每次都会打印这张表。缺一格就是 `blank area: 画种 "…" answers nothing for "…"`。

另外：一条 claim 如果列满六个画种（自称通例），必须有至少两个画种的可视化证据（`iiif_evidence` 指向不同画种的作品），否则只算 `warn`，在 `--strict` 下是 error。

---

## 6. YAML 常见坑

1. **日期一定要加引号**：`updated: "2026-10-25"`。不加引号会被解析成日期对象，在 `updated: 2026-10-25` 这种位置会报类型错（校验器会替你补并提醒，但别依赖它）。
2. **以引号开头的值必须整体加引号**：`statement_zh: "一笔到底"是他的特征` 是语法错误，要么整体 `"..."`，要么改成 `他的特征是"一笔到底"`。
3. 中文标点（、；：）在 YAML 里安全，不需要转义；但 `：` 出现在键值分隔位置时要小心。

---

## 7. 一条 claim 从生到死

```
抽取（LLM 可以帮忙）
  → status: draft，locator 写"（待核验）"
人工查来源、换真实 locator
  → status: verified
人签字（个人为这条结论负责）
  → status: signed + signed_by
发现错误或被新研究推翻
  → status: deprecated，保留不删
```

`npm run validate` 每次都会告诉你：哪些维度还是空的、哪些 locator 还没核、哪些签字缺 A 级来源。
