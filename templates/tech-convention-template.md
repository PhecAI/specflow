---
name: [规范名称，如 frontend-standards]
description: [简短描述，如 React 前端核心编码规范]
globs: [匹配路径，如 src/frontend/**/*.{ts,tsx} 或 **/*.go]
alwaysApply: false
---

# [技术栈名称/端名称] 技术规范 (Tech Conventions)

> 本规范由系统分析师逆向提取生成，作为本端代码生成的绝对约束基线。

## 1. 核心基建与技术栈 (Tech Stack & Core Libraries)
- **核心框架**: [例如 React 18, Vue 3, SpringBoot 3]
- **核心生态**: 
  - 路由: [例如 react-router-dom v6]
  - 状态管理: [例如 Zustand]
  - 网络请求: [例如 axios, 统一封装在 src/utils/request.ts]
  - UI 组件库: [例如 Ant Design v5, Tailwind CSS]

## 2. 绝对红线与代码禁忌 (Red Lines & Forbidden Patterns)
- ❌ **[架构红线]**: [例如：禁止在 UI 组件内直接发原生 fetch 请求，必须调用 API 层封装函数]
- ❌ **[生态红线]**: [例如：处理时间禁止引入 moment.js，必须统一使用 dayjs]
- ❌ **[安全红线]**: [例如：禁止硬编码任何秘钥、Token 或环境变量，必须通过 process.env 读取]
- ✅ **[唯一推荐]**: [例如：前端函数组件强制使用 React Hooks，禁止使用 Class Component]

## 3. 命名规约与代码风格 (Naming & Style Conventions)
- **文件与目录**: [例如：React 组件文件必须使用 PascalCase.tsx，工具函数使用 camelCase.ts]
- **接口与模型**: [例如：请求入参类型以 Req 结尾，返回实体类型以 Resp 结尾]
- **静态检查**: [例如：严格遵循 ESLint 规范，禁止随意使用 @ts-ignore 或 any]

## 4. 黄金代码片段 (Golden Snippets - The "How-To")
[在这里提供 1-2 段从存量代码中提取的、最具代表性的标准代码片段，供大模型在后续开发中完美模仿。例如：一段标准的“带错误捕获和 Loading 状态的网络请求”该怎么写。]

```typescript
// 黄金代码片段示例 (请替换为真实项目代码)
```
