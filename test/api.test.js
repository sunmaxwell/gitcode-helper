// 端到端 API 测试:校验 → 入库 → worker 轮询(已 mock GitCode)→ 状态查询
//
// 隔离策略:
//   1. 用临时 DB 文件(DB_FILE 环境变量),测完删除,不碰开发库
//   2. 用随机测试端口,避免与本地运行的服务冲突
//   3. mock 掉 gitcode.js 的 postPrComment(通过 require.cache 注入),
//      使 queue 全链路在无网络下也能跑通,且可断言"发了什么评论"

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');

// --- 临时 DB 文件(进程内唯一,避免并发测试互相干扰)---
const TMP_DB = path.join(__dirname, 'tmp-api-' + process.pid + '.db');
process.env.DB_FILE = TMP_DB;
// 测试用端口:固定偏移,避开默认 3000(若被占用则 server 启动失败会暴露)
const TEST_PORT = 3999;

// --- mock gitcode.js:记录所有"发送"的评论,而非真实联网 ---
// 关键:在 require server/queue 之前,先把 gitcode.js 的 require.cache 注入 mock
const gitcodePath = require.resolve('../src/gitcode');
const calls = []; // 收集每次 postPrComment 的 (ctx, label)
const realGitcode = require('../src/gitcode');
// mock 模式:'ok' 正常成功;'fail' 返回 500 错误
let mockMode = 'ok';
const gitcodeMock = {
  parsePrUrl: realGitcode.parsePrUrl, // 真实解析,只 mock 发评论
  postPrComment: async (ctx, label) => {
    calls.push({ ctx, label });
    if (mockMode === 'fail') return { ok: false, status: 500, error: 'HTTP 500: boom' };
    return { ok: true, status: 201 };
  },
  API_BASE: realGitcode.API_BASE,
};
delete require.cache[gitcodePath];
require.cache[gitcodePath] = { exports: gitcodeMock, id: gitcodePath, filename: gitcodePath, loaded: true };

// 同样要让 queue 用到 mock:queue.js 在 require 时已 require gitcode,
// 但因为我们在 require queue 之前就注入了 cache,queue 拿到的就是 mock。
// 注意:server.js 也 require queue,需在 require server 前 mock 就绪 —— 顺序已满足。
const { app, initServer } = require('../src/server');
const db = require('../src/db');
const queue = require('../src/queue');

let server;
before(async () => {
  await initServer(); // 必须在 listen 前初始化 DB(测试模式不触发 require.main 守卫内的 initDb)
  await new Promise((resolve) => { server = app.listen(TEST_PORT, resolve); });
  // 注意:queue 不在此全局启动 —— 校验类用例不应触发 worker 发评论,避免污染 calls
});

after(async () => {
  queue.stop();
  await new Promise((r) => server.close(r));
  // 清理临时 DB
  for (const f of [TMP_DB, TMP_DB + '-journal']) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
  }
});

beforeEach(() => {
  calls.length = 0;
  mockMode = 'ok';
});

// --- 小工具:对本机测试服务发请求 ---
async function req(method, pathStr, body) {
  const opts = { method, hostname: '127.0.0.1', port: TEST_PORT, path: pathStr,
    headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {} };
  return new Promise((resolve, reject) => {
    const r = http.request(opts, (res) => {
      let d = ''; res.setEncoding('utf8'); res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

async function submit(pr_url, labels, submitter) {
  return req('POST', '/api/submit', JSON.stringify({ pr_url, labels, submitter }));
}
async function status(id) { return req('GET', '/api/status/' + id); }

// 等待某提交状态离开 pending/running(轮询),最长 ~6s
async function waitSettled(id) {
  for (let i = 0; i < 30; i++) {
    const r = await status(id);
    if (r.body && (r.body.status === 'done' || r.body.status === 'failed')) return r;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('超时未 settle, id=' + id);
}

// ====== 用例 ======

test('submit: 合法提交应入库并返回 pending', async () => {
  const r = await submit('https://gitcode.com/owner/repo/pulls/100', ['/approve'], 'alice');
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'pending');
  assert.equal(typeof r.body.id, 'number');
});

test('submit: 缺 pr_url → 400', async () => {
  const r = await submit('', ['/approve'], 'alice');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /PR 链接必填/);
});

test('submit: 缺提交人 → 400', async () => {
  const r = await submit('https://gitcode.com/o/r/pulls/1', ['/approve'], '');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /提交人必填/);
});

test('submit: 未选标签 → 400', async () => {
  const r = await submit('https://gitcode.com/o/r/pulls/1', [], 'alice');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /至少选择 1 个标签/);
});

test('submit: 非法标签 → 400', async () => {
  const r = await submit('https://gitcode.com/o/r/pulls/1', ['/review'], 'alice');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /标签只能是/);
});

test('submit: PR 链接格式不识别 → 400', async () => {
  const r = await submit('https://gitcode.com/owner/repo', ['/approve'], 'alice');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /PR 链接格式无法识别/);
});

test('status: 不存在的 id → 404', async () => {
  const r = await status(9999999);
  assert.equal(r.status, 404);
});

test('status: 无效 id → 400', async () => {
  const r = await status('abc');
  assert.equal(r.status, 400);
});

test('防重复提交: 同一 PR 短时间内二次提交 → 409 并带原 id', async () => {
  const first = await submit('https://gitcode.com/dedup/owner/pulls/1', ['/approve'], 'alice');
  assert.equal(first.status, 200);
  const second = await submit('https://gitcode.com/dedup/owner/pulls/1', ['/approve'], 'bob');
  assert.equal(second.status, 409);
  assert.equal(second.body.id, first.body.id);
  assert.match(second.body.error, /重复提交/);
});

test('防重复提交: 不同 PR 不受影响', async () => {
  const a = await submit('https://gitcode.com/dedup/owner/pulls/2', ['/approve'], 'alice');
  const b = await submit('https://gitcode.com/dedup/owner/pulls/3', ['/approve'], 'bob');
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.notEqual(a.body.id, b.body.id);
});

// worker 用例共享 calls 与 mockMode,必须串行执行(concurrency:1),否则会串台
describe('worker 全链路', { concurrency: 1 }, () => {
  before(async () => {
    // 清掉校验类用例留下的 pending 残留,保证 worker 从干净状态开始
    await initServer();
    for (const row of db.getPending.all(100)) {
      db.updateStatus.run({ id: row.id, status: 'done', result: '[]', updated_at: db.nowISO() });
    }
    queue.start();
  });
  after(() => queue.stop());
  test('单标签 /approve 应被发送且终态 done', async () => {
    const r = await submit('https://gitcode.com/owner/repo/pulls/123', ['/approve'], 'alice');
    const settled = await waitSettled(r.body.id);
    assert.equal(settled.body.status, 'done');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].label, '/approve');
    assert.equal(calls[0].ctx.owner, 'owner');
    assert.equal(calls[0].ctx.pr_number, 123);
    // result 明细
    assert.equal(settled.body.result[0].label, '/approve');
    assert.equal(settled.body.result[0].ok, true);
  });

  test('双标签串行发送,顺序保留', async () => {
    const r = await submit('https://gitcode.com/o/r/pulls/5', ['/approve', '/lgtm'], 'bob');
    const settled = await waitSettled(r.body.id);
    assert.equal(settled.body.status, 'done');
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((c) => c.label), ['/approve', '/lgtm']);
  });

  test('评论失败时终态 failed 且 result 记录错误', async () => {
    mockMode = 'fail'; // beforeEach 已重置为 ok,这里切失败模式
    const r = await submit('https://gitcode.com/o/r/pulls/8', ['/approve'], 'carol');
    const settled = await waitSettled(r.body.id);
    assert.equal(settled.body.status, 'failed');
    assert.equal(settled.body.result[0].ok, false);
    assert.match(settled.body.result[0].error, /boom/);
  });
});

// 历史列表接口测试(worker 处理后 DB 里有记录可查)
describe('历史列表 /api/submissions', { concurrency: 1 }, () => {
  async function list(qs = '') {
    return req('GET', '/api/submissions' + (qs ? '?' + qs : ''));
  }

  test('返回倒序列表,含 total 与 items', async () => {
    const r = await list('limit=10');
    assert.equal(r.status, 200);
    assert.equal(typeof r.body.total, 'number');
    assert.ok(Array.isArray(r.body.items));
    // items 应按 id 倒序
    for (let i = 1; i < r.body.items.length; i++) {
      assert.ok(r.body.items[i - 1].id >= r.body.items[i].id, '应按 id 倒序');
    }
  });

  test('status 过滤只返回对应状态', async () => {
    const r = await list('status=done&limit=100');
    assert.equal(r.status, 200);
    for (const it of r.body.items) assert.equal(it.status, 'done');
  });

  test('非法 status 被忽略(等价于全部)', async () => {
    const rAll = await list('limit=100');
    const rBad = await list('status=evil&limit=100');
    assert.equal(rBad.body.total, rAll.body.total);
  });

  test('limit 上限 200,offset 分页生效', async () => {
    const r = await list('limit=99999&offset=0');
    assert.equal(r.status, 200);
    assert.ok(r.body.items.length <= 200); // limit 被夹到 200
  });
});
