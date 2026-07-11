// postPrComment 真实 HTTP 回归测试
//
// 背景:曾出现 postPrComment 把 request(method, url, ...) 错调为 request(url, method, ...),
// 导致 "Invalid URL" 运行时错误。由于 api.test.js mock 掉了整个 postPrComment,
// 该 bug 测不到。本测试起一个本地 mock http server 作为 GITCODE_API_BASE,
// 让 postPrComment 真实走 request() 网络封装,以验证请求方法/路径/鉴权正确。

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

// 关键:必须在 require gitcode 之前设好环境变量(gitcode 在加载时即读 env)
const TOKEN = 'test-token-xyz';
let received; // 记录 mock server 收到的请求
let mockServer;

const API_BASE_HOST = '127.0.0.1';
let API_BASE_PORT;

// 关键:gitcode.js 在模块加载时即读 process.env.GITCODE_API_BASE / GITCODE_TOKEN,
// 因此必须在 mock server 起好、环境变量赋值之后,同一个 before 里才 require。
let postPrComment;
before(async () => {
  mockServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received = {
        method: req.method,
        url: req.url,
        auth: req.headers.authorization,
        contentType: req.headers['content-type'],
        userAgent: req.headers['user-agent'],
        body: body ? JSON.parse(body) : null,
      };
      res.statusCode = 201;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: 999, body: 'created' }));
    });
  });
  await new Promise((r) => { mockServer.listen(0, API_BASE_HOST, r); });
  const addr = mockServer.address();
  API_BASE_PORT = addr.port;
  process.env.GITCODE_API_BASE = `http://${API_BASE_HOST}:${API_BASE_PORT}`;
  process.env.GITCODE_TOKEN = TOKEN;
  // 此时 env 已就绪,require gitcode 让其读到本地 API_BASE
  ({ postPrComment } = require('../src/gitcode'));
});

after(async () => {
  await new Promise((r) => mockServer.close(r));
});

test('postPrComment: 真实 HTTP 请求方法为 POST 且路径正确', async () => {
  const r = await postPrComment({ owner: 'acme', repo: 'proj', pr_number: 77 }, '/approve');
  assert.equal(r.ok, true);
  assert.equal(r.status, 201);
  assert.equal(received.method, 'POST', '请求方法必须是 POST(回归:曾经误传成 URL)');
  assert.equal(received.url, '/repos/acme/proj/pulls/77/comments');
});

test('postPrComment: 带 token 鉴权与 JSON 请求体', async () => {
  await postPrComment({ owner: 'o', repo: 'r', pr_number: 5 }, '/lgtm');
  assert.equal(received.auth, `Bearer ${TOKEN}`);
  assert.equal(received.contentType, 'application/json');
  assert.equal(received.body.body, '/lgtm');
  // CloudWAF 会拦截无 UA 的请求,故 gitcode 必须发 User-Agent(回归防丢)
  assert.ok(received.userAgent, '必须发送 User-Agent header');
  assert.match(received.userAgent, /gitcode-helper/);
});

test('postPrComment: owner/repo 含特殊字符应被编码', async () => {
  await postPrComment({ owner: 'my org', repo: 'repo 2', pr_number: 1 }, '/approve');
  // 空格 → %20
  assert.equal(received.url, '/repos/my%20org/repo%202/pulls/1/comments');
});

test('postPrComment: 非 2xx 响应返回 ok=false 与错误信息', async () => {
  // 换一个返回 403 的 mock
  mockServer.removeAllListeners('request');
  mockServer.on('request', (req, res) => {
    res.statusCode = 403;
    res.end('forbidden');
  });
  const r = await postPrComment({ owner: 'o', repo: 'r', pr_number: 9 }, '/approve');
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.match(r.error, /403/);
});
