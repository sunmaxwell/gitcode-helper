// 异步任务队列 worker
//
// 职责:轮询 submissions 表中 status='pending' 的记录,逐条执行:
//   1. 标记为 running(占位,防重复拾取)
//   2. 对 labels 里的每一条标签(/approve 和/或 /lgtm)串行调用 GitCode adapter 发评论
//   3. 全部成功 → status='done';任一失败 → status='failed'
//   4. result 字段以 JSON 记录每条评论的成功/失败明细
//
// 串行发评论的原因:避免并发对同一 PR 发评论产生竞态,也尊重 API 速率限制。

const { getPending, updateStatus, nowISO } = require('./db');
const { postPrComment } = require('./gitcode');

const POLL_INTERVAL_MS = 2000; // 每 2 秒轮询一次
const BATCH_SIZE = 5;

let timer = null;

async function processOne(row) {
  // 占位标记 running
  updateStatus.run({ id: row.id, status: 'running', result: null, updated_at: nowISO() });

  const ctx = { owner: row.owner, repo: row.repo, pr_number: row.pr_number };
  const labels = row.labels.split(',').map((s) => s.trim()).filter(Boolean);

  const results = [];
  for (const label of labels) {
    const r = await postPrComment(ctx, label);
    results.push({ label, ok: r.ok, status: r.status, error: r.error || undefined });
  }

  const allOk = results.every((r) => r.ok);
  updateStatus.run({
    id: row.id,
    status: allOk ? 'done' : 'failed',
    result: JSON.stringify(results),
    updated_at: nowISO(),
  });
}

async function tick() {
  try {
    const rows = getPending.all(BATCH_SIZE);
    for (const row of rows) {
      await processOne(row);
    }
  } catch (err) {
    // 单次轮询出错不影响后续,记录到 stderr
    console.error('[queue] tick error:', err && err.message);
  }
}

function start() {
  if (timer) return;
  // 立即跑一次,再按间隔轮询
  tick();
  timer = setInterval(tick, POLL_INTERVAL_MS);
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { start, stop, tick };
