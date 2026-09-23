# 恢复源码默认提示词 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为白底图和场景图增加独立、安全、可持久化的一键恢复源码默认提示词功能。

**Architecture:** 服务端提示词存储增加按类型删除覆盖值的 `reset(kind)`；HTTP 层通过 DELETE 接口暴露该能力；浏览器公共请求模块封装重置调用；白底图与场景图页面分别在确认后调用对应类型的重置接口。生成链路继续通过现有运行时提示词适配器读取当前有效值。

**Tech Stack:** Node.js ESM、原生 HTTP、原生 HTML/CSS/JavaScript、Node test runner。

## Global Constraints

- 只修改 `/Users/wangyuanzi/Documents/code/work2/qbh_detail_sence/sense-imagev1.0`。
- 白底图和场景图提示词独立恢复；禁止一次清空两类提示词。
- 恢复操作必须先确认，取消时不发送请求。
- 不改变源码默认提示词文本、模型和生成参数。
- 当前目录不是 Git 仓库，不执行提交步骤。

---

### Task 1: 提示词存储重置能力

**Files:**
- Create: `test/promptSettingsReset.test.js`
- Modify: `src/promptSettings.js`

**Interfaces:**
- Consumes: `createPromptSettingsStore({ filePath, defaults })`
- Produces: `store.reset(kind): Promise<string>`，返回该类型的源码默认提示词。

- [ ] **Step 1: Write the failing test**

测试先保存 `manual_product` 和 `curtain_creation` 两个自定义值，再调用 `reset("manual_product")`，断言返回白底图源码默认值、白底图读取回退默认值、场景图仍为自定义值，并在重新创建 store 后继续成立；非法类型必须抛出 `UNSUPPORTED_PROMPT_KIND`。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/promptSettingsReset.test.js`
Expected: FAIL，原因是 `store.reset is not a function`。

- [ ] **Step 3: Write minimal implementation**

在 `createPromptSettingsStore` 内提取原子写入函数：

```js
async function writeStoredValues(values) {
  // mkdir -> 写临时文件 -> rename；失败时删除临时文件
}

async function reset(kind) {
  assertPromptKind(kind);
  const next = { ...(await readStoredValues()) };
  delete next[kind];
  await writeStoredValues(next);
  return normalizedDefaults[kind];
}
```

返回对象包含 `{ readAll, get, save, reset }`。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/promptSettingsReset.test.js`
Expected: PASS。

### Task 2: HTTP 重置接口

**Files:**
- Create: `test/promptSettingsResetHttp.test.js`
- Modify: `server.js`

**Interfaces:**
- Consumes: `promptSettings.reset(kind)`
- Produces: `DELETE /api/editable-prompt-templates/:kind`，成功返回 `{ kind, prompt }`。

- [ ] **Step 1: Write the failing test**

启动真实 `createAppServer`，先 PUT 两类自定义提示词，再 DELETE `manual_product`。断言状态 200、返回源码默认白底提示词；随后 GET 断言白底图为默认值、场景图仍为自定义值；DELETE 非法类型断言 404。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/promptSettingsResetHttp.test.js`
Expected: FAIL，DELETE 当前返回 404。

- [ ] **Step 3: Write minimal implementation**

在现有 `editablePromptMatch` 分支中增加 DELETE 处理，沿用 PUT 的错误状态映射：`UNSUPPORTED_PROMPT_KIND` 为 404，其余存储错误为 500。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/promptSettingsResetHttp.test.js`
Expected: PASS。

### Task 3: 浏览器请求模块

**Files:**
- Create: `test/editablePromptReset.test.js`
- Modify: `public/editablePromptSettings.js`

**Interfaces:**
- Produces: `resetEditablePromptTemplate(kind, fetchImpl = fetch): Promise<string>`。

- [ ] **Step 1: Write the failing test**

传入本地 fake fetch，断言函数调用 `/api/editable-prompt-templates/manual_product`、method 为 DELETE，并返回响应中的 `prompt`；错误响应必须抛出服务端错误文本。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/editablePromptReset.test.js`
Expected: FAIL，模块尚未导出 `resetEditablePromptTemplate`。

- [ ] **Step 3: Write minimal implementation**

校验 kind，发送 DELETE，解析 JSON；非 2xx 抛出 `payload.error || "恢复默认提示词失败"`，成功返回非空 `payload.prompt`。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/editablePromptReset.test.js`
Expected: PASS。

### Task 4: 白底图与场景图按钮

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/creation.html`
- Modify: `public/creation.js`

**Interfaces:**
- 白底图按钮 ID：`resetMainPrompt`
- 场景图按钮 ID：`resetCreationPrompt`
- 两页均调用 `resetEditablePromptTemplate`，分别传入 `manual_product`、`curtain_creation`。

- [ ] **Step 1: Add the controls and event handlers**

在各自“修改提示词”按钮之后增加 `<button type="button">恢复默认提示词</button>`。事件处理先调用 `window.confirm`；确认后禁用按钮，await DELETE 请求，成功后更新状态文本，finally 恢复按钮。

- [ ] **Step 2: Verify the user-visible behavior**

通过本地页面检查两个功能页均显示恢复按钮；取消确认不会发请求；确认后对应提示词回到源码默认值，另一类型保持不变。

### Task 5: 完整回归与交付校验

**Files:**
- Modify: `README.txt`

- [ ] **Step 1: Document the recovery behavior**

在使用说明中增加：修改提示词保存后永久生效；点击“恢复默认提示词”只恢复当前功能并回退源码默认值。

- [ ] **Step 2: Run the complete test suite**

Run: `node --test`
Expected: 0 failures。

- [ ] **Step 3: Verify the Windows package**

Run: `node scripts/verify-release.mjs /Users/wangyuanzi/Documents/code/work2/qbh_detail_sence/sense-imagev1.0`
Expected: `Windows release verification passed`。

- [ ] **Step 4: Confirm prompt config was not unintentionally changed**

检查 `config/prompts.json`，不得残留测试提示词；本次功能开发不修改源码默认提示词内容。
