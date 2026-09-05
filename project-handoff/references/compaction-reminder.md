# 自动压缩计数与提醒回执

只有宿主注入计数状态、需要登记提醒回应，或配置/排查计数器时读取本页。提醒阈值为试运行策略，不是模型故障阈值。

## 提醒规则

- 第 1、2 次自动压缩不因次数提醒；第 3 次后，在最近一次进度汇报中提醒一次。提醒前收拢当前操作，但不等待新的大阶段、不附加“必须证明切换收益”的条件。
- 次数提醒只针对仍有明确后续工作的任务。纯问答、已结束的任务、讨论或修改本 Skill 不自动交接。
- 提醒已发出后，下一次次数提醒至少相隔 3 次新增自动压缩。用户回应“继续”后，从回应时的计数起至少再冷却 3 次。未回应仍继续已授权工作，不逐轮追问。
- 新的、已核实的目标/版本/约束混淆可以越过次数和冷却限制；先纠正，再说明具体问题。同一问题不重复提醒。普通报错、正常改需求不属于混淆。
- “本任务不提醒”关闭本任务所有主动提醒，持续到任务结束；用户显式交接请求仍执行。

## 计数事实

`scripts/compaction_reminder.py` 消费 Codex `PostCompact(auto)` 事件，`SessionStart(compact/startup/resume/clear)` 和 `UserPromptSubmit` 只读当前计数并按需注入短提示。手动压缩、恢复、用户说出“压缩”等文字不增加计数。同一回合可发生多次压缩，不能按 turn_id 去重。程序不分析用户文字来批准交接。

每个 session_id 独立保存到 `<CODEX_HOME>/state/project-handoff/`，仅含计数、提醒点、静默标记和固定回应类别；不保存聊天正文。计数只覆盖 Hook 启用后观察到的事件，旧任务不扫描历史补数。身份明确为子 Agent 的事件跳过；元数据格式无法辨认时，该隔离能力未获保证，不能声称已实测覆盖所有子 Agent 宿主。

## 登记实际提醒和回应

使用当前任务的真实 session_id；只能从宿主已提供的任务标识、当前事件或已核对的记录取得，不能用标题猜测。Windows 用 PowerShell 7 调用以下程序，替换尖括号参数：

```powershell
& '<PYTHON_EXE>' -X utf8 '<SKILL_DIRECTORY>/scripts/compaction_reminder.py' --state-dir '<CODEX_HOME>/state/project-handoff' --session-id '<当前任务ID>' --action status
```

- 提醒已通过交互工具发出成功后，把末尾改为 `--action notified --reason count`；实际混淆或阶段提醒分别使用 `confusion`、`stage`。
- 如果提醒只在最终回复中发出，本轮不能提前标记已送达；下一回合从可见历史核实后登记。Hook 注入、模型打算提醒均不是送达证据。
- 用户已明确选择继续、不再提醒、完整交接时，分别改为 `--action respond --response continue`、`mute`、`handoff`。只有回应当前交接提议才登记；“同意修改这个 Skill”不是交接同意。登记 handoff 不创建新任务，自动接续仍按 handoff.md 的授权与核验执行。
- 没有 Hook 或真实任务 ID 时，只在已有任务状态中记录；如实说明次数不可用，不能靠感觉补造次数。

## 部署和验证边界

第一版计数脚本使用 Windows 的 msvcrt 文件锁，仅验证 Windows。其他平台可用交接指令部分，不能直接宣称计数器兼容。安装 Skill 不等于安装或信任 Hook。
示例中的 <PYTHON_EXE>、<SKILL_DIRECTORY>、<CODEX_HOME> 必须替换为本机已核实的绝对路径（CODEX_HOME 未设置时通常为用户目录下 .codex），不能原样注册占位符。

配套配置为 `hooks/codex-hooks.example.json`，目标是用户级 `<CODEX_HOME>/hooks.json`。不得覆盖别的 Hook；新增或更新前对现有文件做合并检查和备份。现有 `config.toml` 无需改动。运行时计数与 Skill 都留在 Codex 用户目录，Grok 不自动同步。

Codex 要求在原生 `/hooks` 中审阅并信任当前 Hook 定义；未信任时会跳过。不能自行写信任数据库、添加托管策略或使用绕过信任参数来伪装启用。文件和脚本测试通过只能说明已部署；原生发现、信任、真实自动压缩后的注入与用户可见提醒是不同验证层级。

官方接口：https://learn.chatgpt.com/docs/hooks 。本适配器不修改自动压缩阈值，不调用额外模型，不注册定时任务，不自行保存业务交接材料或开启新任务。
