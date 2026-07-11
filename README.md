# gitcode-helper

收集 GitCode PR 链接与 `/approve`、`/lgtm` 标签,后台自动调用 GitCode API 在对应 PR 上发表评论。

## 它解决什么问题

在 GitCode 上给 PR 打 `/approve` / `/lgtm` 审批标签,本质是在 PR 评论里发一条以 `/approve` 或 `/lgtm` 为正文的评论。手工逐个 PR 复制粘贴很繁琐。这个小服务提供一个表单页:填 PR 链接、勾选标签、填提交人,提交后后台串行发评论,并记录每次提交与执行结果。

## 技术栈

- **Express** —— Web 服务与静态表单页托管
- **sql.js**(SQLite Wasm)—— 持久层,**无原生编译依赖**,跨平台开箱即用(选用 sql.js 而非 better-sqlite3 正是为免编译)
- **dotenv** —— 环境变量管理

## 项目结构

```
src/
  server.js     Express 路由 + 后端校验(POST /api/submit、GET /api/status/:id)
  db.js          sql.js 持久层,防抖写盘 + exit 兜底落盘
  gitcode.js     GitCode API 适配器(唯一与 GitCode 后端交互的模块)
  queue.js       轮询 worker:取 pending → 标 running → 串行发评论 → done/failed
  public/        前端表单页(index.html / styles.css / app.js)
test/            node:test 测试套件
data/            SQLite 数据文件(运行时生成,已 gitignore)
```

## 安装

```bash
npm install
```

## 配置

复制 `.env.example` 为 `.env` 并填写:

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `GITCODE_API_BASE` | 是 | GitCode API 根地址,默认 `https://api.gitcode.com/api/v5`(GitCode v5 API,类 Gitee v5。详见 https://docs.gitcode.com/docs/apis/) |
| `GITCODE_TOKEN` | 发评论必填 | GitCode Personal Access Token(个人设置 → 私人令牌生成,需 PR 评论权限)。留空则不发评论,只做表单校验 |
| `PORT` | 否 | 监听端口,默认 3000 |
| `ALLOWED_SUBMITTERS` | 否 | 提交人白名单,逗号分隔;留空表示不限制 |
| `DEDUP_WINDOW_MIN` | 否 | 防重复提交时间窗(分钟),默认 10。同一 PR 在窗口内仍有 pending/running 任务时拒绝重复提交 |

> `GITCODE_TOKEN` 仅服务端使用,绝不进前端。`.env` 已在 `.gitignore` 中。

## 启动

```bash
npm start          # 生产启动
npm run dev        # 开发模式(--watch 热重载)
```

启动后访问 `http://localhost:3000`。

## 测试

```bash
npm test
```

测试套件用 Node 内置 `node:test`,零新增依赖:
- `test/gitcode.test.js` —— `parsePrUrl` 纯函数单元测试(各种 URL 形态、中文路径、非法输入)
- `test/api.test.js` —— 端到端测试:submit 校验 → 入库 → worker 轮询(mock 掉 GitCode)→ 状态查询 → 防重复 → 历史列表
- `test/gitcode-http.test.js` —— `postPrComment` 真实 HTTP 回归测试(本地 mock server,验证请求方法/路径/鉴权/UA,防止 mock 掉整个函数后底层调用出错测不到)

## API

### `POST /api/submit`

提交一条 PR 标签任务。后端为校验最终防线。

**请求体(JSON):**
```json
{ "pr_url": "https://gitcode.com/{owner}/{repo}/pulls/{编号}", "labels": ["/approve"], "submitter": "你的名字" }
```

**校验规则:**
- `pr_url` 必填,且必须能解析出 `owner/repo/pr_number`(支持 `pulls`/`pull`/`merge_requests` 路径,支持 `.git` 后缀与末尾斜杠)
- `labels` 至少 1 个,且只能是 `/approve` 或 `/lgtm`
- `submitter` 必填;若配置了 `ALLOWED_SUBMITTERS`,则必须在白名单内

**响应:** `{ "id": <number>, "status": "pending", "message": "..." }`

### `GET /api/status/:id`

查询某条提交的状态与结果。

**响应:**
```json
{
  "id": 1,
  "status": "done",
  "pr_url": "https://gitcode.com/owner/repo/pulls/123",
  "labels": ["/approve"],
  "submitter": "alice",
  "result": [{ "label": "/approve", "ok": true, "status": 201 }],
  "created_at": "2026-07-11T03:45:00.000Z",
  "updated_at": "2026-07-11T03:45:02.000Z"
}
```

`status` 取值:`pending`(待处理)/ `running`(处理中)/ `done`(完成)/ `failed`(失败)。

### `GET /api/submissions`

提交历史列表(按 id 倒序,分页)。

**查询参数:** `limit`(默认 50,上限 200)、`offset`(默认 0)、`status`(可选,限定 pending/running/done/failed;非法值被忽略为全部)

**响应:**
```json
{
  "total": 42,
  "limit": 50,
  "offset": 0,
  "items": [{ "id": 1, "pr_url": "...", "labels": "/approve,/lgtm", "submitter": "alice", "status": "done", "result": "...", "created_at": "...", "updated_at": "..." }]
}
```

历史页前端在 `http://localhost:3000/history.html`,支持状态过滤与"加载更多"。

## 防重复提交

`/api/submit` 入库前会检查:同一 `owner/repo/pr_number` 在 `DEDUP_WINDOW_MIN`(默认 10 分钟)窗口内,是否仍有 `pending` 或 `running` 的任务。命中则返回 `409`:

```json
{ "error": "该 PR 在 10 分钟内已有提交(编号 3,状态 running),请勿重复提交", "id": 3, "status": "running" }
```

设计上以"提交时刻 + 活跃态"为准:任务一旦完成(done/failed),即可对该 PR 再次提交(如需追加标签);但正在排队或处理中的重复提交会被挡在源头,worker 永远看不到重复。

## 架构说明

### 适配器隔离
`gitcode.js` 是唯一与 GitCode 后端交互的模块。上层 `queue.js` 只调用 `parsePrUrl()` 与 `postPrComment()`。将来若改用真正的 `gitcode` CLI,只需把 `postPrComment` 内部从 HTTP fetch 换成 `child_process.execFile('gitcode', [...])`,上层与表单逻辑一行都不用改。

### 持久层
sql.js 默认在内存运行,`db.js` 每次写后 250ms 防抖落盘,并在 `process.on('exit')` 兜底同步写盘。代价:非正常崩溃可能丢最后 250ms 写入;对低频提交场景足够。

### worker
`queue.js` 每 2 秒轮询 `submissions` 表中 `status='pending'` 的记录,逐条:
1. 标记为 `running`(防同一 tick 内重复拾取)
2. 对 labels 里的每条标签**串行**调用 GitCode adapter 发评论
3. 全部成功 → `done`;任一失败 → `failed`
4. `result` 字段以 JSON 记录每条评论的成功/失败明细

串行发评论是为了避免并发对同一 PR 发评论产生竞态,也尊重 API 速率限制。

## GitCode API 端点

发评论调用:`POST {API_BASE}/repos/{owner}/{repo}/pulls/{number}/comments`
- GitCode v5 API(类 Gitee v5),PR 评论走 `pulls/{number}/comments`(与 issue 评论分开)
- 鉴权:`Authorization: Bearer {GITCODE_TOKEN}`
- 请求体:`{ "body": "/approve" }`(`body` 即标签正文)

> 踩坑:不要用裸 Gitea 的 `gitcode.com/api/v1` + `issues/{index}/comments` + `token` 鉴权——会被 GitCode 边缘 CloudWAF 拦截(HTTP 418 "访问被拦截")。必须走 `api.gitcode.com/api/v5` 子域 + `pulls` 路径 + `Bearer` 鉴权。
