# S2 protected-paths Phase B 复审第 1 轮

- 日期：2026-10-21。只读复审，未运行任何测试/进程。基线 HEAD 116e1a6；对象 s2pb-code.diff（6 文件，新增 protected-mounts.ts 269 行 + protected-paths-docker.test.ts 530 行 + launch/session 接线 + sandbox.yaml + docker-backend 测试收紧）。

## 结论：request_changes（仅 1 项必修，测试标题措辞）

## R-S2PB-1（必修）：init 流形测试标题与实测矛盾

TAP ppd-v4-1 实测输出：`[init 流形残余实测] .git/config 可写（残余成立）；.git/hooks 可写（残余成立）`。但该用例标题为「…；hooks 被护；config 残余如实记录」——hooks 在 init 流形下并无 FS 保护（.git 整体在 rw 面，agent 可 mkdir+写 hook；GIT_TEMPLATE_DIR 仅阻断样本拷贝，样本本就惰性）。标题构成虚假保护声明，违反计划 §"不得合并谎称闭合" 的记账纪律，且会以 "hooks 被护 ok" 形态永久留在每次 TAP/报告里。用例体、console.log 与计划 §3 ① 的记录全部如实，故仅须改标题（如「…；模板样本拷贝被阻；.git/config 与 .git/hooks 可写残余如实记录」），零逻辑改动。

## (1) 挂载派生安全性：通过

- 派生只读 deny_paths（require_approval/deny_reads 不产生挂载，语义正确）；通配符条目固定类别 uncovered 不假装覆盖；`**/**/` 折叠、结尾 `/**` 先剥离再查通配（修复②已在最终 diff 中：8 目录条目回归 21 条清单且单测逐条钉死，该 bug 在现树上必被 "21 个确定目标" 断言抓出）。
- 注入面：`..`/空段/`.`/NUL/根/`.git` 整体全拒；规范化后 resolve+startsWith(workspace+sep) 双保险，宿主侧来源恒在 workspace 内；stub 文件 `flag:"wx"`（O_EXCL 对 symlink 必失败，竞态下不会写穿链接）；symlink 目标 lstat 拒挂；`.git` 门控要求真实目录非链接；已有内容零改写（测试钉死 REAL-CONFIG/CUSTOM=1 原样）。
- 祖先去重正确（含前缀全查）。理论性 note（不阻塞）：lstat 与 stub/挂载间的 TOCTOU 窗口要求攻击者在容器启动前写宿主 workspace，实际不可达；file 祖先+子孙同现的策略形状为理论边角。

## (2) clone 让位与 .git 门控：如实但必须按流形定级

repoUrl 是网关级配置（server.ts:106/1285），且 SCM 生产创建流（gitGrants 签发）以 repoUrl 为前提（:1258-1262 fail-closed）——即 SCM 集成生产部署的每个会话都走 clone 流形，受保护挂载与 stub 整体让位，FS 面保护为零，只剩词法 deny_paths。结构性原因真实（git clone 需空目录、运行中容器无法后补 bind），launch/protected-mounts 注释与计划 §3 ① 均如实声明。定级结论：**s2-protected-paths 整体仍为 partial**——host-workspace/pre-seeded 流形取得经红队实证的内核级闭合（21/26 条映射，5 条通配符如实未覆盖）；clone/SCM 生产流与容器内 init 流形的 .git 面未被本包闭合。后续完成文档必须按流形分账，不得以挂载流形的绿测代表 repoUrl 部署形态；可选后续方向：宿主侧预 clone 或 clone-后置换以闭合 clone 流形。

## (3) 见 R-S2PB-1。

## (4) GIT_TEMPLATE_DIR 与 -e 过滤：不破坏既有不变量

- ro tmpfs（1m，noexec/nosuid/nodev）置于 /var/perimeter，刻意避开 /opt/perimeter 网关代码命名空间——durable 「不挂 /opt/perimeter」断言原样保留；docker-backend.test 对 -e 清单的期望收紧为恰好 [HOME, GIT_TEMPLATE_DIR] 两条（收紧非放宽）。
- 模板目录只影响 init/clone 的样本拷贝；正控用例证明容器内 git add/commit 正常、.git/config 零写入。agent 在 shell 内自行覆盖 GIT_TEMPLATE_DIR 只在 .git 本就可写的流形里有意义（已是声明残余），无新洞。
- 挂载顺序：RO bind 紧跟 workspace 之后追加，排序确定性钉死；launch 不触碰 Docker 所有权台账/fullCID/nonce/reapOrphans 语义。

## (5) 红队真实性：真测、无放宽

- BREACH 门为真实容器内评估（launch argv + sh -c，network none）：任一写入成功即打印 BREACH → 断言失败；目录/文件两组覆盖新建/覆盖/追加/cp/mv 进出/rm/chmod/mkdir/ln -sf，ln -s 别名写单独一组（同 inode 挂载点只读），node 解释器 7 项全拒（NODE-DENIED:7），python 如实记录（镜像未内置，不虚构错误形态）。
- 宿主字节断言用 Buffer deepEqual（修复③：equal 引用比较永假，修复前 BREACH 门已独立通过——字节 oracle 此前缺失而非误绿，披露如实）；三份正控（普通写/子目录/git commit + init 流形）证明拒绝非因无关原因。
- skip 纪律（docker/镜像缺失给因）、--rm + finally rmSync、有界超时组杀，沿用所有权纪律；协调者三连跑 18/18、无残留容器。

## (6) 残余定级：如实

hardlink（RO 是挂载旗标非 inode 旗标；实测 darwin HARDLINK-BLOCKED:ln-failed——Linux 预期 write-through 可写成残余，测试三结局如实接受、字节还原、产物清理，不声称闭合）；嵌套同名只受词法策略；HOME/.gitconfig 与 core.hooksPath 在挂载面外（egress deny-all+凭据不进沙箱兜底）；K8s subPath 生成物与派生清单单测同源钉死、external_blocked 未集群验证且文件型 subPath 语义存疑已注明——各级均与计划 §6 对齐，无夸大。

## 核对范围声明

逐行核对 protected-mounts.ts 全文、launch 接线 hunk、session.ts 透传、两个测试文件全文、sandbox.yaml 新增段、docker-backend.test 期望变更；对照 config/policy.yaml 实际 26 条 deny_paths 复核 21+5 映射；核验 TAP ppd-v4-1（18/18，hardlink 与 init 残余实测行）；追查 repoUrl 全链路（server/session/LaunchContext）。未重审未改动文件。
