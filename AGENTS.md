# AGENTS.md

给在本仓库里工作的 AI agent（以及未来的你）的操作手册。

**一句话：这是一个用规则约束内容的技术知识库，不是文章仓库。** 代码是壳，`data/` 是本体，`scripts/validate.mjs` 是门卫。任何改动只要让门卫报错，就等于没做完。

---

## 30 秒上手

```bash
npm ci
npm run validate        # 结构 + 交叉引用 + 分级纪律 + 画种覆盖率
npm run selftest        # 反向测试：证明每条规则真的会拦人（当前 11 项）
npm run build:site      # 把 YAML 编成 site/data/index.json
npm run preview         # http://localhost:4321
```

推送前必须跑：`npm run validate` 与 `npm run selftest`，两者都绿。

---

## 一、不可违反的底线

这些规则不是风格偏好，是项目能被称为「可信」的全部理由。违反任何一条，产物即报废。

1. **每条结论都要有证据。** 没有 `evidence` 的 claim 不允许存在。
2. **证据必须分级。** A 学术（catalogue raisonné／论文／馆方研究文档）、B 机构（馆藏页／档案）、C 次级（展览页／媒体／访谈）。分级取决于来源本身，不取决于结论多合理。
3. **只有 C 级证据 → `confidence: low` 且必须写 `note_zh`。** 校验器强制。
4. **画种必填。** `medium` 不能为空，也不能因为「反正都对」就默认全选。
5. **不许留空白。** 六维 × 每个声明的画种都必须有答案。
6. **「不适用」不是空白，但它要付代价。** `not_applicable: true` 必须同时给 `reason_zh`（≥10 字）和证据。
7. **不存图片。** 只存 IIIF 指针（manifest + region）。图像字节永不入库。
8. **仿作不能当证据。** `attribution` 必须是 `autograph`。
9. **不许签字。** `signed` 是人做的事。agent 只能把状态停在 `draft` / `verified`，并在理由里说明还需要谁核。
10. **不许把示例数据伪装成真实数据。** `meta.example: true` 与站点上的红色横幅都不可移除；`locator` 里的「（待核验）」不许悄悄删掉当核过。

---

## 二、agent 绝对不能做的六件事

| 禁止 | 为什么 |
|---|---|
| 编造 page number、图版号、引文原句 | 这是最容易被信任、也最致命的错误。查不到就写「（待核验）」，不确定就进 `open_questions` |
| 用模型记忆填补技法判断 | 无法追溯到来源的技法描述，正是本库要取代的东西 |
| 把 `signed_by` 填成自己或假名 | 签字是责任，不是字段 |
| 改 schema 却不同步 `validate.mjs` / `docs/schema.zh.md` / `selftest` | 见第五节「连带责任」 |
| 为了通过校验而放宽规则 | 报错是产品功能，不是障碍 |
| 在数据里塞入受版权保护的图像 | 见底线 7 |

---

## 三、目录与职责

```
schema/            JSON Schema：只管结构（英文字段名）
  common.schema.json   枚举 + claim / evidence / IIIF / 签字 / 画种
  artists.schema.json  画家登记
  works.schema.json    作品登记（携带画种与 IIIF 指针）
  sources.schema.json  来源登记（携带 A/B/C 等级）
  dossier.schema.json  一期一份：六维 + 五子项 + media_covered
data/
  registry/*.yaml      三张共享表
  dossiers/<画家>/<时期>.yaml
scripts/
  validate.mjs         结构与语义校验 + 覆盖率报表
  selftest.mjs         反向测试（破坏一条规则，断言被拒）
  build-site.mjs       YAML → site/data/index.json
  serve.mjs            本地预览
site/                  静态站（三个文件 + 生成的 index.json）
docs/schema.zh.md      中文字段说明与填写规则（改 schema 就改它）
.github/workflows/     ci.yml（校验）+ pages.yml（部署）
```

数据流：`data/*.yaml` → `validate.mjs` 把关 → `build-site.mjs` 编译 → `site/` → GitHub Pages。

---

## 四、常见任务怎么做

### 加一条 claim

1. 定位到 `data/dossiers/<画家>/<时期>.yaml` 的对应维度块。
2. 必填：`medium`、`statement_zh`（一句话、可证伪、≤160 字）、`evidence`（≥1）、`status`。
3. 一句话只放一个判断；需要两句就写两条。
4. 有可视化证据就加 `iiif_evidence`，**所引作品的画种必须在这条 claim 的 `medium` 里**。
5. 查不到的出处写「（待核验）」，不要省略 `locator`。

### 加一个画种

1. 把画种加进 dossier 的 `media_covered`。
2. 然后**必须**在其余五维（时期除外）各给一条 claim 或一条 `not_applicable`——加一个画种等于加五格作业。
3. `npm run validate` 会打出画种覆盖矩阵，缺格直接报错。

### 加一个时期

新建 `data/dossiers/<画家>/<新时期>.yaml`。`period.id` 必须等于 `dossier_id`；`basis_zh` 必须说明为什么切在这里（技法或观看方式的变化，不能是「某年参加某展」）。

### 加一个画家

先往 `data/registry/artists.yaml` 加条目（`id`、`names.zh/en`、生卒年、`authorities.wikidata` 可选），再写 dossier。第二个画家的存在意义是证明 schema 不是只为席勒长的。

---

## 五、连带责任

改一处，必须同步下面这些，否则下一个人会踩空：

| 你改了 | 必须同时改 |
|---|---|
| `schema/common.schema.json` | `scripts/validate.mjs`（新规则的语义检查）、`docs/schema.zh.md`、README 双语、至少一条 `selftest` |
| `schema/dossier.schema.json` | `scripts/build-site.mjs`（新字段要能被站点读到）、`site/app.js`（要么展示它，要么别加） |
| 新增枚举值 | 校验器的枚举相关判断、`site/app.js` 的 `MEDIA_LABELS`／`FIELD_LABELS`、文档表格 |
| 改了校验规则 | `scripts/selftest.mjs` 里加一条**能失败**的用例，否则新规则没人信 |

---

## 六、报错 → 含义 → 修法

| 报错 | 含义 | 修法 |
|---|---|---|
| `blank area: dimension "x" has no claim` | 该维度一条都没有 | 写结论，或对该画种写 `not_applicable` |
| `blank area: 画种 "x" answers nothing for "y"` | 某个声明的画种在某一格没答案 | 补一条该画种的结论或 N/A |
| `C-only evidence must be confidence "low"` | 只有次级来源却标了中/高置信 | 降置信，并写 `note_zh` |
| `unknown source src.x` | 引用了不存在的来源 | 先往 `sources.yaml` 登记 |
| `iiif_evidence points at a oil work, but the claim speaks for drawing_on_paper` | 画种与所引作品不一致 | 换图，或改写 claim 的画种 |
| `copies can never be evidence` | 引用了仿作/临摹 | 换 `autograph` 的作品 |
| `a periodization claim must be "period_level"` | 时期维度挂了具体画种 | 改 `period_level`，或把这条移到别的维度 |
| `claims to hold for all six 画种 but shows visual evidence for 1` | 自称通例但只有一个画种的证据 | 补第二个画种的证据，或缩窄 `medium` |
| `example dossier may only carry example-* signatures` | 示例数据里出现真实签字 | 改回 `example-*`，或把 dossier 变成真数据 |
| `locator still unverified`（note） | 出处还是「（待核验）」 | 查证后换真实页码；查不到就进 `open_questions` |

---

## 七、YAML 三个坑

1. 日期加引号：`updated: "2026-10-25"`（不加会被解析成 Date 对象）。
2. 以引号开头的值必须整体加引号：`statement_zh: "一笔到底"是…` 是语法错误。
3. 中文标点安全，但键值分隔处的全角冒号要小心。

---

## 八、站点与部署

- `site/` 是唯一上线物；`site/data/index.json` 由 CI 生成，**不提交**。
- Pages 走 workflow 部署，仓库设置须为 Settings → Pages → Source: **GitHub Actions**；未启用时 `pages.yml` 会立刻失败并打印这句提示（这是设计，不是 bug）。
- 站点顶部红色横幅是示例数据警告，**在数据变成真实数据前不许删**。

---

## 九、当前状态（v0.2）

- 一位画家（席勒）、一个时期（1911–1914）、**24 条条目**（含 1 条「不适用」）。
- 三个画种有内容：`oil` / `colored_on_paper` / `drawing_on_paper`。
- **`watercolor` / `oil_on_panel` / `print` 完全空白**——席勒版画不少，这是最大的缺口。
- 所有 `locator` 仍是「（待核验）」，`meta.example: true`，**不可对外引用**。
- 数据许可仍未定（代码 MIT；数据 CC BY-SA 4.0 是候选，但未拍板）。

---

## 十、尚未决策

1. **审核界面（info review）怎么落。** 已定「结论 + 出处 + 画种三件一起审」，但**结果写回方式未定**：生成补丁手动贴回 / 浏览器内接 GitHub API 一键开 PR / 只存 localStorage 导出台账 / 本地命令行直改文件。
2. 数据许可。
3. 是否允许「画家 × 时期 × 画种」拆成多份 dossier（当前是一份 dossier 内按画种分叉）。

---

## 十一、提交纪律

- commit 一句话说清做了什么，前缀用模块名：`schema:` / `validate:` / `site:` / `data:` / `pages:`。
- 不 push 未经 `validate` + `selftest` 的提交。
- 不 push 任何把示例数据伪装成真数据的提交。
- 改了规则而没加反向测试的提交，等同于没改。
