# OpenCode 项目交接

把长任务的目标、有效决定、真实进度和下一步整理成接手材料，让新的对话核对后继续，避免重述和两个对话同时改。本仓库是 Table-skills 的 project-handoff 技能在 OpenCode v2 上的重写版本：技能文档沿用原有的评估规则，自动计数与提醒由一个新写的 OpenCode 插件承担，取代上游的 Python 计数脚本与 Codex、Claude Code 钩子模板。

## 适用环境

面向 OpenCode v2。技能与插件各走 OpenCode 的自动发现机制，安装即复制，不需要修改全局配置。

## 仓库结构

```
skill/          技能文档，安装到 ~/.config/opencode/skills/project-handoff/
plugin/         插件，安装到 ~/.config/opencode/plugins/project-handoff/
docs/           实现说明与实测结论
```

技能文档包含 SKILL.md 主入口、references 下的交接流程与计数参考、assets 下的项目状态模板。

## 安装

把 `skill/` 复制为 `~/.config/opencode/skills/project-handoff/`，把 `plugin/` 复制为 `~/.config/opencode/plugins/project-handoff/`。两者都位于 OpenCode 的全局发现目录下，OpenCode 会自动加载。

安装后需要删除任何项目本地的同名插件副本。storage 按 key 前缀共享，若同一项目下同时存在项目本地与全局两个插件实例，每次自动压缩会被计入两次。

技能权限默认在没有匹配规则时要求确认。若希望技能静默加载，在全局配置的技能允许列表中加入 project-handoff。

自动压缩需要处于启用状态，OpenCode 默认启用。若某个项目的配置将 `compaction.auto` 设为 false，该项目的插件不会收到压缩事件，计数保持为零。

## 工作方式

插件订阅会话的自动压缩事件，为每个会话维护独立的压缩计数与提醒状态。计数到达阈值或进入新的实质阶段时，插件把评估规则注入模型上下文，模型据此决定是否建议交接，并通过工具登记评估、准备建议、记录用户回应。建议是否真正送达以最终答复的首段为准，插件核验后才计入正式提醒。

分会话隔离依赖 `handoff:state:` 前缀加会话编号组成的存储键。插件编号或安装目录不参与隔离，更换它们不会区分数据。

## 与上游的差异

计数与提醒由 TypeScript 插件实现，不再依赖外部 Python 进程与宿主钩子。自动接续不自动新建会话，与上游的 Claude Code 版本一致，只保存材料并交付可复制的开场白。计数的触发事件选用压缩成功结束事件，被中断的压缩不计数。

## 实测结论

见 `docs/opencode-implementation.md`。其中记录了 OpenCode 事件流、storage 作用域、回合结束信号等若干与文档不一致、只能靠实测确认的行为。

## 许可

MIT。基于 Table-skills 的 project-handoff 改造，原始版权归 duoduoler-ops。
