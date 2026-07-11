// 前端交互:提交表单 + 轮询状态
const form = document.getElementById('form');
const errEl = document.getElementById('err');
const btn = document.getElementById('submitBtn');
const resultEl = document.getElementById('result');
const ridEl = document.getElementById('rid');
const rstatusEl = document.getElementById('rstatus');
const rdetailEl = document.getElementById('rdetail');

function showError(msg) {
  errEl.textContent = msg;
  errEl.hidden = false;
}
function hideError() { errEl.hidden = true; errEl.textContent = ''; }

const STATUS_TEXT = { pending: '待处理', running: '处理中', done: '已完成', failed: '失败' };

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError();

  const pr_url = document.getElementById('pr_url').value.trim();
  const labels = [...document.querySelectorAll('input[name=labels]:checked')].map((c) => c.value);
  const submitter = document.getElementById('submitter').value.trim();

  // 前端校验(体验层,后端为最终防线)
  if (!pr_url) return showError('请填写 PR 链接');
  if (labels.length === 0) return showError('至少选择 1 个标签');
  if (!submitter) return showError('请填写提交人');

  btn.disabled = true; btn.textContent = '提交中…';
  try {
    const resp = await fetch('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pr_url, labels, submitter }),
    });
    const data = await resp.json();
    if (!resp.ok) return showError(data.error || '提交失败');

    resultEl.hidden = false;
    ridEl.textContent = data.id;
    rstatusEl.textContent = STATUS_TEXT[data.status] || data.status;
    rstatusEl.className = 'st-' + data.status;
    rdetailEl.textContent = '正在后台处理评论,请稍候…';
    form.style.display = 'none';
    pollStatus(data.id);
  } catch (err) {
    showError('网络错误:' + (err.message || err));
  } finally {
    btn.disabled = false; btn.textContent = '提交';
  }
});

async function pollStatus(id) {
  const maxTries = 60; // 最多轮询 ~60 次(~2 分钟)
  for (let i = 0; i < maxTries; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const resp = await fetch(`/api/status/${id}`);
      const data = await resp.json();
      if (!resp.ok) { rdetailEl.textContent = '查询失败'; return; }
      rstatusEl.textContent = STATUS_TEXT[data.status] || data.status;
      rstatusEl.className = 'st-' + data.status;

      if (data.status === 'done' || data.status === 'failed') {
        renderDetail(data);
        return;
      }
    } catch {
      // 单次查询失败,继续重试
    }
  }
  rdetailEl.textContent = '超时,请稍后刷新查看。';
}

function renderDetail(data) {
  rdetailEl.textContent = '';
  if (!data.result || data.result.length === 0) {
    rdetailEl.textContent = data.status === 'done' ? '全部评论发送成功' : '无结果明细';
    return;
  }
  for (const r of data.result) {
    const line = document.createElement('div');
    line.textContent = `${r.label} → ${r.ok ? '✅ 成功' : '❌ 失败'}${r.error ? ' (' + r.error + ')' : ''}`;
    rdetailEl.appendChild(line);
  }
}
