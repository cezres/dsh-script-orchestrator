# Script Orchestrator

脚本编排领域的统一语言，用于澄清执行控制与触发计划的语义。

## Language

**Run control（执行控制）**:
已受理 run 从进行中到持久化终态的控制语义，统一表示取消与等待静止。
_Avoid_: 执行服务、运行辅助逻辑

**Execution driver（执行驱动）**:
一次 run 中脚本、判定与动作的具体执行语义，产生阶段进度、执行结果和可取消的执行活动。
_Avoid_: 运行控制器

**Trigger schedule（触发计划）**:
编排在其生命周期中决定下一次触发时机的计划语义，包含间隔、日历及 fixed-delay 的后继关系。
_Avoid_: 定时器工具、下一时刻计算
