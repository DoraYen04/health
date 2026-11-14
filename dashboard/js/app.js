import { api, toast, esc, fmt, addDays, dateRange, md } from './api.js';
import { initAuth, currentUser, signIn, signOut } from './auth.js';
import { lineChart, barChart, destroyAll, color } from './charts.js';
import { renderRecordTable, renderAddForm, SHEET_VIEWS } from './components/record-table.js';

const $view = document.getElementById('view');
let me = null;

// ---------------------------------------------------------------------------
// 登入
// ---------------------------------------------------------------------------

const $msg = document.getElementById('login-msg');
const $signin = document.getElementById('signin');
let devAuth = false;

async function boot() {
  try {
    if (!devAuth) {
      const cfg = await api('/config').catch(() => ({}));
      devAuth = !!cfg.devAuth;
    }
    if (!devAuth) {
      if (!(await initAuth())) return showLogin('無法載入 Firebase 設定，請透過 Firebase Hosting 網址開啟 Dashboard。', false);
      if (!currentUser()) return showLogin();
    }
    me = await api('/me');
    document.getElementById('who').textContent = me.display_name || me.email || '';
    document.getElementById('login').classList.add('hidden');
    route();
  } catch (e) {
    if (e.status === 401) return showLogin('登入已過期，請重新登入。');
    if (e.status === 403) {
      await signOut().catch(() => {});
      return showLogin(e.message);
    }
    toast(e.message, true);
  }
}

function showLogin(message = '', canSignIn = true) {
  document.getElementById('login').classList.remove('hidden');
  $msg.textContent = message;
  $signin.classList.toggle('hidden', !canSignIn);
}

$signin.onclick = async () => {
  $msg.textContent = '';
  try {
    await signIn();
    await boot();
  } catch (e) {
    if (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') return;
    $msg.textContent = e.code === 'auth/popup-blocked'
      ? '登入視窗被瀏覽器擋下，請允許彈出視窗後再試一次。'
      : `登入失敗：${e.message}`;
  }
};

document.getElementById('logout').onclick = async () => {
  await signOut().catch(() => {});
  location.reload();
};

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

const VIEWS = { overview, trends, nutrition, records, tasks, reports, goals, settings };

function route() {
  const name = (location.hash || '#overview').slice(1);
  const fn = VIEWS[name] || overview;
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === (VIEWS[name] ? name : 'overview')));
  destroyAll();
  $view.innerHTML = '<p class="muted">載入中…</p>';
  fn().catch((e) => {
    if (e.status === 401) return showLogin();
    $view.innerHTML = `<div class="card"><p>載入失敗：${esc(e.message)}</p></div>`;
  });
}
window.addEventListener('hashchange', () => me && route());

function rangeToolbar(id, days, onPick) {
  return {
    html: `<div class="toolbar" id="${id}">
      ${[7, 30, 90].map((d) => `<button class="seg ${d === days ? 'on' : ''}" data-d="${d}">${d} 天</button>`).join('')}
      <span class="muted" style="margin-left:8px">自訂</span>
      <input type="date" data-f="from"> ～ <input type="date" data-f="to"> <button data-act="custom">套用</button>
    </div>`,
    bind() {
      const el = document.getElementById(id);
      el.onclick = (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.d) {
          el.querySelectorAll('button.seg').forEach((x) => x.classList.toggle('on', x === b));
          onPick(addDays(me.today, -(Number(b.dataset.d) - 1)), me.today);
        } else if (b.dataset.act === 'custom') {
          const f = el.querySelector('[data-f=from]').value;
          const t = el.querySelector('[data-f=to]').value;
          if (!f || !t || f > t) return toast('請選擇正確的日期區間', true);
          el.querySelectorAll('button.seg').forEach((x) => x.classList.remove('on'));
          onPick(f, t);
        }
      };
    },
  };
}

function signed(n, unit = '') {
  if (n === null || n === undefined) return '—';
  if (n === 0) return `±0${unit}`;
  return `${n > 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}${unit}`;
}

// ---------------------------------------------------------------------------
// 總覽
// ---------------------------------------------------------------------------

async function overview() {
  const o = await api('/overview');
  const w = o.latest_weight;
  const b = o.latest_body;
  const g = o.goals.find((x) => x.goal_type === '體重') || o.goals[0];
  const n = o.nutrition_today;
  const ex = o.exercise_week;
  const pct = (v, t) => (v !== null && t ? Math.min(100, Math.round((v / t) * 100)) : 0);

  $view.innerHTML = `
    <h2>健康總覽 <span class="muted">${md(o.today)}</span></h2>
    <div class="grid">
      <div class="stat"><div class="label">最新體重</div><div class="value">${fmt(w?.weight_kg, 'kg')}</div>
        <div class="sub">${w ? `${md(w.measure_date)} ${w.period === 'AM' ? '上午' : '下午'} ${w.measure_time || ''}` : '尚無資料'}</div></div>
      <div class="stat"><div class="label">體脂率</div><div class="value">${fmt(b?.body_fat_pct, '%')}</div>
        <div class="sub">${b ? `${md(b.measure_date)}｜較前次 ${signed(o.body_change?.body_fat_pct_pp, ' 百分點')}` : '尚無資料'}</div></div>
      <div class="stat"><div class="label">骨骼肌重</div><div class="value">${fmt(b?.skeletal_muscle_kg, 'kg')}</div>
        <div class="sub">${b ? `較前次 ${signed(o.body_change?.skeletal_muscle_kg, ' kg')}` : '尚無資料'}</div></div>
      <div class="stat"><div class="label">目標進度${g ? `（${esc(g.goal_type)}）` : ''}</div><div class="value">${g?.progress.pct ?? '—'}${g?.progress.pct !== null && g ? '%' : ''}</div>
        <div class="sub">${g ? `${fmt(g.current_value)} → 目標 ${g.target_value}${g.unit}${g.progress.days_left !== null ? `｜剩 ${g.progress.days_left} 天` : ''}` : '<a href="#goals">設定目標</a>'}</div></div>
    </div>
    <div class="grid-2" style="margin-top:16px">
      <div class="card">
        <h3>今日營養</h3>
        ${n.recorded ? `
          <div>熱量 <b>${fmt(n.calorie_kcal)}</b>${n.calorie_target_kcal ? ` / ${n.calorie_target_kcal}` : ''} kcal</div>
          <div class="bar"><span style="width:${pct(n.calorie_kcal, n.calorie_target_kcal)}%;background:var(--series-4)"></span></div>
          <div style="margin-top:8px">蛋白質 <b>${fmt(n.protein_g)}</b>${n.protein_target_g ? ` / ${n.protein_target_g}` : ''} g</div>
          <div class="bar"><span style="width:${pct(n.protein_g, n.protein_target_g)}%;background:var(--series-3)"></span></div>
          <p class="muted">已記錄：${n.meal_types.join('、')}${n.missing_meal_types.length ? `｜未記錄：${n.missing_meal_types.join('、')}（未記錄不視為 0）` : ''}${n.includes_ai_estimate ? '｜含 AI 估算' : ''}</p>`
          : '<p class="muted">今天尚未記錄飲食。</p>'}
      </div>
      <div class="card">
        <h3>本週運動 <span class="muted">${md(ex.from)} 起 7 天</span></h3>
        ${ex.recorded ? `<div class="value" style="font-size:26px;font-weight:700">${ex.total_min} 分鐘 <span class="muted">／${ex.days} 天</span></div>
          ${ex.target_min_week ? `<div class="bar"><span style="width:${pct(ex.total_min, ex.target_min_week)}%"></span></div><p class="muted">週目標 ${ex.target_min_week} 分鐘</p>` : ''}
          <p class="muted">${Object.entries(ex.by_type).map(([k, v]) => `${esc(k)} ${v} 分`).join('、')}${ex.calories_estimated ? `｜估算消耗約 ${ex.calories_estimated} kcal` : ''}</p>`
          : '<p class="muted">近 7 天尚無運動紀錄。</p>'}
      </div>
      <div class="card">
        <h3>今日待辦</h3>
        ${o.today_tasks.length ? `<ul class="tasks">${o.today_tasks.map((t) => `<li><span>${t.done ? '✅' : '○'}</span><span>${esc(t.remind_time)}</span><span>${esc(t.task_name)}</span>${t.done ? '' : '<span class="pill warn">待完成</span>'}</li>`).join('')}</ul>` : '<p class="muted">今天沒有排定作業。</p>'}
      </div>
      <div class="card">
        <h3>逾期項目（近 7 天）</h3>
        ${o.overdue.length ? `<ul class="tasks">${o.overdue.map((r) => `<li><span class="pill bad">逾期</span><span>${md(r.occurrence_date)}</span><span>${esc(r.task_name)}</span></li>`).join('')}</ul>` : '<p class="muted">沒有逾期項目 👍</p>'}
      </div>
    </div>
    <div class="card"><h3>體重趨勢｜最近 30 天</h3><div class="chart-box"><canvas id="c-ov-weight"></canvas></div></div>`;

  const s = await api(`/series?from=${addDays(o.today, -29)}&to=${o.today}`);
  drawWeight('c-ov-weight', s);
}

function drawWeight(id, s) {
  const days = dateRange(s.from, s.to);
  const pick = (p) => days.map((d) => {
    const xs = s.weights.filter((w) => w.date === d && w.period === p);
    return xs.length ? xs[xs.length - 1].weight_kg : null;
  });
  lineChart(id, {
    labels: days.map((d) => d.slice(5).replace('-', '/')),
    datasets: [{ label: '上午', data: pick('AM'), color: color(1) }, { label: '下午', data: pick('PM'), color: color(2) }],
    unit: 'kg',
  });
}

// ---------------------------------------------------------------------------
// 體重與身體組成
// ---------------------------------------------------------------------------

async function trends() {
  const tb = rangeToolbar('tb-trends', 30, (f, t) => load(f, t));
  $view.innerHTML = `
    <h2>體重與身體組成分析</h2>
    ${tb.html}
    <div class="card"><h3>體重（上午／下午分開）</h3><div class="chart-box"><canvas id="c-weight"></canvas></div></div>
    <div class="grid-2">
      <div class="card"><h3>體脂率 %</h3><div class="chart-box"><canvas id="c-fat"></canvas></div></div>
      <div class="card"><h3>骨骼肌重 kg</h3><div class="chart-box"><canvas id="c-muscle"></canvas></div></div>
    </div>
    <div class="card"><h3>身體組成測量紀錄</h3><p class="muted">點「檢視」可看原始照片；所有修改都會保留修改前後值。</p><div id="t-body"></div></div>`;
  tb.bind();
  async function load(from, to) {
    const s = await api(`/series?from=${from}&to=${to}`);
    drawWeight('c-weight', s);
    const labels = s.bodies.map((b) => b.measure_date.slice(5).replace('-', '/'));
    lineChart('c-fat', { labels, datasets: [{ label: '體脂率', data: s.bodies.map((b) => b.body_fat_pct), color: color(1) }], unit: '%' });
    lineChart('c-muscle', { labels, datasets: [{ label: '骨骼肌重', data: s.bodies.map((b) => b.skeletal_muscle_kg), color: color(1) }], unit: 'kg' });
    await renderRecordTable(document.getElementById('t-body'), 'Body_Composition', { from, to });
  }
  await load(addDays(me.today, -29), me.today);
}

// ---------------------------------------------------------------------------
// 飲食與運動
// ---------------------------------------------------------------------------

async function nutrition() {
  const tb = rangeToolbar('tb-nut', 30, (f, t) => load(f, t));
  $view.innerHTML = `
    <h2>飲食與運動</h2>
    ${tb.html}
    <div class="grid-2">
      <div class="card"><h3>每日熱量 kcal</h3><div class="chart-box"><canvas id="c-cal"></canvas></div><p class="muted">只顯示有紀錄的日子；未記錄不視為 0。</p></div>
      <div class="card"><h3>每日蛋白質 g</h3><div class="chart-box"><canvas id="c-pro"></canvas></div></div>
    </div>
    <div class="card"><h3>每日運動分鐘</h3><div class="chart-box" style="height:220px"><canvas id="c-ex"></canvas></div><p class="muted" id="ex-types"></p></div>
    <div class="card"><h3>餐點紀錄</h3><p class="muted">可修正 AI 估算的份量與營養數值，修正後來源自動標示為「使用者修正」。</p><div id="t-meal"></div></div>
    <div class="card"><h3>運動紀錄</h3><p class="muted">「估算」消耗為 MET 公式推算，不等同實測。</p><div id="t-ex"></div></div>`;
  tb.bind();
  async function load(from, to) {
    const s = await api(`/series?from=${from}&to=${to}`);
    const labels = s.nutrition.map((d) => d.date.slice(5).replace('-', '/'));
    barChart('c-cal', {
      labels, datasets: [{ label: '熱量', data: s.nutrition.map((d) => d.calorie_kcal), color: color(1) }], unit: 'kcal',
      refLine: s.targets.calorie_target_kcal ? { label: '目標', value: s.targets.calorie_target_kcal } : null, legend: false,
    });
    barChart('c-pro', {
      labels, datasets: [{ label: '蛋白質', data: s.nutrition.map((d) => d.protein_g), color: color(1) }], unit: 'g',
      refLine: s.targets.protein_target_g ? { label: '目標', value: s.targets.protein_target_g } : null, legend: false,
    });
    const days = dateRange(from, to);
    const exMap = Object.fromEntries(s.exercise.map((e) => [e.date, e.minutes]));
    barChart('c-ex', { labels: days.map((d) => d.slice(5).replace('-', '/')), datasets: [{ label: '運動', data: days.map((d) => exMap[d] ?? null), color: color(1) }], unit: '分鐘' });
    document.getElementById('ex-types').textContent = Object.entries(s.exercise_by_type).map(([k, v]) => `${k} ${v} 分`).join('、') || '此期間無運動紀錄';
    await renderRecordTable(document.getElementById('t-meal'), 'Meal_Log', { from, to });
    await renderRecordTable(document.getElementById('t-ex'), 'Exercise_Log', { from, to });
  }
  await load(addDays(me.today, -29), me.today);
}

// ---------------------------------------------------------------------------
// 資料管理（修正、補登）
// ---------------------------------------------------------------------------

async function records() {
  const sheets = Object.keys(SHEET_VIEWS);
  let sheet = sessionStorage.getItem('rec-sheet') || 'Weight_Log';
  $view.innerHTML = `
    <h2>資料管理</h2>
    <div class="toolbar" id="sheet-pick">${sheets.map((s) => `<button class="seg ${s === sheet ? 'on' : ''}" data-s="${s}">${SHEET_VIEWS[s].title}</button>`).join('')}</div>
    <div class="toolbar"><input type="date" id="r-from" value="${addDays(me.today, -29)}"> ～ <input type="date" id="r-to" value="${me.today}"> <button id="r-go">查詢</button></div>
    <div class="card"><h3>新增／補登</h3><div id="r-add"></div></div>
    <div class="card"><div id="r-table"></div></div>`;
  const load = async () => {
    const from = document.getElementById('r-from').value;
    const to = document.getElementById('r-to').value;
    const dateKey = SHEET_VIEWS[sheet].cols[0][0];
    renderAddForm(document.getElementById('r-add'), sheet, { [dateKey]: me.today }, load);
    await renderRecordTable(document.getElementById('r-table'), sheet, { from, to });
  };
  document.getElementById('sheet-pick').onclick = (e) => {
    const b = e.target.closest('button[data-s]');
    if (!b) return;
    sheet = b.dataset.s;
    try { sessionStorage.setItem('rec-sheet', sheet); } catch { /* ignore */ }
    document.querySelectorAll('#sheet-pick button').forEach((x) => x.classList.toggle('on', x === b));
    load().catch((err) => toast(err.message, true));
  };
  document.getElementById('r-go').onclick = () => load().catch((err) => toast(err.message, true));
  await load();
}

// ---------------------------------------------------------------------------
// 作業排程
// ---------------------------------------------------------------------------

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

async function tasks() {
  const [{ rows, task_types: types }, rem] = await Promise.all([api('/tasks'), api('/reminders')]);
  const freqText = (t) => (t.frequency === '每週' ? `每週${WEEKDAYS[Number(t.weekday)] ?? '?'}` : t.frequency === '每月' ? `每月 ${t.day_of_month === 'last' ? '最後一天' : `${t.day_of_month} 日`}` : '每日');
  const rowHtml = (t) => `
    <tr data-id="${esc(t.task_id)}">
      <td><input data-k="task_name" value="${esc(t.task_name)}"></td>
      <td><select data-k="task_type">${Object.entries(types).map(([k, v]) => `<option value="${k}" ${k === t.task_type ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
      <td><select data-k="frequency">${['每日', '每週', '每月'].map((f) => `<option ${f === t.frequency ? 'selected' : ''}>${f}</option>`).join('')}</select></td>
      <td><select data-k="weekday"><option value=""></option>${WEEKDAYS.map((w, i) => `<option value="${i}" ${String(t.weekday) === String(i) ? 'selected' : ''}>週${w}</option>`).join('')}</select></td>
      <td><input data-k="day_of_month" value="${esc(t.day_of_month ?? '')}" placeholder="1-31 / last" style="width:80px"></td>
      <td><input type="time" data-k="remind_time" value="${esc(t.remind_time)}"></td>
      <td><input type="checkbox" data-k="repeat_enabled" ${t.repeat_enabled === true || t.repeat_enabled === 'TRUE' ? 'checked' : ''}></td>
      <td><input type="number" data-k="repeat_minutes" value="${esc(t.repeat_minutes ?? 30)}" style="width:70px"></td>
      <td><input type="number" data-k="overdue_minutes" value="${esc(t.overdue_minutes ?? 180)}" style="width:70px"></td>
      <td><input data-k="message" value="${esc(t.message ?? '')}"></td>
      <td><input type="checkbox" data-k="enabled" ${t.enabled === true || t.enabled === 'TRUE' ? 'checked' : ''}></td>
      <td><button data-act="save" class="primary">儲存</button></td>
    </tr>`;
  $view.innerHTML = `
    <h2>作業排程管理</h2>
    <div class="note">提醒於設定時間推播；「補提醒」在 N 分鐘後仍未完成時再提醒一次；超過「逾期」分鐘仍未完成標記為逾期。施打日與劑量請依醫囑設定，系統不提供用藥建議。</div>
    <div class="card" style="margin-top:14px"><div class="table-wrap"><table>
      <thead><tr><th>名稱</th><th>類型</th><th>頻率</th><th>星期</th><th>每月日</th><th>時間</th><th>補提醒</th><th>補提醒(分)</th><th>逾期(分)</th><th>提醒訊息</th><th>啟用</th><th></th></tr></thead>
      <tbody id="task-body">${rows.map(rowHtml).join('')}</tbody></table></div>
      <div class="toolbar" style="margin-top:12px"><button id="t-add">＋ 新增作業</button><span class="muted">目前排程：${rows.filter((t) => t.enabled === true || t.enabled === 'TRUE').map((t) => `${esc(t.task_name)} ${freqText(t)} ${esc(t.remind_time)}`).join('｜')}</span></div>
    </div>
    <div class="card"><h3>完成率（${md(rem.from)}～${md(rem.to)}）</h3>
      <table><thead><tr><th>作業</th><th class="num">應完成</th><th class="num">已完成</th><th class="num">逾期</th><th class="num">完成率</th></tr></thead>
      <tbody>${Object.entries(rem.stats).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${v.due}</td><td class="num">${v.done}</td><td class="num">${v.overdue}</td><td class="num">${v.due ? Math.round((v.done / v.due) * 100) : 0}%</td></tr>`).join('') || '<tr><td colspan="5" class="muted">尚無資料</td></tr>'}</tbody></table>
    </div>
    <div class="card"><h3>提醒發送歷史</h3><div class="table-wrap" style="max-height:360px"><table>
      <thead><tr><th>日期</th><th>作業</th><th>類型</th><th>預定</th><th>發送</th><th>狀態</th><th>錯誤</th></tr></thead>
      <tbody>${rem.rows.map((r) => `<tr><td>${md(r.occurrence_date)}</td><td>${esc(r.task_name)}</td><td>${esc(r.reminder_type)}</td><td>${esc(String(r.scheduled_at || '').slice(11, 16))}</td><td>${esc(String(r.sent_at || '').slice(11, 16))}</td>
        <td><span class="pill ${r.status === '已完成' || r.status === '已發送' ? 'good' : r.status === '逾期' || r.status === '失敗' ? 'bad' : ''}">${esc(r.status)}</span></td><td class="muted">${esc(r.last_error || '')}</td></tr>`).join('')}</tbody></table></div></div>`;

  const read = (tr) => {
    const o = {};
    tr.querySelectorAll('[data-k]').forEach((el) => { o[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value; });
    return o;
  };
  document.getElementById('task-body').onclick = async (e) => {
    const b = e.target.closest('button[data-act=save]');
    if (!b) return;
    const tr = b.closest('tr');
    try {
      if (tr.dataset.id) await api(`/tasks/${tr.dataset.id}`, { method: 'PATCH', body: read(tr) });
      else await api('/tasks', { method: 'POST', body: read(tr) });
      toast('已儲存排程');
      tasks();
    } catch (err) { toast(err.message, true); }
  };
  document.getElementById('t-add').onclick = () => {
    document.getElementById('task-body').insertAdjacentHTML('beforeend', rowHtml({
      task_id: '', task_name: '', task_type: 'custom', frequency: '每日', remind_time: '09:00', repeat_enabled: false, repeat_minutes: 0, overdue_minutes: 180, enabled: true,
    }).replace('data-id=""', ''));
  };
}

// ---------------------------------------------------------------------------
// 報表中心
// ---------------------------------------------------------------------------

async function reports() {
  let type = 'Daily';
  $view.innerHTML = `
    <h2>報表中心</h2>
    <div class="toolbar" id="rp-type">${[['Daily', '每日'], ['Weekly', '每週'], ['Monthly', '每月']].map(([k, v]) => `<button class="seg ${k === type ? 'on' : ''}" data-t="${k}">${v}報告</button>`).join('')}
      <span style="margin-left:12px"></span><input type="date" id="rp-date" value="${me.today}"><button id="rp-gen" class="primary">產生／更新報告</button></div>
    <p class="muted">每日 21:00、每週日 20:00、每月最後一天 20:00 自動產生並推播（時間可於作業排程調整）。數值由程式計算，Gemini 只撰寫解讀。</p>
    <div id="rp-list"></div>`;
  const load = async () => {
    const { rows } = await api(`/reports?type=${type}`);
    document.getElementById('rp-list').innerHTML = rows.length ? rows.map((r) => `
      <div class="card"><div class="toolbar" style="margin-bottom:8px"><b>${md(r.start_date)}${r.start_date !== r.end_date ? ` ～ ${md(r.end_date)}` : ''}</b>
        <span class="pill ${r.delivery_status === '已傳送' ? 'good' : r.delivery_status === '失敗' ? 'bad' : ''}">${esc(r.delivery_status || '')}</span>
        <span class="muted">產生於 ${esc(String(r.generated_at || '').replace('T', ' ').slice(0, 16))}</span></div>
        <pre class="report">${esc(r.text)}</pre></div>`).join('') : '<div class="card"><p class="muted">尚無報告。</p></div>';
  };
  document.getElementById('rp-type').onclick = (e) => {
    const b = e.target.closest('button[data-t]');
    if (!b) return;
    type = b.dataset.t;
    document.querySelectorAll('#rp-type button[data-t]').forEach((x) => x.classList.toggle('on', x === b));
    load();
  };
  document.getElementById('rp-gen').onclick = async () => {
    try {
      toast('產生中…');
      await api('/reports/generate', { method: 'POST', body: { type, date: document.getElementById('rp-date').value } });
      toast('報告已產生（未推播）');
      load();
    } catch (err) { toast(err.message, true); }
  };
  await load();
}

// ---------------------------------------------------------------------------
// 目標
// ---------------------------------------------------------------------------

async function goals() {
  const [{ rows }, o] = await Promise.all([api('/records/Goal_Log'), api('/overview')]);
  $view.innerHTML = `
    <h2>目標設定與追蹤</h2>
    <div class="grid">${o.goals.map((g) => `
      <div class="stat"><div class="label">${esc(g.goal_type)}目標</div><div class="value">${g.progress.pct ?? '—'}%</div>
        <div class="bar"><span style="width:${g.progress.pct ?? 0}%"></span></div>
        <div class="sub">起始 ${fmt(g.start_value)} → 目前 ${fmt(g.current_value)} → 目標 ${g.target_value}${g.unit}${g.progress.remaining !== null ? `｜尚差 ${g.progress.remaining}${g.unit}` : ''}${g.target_date ? `｜期限 ${md(g.target_date)}（剩 ${g.progress.days_left} 天）` : ''}</div></div>`).join('') || '<p class="muted">尚未設定進行中的目標。</p>'}
    </div>
    <div class="card" style="margin-top:16px"><h3>新增目標</h3>
      <form id="g-form" class="form-grid">
        <label class="field">類型<select name="goal_type"><option>體重</option><option>體脂</option><option>肌肉</option></select></label>
        <label class="field">目標值<input name="target_value" type="number" step="any" required></label>
        <label class="field">期限<input name="target_date" type="date"></label>
        <label class="field">起始值（空白＝最新紀錄）<input name="start_value" type="number" step="any"></label>
        <label class="field">備註<input name="note"></label>
        <div style="display:flex;align-items:end"><button class="primary">儲存目標</button></div>
      </form>
      <p class="muted">同類型的舊目標會自動改為「暫停」。</p></div>
    <div class="card"><h3>目標歷史</h3><table><thead><tr><th>類型</th><th class="num">起始</th><th class="num">目標</th><th>開始</th><th>期限</th><th>狀態</th></tr></thead>
      <tbody>${rows.map((g) => `<tr><td>${esc(g.goal_type)}</td><td class="num">${fmt(g.start_value)}</td><td class="num">${fmt(g.target_value)}</td><td>${esc(g.start_date)}</td><td>${esc(g.target_date || '')}</td><td>${esc(g.status)}</td></tr>`).join('')}</tbody></table></div>`;
  document.getElementById('g-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = Object.fromEntries([...f.entries()].filter(([, v]) => v !== ''));
    ['target_value', 'start_value'].forEach((k) => { if (k in body) body[k] = Number(body[k]); });
    try { await api('/records/Goal_Log', { method: 'POST', body }); toast('目標已儲存'); goals(); } catch (err) { toast(err.message, true); }
  };
}

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

const SETTING_FIELDS = [
  ['基本', [['display_name', '顯示名稱', 'text'], ['timezone', '時區', 'text'], ['height_cm', '身高 cm（計算 BMI）', 'number']]],
  ['提醒', [['reminder_enabled', '啟用提醒', 'bool'], ['pause_until', '暫停提醒至', 'date'], ['skip_dates', '略過日期（逗號分隔 YYYY-MM-DD）', 'text']]],
  ['上午／下午判斷', [['am_window_start', '上午開始', 'time'], ['am_window_end', '上午結束', 'time'], ['pm_window_start', '下午開始', 'time'], ['pm_window_end', '下午結束', 'time']]],
  ['體重防呆', [['weight_min_kg', '最低合理體重', 'number'], ['weight_max_kg', '最高合理體重', 'number'], ['weight_jump_alert_kg', '與上一筆差距警示 kg', 'number']]],
  ['營養與運動目標', [['calorie_target_kcal', '每日熱量 kcal', 'number'], ['protein_target_g', '每日蛋白質 g', 'number'], ['fat_target_g', '每日脂肪 g', 'number'], ['carb_target_g', '每日碳水 g', 'number'], ['exercise_target_min_week', '每週運動分鐘', 'number']]],
  ['其他', [['default_medication', '預設藥物名稱（施打紀錄）', 'text'], ['report_ai_enabled', '報告使用 Gemini 摘要', 'bool']]],
];

async function settings() {
  const { settings: s } = await api('/settings');
  $view.innerHTML = `
    <h2>系統設定</h2>
    <form id="s-form">${SETTING_FIELDS.map(([title, fields]) => `
      <div class="card"><h3>${title}</h3><div class="form-grid">${fields.map(([k, label, t]) => `
        <label class="field">${label}${t === 'bool'
          ? `<input type="checkbox" name="${k}" ${s[k] ? 'checked' : ''} style="width:auto">`
          : `<input type="${t === 'number' ? 'number" step="any' : t}" name="${k}" value="${esc(s[k] ?? '')}">`}</label>`).join('')}
      </div></div>`).join('')}
      <button class="primary">儲存設定</button>
    </form>
    <p class="muted" style="margin-top:14px">提醒時間請在「作業排程」調整。營養目標由您自行設定，系統不自動給建議值。</p>`;
  document.getElementById('s-form').onsubmit = async (e) => {
    e.preventDefault();
    const body = {};
    SETTING_FIELDS.flatMap(([, f]) => f).forEach(([k, , t]) => {
      const el = e.target.elements[k];
      body[k] = t === 'bool' ? el.checked : el.value;
    });
    try { await api('/settings', { method: 'PUT', body }); toast('設定已儲存'); } catch (err) { toast(err.message, true); }
  };
}

boot();
