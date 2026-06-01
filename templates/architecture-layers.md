# Architecture Layers

> 本文件描述当前项目自己的代码分层画像。SpecFlow 不预设前端/后端层名；由 agent 基于目录、配置、既有代码和规范生成并迭代维护。
> 初始化阶段只写低风险骨架；需求中发现的新分层先作为候选，归档评审通过后再稳定进入本文件。

## Layer Template

### `<layer-id>`

- globs:
  - `<layer-level-glob>`
- role: `<一句话说明该层职责>`
- should:
  - `<该层应该承担的稳定职责>`
- should_not:
  - `<该层不应该承担的职责或依赖>`
- evidence:
  - `<目录、配置或典型文件证据>`

## Layers

- (empty)
