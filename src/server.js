// Express 服务端
//
// 路由:
//   GET  /                  → 静态表单页(public)
//   POST /api/submit        → 校验并入库,返回 {id, status:'pending'}
//   GET  /api/status/:id    → 查询单条提交状态与结果
//
// 校验规则(后端为最终防线):
//   pr_url    必填,且必须能解析出 owner/repo/pr_number
//   labels    至少选 1 个,且只能是 /approve 或 /lgtm
//   submitter 必填;若配置了 ALLOWED_SUBMITTERS,则必须在白名单内

require('dotenv').config();
const path = require('path');
const express = require('express');
const db = require('./db');
const { parsePrUrl } = require('./gitcode');
const queue = require('./queue');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
// 监听地址:0.0.0.0 = 绑定所有网卡,允许外部 IP 访问;127.0.0.1 = 仅本机。
// 注意:本服务无鉴权,开放外部访问时务必配置 ALLOWED_SUBMITTERS 白名单。
const HOST = process.env.HOST || '0.0.0.0';
const ALLOWED_LABELS = new Set(['/approve', '/lgtm']);
const ALLOWED_SUBMITTERS = (process.env.ALLOWED_SUBMITTERS || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
// 同一 PR 去重时间窗(分钟):在此窗口内,若该 PR 仍有 pending/running 任务,拒绝重复提交。
const DEDUP_WINDOW_MIN = parseInt(process.env.DEDUP_WINDOW_MIN || '10', 10);

// POST /api/submit
app.post('/api/submit', (req, res) => {
  const pr_url = String(req.body.pr_url || '').trim();
  const rawLabels = Array.isArray(req.body.labels) ? req.body.labels : [];
  const submitter = String(req.body.submitter || '').trim();

  // 1. 必填校验
  if (!pr_url) return res.status(400).json({ error: 'PR 链接必填' });
  if (!submitter) return res.status(400).json({ error: '提交人必填' });

  // 2. 标签校验:至少 1 个,且只能是白名单标签
  const labels = rawLabels.map((s) => String(s).trim()).filter(Boolean);
  if (labels.length === 0) return res.status(400).json({ error: '至少选择 1 个标签(/approve 或 /lgtm)' });
  if (!labels.every((l) => ALLOWED_LABELS.has(l))) {
    return res.status(400).json({ error: '标签只能是 /approve 或 /lgtm' });
  }

  // 3. PR URL 解析
  const parsed = parsePrUrl(pr_url);
  if (!parsed) {
    return res.status(400).json({ error: 'PR 链接格式无法识别,应为 https://gitcode.com/{owner}/{repo}/pulls/{编号}' });
  }

  // 4. 提交人白名单(可选)
  if (ALLOWED_SUBMITTERS.length && !ALLOWED_SUBMITTERS.includes(submitter.toLowerCase())) {
    return res.status(403).json({ error: '该提交人不在允许列表内' });
  }

  // 4.5 防重复提交:同一 PR 在 DEDUP_WINDOW_MIN 分钟内仍有 pending/running 任务,拒绝
  const now = db.nowISO();
  const since = new Date(Date.now() - DEDUP_WINDOW_MIN * 60 * 1000).toISOString();
  const recent = db.getRecentActive.get({
    owner: parsed.owner, repo: parsed.repo, pr_number: parsed.pr_number, since,
  });
  if (recent) {
    return res.status(409).json({
      error: `该 PR 在 ${DEDUP_WINDOW_MIN} 分钟内已有提交(编号 ${recent.id},状态 ${recent.status}),请勿重复提交`,
      id: recent.id,
      status: recent.status,
    });
  }

  // 5. 入库,异步执行
  const info = db.insertSubmission.run({
    pr_url,
    owner: parsed.owner,
    repo: parsed.repo,
    pr_number: parsed.pr_number,
    labels: labels.join(','),
    submitter,
    now,
  });

  res.json({ id: info.lastInsertRowid, status: 'pending', message: '已提交,后台正在处理评论' });
});

// GET /api/status/:id
app.get('/api/status/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: '无效的 id' });
  const row = db.getById.get(id);
  if (!row) return res.status(404).json({ error: '未找到该提交' });

  let result = null;
  try {
    result = row.result ? JSON.parse(row.result) : null;
  } catch {
    result = null;
  }
  res.json({
    id: row.id,
    status: row.status,
    pr_url: row.pr_url,
    labels: row.labels.split(','),
    submitter: row.submitter,
    result,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
});

// GET /api/submissions?limit=&offset=&status=
// 提交历史列表(按 id 倒序)。status 可选,限定 pending/running/done/failed 之一。
app.get('/api/submissions', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const status = ['pending', 'running', 'done', 'failed'].includes(req.query.status)
    ? req.query.status : '';

  const rows = db.getList.all({ limit, offset, status });
  const total = db.getCount.all(status ? { status } : {});
  res.json({ total, limit, offset, items: rows });
});

// 导出 app 供测试复用(测试里 require('./server') 拿到 app,自行 listen 到测试端口)
module.exports = { app, initServer };

// 异步初始化数据库后再启动(仅在作为入口模块直接运行时触发)
async function initServer() {
  await db.initDb();
}

if (require.main === module) {
  (async () => {
    await db.initDb();
    app.listen(PORT, HOST, () => {
      console.log(`gitcode-helper 已启动: http://${HOST}:${PORT} (绑定 ${HOST},外部可访问)`);
      queue.start();
    });
  })();
}
