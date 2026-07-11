// GitCode API adapter —— 唯一与 GitCode 后端交互的模块
//
// 设计目的:把"发 PR 评论"这个副作用隔离在此处。
//   上层(queue.js)只调用 parsePrUrl() 与 postPrComment()。
//   将来若改用真正的 gitcode CLI,只需把 postPrComment 内部实现
//   从 HTTP fetch 换成 child_process.execFile('gitcode', [...]),
//   上层与表单逻辑一行都不用改 —— 满足用户最初"本地调 CLI"的需求。
//
// 当前实现:GitCode v5 API(api.gitcode.com/api/v5,类 Gitee v5)。
//   端点:POST {base}/repos/{owner}/{repo}/pulls/{number}/comments
//   鉴权:Authorization: Bearer {GITCODE_TOKEN}
//   说明:v5 把 PR 评论与 issue 评论分开,PR 评论走 pulls/{number}/comments。

const https = require('https');
const http = require('http');
const { URL } = require('url');

const API_BASE = process.env.GITCODE_API_BASE || 'https://api.gitcode.com/api/v5';
const TOKEN = process.env.GITCODE_TOKEN || '';

// 从 PR URL 解析出 owner / repo / pr_number
// 支持:
//   https://gitcode.com/{owner}/{repo}/pulls/{number}
//   https://gitcode.com/{owner}/{repo}/pull/{number}   (Gitea 风格)
//   带或不带 .git / 末尾斜杠
function parsePrUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  let url;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;

  const m = url.pathname.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?\/(?:pulls?|merge_requests)\/(\d+)/);
  if (!m) return null;

  const owner = decodeURIComponent(m[1]);
  const repo = decodeURIComponent(m[2]);
  const pr_number = parseInt(m[3], 10);
  if (!owner || !repo || !pr_number) return null;

  return { owner, repo, pr_number };
}

// 底层 HTTP 请求封装,返回 { ok, status, body }
function request(method, urlStr, headers, body) {
  return new Promise((resolve) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        method,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: { ...headers },
      },
      (res) => {
        let chunks = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (chunks += d));
        res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: chunks }));
      }
    );
    req.on('error', (err) => resolve({ ok: false, status: 0, body: String(err && err.message || err) }));
    if (body) req.write(body);
    req.end();
  });
}

// 在指定 PR 上发表一条评论(评论正文即 label 本身,如 "/approve" 或 "/lgtm")
// 返回 { ok: boolean, status?: number, error?: string }
async function postPrComment({ owner, repo, pr_number }, label) {
  if (!TOKEN) {
    return { ok: false, error: 'GITCODE_TOKEN 未配置,无法发送评论(请见 .env.example)' };
  }
  const endpoint = `${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pr_number}/comments`;
  const payload = JSON.stringify({ body: label });
  const { ok, status, body } = await request('POST', endpoint, {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${TOKEN}`,
    Accept: 'application/json',
    // CloudWAF 会拦截无 User-Agent 的请求(防爬虫),故补一个
    'User-Agent': 'gitcode-helper/1.0 (+https://gitcode.com)',
  }, payload);

  if (!ok) {
    return { ok: false, status, error: `HTTP ${status}: ${body.slice(0, 300)}` };
  }
  return { ok: true, status };
}

module.exports = { parsePrUrl, postPrComment, API_BASE };
