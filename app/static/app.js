/* 全局共享工具、网络层、科目元数据缓存、纸面确认窗与月历弹窗。 */
const $ = (selector, root = document) => root?.querySelector(selector) ?? null;
const $$ = (selector, root = document) => (root ? [...root.querySelectorAll(selector)] : []);
const esc = (value = '') =>
  String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const page = document.body.dataset.page;

function deepClone(value) {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

const timeCategoryNames = {
  learning: '有效学习',
  distraction: '分心',
  rest: '主动休息',
  external: '外部打断',
  life: '生活活动',
  legacy_interrupt: '其他非学习（旧记录）',
  legacy_counted: '旧计总（保留原口径）',
};

const labelTimeCategory = label =>
  label.time_category
  || ({
    counted_toilet: 'life',
    counted_walk: 'rest',
    counted_game: 'distraction',
    interrupt_meal: 'life',
    interrupt_incident: 'external',
    interrupt_pause: 'rest',
  }[label.id])
  || (label.bucket === 'counted' ? 'distraction' : 'external');

const segmentTimeCategory = segment =>
  segment.time_category
  || (segment.segment_kind === 'effective'
    ? 'learning'
    : segment.segment_kind === 'counted_label'
      ? 'legacy_counted'
      : 'legacy_interrupt');

function renderTimeSummary(node, summary) {
  if (!node || !summary) return;
  node.innerHTML = `<div class="time-summary-heading"><h2>时间去向</h2><span>已记录 ${formatMinutes(Math.floor(summary.recorded_seconds / 60), summary.recorded_seconds)}</span></div><p class="muted">学习有效率只看学习与分心；休息、生活和外部打断单列。未记录的空档不包含在内。</p><dl class="time-category-list">${Object.entries(summary.categories).filter(([key, value]) => value > 0 || key === 'learning').map(([key, value]) => `<div><dt>${timeCategoryNames[key]}</dt><dd>${formatMinutes(Math.floor(value / 60), value)}</dd></div>`).join('')}</dl><p class="time-summary-efficiency">学习有效率 <strong>${summary.effective_ratio === null ? '—' : formatPercent(summary.effective_ratio)}</strong></p>`;
}

const todayIso = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });

function shiftDays(dateValue, deltaDays) {
  const anchor = new Date(`${dateValue}T12:00:00+08:00`);
  anchor.setDate(anchor.getDate() + deltaDays);
  return anchor.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

function uiIcon(name) {
  const sprite = document.body?.dataset?.iconSprite || '/static/icons/ui.svg';
  return `<svg class="ui-icon" aria-hidden="true" focusable="false"><use href="${esc(sprite)}#${esc(name)}"></use></svg>`;
}

function bindDialogBackdropClose(dialog, isBusy = () => false) {
  if (!dialog) return;
  dialog.addEventListener('click', event => {
    if (event.target !== dialog || isBusy()) return;
    if (event.clientX === 0 && event.clientY === 0) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
      dialog.close();
    }
  });
}

let toastTimer = null;
const toast = message => {
  const element = $('#toast');
  if (!element) return;
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
  element.textContent = message;
  element.classList.add('show');
  toastTimer = setTimeout(() => {
    element.classList.remove('show');
    toastTimer = null;
  }, 2400);
};

function confirmAction(message, options = {}) {
  const modal = $('#confirm-modal');
  const messageNode = $('#confirm-message');
  const headingNode = $('.confirm-heading', modal);
  const acceptButton = $('#confirm-accept');
  const cancelButton = $('#confirm-cancel');
  const dismissNodes = $$('[data-confirm-dismiss]', modal);
  const previousActive = document.activeElement;

  headingNode.textContent = options.title || '清空这一天的数据？';
  messageNode.textContent = message;
  acceptButton.textContent = options.confirmLabel || '确认清空';
  cancelButton.textContent = options.cancelLabel || '取消';
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
  acceptButton.focus();

  return new Promise(resolve => {
    let settled = false;

    const finish = decision => {
      if (settled) return;
      settled = true;
      modal.classList.add('hidden');
      modal.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('modal-open');
      acceptButton.onclick = null;
      cancelButton.onclick = null;
      dismissNodes.forEach(node => { node.onclick = null; });
      document.removeEventListener('keydown', handleKeydown);
      previousActive?.focus?.();
      resolve(decision);
    };

    const handleKeydown = event => {
      if (event.key === 'Escape') finish(false);
    };

    acceptButton.onclick = () => finish(true);
    cancelButton.onclick = () => finish(false);
    dismissNodes.forEach(node => { node.onclick = () => finish(false); });
    document.addEventListener('keydown', handleKeydown);
  });
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
  } catch {
    window.dispatchEvent(new Event('app-network-error'));
    const error = new Error('无法连接服务器，这次操作尚未确认保存；请联网后核对记录再重试。');
    error.status = 0;
    throw error;
  }
  if (!response.ok) {
    if (response.status >= 500) window.dispatchEvent(new Event('app-network-error'));
    let detail = '操作失败';
    try {
      const payload = await response.json();
      const rawDetail = payload?.detail;
      if (Array.isArray(rawDetail) && rawDetail.length) {
        detail = rawDetail.map(item => item?.msg || item?.message || '').find(Boolean) || detail;
      } else if (typeof rawDetail === 'string' && rawDetail.trim()) {
        detail = rawDetail;
      }
    } catch {}
    const error = new Error(detail);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function filenameFromDisposition(value, fallback = 'daily_plan_backup.db') {
  const match = /filename="?([^"]+)"?/i.exec(value || '');
  return match?.[1] || fallback;
}

async function downloadBackupFile() {
  const response = await fetch('/api/system/backup-export');
  if (!response.ok) {
    let detail = '导出备份失败';
    try {
      const payload = await response.json();
      if (typeof payload?.detail === 'string' && payload.detail.trim()) detail = payload.detail;
    } catch {}
    throw new Error(detail);
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filenameFromDisposition(response.headers.get('Content-Disposition'));
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

async function resetDailyDataFor(dateValue) {
  if (!dateValue) return null;
  const confirmed = await confirmAction(
    `将清空 ${dateValue} 的计划、任务、计时、分钟录入、关联待审项及日复盘，并从日周统计移除。清空前自动保存快照，可恢复这一天；GPT 留档和周最终稿保留。`
  );
  if (!confirmed) return null;
  const result = await api(`/api/daily-data/${dateValue}`, { method: 'DELETE' });
  try { localStorage.removeItem(`daily-plan:review-draft:v1:daily:${dateValue}`); } catch {}
  return result;
}

let recoverySequence = 0;
async function refreshResetRecovery(dateValue, onRestored) {
  const button = $('#restore-reset');
  if (!button) return;
  const sequence = ++recoverySequence;
  button.hidden = true;
  button.onclick = null;
  if (!dateValue) return;
  try {
    const snapshots = await api(`/api/daily-data/${dateValue}/reset-snapshots`);
    if (sequence !== recoverySequence || !snapshots.length) return;
    const snapshot = snapshots[0];
    button.hidden = false;
    button.title = `${dateValue} · 重置于 ${snapshot.created_at.replace('T', ' ')}`;
    button.onclick = async () => {
      const { tasks, segments, durations, reviews, vocabulary_counts = 0 } = snapshot.counts;
      if (!await confirmAction(
        `恢复 ${dateValue} 重置前的 ${tasks} 项任务、${segments} 段计时、${durations} 条分钟录入和 ${reviews} 份日复盘${vocabulary_counts ? `、${vocabulary_counts} 份背单词词数` : ''}。进行中的计时恢复为重置时停止。若这天已有新数据，会拒绝覆盖；其他日期保持不变。`,
        { title: '恢复重置前的记录？', confirmLabel: '恢复这一天' }
      )) return;
      button.disabled = true;
      try {
        await api(`/api/daily-data/${dateValue}/reset-snapshots/${snapshot.id}/restore`, { method: 'POST' });
        invalidateCalendarMonth(dateValue);
        await onRestored();
        toast('已恢复重置前的当日记录');
      } catch (error) {
        toast(error.message);
      } finally {
        button.disabled = false;
      }
    };
  } catch (error) {
    if (sequence === recoverySequence) toast(`恢复入口读取失败：${error.message}`);
  }
}

/* 统一设置缓存与科目能力目录 */
let settings = null;
let settingsPromise = null;

const FALLBACK_CATEGORY_META = {
  math: { id: 'math', default_title: '数学', default_task_type: 'daily_goal', supports_word_count: false, word_label_id: null, sub_categories: [], common_minutes: [90, 180, 240, 300], palette_index: 0, icon_key: 'calculator' },
  english: { id: 'english', default_title: '英语', default_task_type: 'daily_goal', supports_word_count: true, word_label_id: 'effective_english_words', sub_categories: [], common_minutes: [15, 30, 45, 60], palette_index: 1, icon_key: 'languages' },
  computer: { id: 'computer', default_title: '408', default_task_type: 'daily_goal', supports_word_count: false, word_label_id: null, sub_categories: ['数据结构', '计算机网络', '操作系统', '计算机组成原理'], common_minutes: [60, 90, 120, 180], palette_index: 2, icon_key: 'cpu' },
  rehab: { id: 'rehab', default_title: '运动', default_task_type: 'habit', supports_word_count: false, word_label_id: null, sub_categories: [], common_minutes: [15, 30, 45, 60], palette_index: 3, icon_key: 'activity' },
  ai_project: { id: 'ai_project', default_title: 'AI 项目', default_task_type: 'daily_goal', supports_word_count: false, word_label_id: null, sub_categories: [], common_minutes: [30, 60, 90, 120], palette_index: 4, icon_key: 'code' },
  sleep: { id: 'sleep', default_title: '睡眠', default_task_type: 'habit', supports_word_count: false, word_label_id: null, sub_categories: [], common_minutes: [15, 30, 45, 60], palette_index: 5, icon_key: 'moon' },
  vibe_coding: { id: 'vibe_coding', default_title: 'vibe coding', default_task_type: 'daily_goal', supports_word_count: false, word_label_id: null, sub_categories: [], common_minutes: [30, 60, 90, 120], palette_index: 4, icon_key: 'code' },
  algorithm: { id: 'algorithm', default_title: '算法', default_task_type: 'daily_goal', supports_word_count: false, word_label_id: null, sub_categories: [], common_minutes: [30, 45, 60, 90], palette_index: 2, icon_key: 'git-branch' },
  reading: { id: 'reading', default_title: '阅读', default_task_type: 'daily_goal', supports_word_count: false, word_label_id: null, sub_categories: [], common_minutes: [20, 30, 45, 60], palette_index: 5, icon_key: 'book' },
  writing: { id: 'writing', default_title: '练字', default_task_type: 'daily_goal', supports_word_count: false, word_label_id: null, sub_categories: ['中文', '英文'], common_minutes: [15, 20, 30, 45], palette_index: 3, icon_key: 'pen' },
};

function setSettings(next) {
  settings = next;
  settingsPromise = next ? Promise.resolve(next) : null;
  return settings;
}

async function ensureSettings(force = false) {
  if (!force && settings) return settings;
  if (!force && settingsPromise) return settingsPromise;
  settingsPromise = api('/api/settings')
    .then(result => {
      settings = result;
      return result;
    })
    .catch(error => {
      settingsPromise = null;
      throw error;
    });
  return settingsPromise;
}

function categoryMeta(category) {
  const fromCatalog = settings?.category_catalog?.[category];
  const fallback = FALLBACK_CATEGORY_META[category];
  const title = settings?.task_titles?.[category] || fromCatalog?.title || fallback?.default_title || category || '项目';
  if (fromCatalog) return { ...fromCatalog, title };
  if (fallback) return { ...fallback, title };
  return {
    id: category,
    title,
    default_title: title,
    default_task_type: 'daily_goal',
    counts_as_study_goal: true,
    supports_word_count: false,
    word_label_id: null,
    sub_categories: [],
    common_minutes: [30, 60, 90, 120],
    palette_index: null,
    icon_key: 'bookmark',
  };
}

const calendarCache = {};
let calendarState = null;

function monthKeyFromDate(dateValue) {
  return String(dateValue || '').slice(0, 7);
}

function shiftMonth(monthKey, delta) {
  const [year, month] = monthKey.split('-').map(Number);
  const target = new Date(year, month - 1 + delta, 1);
  return `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}`;
}

function formatDateLabel(dateValue) {
  if (!dateValue) return '选择日期';
  const [year, month, day] = dateValue.split('-');
  return `${year}/${month}/${day}`;
}

function formatMonthLabel(monthKey) {
  const [year, month] = monthKey.split('-');
  return `${year} 年 ${Number(month)} 月`;
}

function invalidateCalendarMonth(dateValue) {
  if (!dateValue) return;
  delete calendarCache[monthKeyFromDate(dateValue)];
}

function invalidateAllCalendarMonths() {
  Object.keys(calendarCache).forEach(key => delete calendarCache[key]);
}

function formatMinutes(value, seconds) {
  return seconds > 0 && seconds < 60 ? '小于 1 分' : `${Number(value || 0)} 分`;
}

function formatPercent(value) {
  return `${Math.round(Number(value || 0) * 100)}%`;
}

function toDateTimeInputValue(value) {
  if (!value) return '';
  return String(value).slice(0, 19);
}

function fromDateTimeInputValue(value) {
  if (!value) return '';
  return value.length === 16 ? `${value}:00` : value;
}

function dateToLocalDateTimeValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
}

function taskTypeLabel(value) {
  return { habit: '习惯', daily_goal: '每日目标', todo: '具体待办' }[value] || '每日目标';
}

function habitStatusLabel(value) {
  return { done: '做了', missed: '没做', rest: '休息' }[value] || '未记录';
}

function taskTypeOptions(selected = 'daily_goal') {
  return ['habit', 'daily_goal', 'todo']
    .map(value => `<option value="${value}" ${value === selected ? 'selected' : ''}>${taskTypeLabel(value)}</option>`)
    .join('');
}

function taskBoardRatio(value, total) {
  if (!total) return 0;
  return Math.max(0, Math.min(100, Math.round((Number(value || 0) / total) * 100)));
}

function renderTaskExecutionBoard(container, boards, emptyHtml = '') {
  if (!container) return;
  if (!boards?.length) {
    container.innerHTML = emptyHtml;
    return;
  }
  container.innerHTML = boards.map(board => {
    const barBase = Math.max(
      Number(board.bar_total_seconds ?? (board.bar_total_minutes || 0) * 60),
      Number(board.total_seconds ?? (board.total_minutes || 0) * 60),
      Number(board.interrupt_seconds ?? (board.interrupt_minutes || 0) * 60),
      1,
    );
    return `
      <article class="execution-board-card">
        <div class="execution-board-head">
          <div>
            <h3>${esc(board.task_title)}</h3>
            <p class="muted">${esc(categoryMeta(board.category).title)}</p>
          </div>
          <strong>${formatMinutes(board.total_minutes, board.total_seconds)}</strong>
        </div>
        <div class="execution-board-stats">
          <span>原目标 ${board.estimated_minutes || 0} 分</span>
          ${board.habit_status ? `<span>${habitStatusLabel(board.habit_status)}</span>` : ''}
          <span>有效 ${formatMinutes(board.effective_minutes, board.effective_seconds)}</span>
          <span>分心 ${formatMinutes(board.counted_label_minutes, board.counted_label_seconds)}</span>
          <span>休息与事务 ${formatMinutes(board.interrupt_minutes, board.interrupt_seconds)}</span>
          <span>学习有效率 ${board.time_summary?.effective_ratio === null ? '—' : formatPercent(board.effective_ratio)}</span>
        </div>
        <div class="execution-bar" aria-hidden="true">
          <span class="execution-bar-effective" style="width:${taskBoardRatio(board.effective_seconds ?? board.effective_minutes * 60, barBase)}%"></span>
          <span class="execution-bar-counted" style="width:${taskBoardRatio(board.counted_label_seconds ?? board.counted_label_minutes * 60, barBase)}%"></span>
          <span class="execution-bar-interrupt" style="width:${taskBoardRatio(board.interrupt_seconds ?? board.interrupt_minutes * 60, barBase)}%"></span>
        </div>
        <div class="execution-board-lists">
          <div>
            <h4>有效细分</h4>
            ${board.effective_labels?.length
              ? `<ul>${board.effective_labels.map(label => `<li>${esc(label.label_name)} · ${formatMinutes(label.minutes, label.seconds)} · ${formatPercent(label.effective_share)}</li>`).join('')}</ul>`
              : '<p class="muted">还没有有效细分记录</p>'}
          </div>
          <div>
            <h4>分心</h4>
            ${board.counted_labels?.length
              ? `<ul>${board.counted_labels.map(label => `<li>${esc(label.label_name)} · ${formatMinutes(label.minutes, label.seconds)} · ${label.count} 次</li>`).join('')}</ul>`
              : '<p class="muted">还没有分心记录</p>'}
          </div>
          <div>
            <h4>休息、生活与外部打断</h4>
            ${board.interrupt_labels?.length
              ? `<ul>${board.interrupt_labels.map(label => `<li>${esc(label.label_name)} · ${formatMinutes(label.minutes, label.seconds)} · ${label.count} 次</li>`).join('')}</ul>`
              : '<p class="muted">还没有非学习记录</p>'}
          </div>
        </div>
      </article>
    `;
  }).join('');
}

async function fetchCalendarMonth(monthKey) {
  if (!calendarCache[monthKey]) {
    calendarCache[monthKey] = await api(`/api/calendar-status?month=${monthKey}`);
  }
  return calendarCache[monthKey];
}

function updateDateTrigger(button, dateValue) {
  if (!button) return;
  button.textContent = formatDateLabel(dateValue);
  button.setAttribute('aria-label', `选择日期，当前 ${formatDateLabel(dateValue)}`);
}

function closeCalendar() {
  const modal = $('#calendar-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
  calendarState = null;
}

async function renderCalendarMonth() {
  if (!calendarState) return;
  const monthData = await fetchCalendarMonth(calendarState.month);
  if (!calendarState || calendarState.month !== monthData.month) return;
  $('#calendar-month-label').textContent = formatMonthLabel(monthData.month);
  const first = new Date(`${monthData.month_start}T00:00:00`);
  const mondayOffset = (first.getDay() + 6) % 7;
  const slots = [];
  for (let index = 0; index < mondayOffset; index += 1) {
    slots.push('<span class="calendar-empty-slot" aria-hidden="true"></span>');
  }
  monthData.days.forEach(day => {
    const classes = ['calendar-day'];
    if (day.visibility === 'out_of_range') classes.push('out-of-range');
    if (day.status) classes.push(`status-${day.status}`);
    if (day.is_today) classes.push('is-today');
    if (calendarState.selectedDate === day.date) classes.push('is-selected');
    slots.push(`
      <button type="button" class="${classes.join(' ')}" data-date="${day.date}" ${day.visibility === 'out_of_range' ? 'disabled' : ''}>
        <span class="calendar-day-number">${day.day}</span>
        <span class="calendar-day-dot"></span>
      </button>
    `);
  });
  $('#calendar-grid').innerHTML = slots.join('');
  $$('.calendar-day[data-date]').forEach(button => {
    button.onclick = async () => {
      const nextDate = button.dataset.date;
      if (!calendarState || !nextDate) return;
      calendarState.selectedDate = nextDate;
      const onSelect = calendarState.onSelect;
      closeCalendar();
      try { await onSelect(nextDate); } catch (error) { toast(error.message); }
    };
  });
}

async function openCalendar(options) {
  const modal = $('#calendar-modal');
  if (!modal) return;
  calendarState = {
    month: monthKeyFromDate(options.selectedDate || todayIso()),
    selectedDate: options.selectedDate || todayIso(),
    onSelect: options.onSelect,
    title: options.title || '选择日期',
  };
  $('#calendar-title').textContent = calendarState.title;
  $('#calendar-grid').innerHTML = '<div class="muted">正在加载日期状态…</div>';
  $('#calendar-month-label').textContent = formatMonthLabel(calendarState.month);
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
  await renderCalendarMonth();
}

async function bindSharedCalendarTrigger(button, getSelectedDate, onSelect, title) {
  if (!button) return;
  button.onclick = async () => {
    await openCalendar({
      selectedDate: getSelectedDate(),
      onSelect,
      title,
    });
  };
}

if ($('#calendar-modal')) {
  $('#calendar-close').onclick = closeCalendar;
  $$('[data-calendar-dismiss]').forEach(node => { node.onclick = closeCalendar; });
  $('#calendar-prev-month').onclick = async () => {
    if (!calendarState) return;
    calendarState.month = shiftMonth(calendarState.month, -1);
    await renderCalendarMonth();
  };
  $('#calendar-next-month').onclick = async () => {
    if (!calendarState) return;
    calendarState.month = shiftMonth(calendarState.month, 1);
    await renderCalendarMonth();
  };
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && calendarState) closeCalendar();
  });
}

window.DailyPlan = {
  $,
  $$,
  esc,
  page,
  deepClone,
  todayIso,
  shiftDays,
  uiIcon,
  bindDialogBackdropClose,
  toast,
  confirmAction,
  api,
  ensureSettings,
  setSettings,
  categoryMeta,
  get settings() { return settings; },
};
