// SQLite 持久层(sql.js / Wasm,无原生编译依赖)
//
// 表 submissions 字段:
//   id            主键(自增)
//   pr_url        用户填写的 PR 链接(原样保存)
//   owner         从 URL 解析出的仓库 owner
//   repo          从 URL 解析出的仓库名
//   pr_number     从 URL 解析出的 PR 编号(整数)
//   labels        选择的标签,逗号分隔,如 "/approve,/lgtm"
//   submitter     提交人(必填)
//   status        任务状态:pending / running / done / failed
//   result        执行结果 JSON 字符串(每条评论的成功/失败信息)
//   created_at    创建时间,ISO8601 字符串,UTC
//   updated_at    更新时间,ISO8601 字符串,UTC
//
// 注意:sql.js 默认在内存运行,这里每次写后 debounce 持久化到磁盘文件。

const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

// DB 路径可通过环境变量 DB_FILE 覆盖(主要用于测试隔离);
// 也可指定 DB_DIR,在目录下使用默认文件名。
const DB_FILE = process.env.DB_FILE
  || path.join(process.env.DB_DIR || path.join(__dirname, '..', 'data'), 'gitcode-helper.db');
const DATA_DIR = path.dirname(DB_FILE);
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let db = null;
let saveTimer = null;

function nowISO() {
  return new Date().toISOString();
}

// 把内存数据库写盘(防抖)
function persist() {
  if (!db) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const data = db.export();
      fs.writeFileSync(DB_FILE, Buffer.from(data));
    } catch (err) {
      console.error('[db] persist error:', err && err.message);
    }
  }, 250);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS submissions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_url      TEXT NOT NULL,
  owner       TEXT NOT NULL,
  repo        TEXT NOT NULL,
  pr_number   INTEGER NOT NULL,
  labels      TEXT NOT NULL,
  submitter   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  result      TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
`;

async function initDb() {
  if (db) return db;
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_FILE)) {
    const buf = fs.readFileSync(DB_FILE);
    db = new SQL.Database(new Uint8Array(buf));
  } else {
    db = new SQL.Database();
  }
  db.run(SCHEMA);
  process.on('exit', () => {
    try {
      if (db) fs.writeFileSync(DB_FILE, Buffer.from(db.export()));
    } catch {}
  });
  return db;
}

const insertSubmission = {
  run(o) {
    db.run(
      `INSERT INTO submissions (pr_url, owner, repo, pr_number, labels, submitter, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [o.pr_url, o.owner, o.repo, o.pr_number, o.labels, o.submitter, o.now, o.now]
    );
    const r = db.exec('SELECT last_insert_rowid() AS id');
    const id = r[0].values[0][0];
    persist();
    return { lastInsertRowid: id };
  },
};

const getById = {
  get(id) {
    const stmt = db.prepare(`SELECT * FROM submissions WHERE id = ?`);
    const row = stmt.getAsObject([id]);
    stmt.free();
    return row && row.id ? row : null;
  },
};

const getPending = {
  all(limit) {
    const stmt = db.prepare(`SELECT * FROM submissions WHERE status = 'pending' ORDER BY id ASC LIMIT ?`);
    stmt.bind([limit]);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  },
};

// 查"同一 PR 在 since 之后、且仍处于活跃态(pending/running)的提交"。
// 用于防重复提交:submit 时若命中,说明该 PR 短时间内已有任务在跑,拒绝重复。
const getRecentActive = {
  get(o) {
    const stmt = db.prepare(
      `SELECT id, status, labels, created_at FROM submissions
       WHERE owner = ? AND repo = ? AND pr_number = ?
         AND status IN ('pending', 'running')
         AND created_at >= ?
       ORDER BY id DESC LIMIT 1`
    );
    const row = stmt.getAsObject([o.owner, o.repo, o.pr_number, o.since]);
    stmt.free();
    return row && row.id ? row : null;
  },
};

const updateStatus = {
  run(o) {
    db.run(
      `UPDATE submissions SET status = ?, result = ?, updated_at = ? WHERE id = ?`,
      [o.status, o.result, o.updated_at, o.id]
    );
    persist();
  },
};

// 历史列表:按 id 倒序分页。status 可选过滤('' 表示全部)。
const getList = {
  all(o) {
    const where = o.status ? `WHERE status = ?` : `WHERE 1=1`;
    const params = o.status ? [o.status, o.limit, o.offset] : [o.limit, o.offset];
    const stmt = db.prepare(
      `SELECT * FROM submissions ${where} ORDER BY id DESC LIMIT ? OFFSET ?`
    );
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  },
};

const getCount = {
  all(o) {
    const where = o && o.status ? `WHERE status = ?` : `WHERE 1=1`;
    const params = o && o.status ? [o.status] : [];
    const stmt = db.prepare(`SELECT COUNT(*) AS n FROM submissions ${where}`);
    stmt.bind(params);
    let n = 0;
    if (stmt.step()) n = stmt.getAsObject(params).n;
    stmt.free();
    return n;
  },
};

module.exports = { initDb, insertSubmission, getById, getPending, getRecentActive, updateStatus, getList, getCount, nowISO };
