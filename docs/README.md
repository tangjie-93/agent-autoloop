# 文档索引与来源

本目录按用途区分项目文档、本分支补充说明和本地运行指南。本地 `Windows` 电脑优先原生部署，`WSL2` 仅为需要 `Linux` 工具的备用方案；`macOS` / `Linux` 的常规安装与启动仍见 [`INSTALL.md`](../INSTALL.md)。

## 1. 从哪里开始

| 目的 | 阅读入口 |
| --- | --- |
| 原生 `Windows` 安装、启动中台和前端 | [原生 Windows 部署](local/windows-native-deployment.md) |
| Linux 专属 Agent 或依赖需要 `WSL2` | [WSL2 备用部署](local/wsl2-deployment.md) |
| 阅读后端调用链、准备二次开发 | [二次开发导览](local/developer-onboarding.md) |
| 开发插件、查协议或业务状态 | [插件](plugins.md)、[协议](protocol.md)、[状态与转换](state-machines.md) |
| 安装和跨平台验证 | [安装说明](../INSTALL.md)、[流程操作台](../frontend/README.md) |

## 2. 上游文档

“官方”指项目上游 `KKKKhazix/agent-autoloop`，不是模型厂商文档。

| 文档 | 内容 |
| --- | --- |
| [插件开发](plugins.md) | 插件约定、示例与浏览器接入 |
| [状态与转换](state-machines.md) | 事件、事项、轮次、卡片及交付状态 |
| [英文架构图](architecture.en.svg) | 上游系统架构 |

## 3. 本分支修改的文档

| 文档 | 内容 |
| --- | --- |
| [通信协议](protocol.md) | 独立前端、事实流、鉴权与部署说明 |
| [中文架构图](architecture.svg) | 本分支扩展的客户端和运行关系 |

## 4. 本地运行指南

- [原生 Windows 部署](local/windows-native-deployment.md)：默认方案，覆盖安装、登录任务、前端、并发、日志和故障排查。
- [WSL2 备用部署](local/wsl2-deployment.md)：唯一保留的 WSL 方案，覆盖 Linux Agent、路径边界和切换方式。
- [二次开发导览](local/developer-onboarding.md)：调用链、扩展点、状态和测试入口，不重复部署步骤。

## 5. 维护约定

- 修改平台支持、启动命令或路径时，同步检查 `INSTALL.md`、两个 `README`、`frontend/README.md`、协议、示例和本索引。
- 原生 `Windows` 与 `WSL` 的数据目录、依赖和 `Agent` 登录分开维护，不自动迁移、不复制秘密文件；原来的 `Windows Codex` 配置可以保留。不要把某台机器的验收记录当成通用部署步骤。
- 新的真实验收结果应记录环境、命令和结果；历史记录不得覆盖当前主部署方案。
