# 信息收集与审查（inbox）

这套东西解决的是「库里只有档案，没有新信息进来」。它分三段：

```
每周日 09:00（可改）
  _tools\run-weekly.cmd
    └─ node scripts/inbox/weekly.mjs     抓：17 个适配器、中英文查询、原文不译
    └─ node scripts/inbox/screen.mjs     AI 初筛（PTC）：先判范围（无关直接删），再判 T/S/F
         └─ data/inbox/candidates.jsonl  候选池
              └─ /examine                人审：C/D/E 必须过目才算数
```

## 一、来源类别 class（A–E）

`data/registry/sources.yaml` 和候选池都带 `class`。它描述**来源是什么**，和 `grade`（A 学术 / B 机构 / C 次级）是两套坐标。

| class | 是什么 | 谁能用 | 要不要人审 |
|---|---|---|---|
| A | 学术：期刊论文、catalogue raisonné、学术专著 | 校验器允许当证据 | 不用，AI 判过直接入库 |
| B | 机构：美术馆对象页、馆藏目录、展览官方页 | 允许当证据 | 不用 |
| C | 次级：新闻报道、百科、媒体综述 | 允许，但只能撑 `confidence: low` 之外的对应等级 | **要** |
| D | 书籍：专著、图录、工具书 | 必须是 A 或 B 级证据能力 | **要** |
| E | 评论区：社交平台帖子、论坛、用户短评 | 只能 C 级，且**不能支撑已签字（signed）的 claim** | **要** |

硬规则写在 `scripts/validate.mjs` 的 `CLASS_KINDS` 与证据循环里，`scripts/selftest.mjs` 有两条反向用例钉住它
（D 类书不能是 C 级；E 类评论不能支撑 signed claim）。

## 二、每周抓取

```bash
cd artlibrary
node scripts/inbox/weekly.mjs              # 真抓
node scripts/inbox/weekly.mjs --dry        # 只看各源返回多少条，不写盘
node scripts/inbox/weekly.mjs --limit 2    # 每个查询只取前 2 条，调试用
node scripts/inbox/weekly.mjs --only=gnews-zh,met
node scripts/inbox/weekly.mjs --class=C
```

- 查询词在 `scripts/inbox/adapters.mjs` 的 `QUERIES` 里，中英文各 4 条；外文条目保留原文标题与摘要，不翻译。
- 每个查询 45 秒硬超时；单个源失败只记一条 `ok:false`，不影响整轮。
- 去重靠 `fingerprint`（url 或 `adapter|title` 的 sha1 前 12 位）。**判过 F 的指纹会写进 `tombstones.jsonl`，以后不再回收。**
- 每轮在 `data/inbox/runs/<run_id>.json` 留一份报告：各源条数、新增、跳过。

### 现有适配器

| 源 | class | 备注 |
|---|---|---|
| Crossref（works / books） | A / D | 书籍相关性差，靠标题过滤 |
| OpenAlex | A | 本机 IP 额度经常 429，失败自动跳过 |
| Wikidata / Wikipedia（en+zh） | B | 取实体与条目摘要 |
| Art Institute of Chicago / The Met | B | Met 用 `/public/collection/v1.1/`，v1 的 search 已 410 |
| Google News RSS（en+zh） | C | 目前 C 类最稳的来源；链接是 JS 跳转，抓不到正文（标记 `aggregator`） |
| Bing News RSS | C | 条数少；中文查询基本为空 |
| Open Library / Archive.org | D | |
| 豆瓣读书（suggest API） | D | 需要 UA + referer；命中常常是「作者」而非图书，返回 0 是常态 |
| Hacker News (Algolia) | E | 英文讨论 |
| 豆瓣短评 / 豆瓣小组 | E | 正则要容忍 `?_spm_id=` 这类跟踪参数 |

不可用的源记在这里省得重试：Reddit（IP 级封锁）、知乎、微博、Bilibili（412 限流）、Google Books / Semantic Scholar（429）、
DuckDuckGo HTML（202 挑战）、百度（空壳）、Bing 网页版（返回无关结果）。

## 三、AI 初筛（PTC）：先判范围，再判可靠性

```bash
node scripts/inbox/screen.mjs --limit 12              # 过「未初筛」的
node scripts/inbox/screen.mjs --rescreen --limit 24   # 用同一套口径重过「待审」队列
node scripts/inbox/screen.mjs --limit 6 --dry         # 只打印将要做什么
```

**第一步：范围。** 这条材料能不能支撑六个维度之一（时期 / 师从与影响 / 对比与创新 / 材料 / 画面构成 / 题材）的技法判断？
套不上的 —— 生平八卦、拍卖价、展览开幕、失窃与归还诉讼、文创周边、同名撞车、只有书名与出版信息的纯书目条目 ——
一律 `drop`，**不进库、不占人工**。例外：馆藏对象页虽然只有几行，但给出年代、尺寸、材料、题记，算 `material`，留下。

**第二步：可靠性。** 只有留下的材料才判 T / S / F。`F`（荒诞不可信）与 `drop`（不是我们的题）都会从候选池消失、
都写指纹防回流，但分开记账：统计条上是「判 F 已删」与「无关已筛」两格。

- 模型：`deepseek-flash`（可用 `TK_SCREEN_MODEL` 覆盖），以 **prompt → tool call → result** 的多轮循环工作，不是一次性分类。
- 五个工具：`read_candidate`（看条目全文/摘要）、`search_kb`（在已编译的 `site/data/index.json` 里找相关 claim）、
  `fetch_page`（抓原文正文前 3000 字）、`drop(id, reason_zh)`（范围外，直接筛掉）、
  `classify(id, verdict, dimensions, reason_zh)`（范围内，判 T/S/F 并注明服务哪几维）。
- 约束：**先 `read_candidate` 才能判**；每条只出一次结论；`classify` 必须给至少一个 `dimensions`，六维都套不上就该走 `drop`；
  判 F 的 `reason_zh` 至少 20 字，防止一句「垃圾」了事。
- 出口：`drop` → tombstone `kind=out_of_scope`、状态 `dropped`；`F` → tombstone `kind=absurd`、状态 `deleted`；
  `T`/`S` 且 class ∈ {A,B} → 直接 `approved`；class ∈ {C,D,E} → `awaiting_review`，等人。
- 候选挑选按 C→D→E→A→B 轮转取，避免 A/B 把额度吃光、待审的一直排不到。
- 模型有时读完、抓完就收尾不判；这时脚本会推一条消息点名剩下的 id 再催一次（最多 3 次）。`--trace` 能看到每轮调了哪些工具。
- Google News 的 `news.google.com/rss/articles/…` 是 JS 跳转，抓不到正文，这类条目标记 `aggregator: true`；`fetch_page` 会直接告诉模型「按摘要判，拿不准给 S，不许因为读不到就判 F」；只有标题、没有任何技法信息的聚合条目，直接 `drop`。
- AI 只审「属不属于这个库、可不可信」，**不写 claim**。把候选变成 `data/` 里的证据条目仍然要人来做，这是 AGENTS.md 的底线。

## 四、/examine 审查台

```bash
preview.cmd          # 打印 http://localhost:4321/examine 与审查口令
```

- 只在本机跑：`serve.mjs` 挂 `/api/examine/*`，没有令牌时只允许 loopback；令牌在 `_tools\.examine.token`（首次自动生成）。
- 页面：统计条（总数 / 待审 / 已入库 / 已删除）、按 class 过滤、每张卡显示 class / kind / 语种 / 原文标题与链接 / 摘要 / AI 判词，
  四个动作 —— **通过 T**、**通过 S**、**驳回**、**删除 F**（删除要确认，写 tombstone）。
- 「运行 AI 初筛」按钮等效于 `screen.mjs --limit 24`，跑完自动刷新。

### 译 · 摘要

每张卡片有一个「译 · 摘要」按钮（`POST /api/examine/gloss`，实现在 `scripts/inbox/gloss.mjs`）：

- 先抓原文正文（聚合链接抓不到时退回 RSS 摘要），再让 `deepseek-flash` 做两件事：译成中文 + **只总结与席勒有关的部分**。
- 正文抽取的顺序：先在 `<main>` / `<article>` 里找，**但必须在这一块文本里看到标题**才认；对不上就退回整页再去掉导航。
  原因是新闻站的 `<main>` 里常塞着比正文更长的推荐位（NZZ 那页最大的 `<article>` 其实是另一篇讲阿尔萨斯抗议的稿子），
  无条件取最大块会把正文换成别人的文章。
- 译文只译开头至多 4 段（约 800 字），后面用「……」省略；长页被 `max_tokens` 截断时（模型会返回空 content 或断掉的 JSON），
  脚本会按 1200 → 700 → 420 字逐级重试，取第一个能解析出 JSON 的答案，全失败才报 `too-long`。
  旧版没有这个阶梯，外文长页一律报成 `bad-model-json`，看起来像模型不会写 JSON。
- 摘要里不写与席勒无关的人物和话题；整条材料与席勒无关（同名撞车等）时，卡片上会标「与席勒无关」，并用一句话说明它到底是什么。
- 另给「要点」（至多 4 条，只放材料里能指认的事实）和「待核」（需要人工核对的地方，例如出版者与年份冲突、缺页码）。
- 结果缓存在候选条目的 `gloss` 字段里，第二次点不花钱；点「重译 · 摘要」才强制重跑。
- 没有 key → 503 `no-key`，页面提示用 `preview.cmd` 启动；只有标题没有内容 → 提示译不了。
- Bing News 的 `apiclick.aspx?...&url=` 跳转在入库时就解包成出版社原文地址（解不开才标 `aggregator`），
  否则跳转目标会漂移——同一条目隔一天再点，可能抓到完全另一篇文章。

## 五、排期

```powershell
powershell -ExecutionPolicy Bypass -File _tools\install-weekly.ps1            # 每周日 09:00
powershell -ExecutionPolicy Bypass -File _tools\install-weekly.ps1 -Time 21:30 -Day WED
powershell -ExecutionPolicy Bypass -File _tools\install-weekly.ps1 -RunNow    # 立刻跑一次
powershell -ExecutionPolicy Bypass -File _tools\install-weekly.ps1 -Remove    # 卸载
```

任务名 `technique-kb weekly inbox`，日志在 `data/inbox/runs/scheduler.log`。任务只在当前用户登录时运行，
机器休眠会错过并且不补跑；想补就 `-RunNow` 或双击 `_tools\run-weekly.cmd`。

## 六、文件

| 路径 | 作用 |
|---|---|
| `scripts/inbox/adapters.mjs` | 各源抓取与归一化 |
| `scripts/inbox/weekly.mjs` | 一轮抓取的编排与报告 |
| `scripts/inbox/screen.mjs` | AI 初筛（PTC 循环） |
| `scripts/inbox/store.mjs` | 候选池读写、指纹去重、墓碑 |
| `scripts/inbox/examine-api.mjs` | `/api/examine/*` 后端（含 `/gloss`） |
| `scripts/inbox/gloss.mjs` | 一键译 · 摘要：读原文、只总结席勒相关、结果缓存回条目 |
| `scripts/inbox/net.mjs` | fetch 包装：超时、重试、清洗 |
| `data/inbox/candidates.jsonl` | 候选池（git 忽略） |
| `data/inbox/tombstones.jsonl` | 判过 F 的指纹（**提交**，防止垃圾回流） |
| `site/examine.html` / `site/examine.js` | 审查台前端 |

## 七、2026-10-25 首次实跑

三轮抓取共收 183 条，去重后新增 135 条候选（A5 / B41 / C58 / D19 / E12）。头几轮 `screen.mjs` 只判 T/S/F，
留下了 47 条待审；改成「先范围后可靠性」之后用 `--rescreen` 重过，待审队列从 47 条压到 **5 条**，
其余 70 条判为与技法无关直接筛除、20 条判 F 删除。

- 被筛掉的典型：纳粹劫掠与归还诉讼的庭审报道（4 条）、拍卖与市场行情、克鲁姆洛夫纪念馆的机构沿革、
  豆瓣求购贴/同人帖/音乐剧排期（E 类噪声几乎全灭）、只有出版信息没有正文的书目条目。
- 留下的 5 条都是真在做技法判断的：ORF 蒂罗尔台关于 1917 年素描《Vom Bergisel》的「寥寥数笔」、NZZ 对晚期人体画图注的技术描述、
  两篇谈晚期笔法变化与向日葵母题对比的中文报道。
- 判 F 的样本说明了为什么必须逐条阅读，而不是关键词过滤：Wikidata `Q4048433` 是 1989 年培育的月季品种 *Rosa* 'Astrid Lindgren'，
  只因别名栏出现过 "Egon Schiele" 被抓进来；Hacker News 两条评论谈的是 Ruby gem `contracts.ruby`，作者 GitHub 用户名 `egonSchiele`。

这类「同名撞车」与「题材相关但无技法」的材料，正是规则式过滤器最容易放过的东西。
