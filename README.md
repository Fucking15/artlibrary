# technique-kb

**中文** · [English](#english)

一个开源的、可机器校验的**画家技法知识库**：把「一位画家在一个时期的技法」拆成六个维度，每一句话都是一条带分级来源的 *claim*。

An open, machine-checkable knowledge base of **how a painter's technique changed over time**: each artist-period is decomposed into six dimensions, and every sentence is a *claim* with a graded source.

> **在线预览 / Live preview**：https://fucking15.github.io/artlibrary/
> **状态 / Status**：v0.1 骨架。仓库里只包含**一份示例 dossier**，引文为结构示意并标了 `example: true`，不可直接引用。
> One example dossier only; citations are schematic and flagged `example: true` — do not quote them.

---

## 中文

### 它是什么 / 不是什么

| 是 | 不是 |
|---|---|
| 一个结构化事实库：六维分期 + 原子 claim + 分级来源 | 艺术百科：没有生平流水账、没有"十大名作" |
| 图文分离：只存 IIIF 指针，不存图片字节 | 图库或图录扫描站 |
| 问答层的底座：检索 claim，不做文生艺术史 | 一个套壳聊天机器人 |
| 每次推送都被校验的数据仓库 | 一篇写给人读的长文 |

### 仓库结构

```
schema/            JSON Schema（只管结构，字段名英文）
  common.schema.json    枚举 + claim / evidence / IIIF / 签字
  artists.schema.json   画家登记
  works.schema.json     作品登记（携带 IIIF 指针）
  sources.schema.json   来源登记（携带 A/B/C 等级）
  dossier.schema.json   一期一份：六维结构
data/
  registry/*.yaml       共享登记表
  dossiers/<画家>/<时期>.yaml
site/              静态站（GitHub Pages 部署的就是它）
scripts/
  validate.mjs          结构与语义校验、覆盖率报表
  selftest.mjs          反向测试：证明每条规则真的会失败
  build-site.mjs        把 YAML 编成站点用的 index.json
  serve.mjs             本地预览
docs/schema.zh.md      中文字段说明与填写规则
```

### 六个维度

六维必须全部存在，每一维至少一条带来源的 claim，否则校验直接失败：

| # | 维度 | 里面放什么 |
|---|---|---|
| 1 | `period` 时期 | 起止年、**为什么切在这里的分期依据**、可定年的锚点 |
| 2 | `lineage` 师从与影响 | 老师/同侪/流派 → **到底传过来哪些技法要素** |
| 3 | `comparison` 对比与创新 | 指名的对照对象 + 指名的轴：对方在做什么、他多出了什么 |
| 4 | `material` 材料 | 底材、媒介、底子、**工序顺序** |
| 5 | `composition` 画面构成 | 五个必填子项：结构比例、颜色、取景、明暗光影、笔法与技法 |
| 6 | `subject_matter` 题材 | 母题，以及为什么是这个时期画这些 |

第 3 维是唯一没有现成数据可抓的一维。"受克林姆影响很大"却不说是哪一维、哪个元素——正是这个库要替换掉的那种句子。

### 来源分级

| 等级 | 含义 | 例子 |
|---|---|---|
| **A** | 学术 | catalogue raisonné、专著、同行评审论文、馆方研究文档 |
| **B** | 机构 | 馆藏对象页、官方藏品数据库、档案记录 |
| **C** | 次级 | 展览专题页、媒体报道、访谈、纪录片 |

等级由**来源本身的性质**决定，不由"这条结论我多喜欢"决定。校验器强制：

- 全是 C 级证据 → 置信度必须为 `low`，且必须写 `note_zh` 说明局限；
- `signed` 的 claim 必须有明确置信度、签字人，且最好两条独立来源；
- 签字但没有 A 级来源 → 允许，但会被标出。

### 校验

```bash
npm install
npm run validate          # 结构 + 交叉引用 + 分级纪律 + 覆盖率报表
npm run validate:strict   # 额外要求：每一维都得有一条已签字的结论
npm run selftest          # 反向测试：一次破坏一条规则，断言被拒
npm run preview           # 本地起静态站 http://localhost:4321
```

错误阻断，警告是债，提示是预期状态（示例数据、未加引号的日期）。

`npm run selftest` 的存在理由：**没人见过失败的校验器，等于没人能信的校验器。** 它把真实数据破坏六种方式，逐一断言拒绝。

### 加一个时期

1. 从 A/B 级来源抽候选 claim，写成 draft（这一步可以交给 LLM）。
2. 把六维填满；拿不准的写进 `open_questions`，别猜。
3. 把每个「（待核验）」换成真实页码、图版号或图录编号。
4. 亲自核过的才签字（`status: signed` + `signed_by`）。
5. `npm run validate`：不能有 error，且已签字的 claim 里不能残留「待核验」。

### 图像

作品只存 **IIIF 指针**，不存图片：

```yaml
iiif:
  status: resolved
  manifest: https://institution.example/iiif/manifest/1234
```

claim 可以指向它讨论的精确区域（`region: pct:25,10,50,60`）。"轮廓一笔到底"因此变成读者能自己看的东西，而不是一句要人相信的话。馆方的摄影版权仍归馆方，本仓库只存指针与引文。

### 许可

- 代码（`scripts/`、`schema/`、`site/`）：MIT。
- **数据（`data/`）：待定。** 引文是学术性短引；汇编本身的许可（CC BY-SA 4.0 是自然候选）必须在公开发布前定下来。**不要把 `data/` 当 MIT 用。**

### 路线图

- [ ] 把示例 dossier 的示意页码换成真实页码（这是发布前的唯一硬阻塞）
- [ ] 检索 + 答案层：带等级、出处、IIIF 区域的答案卡；`open_questions` 覆盖到的问题明确拒答
- [ ] 评测集：50 道题 + 期望命中的 claim，让答案质量可量化
- [ ] 第二位画家，证明 schema 不是只为席勒长的

---

## English

An open, machine-checkable knowledge base of **how a painter's technique changed over time** — built to sit underneath an AI Q&A layer, not to be read front to back.

Every sentence in this repository is a *claim*: one falsifiable statement, tied to a **graded source** (A / B / C), filed under one of six dimensions of one artist's period. The point is that an answer can always be traced back to a page, and that a **blank dimension is a validation error**, not an editorial choice.

> **Live preview**: https://fucking15.github.io/artlibrary/
> **Status**: v0.1 scaffold. One example dossier is included and flagged `example: true`; its citations are schematic and must not be quoted.

### What this is / is not

| It is | It is not |
|---|---|
| A structured fact base: six dimensions per period, atomic claims, graded sources | An art encyclopedia: no biography timelines, no "top 10 works" |
| Text and image separated: IIIF pointers only, no image bytes | An image host or scanned catalogue site |
| The substrate for a Q&A layer: it retrieves claims | A chatbot in disguise |
| A dataset validated on every push | A long-form essay |

### Layout

```
schema/            JSON Schema (structure only, English field names)
  common.schema.json    enums + claim / evidence / IIIF reference / signature
  artists.schema.json   artist registry
  works.schema.json     work registry (carries the IIIF pointer)
  sources.schema.json   source registry (carries the A/B/C grade)
  dossier.schema.json   one artist-period: the six dimensions
data/
  registry/*.yaml       shared registries
  dossiers/<artist>/<period>.yaml
site/              the static site deployed to GitHub Pages
scripts/
  validate.mjs          structural + semantic validation, coverage report
  selftest.mjs          negative tests: proves each rule can actually fail
  build-site.mjs        compiles the YAML into the site's index.json
  serve.mjs             local preview
docs/schema.zh.md      field-by-field authoring guide (Chinese)
```

### The six dimensions

All six are required, each with at least one sourced claim; otherwise validation fails:

| # | Dimension | What goes in it |
|---|---|---|
| 1 | `period` | start/end, the **basis for cutting the period here**, dated anchors |
| 2 | `lineage` | teacher / peer / group / movement → **which craft elements actually transferred** |
| 3 | `comparison` | a named counterpart on a named axis: what they did, what he did differently |
| 4 | `material` | support, medium, ground, **order of operations** |
| 5 | `composition` | five required sub-fields: structure, colour, framing, light and shade, handling |
| 6 | `subject_matter` | motifs, and why these motifs in this period |

Dimension 3 is the one no dataset can supply. "Influenced by Klimt" with no axis and no element named is exactly the vague sentence this repository exists to replace.

### Source grades

| Grade | Meaning | Examples |
|---|---|---|
| **A** | Scholarly | catalogue raisonné, monograph, peer-reviewed article, museum research document |
| **B** | Institutional | museum object page, official collection database, archive record |
| **C** | Secondary | exhibition microsite, press article, interview, documentary |

The grade is a property of the source, never of how much we like the claim. The validator enforces:

- C-only evidence forces `confidence: low` **and** a `note_zh` stating the limit;
- `signed` claims need explicit confidence, a signer, and preferably two independent sources;
- signing without any A-grade source is allowed but flagged.

### Validation

```bash
npm install
npm run validate          # structure + references + grading discipline + coverage report
npm run validate:strict   # additionally: every dimension needs a signed claim
npm run selftest          # negative tests — break one rule at a time, expect refusal
npm run preview           # static preview at http://localhost:4321
```

Errors block. Warnings are debt. Notes are expected states (an example dossier, an unquoted date).

`npm run selftest` exists because **a validator nobody has watched fail is a validator nobody can trust**: it breaks the real dataset six ways and asserts the refusal each time.

### Adding a period

1. Extract candidate claims from A/B sources into draft form (LLM assistance is fine here).
2. Fill all six dimensions; put anything unresolved in `open_questions` instead of guessing.
3. Replace every `（待核验）` locator with a page, plate or catalogue number.
4. Sign only what you have personally checked (`status: signed` + `signed_by`).
5. `npm run validate` — no errors, and no unverified locators left in signed claims.

### Images

Works carry a **IIIF pointer**, never image bytes:

```yaml
iiif:
  status: resolved
  manifest: https://institution.example/iiif/manifest/1234
```

Claims can then point at the exact region they are talking about (`region: pct:25,10,50,60`), which is how "the contour runs uninterrupted" becomes something a reader can look at rather than take on faith. Photographic rights in the museum's surrogate stay with the institution; this repository stores only the pointer and the quote.

### Licensing

- Code (`scripts/`, `schema/`, `site/`): MIT.
- **Data (`data/`): pending.** Quoted passages are short quotations for scholarship; the compilation itself needs an explicit licence (CC BY-SA 4.0 is the natural candidate) before any public release. Do not publish `data/` under MIT by default.

### CI / deployment

- `.github/workflows/ci.yml` — on every push and PR: install, validate, self-test, build the site payload.
- `.github/workflows/pages.yml` — on `main`: validate, build, then deploy `site/` to GitHub Pages.

Pages is deployed from the workflow, so the repository setting must be **Settings → Pages → Build and deployment → Source: GitHub Actions**.

### Roadmap

- [ ] Replace the example dossier's schematic locators with real ones (the only hard blocker before release).
- [ ] Retrieval and answer layer: answer cards with grade, source and IIIF region; explicit refusal when `open_questions` already covers the question.
- [ ] Evaluation set: 50 questions with expected claims, so answer quality is measured rather than felt.
- [ ] A second artist, to prove the schema is not Schiele-shaped.
