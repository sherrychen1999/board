// 擇木專案進度看板：EIP → 看板同步程式（在 EIP 分頁執行）
// 用法：在已登入的 https://erp.drking.com.tw/ 分頁載入本檔（fetch 後 eval），再執行 await zmSync()
// 產出：window.__zmHTML（新的 index.html 全文）、回傳摘要
// 規則：保留 13 個專案代號與各項 key（執行長的優先順序、排序都靠它們），只更新階段、主責與進度紀錄；
//       舊紀錄沿用（已人工去個資、去成本），只追加上次同步之後的新紀錄，並自動濾掉成本、健康相關句子與網址。
window.zmSync = async function () {
  const BOARD = 'https://sherrychen1999.github.io/board/';
  const tz = d => new Date(new Date(d).getTime() + 8 * 3600e3); // 台北時間
  const md = d => { const t = tz(d); return `${t.getUTCMonth() + 1}/${t.getUTCDate()}`; };
  // 雙週會：自 2026-10-28（週三）起每 14 天；「上次會議」= 今天之前最近的一次（取會議當天結束）
  const lastMeeting = (() => { let m = Date.UTC(2026, 9, 28) - 8 * 3600e3; const now = Date.now(); while (m + 14 * 864e5 + 864e5 <= now) m += 14 * 864e5; return m + 864e5; })();
  // EIP 登入憑證
  let tok = null;
  for (const s of [localStorage, sessionStorage]) for (const k of Object.keys(s)) { const v = s.getItem(k) || ''; if (/token|auth|jwt/i.test(k) && v.length > 20) { tok = v; try { const j = JSON.parse(v); tok = j.token || j.accessToken || j.access_token || v; } catch (e) {} } }
  if (!tok) throw new Error('找不到 EIP 登入資訊，請先登入 EIP');
  const res = await fetch('/api/v1/tasks', { headers: { Authorization: 'Bearer ' + tok } });
  if (!res.ok) throw new Error('EIP 讀取失敗 ' + res.status);
  const d = (await res.json()).data;
  const seen = new Set(), all = [];
  for (const t of [...(d.received || []), ...(d.assigned || [])]) if (!seen.has(t.id)) { seen.add(t.id); all.push(t); }
  // 目前看板
  const html = await (await fetch(BOARD + '?t=' + Date.now(), { cache: 'no-store' })).text();
  const m = html.match(/const P=(\[[\s\S]*?\]);\n/);
  if (!m) throw new Error('看板格式不符');
  const P = JSON.parse(m[1]);
  const ms = html.match(/const SYNCED="([^"]*)";/);
  const prevSync = ms ? Date.parse(ms[1]) : Date.parse('2026-10-30T10:00:00Z');
  const live = all.filter(t => t.status !== 'cancelled');
  const stageOf = k => {
    for (const t of live) for (const s of t.stages || []) if (s.sourceTaskNo === k) return { t, s };
    const t = live.find(t => t.taskNo === k && !(t.stages || []).length);
    return t ? { t, s: null } : null;
  };
  // 公開看板不放成本與健康相關內容
  const SENS = /進貨價|成本|抽成|毛利|利潤|分潤比|\d+\s*元|NT\$|\$\s*\d|薪資|時薪|月薪|底薪|腰痛|病假|疾病|懷孕|身體不適|健康因素|健康原因/;
  const scrub = s => s.replace(/\s+/g, ' ').split(/(?<=[。；;])|，(?=[^，]*?(?:進貨價|成本|抽成|毛利|\d\s*元))/).filter(x => x && !SENS.test(x)).join('').replace(/[，、；\s]+$/, '').trim();
  const conv = (u, stageName) => {
    let c = (u.content || '').trim(), k = '進度';
    if (/^(✏️|📅|🔀|🔄|▶|↺|🗑|📎)/.test(c)) return null;
    if (/^#完成/.test(c)) c = '✅ 完成：' + c;
    if (/^📥/.test(c) || c === '收到') return [md(u.createdAt), u.byName, '收到', '收到', u.createdAt];
    if (/^✅/.test(c)) { k = '回報完成'; c = c.replace(/^✅\s*完成[：:]\s*/, '').replace(/#完成\s*/, ''); }
    else if (/^⚠️/.test(c)) { k = '卡關'; c = c.replace(/^⚠️\s*卡關[：:]\s*/, ''); }
    else if (/^(↩️|↺)/.test(c)) { k = '狀態'; c = c.replace(/^(↩️|↺)\s*/, ''); }
    else if (/^✔/.test(c)) { k = '完成'; c = '已在 EIP 標記完成'; }
    else if (/^💬/.test(c)) c = c.replace(/^💬\s*/, '');
    if (stageName) c = c.replace(stageName + '：', '').replace(stageName, '').replace(/^[：:——\s]+/, '');
    c = c.replace(/（[^（）]{1,8}）$/, '').replace(/（[A-Z]*\d{7}-[\w-]+）/g, '').replace(/#工時\S*/g, '').replace(/^[：:，\s]+/, '');
    c = c.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
    c = scrub(c);
    if (!c || c.length <= 2) return null;
    return [md(u.createdAt), u.byName, k, c, u.createdAt];
  };
  const RESTRUCT = Date.parse('2026-11-05T09:00:00Z'); // EIP 任務整理（舊卡併成階段）
  const mentions = (u, key, s) => { const c = u.content || ''; if (c.includes(key)) return true; if (!s) return false; const nm = s.name.split('：').pop(); return c.includes(s.name.slice(0, 10)) || (nm.length > 3 && c.includes(nm)); };
  // 收集某一項的新紀錄；bump = 最後一個狀態事件是「完成」且晚於上次會議
  const collect = (key, t, s, oldLogs) => {
    const ups = [];
    for (const c of all.filter(c => c.taskNo === key)) {
      const parent = c.status !== 'cancelled' && (c.stages || []).length;
      for (const u of c.updates || []) { if (parent && Date.parse(u.createdAt) > RESTRUCT && !mentions(u, key, s)) continue; ups.push([u, parent && s ? s.name : null]); }
    }
    if (s && t.taskNo !== key) for (const u of t.updates || []) if (mentions(u, key, s)) ups.push([u, s.name]);
    ups.sort((a, b) => a[0].createdAt < b[0].createdAt ? -1 : 1);
    let lastEv = null;
    const undone = new Set();
    for (const [u] of ups) { const c = u.content || ''; if (/^(✅|✔)/.test(c)) lastEv = u; else if (/^(↺|↩️)/.test(c) || (/^▶/.test(c) && lastEv && /^(✅|✔)/.test(lastEv.content))) { if (lastEv && /^(✅|✔)/.test(lastEv.content)) undone.add(lastEv.id); lastEv = u; } }
    const bump = !!(lastEv && /^(✅|✔)/.test(lastEv.content) && Date.parse(lastEv.createdAt) > lastMeeting);
    const have = new Set(oldLogs.map(l => l[0] + '|' + l[3].slice(0, 12)));
    const fresh = [];
    for (const [u, nm] of ups) {
      if (Date.parse(u.createdAt) <= prevSync || undone.has(u.id)) continue;
      const L = conv(u, nm); if (!L) continue;
      const id = L[0] + '|' + L[3].slice(0, 12); if (have.has(id)) continue; have.add(id); fresh.push(L);
    }
    fresh.sort((a, b) => a[4] < b[4] ? 1 : -1);
    return { fresh, bump };
  };
  const stageNum = (s, t) => { const st = s ? s.state : t.status; if (st === 'todo') return 0; if (st === 'done') { const at = Date.parse((s && s.doneAt) || t.doneTime || 0); return at && at > lastMeeting ? 2 : 3; } if (st === 'review') return 2; return 1; };
  const out = { updated: [], unchanged: [], notFound: [], added: [], newLogs: 0 };
  const boardKeys = new Set();
  for (const p of P) for (const it of p.items) {
    const key = it[6]; boardKeys.add(key);
    if (!it[0]) continue; // P04 非 EIP 項目
    const hit = stageOf(key);
    if (!hit) { out.notFound.push(key + ' ' + it[1]); continue; }
    const { t, s } = hit;
    let stg = it[2];
    const state = s ? s.state : (t.status === 'done' ? 'done' : t.status === 'review' ? 'review' : 'doing');
    if (state === 'todo') stg = 0; else if (state === 'doing' || state === 'blocked') stg = 1;
    else if (state === 'review') stg = 2;
    else if (state === 'done') { const at = Date.parse((s && s.doneAt) || t.doneTime || 0); stg = at && at > lastMeeting ? 2 : 3; }
    const { fresh, bump } = collect(key, t, s, it[8]);
    if (bump && stg < 2 && state !== 'todo') stg = 2;
    const logs = it[8].slice();
    const merged = [...fresh.map(l => l.slice(0, 4)), ...logs];
    const comp = []; // 同日連續「收到」合併
    for (const l of merged) { const prev = comp[comp.length - 1]; if (prev && prev[2] === '收到' && l[2] === '收到' && prev[0] === l[0]) { if (!prev[1].includes(l[1])) prev[1] += '、' + l[1]; } else comp.push(l.slice()); }
    const owner = (s && s.ownerName) || it[4];
    const changed = stg !== it[2] || owner !== it[4] || fresh.length;
    it[2] = stg; it[4] = owner; it[8] = comp;
    out.newLogs += fresh.length;
    (changed ? out.updated : out.unchanged).push(key);
  }
  // EIP 新結構裡有、看板上還沒有的擇木階段 → 加進同一張大任務卡其他階段所在的專案
  // （產品開發卡 S1151105-002～011 依策略長「開發進度看板」，不放進來；已完成的不加）
  const projOfKey = {}; for (const p of P) for (const it of p.items) projOfKey[it[6]] = p;
  for (const t of live) {
    if (t.series !== '擇木' || /^S1151105-0(0[2-9]|1[01])$/.test(t.taskNo)) continue;
    const st = t.stages || []; if (!st.length) continue;
    const votes = {}; for (const s of st) { const p = projOfKey[s.sourceTaskNo]; if (p) votes[p.id] = (votes[p.id] || 0) + 1; }
    const pid = Object.keys(votes).sort((a, b) => votes[b] - votes[a])[0]; if (!pid) continue;
    const p = P.find(x => x.id === pid);
    for (const s of st) {
      const k = s.sourceTaskNo || `${t.taskNo}#${s.seq}`;
      if (boardKeys.has(k) || s.state === 'done') continue;
      if (k === t.taskNo && boardKeys.has(t.taskNo)) continue;
      const { fresh } = collect(k, t, s, []);
      p.items.push([/^[A-Z]*\d{7}-/.test(k) ? k : '', s.name.replace(/^[^：]{2,6}：/, ''), stageNum(s, t), '', s.ownerName || t.assigneeName, '', k, 0, fresh.map(l => l.slice(0, 4))]);
      boardKeys.add(k); projOfKey[k] = p; out.added.push(`${pid} ${k} ${s.name.slice(0, 24)}`);
    }
  }
  const now = new Date().toISOString();
  let nh = html.replace(m[0], 'const P=' + JSON.stringify(P) + ';\n');
  if (ms) nh = nh.replace(ms[0], `const SYNCED="${now}";`); else nh = nh.replace('const STEPS=', `const SYNCED="${now}";\nconst STEPS=`);
  if (!nh.includes('id="synced"')) {
    nh = nh.replace('<div class="status" id="status">', '<div class="status" id="synced"></div>\n<div class="status" id="status">');
    nh = nh.replace('render();\nasync function load', '{const t=new Date(Date.parse(SYNCED)+8*36e5);document.getElementById("synced").textContent=`進度同步自 EIP：${t.getUTCMonth()+1}/${t.getUTCDate()} ${String(t.getUTCHours()).padStart(2,"0")}:${String(t.getUTCMinutes()).padStart(2,"0")}（每天早上自動更新）`}\nrender();\nasync function load');
  }
  window.__zmHTML = nh; window.__zmP = P;
  out.lastMeeting = md(lastMeeting - 864e5);
  out.prevSync = new Date(prevSync).toISOString(); out.now = now; out.size = nh.length;
  return out;
};
