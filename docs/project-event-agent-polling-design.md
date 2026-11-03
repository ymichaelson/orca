# GitLab 项目事件主动查询设计

- 日期：2026-11-03
- 状态：设计提案与工作量评估；尚未实现，也未在目标内网 GitLab 上完成接口验证。
- 范围：同一 GitLab 实例内约 10～20 个选定仓库，发现新 MR、新 Issue、MR 状态和代码变化。
- 部署约束：全部采集通过主动 API 请求完成，不依赖 GitLab webhook、公网回调、端口映射或隧道。
- 与既有设计的关系：本文提出替换[原设计](./project-event-agent-redesign.md)中的事件接收与 hook 注册方式；不改变项目规则、决策动作或 Agent 权限。现有 webhook 部署说明仍描述当前实现，本文不代表迁移已完成。

## 1. 结论

建议在项目执行主机上的 Orca runtime / orcad 中增加常驻轮询器，复用已有 GitLab 身份认证、事件账本、上下文读取和后续处理链。默认以 10 秒为起始轮询间隔，可按实际负载调整到 5 秒。无需让 GitLab 主动连接 Orca。

同一 GitLab 实例和兼容认证上下文中的多个项目可以合并查询，不必固定为“20 个仓库就发 20 次请求”。优先验证 GraphQL 批量查询，受分页、查询复杂度或版本限制时拆批，并支持 REST 作为兼容路径。一次 HTTP 请求不等于完整同步所有数据，也不代表服务端只执行一次数据库查询。

这是中等规模改造。限定核心范围，预计约 5～8 人日完成可用迁移与关键验证；如果还要完整覆盖评论、审批等细节并清理旧配置，粗估总计约 2～3 周。估算以熟悉项目的开发者为前提，需要目标 GitLab 验证后再收敛。

## 2. 目标、边界与事件语义

### 2.1 首期目标

- 发现选定项目新建的 MR 和 Issue。
- 识别 MR 的关闭、重新打开、合并等状态变化，以及标题、描述等相关字段变化。
- 通过 source head SHA / diff head SHA 识别 MR 最新代码变化；仅在需要时读取具体 diff。
- 将检测到的变化接入已有项目事件处理流程，保持同一 Inbox 事项的关联关系。
- 持久化同步进度，支持进程重启、网络中断后的恢复与补抓。
- 所有发现与补充读取均使用 API，不以 webhook 作为兜底前提。

### 2.2 接近实时，不承诺完整操作日志

每 5 秒查询一次时，健康情况下发现延迟约为 0～5 秒加 API 请求和处理时间；每 10 秒查询一次则相应变为 0～10 秒。分页、限流、网络故障、队列积压会增加延迟，应在状态中展示。

轮询观察的是资源状态。一个 MR 在两轮间被修改多次，可能只观察到最终版本；新建后又立即删除的对象也可能无法发现。因此，目标是发现新对象和可观察的状态变化，不是保证重放每一次用户操作。需要完整审计日志时，必须另行评估 GitLab 提供的审计或事件能力。

评论、审批、流水线等不自动视为已覆盖。若扩展这些能力，应分别验证查询接口、变化标识和补抓策略，不能假设所有变化都会可靠更新父对象的 `updated_at`。

首次接入默认先建立基线，不因导入历史对象而批量派发 Agent。基线期间发生的变化需要通过重叠扫描补获；基线策略和历史导入行为在实现前明确。

## 3. GitLab 查询能力与请求数量

这里的 pull 指调用 GitLab API 拉取信息，不是执行 `git pull`。拉取 Git 提交不能替代 MR、Issue、评论和审批等平台数据查询。

| 路径                 | 能力                                                                                    | 限制与用途                                                                                |
| -------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| GraphQL 合并查询     | 在一次 HTTP 请求中读取多个选定项目及其 MR / Issue；可通过 aliases 或 multiplex 组织查询 | 需要验证目标版本 schema、分页、复杂度、响应时间及部分错误；不能承诺 20 个项目永远一次完成 |
| 全局 REST MR 列表    | `GET /merge_requests?scope=all&updated_after=...`，查询当前凭证可访问的 MR              | `scope` 必须显式指定；本地按选定项目过滤，可能读取大量无关项目数据                        |
| 全局 REST Issue 列表 | `GET /issues?scope=all&updated_after=...`                                               | 同样需项目过滤；GitLab.com 的全局 scope 可能受限制，不能假设所有部署一致                  |
| Group REST 列表      | 查询同一 Group 下的 MR / Issue，再筛选选定项目                                          | 适合项目集中在少数 Group 的情况；需验证子组覆盖和权限                                     |
| 按项目 REST 列表     | 分别查询各项目的 MR / Issue                                                             | 兼容性路径；每轮通常至少约 `2 × 项目数` 次，再加分页和详情请求                            |
| 全局 Events API      | 提供部分活动记录                                                                        | 官方文档明确全局接口不返回 MR 相关事件，不能作为本方案唯一来源                            |

REST 常规分页默认每页 20 条，最大通常为 100 条；具体端点可能有额外限制。实现应读取分页信息并完整处理页面，而不是把“本轮最多读 100 条”当作已同步完成。

请求应按 GitLab 地址、认证身份及执行主机上下文分组。不同实例不能合成一个 GitLab HTTP 请求；不同凭证也不能为减少请求而合并权限或复用错误的账号。

### 3.1 请求预算示例

| 假设                                    | 每轮请求数 | 5 秒间隔的每分钟请求数 |
| --------------------------------------- | ---------- | ---------------------- |
| 一批 GraphQL 足够，且无分页、无详情补拉 | 1          | 12                     |
| MR / Issue 各一次列表，且无分页         | 2          | 24                     |
| 20 个项目分别查询 MR / Issue，且无分页  | 40         | 480                    |

这些只是计算示例，不是容量保证。详情补拉、notes、diffs、分页和失败重试需要另计。应先在目标 GitLab 测试查询大小、延迟和限流，再决定批量大小及轮询频率。

## 4. 推荐架构

```text
项目执行主机上的 Orca runtime / orcad
    → 按 GitLab 实例与认证上下文分组
    → 周期性查询选定项目的 MR / Issue 增量列表
    → 校验项目归属，对比持久化的已见状态 / SHA
    → 为变化项创建稳定去重标识并持久入队
    → 现有项目事件决策与动作处理
    → 必要时通过 API 补拉权威详情、notes、diffs
    → 汇总到现有 Inbox
```

客户端只展示和控制所属执行主机的采集状态。远端不可用时不得转到本地使用另一套凭证继续执行。

### 4.1 调度与负载

- 初始建议 10 秒间隔，允许在目标实例验证后调整为 5 秒；不把秒级数字作为实时性 SLA。
- 同一采集分组串行运行，上一轮未完成时不叠加启动下一轮。
- 对跨组请求设置有界并发；对变化项的详情读取同样限制并发。
- 无变化时只做轻量发现查询，变化后再读取完整上下文。
- 发生限流时尊重 `Retry-After` 等服务端提示；网络故障使用带抖动的退避，恢复后补抓。
- 避免只检查 `state=opened`，否则会漏掉关闭、合并等状态转换。
- 增量列表之外，安排成本可控的周期性校对，验证已跟踪 MR 的状态与 head，降低对 `updated_at` 行为的单点依赖。
- 停止 owner、移除项目或切换凭证时取消相关请求，防止旧轮次写入新配置。

### 4.2 同步进度与去重

新增持久化采集状态，至少记录采集分组 / binding 身份、配置版本、成功完成的时间边界、初始化状态、最近成功时间、错误和退避信息。MR 与 Issue 的进度独立管理；部分失败不得被整组成功掩盖。

每个已见对象记录稳定身份及状态摘要，例如项目数字 ID、对象类型、IID、`updated_at`、状态和 MR head SHA。去重键必须包含可区别状态版本的摘要，不能仅使用 IID 或客户端收到响应的时间。

增量查询使用重叠时间窗口，容忍时间精度和时钟差异；结合稳定排序及对象 ID 处理相同时间戳。对翻页期间数据变动的行为进行验证，必要时通过窗口重读和周期校对补偿。

只有页面处理成功、变化已持久入队后才能推进已完成游标。若分页中途失败，可以保留已持久化结果，但下轮必须从安全边界重读并依靠去重恢复。队列满、配置失效或认证失败时不得悄悄丢弃变化后推进进度。

同一数据库内应尽量用事务关联已见版本、变化入队和进度更新，避免崩溃后出现“进度已推进但事件未入库”。外部副作用仍使用现有动作层的幂等与恢复机制，不宣称端到端 exactly-once。

## 5. 原生订阅、反向代理与 n8n

### 5.1 GitLab 原生订阅

GitLab 确实提供部分 WebSocket / GraphQL subscriptions。当前上游源码可见 MR diff 生成、审批状态、合并状态、工作项及部分评论等订阅；也有仅覆盖当前用户作为 assignee / reviewer 的 MR 更新。

这些字段的版本、权限和作用范围不同，部分能力仍标记为实验性。当前上游支持不代表目标内网版本支持，也不代表覆盖选定项目所有新建 MR 和所有变更。

因此，原生订阅是后续可选的低延迟信号：收到通知后主动重读状态，断线后继续查询补抓。首期正确性不依赖订阅。实施前应核对目标版本的 schema 和实际订阅行为；UI 中的“订阅通知”设置也不等同于提供程序可消费的事件流。

反向代理可以转发已有 WebSocket 连接，无法生成 GitLab 未提供的订阅能力。GitLab Runner 的任务长轮询接口也不能用于订阅 MR / Issue 变化。

### 5.2 n8n 内网部署

n8n 可以使用 `Schedule Trigger → HTTP Request → 状态对比 / 去重 → 持久化结果` 实现主动查询。Schedule Trigger 支持秒级间隔；实际运行频率受执行耗时和部署资源影响。

n8n 内置的 GitLab Trigger 会创建项目 webhook，不符合本方案“只能主动查询”的约束，不能选它作为替代入口。

使用 n8n 仍需实现分页、持久化游标、基线、失败重试、并发控制和重叠执行保护。采集结果进入 Orca 还需要明确的认证、事件格式和幂等接入契约，不能直接假设兼容现有 webhook。

| 部署方式                      | 建议                                                            |
| ----------------------------- | --------------------------------------------------------------- |
| Orca runtime / orcad 内置采集 | 首选，复用现有凭证、账本、生命周期和下游                        |
| 独立内网采集服务              | 多系统共享采集，或要求脱离 Orca 运行时持续采集时再考虑          |
| 自托管 n8n                    | 已有 n8n 运维基础、需要可视化编排时可用，但不减少同步正确性工作 |

桌面关闭后能否继续采集，取决于所属 runtime / orcad 是否持续运行；移动端或桌面客户端无需各自重复轮询 GitLab。

## 6. 当前代码基础与改造点

当前实现入库的是原始 webhook delivery，下游再从 body 提取事实，并非已有独立于传输方式的完整标准事件层。

| 现有模块                                                                                                                                                                                                                      | 现状与改造方向                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [`forge-inbox-webhook-ingress.ts`](../src/main/forge-inbox/forge-inbox-webhook-ingress.ts) / [`forge-inbox-project-event-commit.ts`](../src/main/forge-inbox/forge-inbox-project-event-commit.ts)                             | 当前按路由、header、secret 验证并持久化原始 body；新增内部采集入队路径，不伪造 HTTP 请求绕过鉴权     |
| [`forge-inbox-project-event-decision-facts.ts`](../src/main/forge-inbox/forge-inbox-project-event-decision-facts.ts) / [`forge-inbox-project-event-subject.ts`](../src/main/forge-inbox/forge-inbox-project-event-subject.ts) | 依赖 webhook 的 `object_kind`、`object_attributes` 等结构；需要查询快照到内部事实的适配              |
| [`forge-inbox-project-binding-reconcile.ts`](../src/main/forge-inbox/forge-inbox-project-binding-reconcile.ts) / [`forge-inbox-owner-project-events.ts`](../src/main/forge-inbox/forge-inbox-owner-project-events.ts)         | 拆开项目身份解析、API 权限验证和 hook 注册；采集模式不再要求 callback URL、secret 或管理 hook 的权限 |
| [`forge-inbox-gitlab-api-client.ts`](../src/main/forge-inbox/forge-inbox-gitlab-api-client.ts)                                                                                                                                | 已有详情、notes、diffs 和现有 transport；需扩展可靠的增量列表 / 批量查询能力                         |
| [`forge-inbox-project-event-observation-snapshot.ts`](../src/main/forge-inbox/forge-inbox-project-event-observation-snapshot.ts)                                                                                              | 复用权威快照和稳定性校验；避免每轮对所有对象执行完整详情链                                           |
| [`forge-inbox-project-event-open-state-refresh.ts`](../src/main/forge-inbox/forge-inbox-project-event-open-state-refresh.ts)                                                                                                  | 只刷新已入库对象，不能发现新 MR / Issue，不能直接充当采集器                                          |
| [`forge-inbox-owner-service.ts`](../src/main/forge-inbox/forge-inbox-owner-service.ts) / [`forge-inbox-owner-running.ts`](../src/main/forge-inbox/forge-inbox-owner-running.ts)                                               | 接入现有 owner 的启动、网络就绪、取消、停止和队列唤醒生命周期                                        |
| [`forge-inbox-schema-project-event-tables.ts`](../src/main/forge-inbox/forge-inbox-schema-project-event-tables.ts)                                                                                                            | 增加采集进度和已见版本存储，设计迁移及旧程序拒绝不兼容 schema 的行为                                 |

首期建议新增明确的采集适配器，生成现有处理链可消费的 delivery / facts，尽量复用下游。兼容 payload 是内部过渡表示，不宣称它是 GitLab 实际发送的 webhook；应标注来源为 polling、观察时间和已知的变化字段。

API 快照不能还原精确的 webhook action。只能根据基线、历史状态和当前状态推断可证明的变化，无法判断时应表达为“观察到更新”，不能捏造评论、审批或用户操作事实。

## 7. 凭证、平台与配置兼容

- 复用项目执行主机上既有 `glab` 登录与凭证保护机制，不要求用户向项目配置粘贴新的 token，也不向 Agent 暴露凭证。
- 采集权限和 Agent 写操作权限分别判断。取消 hook 管理权限要求，不意味着自动允许评论、审批或合并。
- 按目标实例地址校验请求和项目归属，不能跨实例发送认证信息；保留现有 TLS 验证与凭证失效处理。
- 远端 host 独立采集，桌面、Web、移动端读取其状态；混合版本需明确能力协商。旧 host 不支持 polling 时显示不支持，不静默恢复 hook 注册。
- folder workspace 通过显式 GitLab 项目身份参与采集，不依赖工作目录一定是 Git worktree；多个 workspace 对应同一远端项目时避免重复采集。
- 复用现有跨平台进程和路径封装；实现时遵循[跨平台支持约束](./agents-md-refs/cross-platform-support.md)。
- 设置与状态展示遵循[样式指南](./STYLEGUIDE.md)。用最近成功查询、同步中、退避、认证失效等状态代替仅凭本地进程已启动就显示“已连接”。

## 8. 迁移顺序

1. **目标实例验证**：确认 GitLab 版本、MR / Issue API 权限、GraphQL 批量能力、分页、SHA 字段、限流及响应耗时；验证列表能捕获目标变化。
2. **采集核心**：增加增量读取、项目过滤、基线、游标、已见版本、入队适配及取消 / 退避。
3. **接入已有 owner**：复用决策与动作链、权威重读和现有凭证；展示采集健康状态。
4. **解绑 webhook 前提**：采集模式的启用、重验证和重启不再注册 hook，也不要求 receiver URL 或 secret。
5. **切换验证**：以明确边界停止旧入口对相关 binding 的准入，处理已入库 delivery；避免 webhook 和 polling 因去重键不同而重复派发。仅在有管理权限且确认归属时清理 Orca 管理的旧 hook，不碰其他集成。
6. **扩展与清理**：按需要增加评论、审批等采集，清理旧配置和 UI；保持历史事项及处理记录可读取。

本文仅记录设计；具体实施、移除远端 hook 或修改部署配置应在实施任务中执行。

## 9. 验收重点

- 10～20 个选定项目能发现新 MR / Issue，未选项目不入队；验证实际请求次数而非假设一次足够。
- MR 新提交、force push、关闭、合并、重开可被识别；明确不能完整还原中间操作的边界。
- 首次基线不触发历史任务风暴，基线期间的新变化能补抓。
- 超过一页、同时间戳、多页途中更新、部分查询错误不会静默丢失对象。
- 在入队与游标更新附近终止进程并重启，变化不丢失，重复观察不会重复派发。
- 认证失效、429、网络中断、队列满、项目移除和凭证切换能正确暂停、退避、取消和恢复。
- 运行中无需 webhook 接收端口；启用、重验证、重启不会偷偷注册 hook。
- 远端 runtime、folder workspace、多个 workspace 对应同一 GitLab 项目，以及旧版本客户端 / 服务端均有明确行为。
- 若接入 n8n 或订阅，分别验证其交付与恢复行为，不把信号到达当成权威状态或完整同步证据。

## 10. 工作量评估

| 范围                                                                           | 粗估                               |
| ------------------------------------------------------------------------------ | ---------------------------------- |
| 目标实例能力验证与变化检测原型                                                 | 1～2 人日                          |
| 核心迁移：新 MR / Issue、MR 状态与代码变化、持久化恢复、现有流程接线与关键测试 | 总计约 5～8 人日，包含前述验证     |
| 进一步彻底清理 webhook 数据模型、配置、UI / RPC 和旧生命周期                   | 总计约 8～12 人日，视兼容要求调整  |
| 同时完整扩展评论、审批等采集并完成额外验证                                     | 总计约 2～3 周，实际范围需再次确认 |

以上是不同范围的累计估算，不应逐行相加。主要复杂度在增量同步正确性、快照到事件的适配和 binding 生命周期，仓库数量本身不是主要改造成本。本文没有完成目标实例压测，也不构成性能或交付日期承诺。

## 11. 参考资料

- [GitLab GraphQL API：multiplex 与查询限制](https://docs.gitlab.com/api/graphql/)
- [GitLab MR API](https://docs.gitlab.com/api/merge_requests/)
- [GitLab Issue API](https://docs.gitlab.com/api/issues/)
- [GitLab REST 分页](https://docs.gitlab.com/api/rest/)
- [GitLab Events API 的覆盖限制](https://docs.gitlab.com/api/events/)
- [GitLab GraphQL 实时订阅说明](https://docs.gitlab.com/development/fe_guide/graphql/)
- [GitLab 上游订阅字段源码](https://github.com/gitlabhq/gitlabhq/blob/master/app/graphql/types/subscription_type.rb)（随版本变化，以目标实例为准）
- [n8n GitLab Trigger 源码](https://github.com/n8n-io/n8n/blob/master/packages/nodes-base/nodes/Gitlab/GitlabTrigger.node.ts)
- [n8n Schedule Trigger 源码](https://github.com/n8n-io/n8n/blob/master/packages/nodes-base/nodes/Schedule/ScheduleTrigger.node.ts)
