# 01 SKU 目录、花位图与双提示词生成链路 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 01 白底图生成升级为按文件名 SKU 自动读取 CSV、判断素面/有花位、匹配完整花位图、计算真实物理数量，并分别使用两套可编辑默认提示词生成 Image 1 + Image 2 或 Image 1 + Image 2 + Image 3。

**Architecture:** 新增服务端 SKU 面料目录模块作为唯一可信数据源：它负责标准化文件名、解析 CSV、匹配完整花位图并计算样本跨度和花位数量；前端只做批量预检与信息展示，实际生成时服务端再次解析并校验。白底图提示词拆为“无花位”和“有花位”两个独立设置；生成器按目录结果选择提示词和图片顺序，并把有效提示词及目录元数据返回前端和历史记录。

**Tech Stack:** Node.js ESM、原生 HTTP、原生 HTML/CSS/JavaScript、Node test runner、FormData、Sharp（沿用现有图片处理）。

## Global Constraints

- 只修改 `/Users/wangyuanzi/Documents/code/work2/qbh_detail_sence/sense-imagev1.0`。
- CSV 默认路径：`/Users/wangyuanzi/Documents/code/work2/test/32/比利时门店居莱 - Volume#32（已完成）.csv`。
- 完整花位图默认目录：`/Users/wangyuanzi/Documents/code/work2/test/32/居莱/花位图`。
- Image 1 始终只控制窗帘结构；Image 2 始终是颜色、纱线、织法、密度和材质的唯一依据；Image 3 只控制完整花位的二维结构、方向和布局。
- CSV 的 `花位纵向长(cm)` 与 `花位横向长(cm)` 同时为 `/` 时判定为无花位；同时为有效正数时判定为有花位；只缺一个或数值非法时必须报错。
- 10 cm 样本在 270 cm 高度内的整张样本跨度固定为 27 次，15 cm 样本固定为 18 次；该数量用于锁定 Image 2 观察到的纹理密度，不等于 CSV 花位循环数。
- 有花位的真实循环数只按 CSV 计算：纵向 `270 / 花位纵向长`，每片展开横向 `330 / 花位横向长`，两片总展开横向 `660 / 花位横向长`。
- 不继续移植或维护 03 的 AI 面料分析、类别确认、比例字段校验逻辑。
- 当前目录不是 Git 仓库，不执行提交步骤；每个任务使用定向测试作为检查点。

---

### Task 1: 文件名、SKU 与样本尺寸的纯函数

**Files:**
- Create: `test/manualFabricIdentity.test.js`
- Create: `src/manualFabricIdentity.js`
- Modify: `src/naming.js`

**Interfaces:**
- Produces: `normalizeManualFabricSku(fileName): string`
- Produces: `sampleSizeFromManualFabricName(fileName): 10 | 15 | null`
- `skuFromFabricName` 对手工白底图文件继续返回不含 `_detail_10`、`_detail_15` 和末尾 `（1）/（2）` 的 SKU。

- [ ] **Step 1: Write the failing identity tests**

覆盖 `JLW828558-05_detail_15.jpg`、`JLS1025-01（1）_detail_15.jpg`、`SKU_detail_10.png`、无尺寸后缀文件及路径分隔符；断言 SKU、尺寸和未知尺寸回退值正确。

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --test test/manualFabricIdentity.test.js`
Expected: FAIL，目标模块尚不存在或现有 `skuFromFabricName` 保留了尺寸后缀。

- [ ] **Step 3: Implement the minimal pure functions**

标准化顺序固定为：取 basename → 去扩展名 → 去 `_detail_10/_detail_15` 或 `_detail` → 去末尾全角括号批次标记 → trim。不要删除 SKU 中部合法的括号或连字符。

- [ ] **Step 4: Reuse the normalizer in output naming**

让服务端与浏览器当前输出名链路都使用相同 SKU 语义，避免 CSV 查询 SKU 与输出文件名不一致。

- [ ] **Step 5: Run the focused test**

Run: `node --test test/manualFabricIdentity.test.js`
Expected: PASS。

### Task 2: CSV 解析、目录索引与完整花位图匹配

**Files:**
- Create: `test/fabricCatalog.test.js`
- Create: `src/csvRows.js`
- Create: `src/fabricCatalog.js`

**Interfaces:**
- Produces: `parseCsvRows(text): object[]`，支持带逗号、双引号和换行的字段。
- Produces: `createFabricCatalog({ csvPath, repeatImageDir, fileOps? })`。
- Produces: `catalog.resolve({ fileName, fallbackSampleSizeCm }): Promise<FabricCatalogEntry>`。

`FabricCatalogEntry` 至少包含：

```js
{
  sku,
  sampleSizeCm,
  sampleSizeSource: "filename" | "fallback",
  fabricMode: "plain" | "repeat",
  composition,
  repeatVerticalCm,
  repeatHorizontalCm,
  repeatImagePath,
  repeatImageName,
}
```

- [ ] **Step 1: Write failing CSV parser tests**

测试普通行、引号字段、字段内逗号、双引号转义及 CRLF；不得用简单 `split(',')`。

- [ ] **Step 2: Write failing catalog fixture tests**

在临时目录创建小型 CSV 与花位图文件，覆盖：无花位 `/`、有花位数值、成分读取、文件名尺寸优先于顶部回退、SKU 缺失、仅一个 `/`、非法/非正数尺寸、有花位但缺 Image 3、同一 SKU 多个候选花位图。

- [ ] **Step 3: Run tests to verify failure**

Run: `node --test test/fabricCatalog.test.js`
Expected: FAIL，模块尚不存在。

- [ ] **Step 4: Implement a lazy cached catalog**

首次 `resolve` 时读取 CSV 和花位图目录并建立标准化 SKU 索引；成功后缓存，读取失败时返回包含路径与 SKU 的中文错误。重复图片匹配只允许唯一结果；不能静默选第一个。

- [ ] **Step 5: Run catalog tests**

Run: `node --test test/fabricCatalog.test.js`
Expected: PASS。

### Task 3: 独立物理尺度换算

**Files:**
- Create: `test/manualProductScale.test.js`
- Create: `src/manualProductScale.js`

**Interfaces:**
- Produces: `calculateManualProductScale({ sampleSizeCm, fabricMode, repeatVerticalCm, repeatHorizontalCm })`。

返回值至少包含：

```js
{
  sampleSpanVertical: 27,
  sampleSpanHorizontalPerPanel: 33,
  sampleSpanHorizontalTotal: 66,
  repeatCountVertical: null,
  repeatCountHorizontalPerPanel: null,
  repeatCountHorizontalTotal: null,
}
```

有花位时后三项为真实小数结果；15 cm 样本的前三项分别为 18、22、44。

- [ ] **Step 1: Write the failing scale tests**

覆盖 10 cm、15 cm、无花位、有花位、非整除花位、零值和缺值。明确断言样本跨度与 CSV 花位循环是两套独立数量，禁止相互覆盖。

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --test test/manualProductScale.test.js`
Expected: FAIL，模块尚不存在。

- [ ] **Step 3: Implement constants and calculations**

集中定义成品尺寸 330×270、每片展开 330×270、总展开宽 660、中间开口 30；返回原始数值，不在计算层拼中文提示词。

- [ ] **Step 4: Run the focused test**

Run: `node --test test/manualProductScale.test.js`
Expected: PASS。

### Task 4: 无花位/有花位两套源码默认提示词与运行时硬参数

**Files:**
- Create: `test/curtainProductPrompt.test.js`
- Modify: `src/curtainProductPrompt.js`

**Interfaces:**
- Produces: `MANUAL_CURTAIN_PRODUCT_PLAIN_PROMPT`
- Produces: `MANUAL_CURTAIN_PRODUCT_REPEAT_PROMPT`
- Extends: `buildCurtainProductPrompt({ fabricMode, fabricMetadata, scale, ... })`

- [ ] **Step 1: Write failing prompt tests**

无花位断言：提示词只引用 Image 1 和 Image 2；包含成分标签、样本尺寸、27/18 次样本跨度、经纬组织与微纹理不得磨平；不含蓝色、浅蓝、蓝灰、短纬纱块组等旧面料专属词。

有花位断言：提示词明确 Image 3 职责、CSV 纵横花位厘米、纵向/每片横向/总横向循环数、Image 2 颜色材质优先级、禁止将 Image 3 颜色带入；不把整张样本跨度当花位循环。

- [ ] **Step 2: Run test and verify failure**

Run: `node --test test/curtainProductPrompt.test.js`
Expected: FAIL，当前只有一套 `MANUAL_CURTAIN_PRODUCT_FIXED_PROMPT`。

- [ ] **Step 3: Replace the old single prompt with two generic prompts**

从用户确认的默认提示词保留通用的三尺度重建、图片职责、独立坐标、光影分离、连续裁切和输出要求；删除所有浅蓝、蓝灰、青灰、纵向蓝块、横向短纱等特定面料描述。

无花位提示词重点：颜色、深浅关系、经纬、颗粒、孔隙、粗糙度、微高光和微阴影；不存在花位时不得虚构图案。

有花位提示词重点：Image 2 负责实际色号与材质，Image 3 负责完整花位结构，CSV 负责厘米尺寸；花位先在连续平展面料上建立，再裁切与包覆。

- [ ] **Step 4: Add one runtime parameter section generated from structured metadata**

运行时段落必须直白列出 270/样本尺寸、330/样本尺寸、660/样本尺寸；有花位另列 270/纵向花位、330/横向花位、660/横向花位及计算结果。运行时参数优先级高于可编辑正文，避免用户误删尺度链路。

- [ ] **Step 5: Run prompt tests**

Run: `node --test test/curtainProductPrompt.test.js`
Expected: PASS。

### Task 5: 拆分可编辑提示词类型且不继承旧覆盖值

**Files:**
- Modify: `test/promptSettingsReset.test.js`
- Modify: `test/promptSettingsResetHttp.test.js`
- Modify: `test/editablePromptReset.test.js`
- Modify: `src/promptSettings.js`
- Modify: `public/editablePromptSettings.js`

**Interfaces:**
- New prompt kinds: `manual_product_plain`, `manual_product_repeat`, `curtain_creation`。
- Existing queued job kind remains `manual_product` and is not itself an editable prompt kind。

- [ ] **Step 1: Update tests to the new prompt kind set**

断言两套白底提示词可独立读取、保存和恢复，恢复一个不会影响另一个或场景提示词；旧 `manual_product` 覆盖值不得自动复制到两个新槽。

- [ ] **Step 2: Run tests and verify failure**

Run: `node --test test/promptSettingsReset.test.js test/promptSettingsResetHttp.test.js test/editablePromptReset.test.js`
Expected: FAIL，当前只允许旧 `manual_product`。

- [ ] **Step 3: Implement the new prompt kinds**

更新服务端和浏览器白名单。`withCurrentFixedPrompt` 只继续处理 `creation`；手工白底图提示词必须在服务端解析 SKU 类型后调用 `promptSettings.get(modeKey)`，不能相信浏览器传来的类型或 `fixedPrompt`。

- [ ] **Step 4: Preserve unrelated stored settings without writing defaults as overrides**

修正 `save` 使用原始存储值而不是 `readAll()` 全量回写，确保旧配置文件中的 `manual_product` 不会污染新类型，同时不删除用户的场景提示词覆盖。

- [ ] **Step 5: Run prompt settings tests**

Run: `node --test test/promptSettingsReset.test.js test/promptSettingsResetHttp.test.js test/editablePromptReset.test.js`
Expected: PASS。

### Task 6: FormData 支持 Image 3 且固定图片顺序

**Files:**
- Create: `test/imageApiCurtainProduct.test.js`
- Modify: `src/imageApi.js`

**Interfaces:**
- Extends: `buildCurtainProductFormData({ template, fabric, repeatImage?, fabricMetadata, scale, ... })`。
- Plain image order: Image 1 template, Image 2 sample。
- Repeat image order: Image 1 template, Image 2 sample, Image 3 full repeat。

- [ ] **Step 1: Write failing FormData tests**

读取 `form.getAll('image')` 的文件名，断言无花位两张、有花位三张且顺序固定；断言最终 prompt 包含与图片编号一致的职责说明。

- [ ] **Step 2: Run test and verify failure**

Run: `node --test test/imageApiCurtainProduct.test.js`
Expected: FAIL，当前函数不接受或附加 Image 3。

- [ ] **Step 3: Implement optional repeat image append**

只有 `fabricMode === 'repeat'` 且 repeat image 有效时才附加 Image 3；无花位请求不得发送占位图或第三张图片。

- [ ] **Step 4: Run focused tests**

Run: `node --test test/imageApiCurtainProduct.test.js test/curtainProductPrompt.test.js`
Expected: PASS。

### Task 7: 服务端预检接口与生成时权威校验

**Files:**
- Create: `test/manualFabricMetadataHttp.test.js`
- Create: `test/manualProductGenerationCatalog.test.js`
- Modify: `server.js`

**Interfaces:**
- Produces: `POST /api/manual-product/fabric-metadata`
- Request: `{ fileNames: string[], fallbackSampleSizeCm: 10 | 15 }`
- Response: `{ items: [{ fileName, ok, metadata?, error? }] }`
- `createAppServer` accepts injectable `fabricCatalog` for tests。

- [ ] **Step 1: Write failing metadata endpoint tests**

用 fake catalog 启动真实服务器，断言一批文件可部分成功、部分失败；错误项包含具体文件和原因，不能返回通用 `Failed to fetch`。

- [ ] **Step 2: Write failing generation integration tests**

使用 fake catalog、内置模板、fake upstream fetch 和临时花位图：

- 无花位生成只上传 Image 1+Image 2，并读取 `manual_product_plain`；
- 有花位生成上传 Image 1+Image 2+Image 3，并读取 `manual_product_repeat`；
- 浏览器伪造类型、花位或提示词不会覆盖服务端目录结果；
- 缺 CSV SKU、非法花位或缺 Image 3 在调用上游前失败。

- [ ] **Step 3: Run tests to verify failure**

Run: `node --test test/manualFabricMetadataHttp.test.js test/manualProductGenerationCatalog.test.js`
Expected: FAIL，接口和目录注入尚不存在。

- [ ] **Step 4: Wire the catalog into `createAppServer`**

增加默认 CSV/花位图路径常量和可注入 catalog。预检接口只返回安全元数据，不返回服务器绝对路径。

- [ ] **Step 5: Resolve again inside generation worker**

`executeManualCurtainProductGeneration` 根据 `payload.fabric.name` 和顶部 fallback 尺寸重新解析：计算 scale、读取对应可编辑提示词、按需读取 Image 3、构建 FormData。删除 worker 预先给 `manual_product` 注入单提示词的行为。

- [ ] **Step 6: Return authoritative result metadata**

无论 `clientHistory` 是否为 true，结果至少返回 `effectivePrompt` 与安全的 `fabricMetadata`；包含 SKU、样本尺寸与来源、类型、成分、花位尺寸、所有数量和 Image 3 匹配状态。

- [ ] **Step 7: Run integration tests**

Run: `node --test test/manualFabricMetadataHttp.test.js test/manualProductGenerationCatalog.test.js`
Expected: PASS。

### Task 8: 前端批量预检、队列展示与局部阻断

**Files:**
- Create: `test/manualFabricMetadataClient.test.js`
- Create: `public/manualFabricMetadata.js`
- Modify: `public/app.js`
- Modify: `public/styles.css`

**Interfaces:**
- Produces: `fetchManualFabricMetadata(fileNames, fallbackSampleSizeCm, fetchImpl?)`。
- Manual row gains: `catalogStatus`, `fabricMetadata`, `catalogError`。

- [ ] **Step 1: Write failing client request tests**

断言批量 POST 的 URL、方法、正文、错误解析和保持输入顺序；测试部分错误仍返回成功项。

- [ ] **Step 2: Run test and verify failure**

Run: `node --test test/manualFabricMetadataClient.test.js`
Expected: FAIL，客户端模块尚不存在。

- [ ] **Step 3: Make add-task flow asynchronous**

`handleGenerate` 在添加白底任务时先批量预检文件名。成功项建立 pending rows；失败项建立不可运行的 error rows 并显示具体原因。一个 SKU 失败不能阻断同批其他 SKU。

- [ ] **Step 4: Preserve mixed 10/15 cm batches**

每行使用服务端返回的文件名尺寸；只有文件名无 `_detail_10/_detail_15` 时才使用顶部实拍尺寸。顶部选择仍作为同一批的 fallback，而不是覆盖明确后缀。

- [ ] **Step 5: Render catalog summaries**

队列副标题显示：SKU、`10/15 cm（文件名/顶部）`、`无花位/有花位`、成分、CSV 花位尺寸与循环数、Image 3 状态。长文本通过样式换行，不覆盖操作按钮。

- [ ] **Step 6: Run client tests**

Run: `node --test test/manualFabricMetadataClient.test.js`
Expected: PASS。

### Task 9: 双提示词编辑器与独立恢复

**Files:**
- Create: `test/manualPromptKind.test.js`
- Create: `public/manualPromptKind.js`
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`

**Interfaces:**
- Prompt editor selection values: `manual_product_plain`, `manual_product_repeat`。

- [ ] **Step 1: Write failing prompt-kind helper tests**

断言 UI 选择值只可映射到两个白底提示词槽，非法值回退无花位；保存/恢复只影响当前选择。

- [ ] **Step 2: Run test and verify failure**

Run: `node --test test/manualPromptKind.test.js`
Expected: FAIL，模块尚不存在。

- [ ] **Step 3: Add a clear prompt type selector to the dialog**

在“修改内置提示词”弹窗加入“无花位面料 / 有花位面料”选择。切换时加载对应文本；保存和恢复均操作当前类型，并在状态文案中写明类型。

- [ ] **Step 4: Keep runtime parameters visibly locked**

编辑器说明明确：SKU、成分、样本尺寸、CSV 花位尺寸、循环数量和 Image 3 图片职责由服务端运行时追加，编辑正文不能覆盖。

- [ ] **Step 5: Run prompt UI helper and HTTP tests**

Run: `node --test test/manualPromptKind.test.js test/promptSettingsResetHttp.test.js test/editablePromptReset.test.js`
Expected: PASS。

### Task 10: 本地历史记录与有效提示词留档

**Files:**
- Create: `test/localHistoryFabricMetadata.test.js`
- Modify: `public/localHistoryStore.js`
- Modify: `public/app.js`
- Modify: `server.js`

**Interfaces:**
- History entry stores `effectivePrompt` and `product.fabricMetadata`。

- [ ] **Step 1: Write failing normalization tests**

断言安全字段可保存/读取，路径字段、图片二进制或花位图绝对路径不会进入浏览器历史；无花位 null 字段保持 null，有花位数值保持 number。

- [ ] **Step 2: Run test and verify failure**

Run: `node --test test/localHistoryFabricMetadata.test.js`
Expected: FAIL，当前只保存帘头和样本尺寸。

- [ ] **Step 3: Save authoritative generation metadata**

`generateManualRow` 使用服务器返回的 `effectivePrompt` 和 `fabricMetadata` 写 IndexedDB；服务端非 client-history 路径同步扩展 `sanitizeProductMetadata`，确保历史页可复核本次使用的目录与数量。

- [ ] **Step 4: Run history tests**

Run: `node --test test/localHistoryFabricMetadata.test.js test/manualProductGenerationCatalog.test.js`
Expected: PASS。

### Task 11: 真实数据审计、全量回归与浏览器验收

**Files:**
- Create: `scripts/audit-manual-fabric-catalog.mjs`
- Modify: `README.txt`

- [ ] **Step 1: Add a read-only catalog audit script**

脚本读取默认 CSV、`32-10`、`32-15` 和完整花位图目录，输出：样本数、标准化 SKU 数、CSV 缺失、花位字段非法、有花位图缺失/重复、文件名尺寸未知。脚本不得修改任何素材。

- [ ] **Step 2: Run the audit against the real dataset**

Run: `node scripts/audit-manual-fabric-catalog.mjs`
Expected: 64 个样本、55 个标准化 SKU、27 个有花位 SKU；CSV 匹配、完整花位图匹配及花位字段均无阻断错误（若素材之后变化，以“0 阻断错误”为验收标准）。

- [ ] **Step 3: Run the complete test suite**

Run: `node --test`
Expected: 0 failures。

- [ ] **Step 4: Start 01 on an isolated verification port**

Run: `PORT=3461 npm start`
Expected: 服务正常监听，终端无启动错误。不要占用或覆盖用户当前其他版本的端口。

- [ ] **Step 5: Verify the browser workflow manually**

检查：

1. 上传一个 `_detail_10` 无花位 SKU：显示 10 cm、27/33/66 样本跨度、无 Image 3，最终请求两张参考图。
2. 上传一个 `_detail_15` 有花位 SKU：显示 15 cm、18/22/44 样本跨度、CSV 花位厘米及真实循环数，Image 3 已匹配，最终请求三张参考图。
3. 同批混合 10/15 cm 文件：每行尺寸独立正确。
4. 人为使用不存在 SKU：该行显示具体阻断错误，其余行可继续生成。
5. 两套提示词可分别编辑与恢复，旧 `manual_product` 覆盖不影响新默认值。
6. 生成历史含有效提示词、SKU、成分、样本尺寸、花位尺寸和数量。

- [ ] **Step 6: Document the new data contract and operator workflow**

README 写明默认目录、CSV 必需列、SKU 文件名规则、10/15 后缀优先级、无花位 `/` 规则、Image 3 职责、两类提示词编辑方式及常见阻断错误。

