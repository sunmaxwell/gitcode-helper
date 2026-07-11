// parsePrUrl 单元测试 —— gitcode.js 是纯函数模块,无副作用,最好测
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parsePrUrl } = require('../src/gitcode');

test('parsePrUrl: 标准 pulls 路径', () => {
  assert.deepEqual(parsePrUrl('https://gitcode.com/owner/repo/pulls/123'), {
    owner: 'owner', repo: 'repo', pr_number: 123,
  });
});

test('parsePrUrl: Gitea 风格 pull 路径', () => {
  assert.deepEqual(parsePrUrl('https://gitcode.com/owner/repo/pull/42'), {
    owner: 'owner', repo: 'repo', pr_number: 42,
  });
});

test('parsePrUrl: 末尾斜杠', () => {
  assert.deepEqual(parsePrUrl('https://gitcode.com/owner/repo/pulls/7/'), {
    owner: 'owner', repo: 'repo', pr_number: 7,
  });
});

test('parsePrUrl: 带 .git 后缀', () => {
  assert.deepEqual(parsePrUrl('https://gitcode.com/owner/repo.git/pulls/9'), {
    owner: 'owner', repo: 'repo', pr_number: 9,
  });
});

test('parsePrUrl: 中文 owner/repo(经 URL 编码)', () => {
  // 用户/我的仓库 —— decodeURIComponent 应还原
  const url = 'https://gitcode.com/%E7%94%A8%E6%88%B7/%E6%88%91%E7%9A%84%E4%BB%93%E5%BA%93/pulls/3';
  const p = parsePrUrl(url);
  assert.equal(p.owner, '用户');
  assert.equal(p.repo, '我的仓库');
  assert.equal(p.pr_number, 3);
});

test('parsePrUrl: 非 http(s) 协议拒绝', () => {
  assert.equal(parsePrUrl('ftp://gitcode.com/a/b/pulls/1'), null);
  assert.equal(parsePrUrl('javascript:alert(1)'), null);
});

test('parsePrUrl: 路径不匹配返回 null', () => {
  assert.equal(parsePrUrl('https://gitcode.com/owner/repo/issues/123'), null);
  assert.equal(parsePrUrl('https://gitcode.com/owner/repo'), null);
  assert.equal(parsePrUrl('https://gitcode.com/owner/repo/pulls/abc'), null);
});

test('parsePrUrl: 非字符串/空值返回 null', () => {
  assert.equal(parsePrUrl(null), null);
  assert.equal(parsePrUrl(undefined), null);
  assert.equal(parsePrUrl(''), null);
  assert.equal(parsePrUrl(123), null);
});

test('parsePrUrl: 无效 URL 返回 null', () => {
  assert.equal(parsePrUrl('not a url at all'), null);
  assert.equal(parsePrUrl('http://'), null);
});
