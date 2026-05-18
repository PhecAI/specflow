# Specflow — Implement vs Change 判定（参考）

> 本文是重型参考文档；`using-specflow` 只保留决策流与索引。

## 目标

在推进需求开发前，先把当前输入落到以下四件事上：

1. **目标需求**：你在操作哪个 `ai-docs/<requirementId>/`？
2. **相关性**：用户输入是否与该需求相关？
3. **变更类型**：是需求/合约/方案变更，还是纯实现推进？
4. **动作**：走 `sync-document`（change）还是走实现闭环（implement）？

### 需求变动的统一入口（含接口文档）

**业务侧变动**（PRD、AC、规则、验收）与 **技术侧事实变动**（接口路径、请求/响应字段、错误码、DB 列、第三方契约、**后补的接口文档/OpenAPI**）都属于 **需求变动**，不是「随便改两行代码」的实现细节。

- **接口文档**影响的是 **技术契约与实现**（通常先更新 `plan.md` 的 Contract / Feature，再动代码）；在入口应优先归类为 **合约变更**（命中下面「变更类型分类」第 2 条），走 **`orchestrator change` + `sync-document`**（常见 `--target plan`；若同时改业务口径用 `both`），再跑编排与 `implement`。
- **不要**假设「文档和产品需求变更不是一类」——入口只区分 **会变 spec/plan 的变动** vs **纯 Roadmap 推进**。

---

## 判定流程（建议先读一遍再执行）

### 1) 需求定位（Requirement Selection）

- **优先**：用户显式给了需求号/路径 → 选它
- **否则**：若存在“正在进行中”的需求 → 选当前 active（如引擎 `init` 返回推荐 id，则按引擎引导）
- **否则**：进入 `init`，让 your human partner 选/给需求号

### 2) 相关性判断（Relevance）

把输入分为三类：

- **强相关**：提到 AC、Roadmap task、接口名、文件路径、QA failure、日志、模块名
- **弱相关**：只说“继续/优化/修一下”，无指向；在 Specflow 会话里默认按强相关处理
- **不相关**：明确另一个需求号/完全不同模块/另一个项目目标

动作：

- 不相关 → 不推进当前需求；切换需求或新建需求
- 强/弱相关 → 进入下一步分类

### 3) 变更类型分类（Change Classification）

按优先级命中即停止：

1. **Spec/AC/外部行为变更**：新增/删减能力、改业务规则、改验收标准、改用户可见行为
  → `sync-document`（`--target specify|both`）→ 再跑编排
2. **合约/接口/Schema 变更**（含 **新到或更新的接口文档**：Swagger/OpenAPI、后端交付的 Markdown/PDF、飞书接口说明等）：API request/response、字段语义、DB schema、兼容策略、**以文档形式补齐的契约事实**
  → `sync-document`（`--target plan|both`）→ 再跑编排
3. **方案/设计变更**：架构/组件/存储/性能策略变化，但外部行为不变
  → `sync-document`（`--target plan`）→ 再跑编排
4. **纯实现推进**：按 Roadmap 实现/修 bug/补测试，不改变 1/2/3
  → 走 `orchestrating-specflow` implement/qa 闭环

---

## ✅ / ❌ 示例（高频）

### 示例 1：接口字段变更（Contract change）

**输入：**

> “把 response 里的 `foo` 改成 `bar`，并保持兼容一周。”

**❌ Bad：** 直接改代码与测试，把接口改了就提交。  
**✅ Good：** 先 `sync-document` 更新 plan 的 Contract（含兼容策略）→ 重跑引擎 → 再实现。

### 示例 2：改验收标准（Spec/AC change）

**输入：**

> “AC-3 改一下：允许为空，但需要默认值。”

**❌ Bad：** 直接按新 AC 改实现，但不更新 specify/plan。  
**✅ Good：** 先 `sync-document` 更新 specify（必要时 both）→ 重跑引擎 → 再实现/QA。

### 示例 3：只说“继续”（弱相关 → 默认相关）

**输入：**

> “继续。”

**❌ Bad：** 直接猜要做哪个文件/哪个任务。  
**✅ Good：** 跑编排拿 `suggestedAction`，按引擎派发并闭环。

### 示例 4：不相关请求（切换需求）

**输入：**

> “顺便把登录页也改一下。”（当前需求是支付）

**❌ Bad：** 把登录页改动塞进当前需求实现。  
**✅ Good：** 停止推进当前需求；让 your human partner 提供登录页需求号或新建需求。