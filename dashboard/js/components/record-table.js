import { api, esc, toast, openProtected } from '../api.js';

// 每張資料表要顯示的欄位、標籤與輸入型態
export const SHEET_VIEWS = {
  Weight_Log: {
    title: '體重紀錄',
    cols: [
      ['measure_date', '日期', 'date'], ['weekday', '星期', 'ro'], ['measure_time', '時間', 'time'],
      ['period', '時段', 'select', ['AM', 'PM']], ['weight_kg', '體重 kg', 'number'], ['source', '來源', 'ro'],
      ['status', '狀態', 'ro'], ['note', '備註', 'text'],
    ],
  },
  Body_Composition: {
    title: '身體組成',
    cols: [
      ['measure_date', '日期', 'date'], ['weight_kg', '體重', 'number'], ['body_fat_pct', '體脂率 %', 'number'],
      ['body_fat_kg', '體脂肪 kg', 'number'], ['skeletal_muscle_kg', '骨骼肌 kg', 'number'], ['visceral_fat', '內臟脂肪', 'number'],
      ['bmr_kcal', '基礎代謝', 'number'], ['bmi', 'BMI', 'number'], ['photo_id', '照片', 'photo'], ['ai_confidence', '辨識', 'ro'], ['status', '狀態', 'ro'],
    ],
  },
  Meal_Log: {
    title: '飲食紀錄',
    cols: [
      ['meal_date', '日期', 'date'], ['meal_time', '時間', 'time'], ['meal_type', '餐別', 'select', ['早餐', '午餐', '晚餐', '點心']],
      ['food_name', '食物', 'text'], ['quantity', '份量', 'text'], ['calorie_kcal', '熱量', 'number'], ['protein_g', '蛋白質', 'number'],
      ['fat_g', '脂肪', 'number'], ['carb_g', '碳水', 'number'], ['nutrition_source', '來源', 'select', ['AI估算', '產品標示', '使用者輸入', '使用者修正', '資料庫']],
      ['photo_id', '照片', 'photo'],
    ],
  },
  Exercise_Log: {
    title: '運動紀錄',
    cols: [
      ['exercise_date', '日期', 'date'], ['exercise_time', '時間', 'time'], ['exercise_type', '類型', 'text'], ['duration_min', '分鐘', 'number'],
      ['distance_km', '距離 km', 'number'], ['intensity', '強度', 'select', ['低', '中', '高']], ['calories_burned', '消耗 kcal', 'number'],
      ['calories_source', '消耗來源', 'select', ['估算', '使用者輸入', '裝置']], ['note', '備註', 'text'],
    ],
  },
  Injection_Log: {
    title: '施打紀錄',
    cols: [
      ['injection_date', '日期', 'date'], ['injection_time', '時間', 'time'], ['medication', '藥物', 'text'], ['dosage_mg', '劑量 mg', 'number'],
      ['status', '狀態', 'select', ['已施打', '延後', '未施打']], ['note', '備註', 'text'],
    ],
  },
};

function cell(row, [key, , type]) {
  const v = row[key];
  if (type === 'photo') return v ? `<a href="#" data-photo="${esc(v)}">檢視</a>` : '';
  return esc(v ?? '');
}

function input(row, [key, , type, opts]) {
  const v = row[key] ?? '';
  if (type === 'ro' || type === 'photo') return cell(row, [key, '', type]);
  if (type === 'select') {
    return `<select data-k="${key}">${['', ...opts].map((o) => `<option ${String(o) === String(v) ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  }
  const t = type === 'number' ? 'number" step="any' : type;
  return `<input type="${t}" data-k="${key}" value="${esc(v)}">`;
}

/**
 * 可編輯表格：點「修改」→ 行內編輯 →「儲存」寫回（後端保留修改前後值）
 */
export async function renderRecordTable(container, sheet, { from, to, onChange } = {}) {
  const view = SHEET_VIEWS[sheet];
  const q = new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) });
  const { rows } = await api(`/records/${sheet}?${q}`);
  const idKey = { Weight_Log: 'weight_id', Body_Composition: 'body_id', Meal_Log: 'meal_id', Exercise_Log: 'exercise_id', Injection_Log: 'injection_id' }[sheet];
  const numeric = new Set(view.cols.filter((c) => c[2] === 'number').map((c) => c[0]));

  const draw = () => {
    container.innerHTML = rows.length ? `
      <div class="table-wrap"><table>
        <thead><tr>${view.cols.map((c) => `<th class="${numeric.has(c[0]) ? 'num' : ''}">${c[1]}</th>`).join('')}<th></th></tr></thead>
        <tbody>${rows.map((r) => `
          <tr data-id="${esc(r[idKey])}">
            ${view.cols.map((c) => `<td class="${numeric.has(c[0]) ? 'num' : ''}">${cell(r, c)}</td>`).join('')}
            <td style="white-space:nowrap"><button data-act="edit">修改</button> <button data-act="del" class="danger">刪除</button> <button data-act="hist">歷程</button></td>
          </tr>`).join('')}
        </tbody></table></div>` : '<p class="muted">此期間沒有資料。</p>';
  };
  draw();

  container.onclick = async (e) => {
    const photo = e.target.closest('a[data-photo]');
    if (photo) { e.preventDefault(); return openProtected(`/photos/${encodeURIComponent(photo.dataset.photo)}`); }
    const btn = e.target.closest('button');
    if (!btn) return;
    const tr = btn.closest('tr');
    const id = tr?.dataset.id;
    const row = rows.find((r) => r[idKey] === id);
    const act = btn.dataset.act;
    try {
      if (act === 'edit') {
        tr.classList.add('editing');
        tr.innerHTML = `${view.cols.map((c) => `<td>${input(row, c)}</td>`).join('')}
          <td style="white-space:nowrap"><button data-act="save" class="primary">儲存</button> <button data-act="cancel">取消</button></td>`;
      } else if (act === 'cancel') {
        draw();
      } else if (act === 'save') {
        const patch = {};
        tr.querySelectorAll('[data-k]').forEach((el) => {
          const k = el.dataset.k;
          const val = el.value;
          if (String(row[k] ?? '') !== val) patch[k] = numeric.has(k) ? (val === '' ? null : Number(val)) : val;
        });
        if (!Object.keys(patch).length) { draw(); return; }
        const r = await api(`/records/${sheet}/${id}`, { method: 'PATCH', body: patch });
        Object.assign(row, r.row);
        toast(`已更新 ${r.changes} 個欄位（保留修改紀錄）`);
        draw();
        onChange?.();
      } else if (act === 'del') {
        if (!window.confirm('確定刪除？（資料標記為已刪除，不會真的移除）')) return;
        await api(`/records/${sheet}/${id}`, { method: 'DELETE' });
        rows.splice(rows.indexOf(row), 1);
        toast('已刪除');
        draw();
        onChange?.();
      } else if (act === 'hist') {
        const { rows: logs } = await api(`/audit?record_id=${encodeURIComponent(id)}`);
        window.alert(logs.length ? logs.map((l) => `${l.changed_at}  ${l.field}：${l.before_value} → ${l.after_value}（${l.changed_by}）`).join('\n') : '沒有修改紀錄');
      }
    } catch (err) {
      toast(err.message, true);
    }
  };
}

/** 新增表單 */
export function renderAddForm(container, sheet, defaults, onDone) {
  const view = SHEET_VIEWS[sheet];
  const cols = view.cols.filter((c) => !['ro', 'photo'].includes(c[2]));
  container.innerHTML = `
    <form class="form-grid">
      ${cols.map((c) => `<label class="field">${c[1]}${input(defaults, c)}</label>`).join('')}
      <div style="display:flex;align-items:end"><button class="primary" type="submit">新增</button></div>
    </form>`;
  container.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    const body = {};
    container.querySelectorAll('[data-k]').forEach((el) => {
      if (el.value === '') return;
      const c = cols.find((x) => x[0] === el.dataset.k);
      body[el.dataset.k] = c[2] === 'number' ? Number(el.value) : el.value;
    });
    try {
      await api(`/records/${sheet}`, { method: 'POST', body });
      toast('已新增');
      onDone?.();
    } catch (err) {
      toast(err.message, true);
    }
  };
}
