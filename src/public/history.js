// 提交历史列表页前端:拉取 /api/submissions 分页渲染,支持状态过滤 + 加载更多
const tbody = document.getElementById('tbody');
const moreBtn = document.getElementById('more');
const emptyEl = document.getElementById('empty');
const countEl = document.getElementById('count');
const statusFilter = document.getElementById('statusFilter');

const STATUS_TEXT = { pending: '待处理', running: '处理中', done: '已完成', failed: '失败' };
const PAGE_SIZE = 50;
let offset = 0;
let loaded = 0;
let total = 0;

function fmtTime(iso) {
  // ISO8601 UTC → 本地可读
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch { return iso; }
}

function el(tag, opts) {
  const n = document.createElement(tag);
  if (opts) {
    if (opts.cls) n.className = opts.cls;
    if (opts.text != null) n.textContent = opts.text;
    if (opts.href) { n.href = opts.href; n.target = '_blank'; n.rel = 'noopener'; }
  }
  return n;
}

function renderRow(r) {
  const tr = document.createElement('tr');

  // # 编号
  tr.appendChild(el('td', { text: String(r.id) }));

  // PR 链接 + 结果明细(纯 DOM 构建,避免 innerHTML XSS 风险)
  const tdUrl = el('td', { cls: 'url' });
  const a = el('a', { href: r.pr_url, text: r.pr_url });
  tdUrl.appendChild(a);
  if (r.result) {
    try {
      const arr = JSON.parse(r.result);
      for (const x of arr) {
        tdUrl.appendChild(el('div', {
          cls: 'detail',
          text: `${x.label} → ${x.ok ? '✅' : '❌'}${x.error ? ' ' + x.error : ''}`
        }));
      }
    } catch {}
  }
  tr.appendChild(tdUrl);

  // 标签
  const tdLabels = el('td');
  for (const l of (r.labels || '').split(',').filter(Boolean)) {
    tdLabels.appendChild(el('span', { cls: 'lbl', text: l }));
  }
  tr.appendChild(tdLabels);

  // 提交人
  tr.appendChild(el('td', { text: r.submitter }));

  // 状态徽章
  const tdStatus = el('td');
  tdStatus.appendChild(el('span', {
    cls: 'pill ' + r.status,
    text: STATUS_TEXT[r.status] || r.status,
  }));
  tr.appendChild(tdStatus);

  // 时间
  tr.appendChild(el('td', { text: fmtTime(r.created_at) }));

  return tr;
}

async function loadFirst() {
  offset = 0; loaded = 0; tbody.innerHTML = '';
  await loadMore();
}

async function loadMore() {
  moreBtn.hidden = true;
  const status = statusFilter.value;
  const url = `/api/submissions?limit=${PAGE_SIZE}&offset=${offset}${status ? '&status=' + encodeURIComponent(status) : ''}`;
  let data;
  try {
    const resp = await fetch(url);
    data = await resp.json();
  } catch (err) {
    countEl.textContent = '加载失败:' + (err.message || err);
    return;
  }
  total = data.total;
  for (const r of data.items) tbody.appendChild(renderRow(r));
  loaded += data.items.length;
  offset += data.items.length;

  emptyEl.hidden = loaded > 0;
  countEl.textContent = `共 ${total} 条,已加载 ${loaded} 条`;
  moreBtn.hidden = loaded >= total || data.items.length === 0;
}

moreBtn.addEventListener('click', loadMore);
statusFilter.addEventListener('change', loadFirst);

loadFirst();
