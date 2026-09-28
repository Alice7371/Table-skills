# ZCODE_COMPATIBILITY — project-handoff 在 ZCode 下的兼容性判定(2026-09-27 安装时核查)

来源:https://github.com/duoduoler-ops/Table-skills/tree/main/project-handoff(原生态为 OpenAI Codex CLI 生态)。
本文件是安装时的兼容性核查结论,上游 6 个文件未做任何改动。

## 判定矩阵

| 组件 | 兼容性 | 说明 |
|---|---|---|
| `SKILL.md` 核心工作流(评估/保存/恢复/完整交接) | ✅ 直接可用 | 全文宿主无关:无 CODEX_HOME、无脚本路径、无英文 compaction/hook 事件硬编码;frontmatter `name: project-handoff` + 中文 description 符合 ZCode 技能格式(参照 s2600-power 先例) |
| `references/handoff.md`(交接文档五类目协议) | ✅ 设计上即宿主无关 | 文档明示 Codex 线程工具(list_projects/create_thread/wait_threads 等)"仅为接口示例,以当前会话实际暴露的工具为准"——ZCode 对应:Agent 工具、SendMessage、ReadSessionContext、CronCreate 等 |
| `references/compaction-reminder.md` + `hooks/codex-hooks.example.json` + `scripts/compaction_reminder.py` | ⚠️ Codex 专属,**默认休眠** | 为 Codex hooks 体系写的自动压缩提醒;ZCode 有对应能力但需适配,见下节 |
| `agents/openai.yaml` | 惰性 | 非 ZCode 格式,保留作元数据参考,不生效 |

## 入口词差异

上游入口词 `$project-handoff` 不是 ZCode 的斜杠命令语法。在 ZCode 里:
- 下一会话起,技能列表会出现 **project-handoff**,输入 `/project-handoff` 调用;
- 或直接用自然语言说"做一次 project-handoff 交接 / 保存进度准备交接 / 恢复交接"。

## hooks 自动提醒:ZCode 映射关系(未接线,留作可选启用)

ZCode hooks 支持 7 个事件:SessionStart、UserPromptSubmit、PreToolUse、PermissionRequest、PostToolUse、PostToolUseFailure、Stop(见 zcode-guide:diagnosing-hooks)。与 Codex 事件的映射:

| Codex 事件 | ZCode 对应 | 保真度 |
|---|---|---|
| `SessionStart`(matcher `^(startup\|resume\|clear\|compact)$`) | `SessionStart` 同名事件、matcher 完全相同 | ✅ 精确 |
| `UserPromptSubmit` | `UserPromptSubmit` 同名 | ✅ 精确 |
| `Stop` | `Stop` 同名(ZCode 可请求续跑,最多 3 次) | ✅ 概念一致 |
| `PostCompact(auto)`(仅自动压缩计数) | `SessionStart` matcher `^compact$` | ⚠️ 近似:ZCode 无独立 PostCompact 事件,**自动/手动压缩的区分未经验证**(脚本按"仅自动压缩计数"设计) |

状态目录映射:`<CODEX_HOME>/state/project-handoff` → `C:\Users\alice\.zcode\state\project-handoff`。

### 启用步骤(想做时再做)
1. 编辑 `C:\Users\alice\.zcode\cli\config.json`,加入(默认禁用,必须显式开):
```json
{
  "hooks": {
    "enabled": true,
    "events": {
      "SessionStart": [
        { "matcher": "^(startup|resume|clear|compact)$",
          "hooks": [ { "type": "command",
            "command": "python -X utf8 C:/Users/alice/.zcode/skills/project-handoff/scripts/compaction_reminder.py --state-dir C:/Users/alice/.zcode/state/project-handoff --session-id <SESSION_ID> --action status",
            "timeoutMs": 5000 } ] },
        { "matcher": "^compact$",
          "hooks": [ { "type": "command",
            "command": "python -X utf8 C:/Users/alice/.zcode/skills/project-handoff/scripts/compaction_reminder.py --state-dir C:/Users/alice/.zcode/state/project-handoff --session-id <SESSION_ID> --action evaluate",
            "timeoutMs": 5000 } ] }
      ],
      "UserPromptSubmit": [ { "hooks": [ { "type": "command",
        "command": "python -X utf8 C:/Users/alice/.zcode/skills/project-handoff/scripts/compaction_reminder.py --state-dir C:/Users/alice/.zcode/state/project-handoff --session-id <SESSION_ID> --action status",
        "timeoutMs": 5000 } ] } ],
      "Stop": [ { "hooks": [ { "type": "command",
        "command": "python -X utf8 C:/Users/alice/.zcode/skills/project-handoff/scripts/compaction_reminder.py --state-dir C:/Users/alice/.zcode/state/project-handoff --session-id <SESSION_ID> --action status",
        "timeoutMs": 5000 } ] } ]
    }
  }
}
```
2. 先跑冒烟:`--action status`(只读)确认脚本在 ZCode 环境可运行,再启用 evaluate。

### 未验证项(启用前须知)
- **stdin 契约**:脚本按 Codex 的 hook 输入格式解析 stdin(如 `stop_hook_active`、`turn_id`);ZCode 的 hook stdin schema 不同,脚本的哪些分支能工作需要冒烟验证。
- **session_id 可用性**:`<SESSION_ID>` 占位符要求 ZCode hook 输入里携带会话标识,未确认。
- **自动压缩识别**:见映射表 ⚠️ 项。
- `additionalContext` 注入:ZCode 支持(严格 JSON 输出 schema),但脚本的输出键需对照 ZCode schema 校验,多余键会导致整条输出被丢弃。

## 结论

**核心交接/恢复/文档协议:兼容,立即可用(下次会话起)。** hooks 自动压缩提醒:能力上可适配但属实验性,默认未接线——不影响手动交接的任何功能;想用时按上节步骤启用并先做只读冒烟。
