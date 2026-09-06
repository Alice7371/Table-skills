# 自动压缩计数与提醒回执

只有宿主注入提醒状态、需要准备建议或登记回应、配置/排查计数器时读取本页。次数是试运行策略，不是模型故障阈值。

## 提醒规则

- 第 1、2 次压缩不因次数提醒；首次到第 3 次后，在操作安全收拢、仍有明确后续时提醒。本轮建议必须进入最终答复，进度消息不替代最终展示。
- 一次提醒之后，普通再提醒须同时满足：新实质阶段、具体切换收益、至少新增 3 次压缩。次数只解除冷却，新阶段不能越过冷却。版本号变化、调参和重渲染不是新阶段。
- 用户回应“先不交接／继续做”后，从回应时再冷却至少 3 次；指定“做完 X 再提醒”则以 X 为准。未回应不追问，已交付的建议不逐轮重贴。
- 新的已核实混淆先纠正，可越过次数和指定节点限制；同一问题只提醒一次。“本任务不提醒”仍优先，用户主动恢复或显式交接请求除外。
- 纯问答、无后续、讨论或修改本 Skill 不主动提醒。提醒与交接授权分开。

## 计数事实

`scripts/compaction_reminder.py` 只在 Codex `PostCompact(auto)` 增加压缩次数；`SessionStart` 和 `UserPromptSubmit` 注入当前状态并记录宿主提供的真实 turn_id；`Stop` 只核对本轮已经准备的建议。手动压缩、恢复、注入次数、工具调用和文字出现“压缩”都不计数。同一回合可以多次自动压缩，不能按 turn_id 去重。

每个 session_id 独立保存到 `<CODEX_HOME>/state/project-handoff/`。仅保存计数、阶段/问题标识、回应类别、用户指定节点、一条最多 600 字的待交付建议及展示回执；不保存完整聊天、不扫描历史。身份明确为子 Agent 的事件跳过；无法识别的元数据不能声称已隔离。

旧 JSON 保留原字段，通过附加 `tracking_version: 2` 字段兼容升级；`status` 真正只读，不创建锁文件、不写回。旧状态只记录了最后一次提醒位置时，`reminder_count` 为 null（历史总数未知），`tracked_reminder_count` 只累计新版核验的次数；不得把 `last_notified_at` 当提醒总数。比如 `auto_count=10`、`last_notified_at=10` 表示累计压缩 10 次、上次提醒发生于第 10 次。

## 准备、展示与回应

使用当前任务的真实 session_id、turn_id：来自宿主事件/状态或已核对的记录，不用标题猜测；`active_turn_id` 可从状态读取。没有可靠标识时不用猜值调用脚本，沿用已有任务状态和最终答复自检。Windows 使用 PowerShell 7：

```powershell
& '<PYTHON_EXE>' -X utf8 '<SKILL_DIRECTORY>/scripts/compaction_reminder.py' --state-dir '<CODEX_HOME>/state/project-handoff' --session-id '<当前任务ID>' --action status
```

以下参数接在同一程序和 `--state-dir`、`--session-id` 后。尖括号必须替换成当前事实；命令执行成功仍要检查 `prepared` 是否为 true，false 代表未通过提醒条件，不应发出建议。

| 动作 | 参数与依据 |
| --- | --- |
| 提醒前准备 | `--action prepare --turn-id '<当前回合ID>' --reason count --stage-key 'opening-design' --safe --has-next --notice '交接建议：<具体原因、接续第一步和确认覆盖的动作>'`；safe 与 has-next 只能在实际安全、有明确后续时提供 |
| 阶段提醒 | 上行 reason 改 `stage`，加 `--benefit`；stage-key 使用稳定业务阶段，不能把版本号、日期或回合号当阶段 |
| 新混淆 | reason 改 `confusion`，加 `--benefit --cause-key '<本次已纠正问题的稳定标识>'`；同一问题不能换标识重提醒 |
| 用户指定节点已到 | reason 改 `checkpoint`，加 `--checkpoint-key '<此前登记的节点标识>'`；Agent 核实节点确已达到，程序只核对标识 |
| 进度消息已实际发出 | `--action notified --turn-id '<原展示回合ID>' --proposal-id '<prepare返回的id>' --channel commentary`；准备或 Hook 注入不能登记为展示 |
| 用户回应继续 | `--action respond --turn-id '<用户回应所在回合ID>' --proposal-id '<当前建议id>' --response continue`；只登记对该建议的明确回应，同一回应不换 ID 重记 |
| 指定以后节点 | 上行 response 改 `defer`，加 `--checkpoint-key 'sample-ready'`；在已有任务记录中保留该标识对应的用户约定 |
| 本任务静默 / 恢复 | `--action respond --turn-id '<回应回合ID>' --response mute` 或 `resume`；仅用户明确要求时使用 |
| 完整交接同意 | 回应参数使用 `handoff`；这只停止主动提醒，实际交接按 handoff.md 的授权核验执行 |
| 本轮建议失效 | `--action cancel --proposal-id '<当前建议id>'`；任务无后续或建议已不适用时撤销，不伪装为用户拒绝 |

`notice` 是最终答复末尾的一段正文，以“交接建议：”开头，写清实际建议而不是规则说明；可以加粗，不放进引用、示例或代码块。进度消息和最终答复共用 proposal_id，只累计一次实际提醒；最终展示不再次重置冷却。

`Stop` 从宿主的 `last_assistant_message` 核对当前 turn_id 的 notice，不读取完整对话。漏写且本轮尚未补写时，最多请求一次保留成果答复并补齐建议；仍漏写则记录未核验并警告，不循环、不虚报送达。它只检查已 prepare 的建议，不能替 Agent 判断阶段或保证零漏报；“最终文本包含建议”也不代表用户已经阅读。

没有可用 Stop 时，下一回合核对可见历史，使用 `--action notified --turn-id '<原展示回合ID>' --proposal-id '<原建议id>' --channel final` 补记；当前回合不能提前标记最终送达。被中断的建议只有在核对最新回应、确认仍适用后才能重新 prepare，本轮不要因为旧建议未回应就自动重贴。

## 部署和验证边界

计数脚本使用 Windows 的 msvcrt 文件锁，仅验证 Windows。其他平台可用交接指令部分，不能直接宣称计数器兼容。安装 Skill 不等于启用 Hook。
示例中的 `<PYTHON_EXE>`、`<SKILL_DIRECTORY>`、`<CODEX_HOME>` 必须替换为本机已核实的绝对路径（CODEX_HOME 未设置时通常为用户目录下 .codex），不能原样注册占位符。

配套配置为 `hooks/codex-hooks.example.json`，目标是用户级 `<CODEX_HOME>/hooks.json`，新增 Stop 条目时保留其他 Hook。更新前合并检查并备份；现有 `config.toml` 无需改动。计数与 Skill 都留在 Codex 用户目录，Grok 不自动同步。附加状态字段保留旧计数，回退脚本时不回滚运行期间新增的真实压缩计数。

Codex 要求在原生 `/hooks` 中审阅并信任当前 Hook 定义；未信任时会跳过。不能自行写信任数据库、添加托管策略或使用绕过信任参数来伪装启用。文件和脚本测试通过只能说明已部署；原生发现、信任、真实自动压缩后的注入与用户可见提醒是不同验证层级。

官方接口：https://learn.chatgpt.com/docs/hooks 。脚本不联网、不调用模型 API；只有最终漏写时，Stop 会让宿主最多补一轮答复，消耗正常任务用量。它不修改自动压缩阈值、不注册定时任务、不自行保存业务交接材料或开启新任务。
