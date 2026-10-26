const $ = (selector, root=document) => root.querySelector(selector);
const $$ = (selector, root=document) => [...root.querySelectorAll(selector)];
const esc = (value='') => String(value).replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
const page = document.body.dataset.page;
const timeCategoryNames = {learning:'有效学习',distraction:'分心',rest:'主动休息',external:'外部打断',life:'生活活动',legacy_interrupt:'其他非学习（旧记录）',legacy_counted:'旧计总（保留原口径）'};
const labelTimeCategory = label => label.time_category || ({counted_toilet:'life',counted_walk:'rest',counted_game:'distraction',interrupt_meal:'life',interrupt_incident:'external',interrupt_pause:'rest'}[label.id]) || (label.bucket === 'counted' ? 'distraction' : 'external');
const segmentTimeCategory = segment => segment.time_category || (segment.segment_kind === 'effective' ? 'learning' : segment.segment_kind === 'counted_label' ? 'legacy_counted' : 'legacy_interrupt');
function renderTimeSummary(node, summary) {
  if (!node || !summary) return;
  node.innerHTML = `<div class="time-summary-heading"><h2>时间去向</h2><span>已记录 ${formatMinutes(Math.floor(summary.recorded_seconds/60),summary.recorded_seconds)}</span></div><p class="muted">学习有效率只看学习与分心；休息、生活和外部打断单列。未记录的空档不包含在内。</p><dl class="time-category-list">${Object.entries(summary.categories).filter(([key,value])=>value>0 || key==='learning').map(([key,value])=>`<div><dt>${timeCategoryNames[key]}</dt><dd>${formatMinutes(Math.floor(value/60),value)}</dd></div>`).join('')}</dl><p class="time-summary-efficiency">学习有效率 <strong>${summary.effective_ratio === null ? '—' : formatPercent(summary.effective_ratio)}</strong></p>`;
}
const todayIso = () => new Date().toLocaleDateString('en-CA');
const toast = (message) => {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  setTimeout(() => element.classList.remove('show'), 2200);
};

function confirmAction(message, options={}) {
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
      dismissNodes.forEach(node => node.onclick = null);
      document.removeEventListener('keydown', handleKeydown);
      previousActive?.focus?.();
      resolve(decision);
    };

    const handleKeydown = event => {
      if (event.key === 'Escape') finish(false);
    };

    acceptButton.onclick = () => finish(true);
    cancelButton.onclick = () => finish(false);
    dismissNodes.forEach(node => node.onclick = () => finish(false));
    document.addEventListener('keydown', handleKeydown);
  });
}

async function api(path, options={}) {
  let response;
  try { response = await fetch(path, {cache:'no-store',headers:{'Content-Type':'application/json'}, ...options}); }
  catch { window.dispatchEvent(new Event('app-network-error')); throw new Error('无法连接服务器，这次操作尚未确认保存；请联网后核对记录再重试。'); }
  if (!response.ok) {
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
    throw new Error(detail);
  }
  return response.json();
}

function filenameFromDisposition(value, fallback='daily_plan_backup.db') {
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
  const result = await api(`/api/daily-data/${dateValue}`, {method:'DELETE'});
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
    button.title = `${dateValue} · 重置于 ${snapshot.created_at.replace('T',' ')}`;
    button.onclick = async () => {
      const {tasks,segments,durations,reviews,vocabulary_counts=0} = snapshot.counts;
      if (!await confirmAction(
        `恢复 ${dateValue} 重置前的 ${tasks} 项任务、${segments} 段计时、${durations} 条分钟录入和 ${reviews} 份日复盘${vocabulary_counts ? `、${vocabulary_counts} 份背单词词数` : ''}。进行中的计时恢复为重置时停止。若这天已有新数据，会拒绝覆盖；其他日期保持不变。`,
        {title:'恢复重置前的记录？',confirmLabel:'恢复这一天'})) return;
      button.disabled = true;
      try {
        await api(`/api/daily-data/${dateValue}/reset-snapshots/${snapshot.id}/restore`,{method:'POST'});
        invalidateCalendarMonth(dateValue);
        await onRestored();
        toast('已恢复重置前的当日记录');
      } catch(error) { toast(error.message); }
      finally { button.disabled = false; }
    };
  } catch(error) {
    if (sequence === recoverySequence) toast(`恢复入口读取失败：${error.message}`);
  }
}

let settings = null;
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

function taskTypeLabel(value) { return {habit:'习惯', daily_goal:'每日目标', todo:'具体待办'}[value] || '每日目标'; }
function habitStatusLabel(value) { return {done:'做了', missed:'没做', rest:'休息'}[value] || '未记录'; }
function taskTypeOptions(selected='daily_goal') { return ['habit','daily_goal','todo'].map(value => `<option value="${value}" ${value === selected ? 'selected' : ''}>${taskTypeLabel(value)}</option>`).join(''); }

function taskBoardRatio(value, total) {
  if (!total) return 0;
  return Math.max(0, Math.min(100, Math.round((Number(value || 0) / total) * 100)));
}

function renderTaskExecutionBoard(container, boards, emptyHtml='') {
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
            <p class="muted">${esc(settings?.task_titles?.[board.category] || board.category)}</p>
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
  $$('[data-calendar-dismiss]').forEach(node => node.onclick = closeCalendar);
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

if (page === 'today') {
  const ROUTE_SLOT_COUNT = 5;
  const dateInput = $('#plan-date');
  const dateButton = $('#plan-date-button');
  const carryoverButton = $('#carryover-button');
  const carryoverPopover = $('#carryover-popover');
  const carryoverDot = $('#carryover-dot');
  const carryoverEmpty = $('#carryover-empty');
  const carryoverHint = $('#carryover-hint');
  const carryoverCount = $('#carryover-count');
  const carryoverList = $('#carryover-popover-list');
  const requestedDate = new URLSearchParams(location.search).get('date');
  dateInput.value = PlanUI.validDate(requestedDate) ? requestedDate : todayIso();
  updateDateTrigger(dateButton, dateInput.value);
  let currentPlan = null;
  let swapSourceId = null;
  let carryoverItems = [];
  let targetEditState = null;
  let targetEditBusy = false;

  function setTodayStage(stage) {
    const checkinStage = $('#today-checkin-stage');
    const reviewStage = $('#today-review-stage');
    const showingReview = stage === 'review';
    checkinStage.classList.toggle('hidden', showingReview);
    reviewStage.classList.toggle('hidden', !showingReview);
    document.body.classList.toggle('today-list-stage', showingReview);
    $('#today-page-header .plan-status-actions').classList.toggle('hidden', !showingReview);
    $('#today-page-header h1').textContent = showingReview
      ? (currentPlan?.status === 'draft' ? '安排今天' : '今天的清单') : (targetEditState ? '修改目标时长' : '今天的目标');
    const historical = dateInput.value !== todayIso();
    if (historical && !targetEditState) $('#today-page-header h1').textContent = dateInput.value < todayIso() ? '历史计划' : '所选日期计划';
    $('#reset-day').textContent = historical ? '重置此日' : '重置今天';
    if (showingReview) window.scrollTo({top: 0, behavior: 'smooth'});
  }

  const taskTitle = task => settings?.task_titles?.[task.category] || task.category;
  const taskById = id => currentPlan?.tasks.find(task => String(task.id) === String(id));

  function closeCarryoverPopover() {
    carryoverPopover?.classList.add('hidden');
    carryoverPopover?.setAttribute('aria-hidden', 'true');
    carryoverButton?.setAttribute('aria-expanded', 'false');
  }

  function toggleCarryoverPopover(forceOpen) {
    if (!carryoverPopover || !carryoverButton) return;
    const shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : carryoverPopover.classList.contains('hidden');
    carryoverPopover.classList.toggle('hidden', !shouldOpen);
    carryoverPopover.setAttribute('aria-hidden', String(!shouldOpen));
    carryoverButton.setAttribute('aria-expanded', String(shouldOpen));
  }

  function renderCarryoverPopover() {
    if (!carryoverList || !carryoverCount || !carryoverEmpty || !carryoverHint || !carryoverDot) return;
    const hasItems = carryoverItems.length > 0;
    carryoverCount.textContent = carryoverItems.length;
    carryoverDot.classList.toggle('hidden', !hasItems);
    carryoverEmpty.classList.toggle('hidden', hasItems);
    carryoverHint.classList.toggle('hidden', !hasItems);
    carryoverList.innerHTML = hasItems
      ? carryoverItems.map(item => `<div class="carryover" data-id="${Number(item.id)}"><div><strong>${esc(item.title)}</strong><small>${Number(item.estimated_minutes)} 分钟 · ${esc(settings?.task_titles?.[item.category] || item.category)}</small></div><div class="carryover-actions"><button data-action="reschedule">重排</button><button data-action="split">拆小</button><button data-action="discard">放弃</button></div></div>`).join('')
      : '';
    $$('.carryover-actions button', carryoverPopover).forEach(button => button.onclick = async () => {
      const action = button.dataset.action;
      const payload = {action};
      if (action === 'reschedule') payload.target_date = prompt('重排到哪一天？格式 YYYY-MM-DD', dateInput.value);
      if (action === 'split') payload.split_title = prompt('拆小后的任务名称');
      if (action !== 'discard' && !payload.target_date && !payload.split_title) return;
      try {
        await api(`/api/carryovers/${button.closest('.carryover').dataset.id}/resolve`, {method:'POST', body:JSON.stringify(payload)});
        await loadCarryovers();
        toggleCarryoverPopover(true);
        toast('待审项已处理');
      } catch (error) { toast(error.message); }
    });
  }

  document.addEventListener('click', event => {
    if (!carryoverPopover || carryoverPopover.classList.contains('hidden')) return;
    if (carryoverButton?.contains(event.target) || carryoverPopover.contains(event.target)) return;
    closeCarryoverPopover();
  });

  function draftTasksFromDom() {
    if (!currentPlan || currentPlan.status !== 'draft') return currentPlan?.tasks || [];
    return $$('.task-card[data-task-id]').map(card => {
      const original = taskById(card.dataset.taskId);
      const activeTab = $('.sub-category-tabs .active', card);
      return {
        ...original,
        title: $('.title-input', card)?.value || original.title,
        estimated_minutes: Number($('.minutes-input', card)?.value ?? original.estimated_minutes),
        completion_criteria: $('.criteria-input', card)?.value ?? original.completion_criteria,
        sub_category: activeTab?.dataset.val || original.sub_category,
        task_type: $('.task-type-input', card)?.value || original.task_type,
        is_sub: card.closest('#sub-route-list') ? true : false,
      };
    });
  }

  function syncDraftFromDom() {
    if (!currentPlan || currentPlan.status !== 'draft') return;
    currentPlan.tasks = draftTasksFromDom();
  }

  function currentEstimatedMinutes() {
    const tasks = currentPlan?.status === 'draft' ? draftTasksFromDom() : currentPlan?.tasks || [];
    return tasks.reduce((sum, task) => sum + Number(task.estimated_minutes || 0), 0);
  }

  function updateTimeSummary() {
    const summary = $('#time-summary');
    if (!currentPlan) {
      summary.classList.add('hidden');
      return;
    }
    summary.classList.remove('hidden');
    const total = currentEstimatedMinutes();
    summary.textContent = `计划合计 ${total} 分`;
    const display = $('#plan-total-display');
    if (display) display.innerHTML = `${total} <small>分钟</small>`;
    $('#plan-main-count').textContent = `${currentPlan.tasks.filter(task => !task.is_sub).length} 项主要安排`;

  }

  function taskPayload() {
    return draftTasksFromDom().map(task => ({
      id: task.id,
      title: task.title,
      category: task.category,
      estimated_minutes: task.estimated_minutes,
      priority: task.priority,
      completion_criteria: task.completion_criteria,
      reason: task.reason || '',
      source: task.source || 'rule',
      task_type: task.task_type,
      is_sub: task.is_sub ? 1 : 0,
      sub_category: task.sub_category || null,
    }));
  }

  function renderSubmitButton(plan) {
    const button = $('#open-execution-desk');
    const badge = $('#plan-status');
    if (plan.status === 'draft') {
      button.classList.add('hidden');
      badge.className = 'status';
      badge.textContent = '草稿';
    } else {
      button.className = 'primary btn-submit';
      button.disabled = false;
      button.textContent = dateInput.value === todayIso() ? '进入执行台' : '查看当日执行记录';
      badge.className = 'status plan-confirmed-status';
      badge.textContent = '计划已安排';
    }
  }

  function subCategoryTabs(task) {
    let values = [];
    let labels = [];
    if (task.category === 'computer') {
      values = ['数据结构', '计算机网络', '操作系统', '计算机组成原理'];
      labels = ['数据结构', '计网', 'OS', '计组'];
    } else if (task.category === 'writing') {
      values = ['中文', '英文'];
      labels = values;
    }
    if (!values.length) return '';
    return `<div class="sub-category-tabs" data-task-id="${task.id}">${values.map((value, index) =>
      `<button type="button" class="tab-btn ${task.sub_category === value ? 'active' : ''}" data-val="${value}">${labels[index]}</button>`
    ).join('')}</div>`;
  }

  function taskControls(task, index, routeLength) {
    if (currentPlan.status !== 'draft') return '';
    return `<div class="task-controls">
      <button type="button" class="order-button move-up" ${index === 0 ? 'disabled' : ''} aria-label="上移">↑</button>
      <button type="button" class="order-button move-down" ${index === routeLength - 1 ? 'disabled' : ''} aria-label="下移">↓</button>
      <button type="button" class="route-swap-button" data-id="${task.id}">调整航线</button>
      <button type="button" class="delete-task" aria-label="删除任务">×</button>
    </div>`;
  }

  function renderTask(task, index, routeLength) {
    const approved = currentPlan.status !== 'draft';
    const isSub = Boolean(task.is_sub);
    const zeroMinuteMain = approved && !isSub && Number(task.estimated_minutes) === 0;
    const lead = !approved
      ? ''
      : isSub
      ? '<span class="task-bullet">•</span>'
      : zeroMinuteMain
        ? '<span class="task-index" aria-hidden="true">—</span>'
        : approved && task.task_type === 'habit'
        ? `<span class="task-index">${habitStatusLabel(task.habit_status)}</span>`
        : approved
        ? `<input class="task-check" type="checkbox" ${task.completed ? 'checked' : ''} aria-label="完成任务">`
        : `<span class="task-index">${index + 1}</span>`;
    let timeBlock;
    if (!approved) {
      timeBlock = isSub
        ? '<span class="execution-locked">确认后记录实际时间</span>'
        : `<label class="minutes-label"><input class="minutes-input" data-goal-category="${esc(task.category)}" aria-label="${esc(task.title)}目标分钟" type="number" min="0" max="720" step="15" value="${task.estimated_minutes}"> 分钟</label>`;
    } else if (isSub) {
      timeBlock = `<label class="actual-minutes-label">实际 <input class="actual-minutes-input" type="number" min="0" value="${task.actual_minutes || 0}"> 分钟</label>`;
    } else if (zeroMinuteMain) {
      timeBlock = `<span>目标 0 分钟</span><span>实际 ${task.actual_minutes || 0} 分 · 可在执行台开始</span>`;
    } else {
      timeBlock = `<span>计划 ${task.estimated_minutes} 分钟</span><span class="actual-minutes-readonly">有效 ${task.actual_minutes || 0} 分</span>`;
    }
    const titleBlock = approved
      ? `<h3 class="task-archive-title">${esc(task.title)}</h3>`
      : `<input class="task-archive-title title-input" type="text" aria-label="${esc(task.title)}名称" value="${esc(task.title)}">`;
    const criteriaBlock = isSub
      ? ''
      : approved
        ? `<p class="task-archive-note">${esc(task.completion_criteria)}</p>`
        : `<input class="task-archive-note criteria-input" type="text" value="${esc(task.completion_criteria)}" placeholder="完成标准">`;
    const editor = `<dialog class="task-edit-dialog" aria-label="${esc(task.title)}设置">
      <div class="task-edit-heading"><h3>项目设置</h3><button type="button" class="task-edit-close">完成</button></div>
      ${subCategoryTabs(task)}
      ${approved ? `<span>${taskTypeLabel(task.task_type)}</span>` : `<label class="task-type-field">事项类型<select class="task-type-input">${taskTypeOptions(task.task_type)}</select></label>`}
      ${criteriaBlock}
      ${taskControls(task, index, routeLength)}
    </dialog>`;
    return `<article class="task-card task-archive-card ${!approved ? 'task-text-only' : ''} ${isSub ? 'sub-route-task' : 'main-route-task'} ${task.completed ? 'completed' : ''}" data-task-id="${task.id}" data-category="${esc(task.category)}">
      ${lead}
      <div class="task-content"><div class="task-name-group"><div class="task-title-row">${titleBlock}</div><small class="task-kind-caption">${taskTypeLabel(task.task_type)}</small></div>
        <div class="task-meta task-paper-tags">${timeBlock}</div>
      </div>
      <button type="button" class="task-edit-open" aria-label="${esc(task.title)}设置" title="项目设置"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg></button>
      <button type="button" class="route-target hidden" data-id="${task.id}">与此项交换</button>
      ${editor}
    </article>`;
  }

  function renderPlaceholder(isSub) {
    return `<article class="route-placeholder" data-route="${isSub ? 'sub' : 'main'}">
      <button type="button" class="placeholder-target" disabled>空位</button>
    </article>`;
  }

  function renderRoute(list, tasks, isSub) {
    const slots = tasks.map((task, index) => renderTask(task, index, tasks.length));
    while (slots.length < ROUTE_SLOT_COUNT) slots.push(renderPlaceholder(isSub));
    list.innerHTML = slots.join('');
  }

  function renderPlan(plan) {
    targetEditState = null;
    configureTargetForm(false);
    currentPlan = plan;
    swapSourceId = null;
    setTodayStage('review');
    $('#sub-route-details').open = true;
    selectPlanRoute('main');
    renderSubmitButton(plan);
    $('#plan-title').textContent = plan.status === 'draft' ? '安排今天' : '今天的清单';
    $('#plan-day-caption').textContent = `${formatDateLabel(plan.date || dateInput.value)} · ${plan.status === 'draft' ? '草稿' : '已安排'}`;
    $('#draft-actions').classList.remove('hidden');
    $('#save-draft').classList.toggle('hidden', plan.status !== 'draft');
    $('#approve-plan').classList.toggle('hidden', plan.status !== 'draft');
    $('#adjust-checkin').classList.toggle('hidden', plan.status !== 'draft');
    $('#degraded-notice').classList.toggle('hidden', !plan.degraded_reason);
    $('#method-list').innerHTML = plan.methods.map(method => `<li>${esc(method)}</li>`).join('');

    const mainTasks = plan.tasks.filter(task => !task.is_sub);
    const subTasks = plan.tasks.filter(task => task.is_sub);
    $('#sub-route-count').textContent = `${subTasks.length} 项`;
    $('#compact-sub-count').textContent = `${subTasks.length} 项`;
    renderRoute($('#main-route-list'), mainTasks, false);
    renderRoute($('#sub-route-list'), subTasks, true);
    bindTaskEvents();
    updateTimeSummary();
  }

  function selectPlanRoute(route) {
    const previous=$('#plan-section').dataset.route;
    $('#plan-section').dataset.route = route;
    $$('.plan-route-tab').forEach(button => {
      const selected = button.dataset.route === route;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    PlanUI.indicator($('.plan-route-tabs'),'[aria-pressed=true]','.plan-tab-indicator');
    if(previous&&previous!==route)PlanUI.enter($('#plan-section .columns-layout'),route==='sub'?1:-1);
  }
  const planTabs=$('.plan-route-tabs');
  if(planTabs){const line=document.createElement('span');line.className='plan-tab-indicator surface-tab-indicator';planTabs.append(line);new ResizeObserver(()=>PlanUI.indicator(planTabs,'[aria-pressed=true]','.plan-tab-indicator')).observe(planTabs);}
  $$('.plan-route-tab').forEach(button => button.onclick = () => selectPlanRoute(button.dataset.route));

  function markPlanDirtyAfterSubmission() {
    if (currentPlan?.status === 'submitted') {
      currentPlan.status = 'approved';
      renderSubmitButton(currentPlan);
    }
  }

  function cancelSwap() {
    swapSourceId = null;
    $$('.swap-source').forEach(card => card.classList.remove('swap-source'));
    $$('.route-target').forEach(button => button.classList.add('hidden'));
    $$('.placeholder-target').forEach(button => { button.disabled = true; button.textContent = '空位'; });
  }

  function beginSwap(sourceId) {
    if (String(swapSourceId) === String(sourceId)) {
      cancelSwap();
      return;
    }
    cancelSwap();
    swapSourceId = sourceId;
    const sourceCard = $(`.task-card[data-task-id="${sourceId}"]`);
    const sourceIsSub = Boolean(sourceCard.closest('#sub-route-list'));
    sourceCard.classList.add('swap-source');
    $('.task-edit-dialog', sourceCard)?.close();
    selectPlanRoute(sourceIsSub ? 'main' : 'sub');
    $$('.task-card[data-task-id]', sourceIsSub ? $('#main-route-list') : $('#sub-route-list')).forEach(card => {
      const target = taskById(card.dataset.taskId);
      $('.route-target', card)?.classList.remove('hidden');
    });
    $$('.placeholder-target', sourceIsSub ? $('#main-route-list') : $('#sub-route-list')).forEach(button => {
      button.disabled = false;
      button.textContent = '交换到这里';
    });
  }

  function completeSwap(targetId, targetIsSub) {
    syncDraftFromDom();
    const source = taskById(swapSourceId);
    const sourceIsSub = Boolean(source.is_sub);
    const sourceTasks = currentPlan.tasks.filter(task => Boolean(task.is_sub) === sourceIsSub);
    const targetTasks = currentPlan.tasks.filter(task => Boolean(task.is_sub) === targetIsSub);
    const sourceIndex = sourceTasks.findIndex(task => task.id === source.id);
    sourceTasks.splice(sourceIndex, 1);

    if (targetId === null) {
      source.is_sub = targetIsSub;
      if (!source.is_sub && source.estimated_minutes === 0) source.estimated_minutes = 30;
      targetTasks.push(source);
    } else {
      const targetIndex = targetTasks.findIndex(task => String(task.id) === String(targetId));
      const target = targetTasks[targetIndex];
      source.is_sub = targetIsSub;
      target.is_sub = sourceIsSub;
      if (!source.is_sub && source.estimated_minutes === 0) source.estimated_minutes = 30;
      if (!target.is_sub && target.estimated_minutes === 0) target.estimated_minutes = 30;
      targetTasks[targetIndex] = source;
      sourceTasks.splice(sourceIndex, 0, target);
    }
    currentPlan.tasks = sourceIsSub ? [...targetTasks, ...sourceTasks] : [...sourceTasks, ...targetTasks];
    renderPlan(currentPlan);
  }

  function moveWithinRoute(taskId, direction) {
    syncDraftFromDom();
    const task = taskById(taskId);
    const routeTasks = currentPlan.tasks.filter(item => Boolean(item.is_sub) === Boolean(task.is_sub));
    const otherTasks = currentPlan.tasks.filter(item => Boolean(item.is_sub) !== Boolean(task.is_sub));
    const index = routeTasks.findIndex(item => item.id === task.id);
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= routeTasks.length) return;
    [routeTasks[index], routeTasks[nextIndex]] = [routeTasks[nextIndex], routeTasks[index]];
    currentPlan.tasks = task.is_sub ? [...otherTasks, ...routeTasks] : [...routeTasks, ...otherTasks];
    renderPlan(currentPlan);
  }

  function bindTaskEvents() {
    bindGoalSuggestions($$('#plan-section .minutes-input'));
    $$('.task-type-input').forEach(input => input.onchange = () => { $('.task-kind-caption', input.closest('.task-card')).textContent = taskTypeLabel(input.value); });
    $$('.task-edit-open').forEach(button => button.onclick = () => $('.task-edit-dialog', button.closest('.task-card')).showModal());
    $$('.task-edit-close').forEach(button => button.onclick = () => button.closest('dialog').close());

    $$('.sub-category-tabs button').forEach(button => button.onclick = async () => {
      const container = button.closest('.sub-category-tabs');
      const card = button.closest('.task-card');
      $$('button', container).forEach(item => item.classList.remove('active'));
      button.classList.add('active');
      if (currentPlan.status !== 'draft') {
        try {
          await api(`/api/tasks/${card.dataset.taskId}`, {method:'PATCH', body:JSON.stringify({sub_category:button.dataset.val})});
          markPlanDirtyAfterSubmission();
        } catch (error) { toast(error.message); }
      }
    });

    $$('.route-swap-button').forEach(button => button.onclick = () => beginSwap(button.dataset.id));
    $$('.route-target').forEach(button => button.onclick = () => {
      const targetCard = button.closest('.task-card');
      completeSwap(targetCard.dataset.taskId, Boolean(targetCard.closest('#sub-route-list')));
    });
    $$('.placeholder-target').forEach(button => button.onclick = () => {
      completeSwap(null, button.closest('#sub-route-list') !== null);
    });
    $$('.move-up').forEach(button => button.onclick = () => moveWithinRoute(button.closest('.task-card').dataset.taskId, -1));
    $$('.move-down').forEach(button => button.onclick = () => moveWithinRoute(button.closest('.task-card').dataset.taskId, 1));
    $$('.delete-task').forEach(button => button.onclick = () => {
      syncDraftFromDom();
      const id = button.closest('.task-card').dataset.taskId;
      currentPlan.tasks = currentPlan.tasks.filter(task => String(task.id) !== String(id));
      renderPlan(currentPlan);
    });
    $$('.minutes-input').forEach(input => input.oninput = () => updateTimeSummary());

    $$('.task-check').forEach(checkbox => checkbox.onchange = async () => {
      const card = checkbox.closest('.task-card');
      try {
        const updated = await api(`/api/tasks/${card.dataset.taskId}`, {method:'PATCH', body:JSON.stringify({completed:checkbox.checked})});
        card.classList.toggle('completed', updated.completed);
        const actualInput = $('.actual-minutes-input', card);
        if (actualInput) actualInput.value = updated.actual_minutes || 0;
        Object.assign(taskById(card.dataset.taskId), updated);
        invalidateCalendarMonth(dateInput.value);
        markPlanDirtyAfterSubmission();
      } catch (error) {
        checkbox.checked = !checkbox.checked;
        toast(error.message);
      }
    });

    $$('.actual-minutes-input').forEach(input => input.onchange = async () => {
      const card = input.closest('.task-card');
      try {
        const updated = await api(`/api/tasks/${card.dataset.taskId}`, {method:'PATCH', body:JSON.stringify({actual_minutes:Number(input.value)})});
        card.classList.toggle('completed', updated.completed);
        const checkbox = $('.task-check', card);
        if (checkbox) checkbox.checked = updated.completed;
        Object.assign(taskById(card.dataset.taskId), updated);
        invalidateCalendarMonth(dateInput.value);
        markPlanDirtyAfterSubmission();
      } catch (error) { toast(error.message); }
    });
  }

  const commonTargetMinutes={math:[90,180,240,300],english:[15,30,45,60],computer:[60,90,120,180],rehab:[15,30,45,60]};
  let targetHistory={},targetHistorySequence=0,goalSuggestionInput=null,goalSuggestionPanel=null;
  const boundGoalInputs=new WeakSet();
  function closeGoalSuggestions() {
    if(goalSuggestionInput)goalSuggestionInput.setAttribute('aria-expanded','false');
    goalSuggestionPanel?.remove();goalSuggestionPanel=null;goalSuggestionInput=null;
  }
  function positionGoalSuggestions() {
    if(!goalSuggestionInput?.isConnected || !goalSuggestionPanel){closeGoalSuggestions();return;}
    const box=goalSuggestionInput.getBoundingClientRect(),viewport=window.visualViewport;
    const top=viewport?.offsetTop || 0,left=viewport?.offsetLeft || 0;
    const width=viewport?.width || innerWidth,height=viewport?.height || innerHeight;
    goalSuggestionPanel.style.width=`${Math.min(296,width-24)}px`;
    goalSuggestionPanel.style.maxHeight=`${Math.max(80,Math.min(260,height-24))}px`;
    const panelHeight=goalSuggestionPanel.getBoundingClientRect().height;
    goalSuggestionPanel.style.left=`${Math.max(left+12,Math.min(box.left,left+width-goalSuggestionPanel.offsetWidth-12))}px`;
    const submit=$('#checkin-form [type=submit]')?.getBoundingClientRect();
    const coversSubmit=submit && box.bottom+6<submit.bottom && box.bottom+panelHeight+6>submit.top;
    goalSuggestionPanel.style.top=`${box.bottom+panelHeight+8<=top+height-12 && !coversSubmit ? box.bottom+6 : Math.max(top+12,box.top-panelHeight-6)}px`;
  }
  function showGoalSuggestions(input) {
    if(input.disabled)return;
    closeGoalSuggestions();goalSuggestionInput=input;
    const category=input.dataset.targetCategory || input.dataset.goalCategory;
    const common=commonTargetMinutes[category] || [30,60,90,120];
    const recent=(targetHistory[category] || []).filter(value=>!common.includes(value));
    const group=(title,values)=>values.length ? `<p>${title}</p><div class="target-suggestion-options">${values.map(value=>`<button type="button" data-goal-minutes="${value}">${value}</button>`).join('')}</div>` : '';
    const panel=document.createElement('div');panel.id='target-suggestions';panel.className='target-suggestions';panel.setAttribute('role','dialog');
    panel.setAttribute('aria-label',`${settings.task_titles[category] || '项目'}目标分钟候选`);
    panel.innerHTML=group('常用分钟',common)+group('最近用过',recent);
    goalSuggestionPanel=panel;input.setAttribute('aria-controls',panel.id);input.setAttribute('aria-expanded','true');
    $$('button',panel).forEach(button=>button.onclick=()=>{
      input.value=button.dataset.goalMinutes;input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));
      input.focus({preventScroll:true});closeGoalSuggestions();
    });
    panel.onkeydown=event=>{if(event.key==='Escape'){event.preventDefault();input.focus({preventScroll:true});closeGoalSuggestions();}};
    document.body.appendChild(panel);positionGoalSuggestions();
  }
  function bindGoalSuggestions(inputs) {
    inputs.forEach(input=>{
      if(boundGoalInputs.has(input))return;boundGoalInputs.add(input);
      input.step='15';input.setAttribute('aria-haspopup','dialog');input.setAttribute('aria-expanded','false');
      input.addEventListener('focus',()=>showGoalSuggestions(input));
      input.addEventListener('click',()=>{if(goalSuggestionInput!==input)showGoalSuggestions(input);});
      input.addEventListener('input',()=>input.setCustomValidity(''));
      input.addEventListener('keydown',event=>{
        if(event.key==='Escape'){closeGoalSuggestions();return;}
        if(event.altKey&&event.key==='ArrowDown'){event.preventDefault();goalSuggestionPanel?.querySelector('button')?.focus();return;}
        if(['ArrowUp','ArrowDown'].includes(event.key)){
          event.preventDefault();input.value=Math.max(0,Math.min(720,Number(input.value || 0)+(event.key==='ArrowUp'?15:-15)));
          input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));
        }
      });
    });
  }
  async function loadTargetHistory() {
    const target=dateInput.value,sequence=++targetHistorySequence;targetHistory={};closeGoalSuggestions();
    try {
      const result=await api(`/api/target-suggestions?before_date=${encodeURIComponent(target)}`);
      if(sequence===targetHistorySequence && target===dateInput.value)targetHistory=result.categories;
    } catch { /* 候选历史读取失败仍保留常用值与手动输入。 */ }
  }
  document.addEventListener('pointerdown',event=>{
    if(goalSuggestionPanel&&!goalSuggestionPanel.contains(event.target)&&event.target!==goalSuggestionInput)closeGoalSuggestions();
  });
  document.addEventListener('focusin',event=>{
    if(goalSuggestionPanel&&!goalSuggestionPanel.contains(event.target)&&event.target!==goalSuggestionInput)closeGoalSuggestions();
  });
  window.addEventListener('resize',positionGoalSuggestions);
  window.addEventListener('scroll',positionGoalSuggestions,{capture:true,passive:true});
  window.visualViewport?.addEventListener('resize',positionGoalSuggestions);
  function validateMorningTargets() {
    for(const input of $$('[data-target-category]')){
      input.setCustomValidity('');
      if(input.value==='' || !Number.isInteger(Number(input.value)) || Number(input.value)<0 || Number(input.value)>720){
        input.setCustomValidity('请输入0～720的整数分钟。');input.reportValidity();return false;
      }
    }
    return true;
  }

  function configureTargetForm(editing) {
    $('#checkin-title').textContent = editing ? '各项目目标时长' : dateInput.value === todayIso() ? '填写今天的目标' : '填写此日目标';
    $('#target-edit-note').hidden = !editing;
    $('#cancel-target-edit').hidden = !editing;
    $('#checkin-submit > span').textContent = editing ? '保存并返回清单' : '生成今天的草稿';
    $('#checkin-submit .checkin-next').hidden = editing;
    $('#morning-energy-field').hidden = editing || !settings?.show_energy_selector;
    $('#morning-day-type-field').hidden = editing || !settings?.show_day_type_selector;
    $('#target-edit-error').hidden = true;
    $('#target-edit-error').textContent = '';
    $('#checkin-form').classList.toggle('editing-targets', editing);
  }

  function renderMorningTargets(tasks = null) {
    const fields = tasks || (settings.main_project_categories || ['math', 'english', 'computer', 'rehab'])
      .filter(category => category !== 'rehab' || settings.rehab_enabled)
      .map(category => ({category, title:settings.task_titles[category] || category,
        estimated_minutes:settings.draft_main_minutes_by_category?.[category] || 0}));
    $('#morning-targets').innerHTML = fields.map(task => `<label><span class="target-field-label">${esc(task.title)}<small>分钟</small></span><input type="number" min="0" max="720" step="15" required aria-label="${esc(task.title)}目标分钟" data-target-category="${esc(task.category)}" ${task.id ? `data-target-task-id="${Number(task.id)}"` : ''} value="${Number(task.estimated_minutes)}"></label>`).join('');
    const update = () => { $('#morning-total').textContent = `计划合计 ${$$('[data-target-category]').reduce((sum, input) => sum + Number(input.value || 0), 0)} 分`; };
    $$('[data-target-category]').forEach(input => input.oninput = update);
    bindGoalSuggestions($$('[data-target-category]'));
    update();
  }

  function beginTargetEdit() {
    if (targetEditBusy || currentPlan?.status !== 'draft') return;
    closeGoalSuggestions();
    syncDraftFromDom();
    targetEditState = {date:dateInput.value, tasks:taskPayload()};
    configureTargetForm(true);
    renderMorningTargets(currentPlan.tasks.filter(task => !task.is_sub));
    setTodayStage('checkin');
    window.scrollTo({top:0, behavior:'smooth'});
    $('#checkin-title').tabIndex = -1;
    $('#checkin-title').focus({preventScroll:true});
    window.PlanUI?.enter($('#today-checkin-stage'), -1);
  }

  function setTargetEditBusy(busy) {
    targetEditBusy = busy;
    $('#checkin-form').setAttribute('aria-busy', String(busy));
    $$('#checkin-form input, #checkin-form select, #checkin-form button').forEach(node => node.disabled = busy);
    [dateButton, $('#reset-day'), $('#restore-reset'), carryoverButton].forEach(node => { if (node) node.disabled = busy; });
  }

  async function saveTargetEdit() {
    if (targetEditBusy || !targetEditState) return;
    const edit = targetEditState;
    const minutes = new Map($$('[data-target-task-id]').map(input => [Number(input.dataset.targetTaskId), Number(input.value)]));
    const tasks = edit.tasks.map(task => minutes.has(task.id) ? {...task, estimated_minutes:minutes.get(task.id)} : task);
    closeGoalSuggestions();
    $('#target-edit-error').hidden = true;
    setTargetEditBusy(true);
    $('#checkin-submit > span').textContent = '正在保存…';
    try {
      const plan = await api(`/api/daily-plans/${edit.date}`, {method:'PUT', body:JSON.stringify({tasks})});
      invalidateCalendarMonth(edit.date);
      renderPlan(plan);
      $('#adjust-checkin').focus({preventScroll:true});
      window.PlanUI?.enter($('#today-review-stage'));
      toast('目标时长已保存');
    } catch (error) {
      $('#target-edit-error').textContent = error.message;
      $('#target-edit-error').hidden = false;
    } finally {
      setTargetEditBusy(false);
      if (targetEditState) $('#checkin-submit > span').textContent = '保存并返回清单';
    }
  }

  $('#cancel-target-edit').onclick = () => {
    if (targetEditBusy) return;
    closeGoalSuggestions();
    renderPlan(currentPlan);
    $('#adjust-checkin').focus({preventScroll:true});
    window.PlanUI?.enter($('#today-review-stage'));
  };

  async function loadCarryovers() {
    carryoverItems = await api('/api/carryovers');
    renderCarryoverPopover();
  }

  async function loadPlanForDate() {
    PlanUI.setDate(dateInput.value);
    history.replaceState(null, '', '/?date='+encodeURIComponent(dateInput.value));
    loadTargetHistory();
    cancelSwap();
    targetEditState = null;
    configureTargetForm(false);
    renderMorningTargets();
    currentPlan = null;
    setTodayStage('checkin');
    $('#time-summary').classList.add('hidden');
    updateTimeSummary();
    try {
      renderPlan(await api(`/api/daily-plans/${dateInput.value}`));
    } catch (error) {
      if (error.message !== '计划不存在') toast(error.message);
    }
    await refreshResetRecovery(dateInput.value,async()=>{ await loadPlanForDate(); await loadCarryovers(); });
  }

  $('#reset-day').onclick = async () => {
    try {
      const result = await resetDailyDataFor(dateInput.value);
      if (!result) return;
      invalidateCalendarMonth(dateInput.value);
      cancelSwap();
      targetEditState = null;
      configureTargetForm(false);
      renderMorningTargets();
      currentPlan = null;
      setTodayStage('checkin');
      $('#time-summary').classList.add('hidden');
      await loadCarryovers();
      await refreshResetRecovery(dateInput.value,async()=>{ await loadPlanForDate(); await loadCarryovers(); });
      toast(result.message);
    } catch (error) { toast(error.message); }
  };

  carryoverButton.onclick = event => {
    event.stopPropagation();
    toggleCarryoverPopover();
  };

  $('#checkin-form').onsubmit = async event => {
    event.preventDefault();
    if (targetEditBusy || !validateMorningTargets()) return;
    if (targetEditState) { await saveTargetEdit(); return; }
    closeGoalSuggestions();
    const submit = event.submitter;
    if (currentPlan?.status === 'draft') {
      const confirmed = await confirmAction('重新生成会覆盖当前未确认草稿。', {title:'重新生成今天的草稿？', confirmLabel:'重新生成'});
      if (!confirmed) return;
    }
    submit.disabled = true;
    submit.firstElementChild.textContent = '正在生成…';
    try {
      const plan = await api('/api/daily-plans/draft', {method:'POST', body:JSON.stringify({
        date:dateInput.value,
        energy:settings.show_energy_selector ? $('input[name=energy]:checked').value : 'normal',
        target_minutes:Object.fromEntries($$('[data-target-category]').map(input => [input.dataset.targetCategory, Number(input.value)])),
        day_type:settings.show_day_type_selector ? $('#day-type').value : 'normal',
      })});
      invalidateCalendarMonth(dateInput.value);
      renderPlan(plan);
      await loadCarryovers();
    } catch (error) { toast(error.message); }
    finally {
      submit.disabled = false;
      submit.firstElementChild.textContent = '生成今天的草稿';
    }
  };

  $('#save-draft').onclick = async () => {
    try {
      renderPlan(await api(`/api/daily-plans/${dateInput.value}`, {method:'PUT', body:JSON.stringify({tasks:taskPayload()})}));
      invalidateCalendarMonth(dateInput.value);
      toast('草稿已保存');
    } catch (error) { toast(error.message); }
  };
  $('#approve-plan').onclick = async () => {
    const button = $('#approve-plan');
    if (button.disabled) return;
    const targetDate = dateInput.value;
    button.disabled = true;
    $('#save-draft').disabled = true;
    try {
      await api(`/api/daily-plans/${targetDate}`, {method:'PUT', body:JSON.stringify({tasks:taskPayload()})});
      await api(`/api/daily-plans/${targetDate}/approve`, {method:'POST'});
      invalidateCalendarMonth(targetDate);
      window.location.href = `/execute?date=${encodeURIComponent(targetDate)}`;
    } catch (error) { toast(error.message); }
    finally {
      button.disabled = false;
      $('#save-draft').disabled = false;
    }
  };
  $('#adjust-checkin').onclick = beginTargetEdit;
  const openExecutionDesk = () => {
    window.location.href = `/execute?date=${encodeURIComponent(dateInput.value)}`;
  };
  $('#open-execution-desk').onclick = openExecutionDesk;
  document.addEventListener('keydown', event => { if (event.key === 'Escape') cancelSwap(); });

  loadCarryovers();
  api('/api/settings').then(result => {
    settings = result;
    renderMorningTargets();
    $('#morning-energy-field').hidden=!settings.show_energy_selector;
    $('#morning-day-type-field').hidden=!settings.show_day_type_selector;
    bindSharedCalendarTrigger(dateButton, () => dateInput.value, async nextDate => {
      if (targetEditBusy || nextDate === dateInput.value) return;
      if (targetEditState && $$('[data-target-task-id]').some(input => Number(input.value) !== targetEditState.tasks.find(task => task.id === Number(input.dataset.targetTaskId))?.estimated_minutes)) {
        if (!await confirmAction('尚未保存的目标时长会丢弃，原清单保持不变。', {title:'放弃修改并切换日期？', confirmLabel:'放弃并切换'})) return;
      }
      dateInput.value = nextDate;
      updateDateTrigger(dateButton, nextDate);
      await loadPlanForDate();
    }, '选择今天页日期');
    return loadPlanForDate();
  }).catch(error => toast(error.message));
}

if (page === 'execute' || $('#review-records-workspace') || $('#history-records-workspace')) {
  const historyView = page === 'execution-history';
  const recordsOnly = page !== 'execute';
  let executionTab = 'courses';
  let controlsFocus = null;
  let controlsClosing=false, controlsCloseTimer=null;
  const dateInput = $('#execute-date');
  const selectedFromQuery = new URLSearchParams(window.location.search).get('date');
  let executionState = null;
  let notificationState = null;
  let selectedTaskId = null;
  let controlsExpanded = false;
  let controlsHadActive = false;
  let controlsDate = null;
  let switchingEffectiveLabel = false;
  let executionRevision = 0;
  let executionWrites = 0;
  let executionLoadSequence = 0;
  let liveSyncPending = false;
  let clockSource = null;
  let clockSeconds = 0;
  let clockReceivedAt = 0;
  let clockActive = false;
  let syncFailed = false;
  let timingPending = false;
  let timingAction = '';
  let autoStopBusy = false;
  let quickCorrectionBusy = false;
  let quickCorrectionSource = null;
  let quickCorrectionCategory = null;
  let quickCorrectionRequestId = null;
  const receivedTimes = new WeakMap();
  let segmentDialogDate = null;
  let segmentEditBusy = false;
  const segmentDialog = $('#segment-edit-dialog');
  const chronology = new ExecutionTimeline($('#execute-chronology'), openSegmentEditor, openNewSegmentEditor);
  $('#segment-edit-close').onclick=()=>{if(!segmentEditBusy)segmentDialog.close();};
  segmentDialog.addEventListener('close',()=>{if(segmentDialogDate===dateInput.value)(recordsPageOpen?$('#execution-records-content .chronology-record.is-selected')||$('#execution-records-content .chronology-dismiss'):$('#execute-chronology .chronology-surface'))?.focus({preventScroll:true});});
  segmentDialog.addEventListener('cancel',event=>{if(segmentEditBusy)event.preventDefault();});
  segmentDialog.addEventListener('click',event=>{if(!segmentEditBusy&&event.target===segmentDialog&&event.clientX!==0){const box=segmentDialog.getBoundingClientRect();if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)segmentDialog.close();}});
  function openSegmentEditor(id) {
    const segment=executionState?.segments.find(item=>item.id===id);
    if(!segment||timingPending||segmentEditBusy)return;
    segmentDialogDate=dateInput.value;
    $('#segment-edit-title').textContent=segment.ended_at?'编辑时间段':'编辑运行中记录';
    $('#segment-edit-context').textContent=`${segment.task_title} · ${timeCategoryNames[segmentTimeCategory(segment)]}${segment.is_estimated?' · 补记·估计':''}`;
    $('#segment-edit-error').hidden=true;
    $('#segment-edit-content').innerHTML=segmentEditorHtml(segment,false,{open:true});
    wireSegmentEditors($('#segment-edit-content'));
    segmentDialog.showModal();
  }

  const header = $('.site-header');
  const currentPanel = $('#execute-current-panel');
  const controlsRoot = $('#execution-controls');
  const controlsFab = $('#execution-controls-fab');
  const backdrop = $('#execution-controls-backdrop');
  const mini = $('#execution-mini');
  const phoneSheet = matchMedia('(max-width:999px)');
  function controlsBusy() { return timingPending||segmentEditBusy||quickCorrectionBusy||wordCountsBusy||autoStopBusy; }
  function beginControlsClose() {
    if(historyView || controlsClosing)return;
    controlsClosing=true;
    const closeDuration=phoneSheet.matches?sheetDrag.dismiss():matchMedia('(prefers-reduced-motion: reduce)').matches?0:180;
    controlsRoot.classList.add('is-closing');backdrop.classList.add('is-closing');
    controlsCloseTimer=setTimeout(()=>{
      controlsClosing=false;controlsCloseTimer=null;controlsRoot.classList.remove('is-closing');backdrop.classList.remove('is-closing');sheetDrag.reset();updateExecutionControls();
      const fallback=executionState?.active_segment?$('#execution-mini-open'):recordsOnly?$('#review-records-open'):controlsFab;
      const restore=controlsFocus?.isConnected&&controlsFocus.matches('button,a[href],input,select,textarea,[tabindex]')&&controlsFocus.getClientRects().length?controlsFocus:fallback;
      restore?.focus({preventScroll:true});
    },closeDuration);
  }
  function updateExecutionControls() {
    if (historyView) {
      controlsExpanded=true;
      controlsRoot.hidden=!executionState || (!executionState.plan && !executionState.has_execution);
      controlsRoot.removeAttribute('aria-modal');
      controlsFab.hidden=true; mini.hidden=true; backdrop.hidden=true;
      $('#execution-controls-title').textContent='时间轴与记录';
      $('#execution-overlay').classList.toggle('has-running',Boolean(executionState?.active_segment));
      return;
    }
    const active=Boolean(executionState?.active_segment);
    if(controlsDate!==dateInput.value){controlsDate=dateInput.value;controlsExpanded=false;controlsHadActive=false;resetRecordsPage();}
    if(active&&!controlsHadActive||timingPending||!$('#execute-operation-feedback').hidden)controlsExpanded=true;
    else if(controlsHadActive&&!active&&!segmentDialog.open&&!$('#quick-correction-dialog').open&&!$('#word-count-dialog').open&&!$('#auto-stop-dialog').open&&!recordsPageOpen){controlsExpanded=false;beginControlsClose();}
    controlsHadActive=active;
    const shown=controlsExpanded||controlsClosing;
    if(controlsRoot.hidden&&shown)controlsRoot.style.removeProperty('animation');
    controlsRoot.hidden=!shown;
    controlsFab.hidden=recordsOnly||shown||active;
    mini.hidden=recordsOnly||shown||!active;
    controlsFab.setAttribute('aria-expanded',String(controlsExpanded));
    controlsFab.disabled=controlsBusy();
    $('#execution-controls-close').disabled=controlsBusy();
    $('#execution-sheet-handle').disabled=controlsBusy();
    $('#execution-mini-stop').disabled=timingPending;
    backdrop.hidden=!shown||!phoneSheet.matches;
    const modal=shown&&phoneSheet.matches;
    controlsRoot.setAttribute('aria-modal',String(modal));
    document.querySelector('main').inert=modal;
    header.inert=modal;
    document.body.classList.toggle('execution-sheet-open',modal);
    document.body.classList.toggle('execution-panel-open',shown);
    document.body.classList.toggle('execution-is-running',active);
    $('#execution-overlay').classList.toggle('has-running',active);
    $('#execution-controls-title').textContent=recordsOnly?`${dateInput.value} · 时间记录`:'计时与记录';
    $('#execution-mini-title').textContent=active?`${active.task_title}${active.label_name?'／'+active.label_name:''}`:'';
    if(!shown) {document.querySelector('main').inert=false;header.inert=false;}
  }
  function openExecutionControls() {
    if(controlsCloseTimer){clearTimeout(controlsCloseTimer);controlsCloseTimer=null;controlsClosing=false;controlsRoot.classList.remove('is-closing');backdrop.classList.remove('is-closing');}
    if(!controlsExpanded){sheetDrag.reset();resetRecordsPage();controlsFocus=document.activeElement;}
    controlsDate=dateInput.value;controlsExpanded=true;updateExecutionControls();
    requestAnimationFrame(()=>{if(!historyView&&phoneSheet.matches&&!document.querySelector('dialog[open]'))$('#execution-controls-close').focus({preventScroll:true});chronology.render();});
  }
  function closeExecutionControls() {
    if(historyView)return false;
    if(!controlsExpanded && !controlsClosing)return true;
    if(controlsBusy()||document.querySelector('dialog[open]'))return false;
    controlsExpanded=false;$('#execute-operation-feedback').hidden=true;beginControlsClose();updateExecutionControls();return true;
  }
  controlsFab.onclick=openExecutionControls;
  $('#execution-mini-open').onclick=openExecutionControls;
  $('#execution-controls-close').onclick=closeExecutionControls;
  $('#execution-sheet-handle').onclick=closeExecutionControls;
  backdrop.onclick=closeExecutionControls;
  const sheetBody=$('.execution-sheet-body',controlsRoot),workPage=$('#execution-workpage'),recordsPage=$('#execution-records-page');
  let recordsPageOpen=false,pageAnimation=null,workScroll=0;
  function resetRecordsPage() {
    pageAnimation?.cancel();pageAnimation=null;recordsPageOpen=false;
    workPage.hidden=false;recordsPage.hidden=true;sheetBody.style.removeProperty('height');sheetBody.classList.remove('showing-records');
    chronology.nearby=null;
  }
  if(!historyView){
    chronology.recordsNode=$('#execution-records-content');
    chronology.recordsReturnLabel=recordsOnly?'← 返回时间轴':'← 返回计时';
    chronology.onRecordsPage=show=>{
      pageAnimation?.cancel();
      if(show&&!recordsPageOpen){sheetBody.style.height=`${sheetBody.getBoundingClientRect().height}px`;workScroll=sheetBody.scrollTop;}
      recordsPageOpen=show;workPage.hidden=show;recordsPage.hidden=!show;
      sheetBody.classList.toggle('showing-records',show);sheetBody.scrollTop=show?0:workScroll;
      const target=show?recordsPage:workPage;
      if(!matchMedia('(prefers-reduced-motion:reduce)').matches)pageAnimation=target.animate([{opacity:0,transform:`translateX(${show?20:-20}px)`},{opacity:1,transform:'translateX(0)'}],{duration:240,easing:'cubic-bezier(.22,.8,.25,1)'});
      requestAnimationFrame(()=>{if(show)$('#execution-records-content .chronology-dismiss')?.focus({preventScroll:true});else{chronology.render();$('#execute-chronology .chronology-browse')?.focus({preventScroll:true});}});
    };
  }
  const sheetDrag=new ExecutionSheetDrag(controlsRoot,backdrop,()=>!historyView&&phoneSheet.matches&&controlsExpanded&&!controlsClosing&&!controlsBusy()&&!document.querySelector('dialog[open]'),closeExecutionControls);
  phoneSheet.addEventListener('change',()=>{sheetDrag.reset();updateExecutionControls();});
  window.addEventListener('resize',()=>{if(!recordsPageOpen)sheetBody.style.removeProperty('height');});
  document.addEventListener('keydown',event=>{
    if(historyView||!controlsExpanded||document.querySelector('dialog[open]'))return;
    if(event.key==='Escape'){if(executionUiState.expandedLabelBucket||executionUiState.effectivePickerTaskId!==null)return;event.preventDefault();event.stopImmediatePropagation();closeExecutionControls();return;}
    if(event.key==='Tab'&&phoneSheet.matches){const focusable=[...controlsRoot.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')].filter(node=>node.getClientRects().length);const first=focusable[0],last=focusable.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}
  });

  function updateExecutionOffsets() {
    const headerHeight = header.getBoundingClientRect().height;
    document.documentElement.style.setProperty('--execution-header-height',`${headerHeight}px`);
    document.body.style.setProperty('--execution-scroll-offset',`${headerHeight + 12}px`);
  }
  const executionResize = new ResizeObserver(updateExecutionOffsets);
  executionResize.observe(header); executionResize.observe(currentPanel);

  function updateTimingControls() {
    const active = executionState?.active_segment;
    currentPanel.setAttribute('aria-busy',String(timingPending));
    $('#execute-stop').disabled = timingPending || !active;
    $('#execute-stop').textContent = timingPending && timingAction === '停止' ? '正在停止…' : '停止';
    $('#quick-correction-open').disabled = timingPending || !active || active.segment_kind !== 'effective' || active.included === false;
    $$('.task-start-button, .effective-start-option, .execution-label-button, #mobile-counted-toggle, #mobile-interrupt-toggle').forEach(button=>{button.disabled=timingPending;});
    $('#mobile-return-effective').disabled = timingPending || !(active && active.segment_kind !== 'effective' && active.task_id);
    updateExecutionControls();
  }

  function showExecutionError(message) {
    $('#execute-operation-message').textContent = message;
    $('#execute-operation-feedback').hidden = false;
    if(recordsPageOpen)chronology.showRecords(false);
    openExecutionControls();
    requestAnimationFrame(()=>$('#execute-operation-feedback').scrollIntoView({block:'nearest'}));
  }

  async function executionApi(path, options={}) {
    const requestDate=dateInput.value;
    const writing = options.method && options.method !== 'GET';
    const timing = writing && (/\/(tasks\/start|labels\/start|stop|quick-corrections|auto-stop)$/.test(path) || (options.method==='PUT' && path.endsWith(`/segments/${executionState?.active_segment?.id}`)));
    if (timing && timingPending) throw new Error('正在处理当前计时操作，请稍候。');
    if (timing) {
      timingPending = true;
      timingAction = path.endsWith('/auto-stop') ? '设置自动停止' : options.method==='PUT' ? '保存修改' : path.endsWith('/quick-corrections') ? '补记' : path.endsWith('/stop') ? '停止' : executionState?.active_segment ? '切换' : '开始';
      $('#execute-operation-feedback').hidden = true;
      updateTimingControls();
    }
    if (writing) {
      executionWrites++; executionRevision++;
      $('#execute-record-status').textContent = timing ? `正在${timingAction}，等待服务器确认…` : '正在保存…';
    }
    try {
      const result = await api(path, options);
      if (result && typeof result === 'object') receivedTimes.set(result, performance.now());
      if(writing&&recordsOnly)setTimeout(()=>document.dispatchEvent(new CustomEvent('execution-records-changed',{detail:{date:requestDate}})),0);
      return result;
    } catch (error) {
      if (writing) $('#execute-record-status').textContent = '这次操作未确认保存，请重试；原有记录保留。';
      if (timing) showExecutionError(`${error.message}；这次操作未确认，当前仍显示上次确认的计时。可先核对记录再重试。`);
      throw error;
    } finally {
      if (writing) { executionWrites--; executionRevision++; }
      if (timing) { timingPending = false; updateTimingControls(); }
    }
  }

  const autoDialog=$('#auto-stop-dialog'),autoTime=$('#auto-stop-time'),autoError=$('#auto-stop-error');
  let autoStopSegment=null,autoStopDate=null;
  const localDateTime=value=>{const d=new Date(value);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;};
  function previewAutoStop() {
    const due=new Date(autoTime.value),seconds=(due-Date.now())/1000;
    $('#auto-stop-preview').textContent=Number.isFinite(seconds)&&seconds>0?`将在 ${due.toLocaleString('zh-CN',{month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'})} 停止并保存。`:'请选择未来24小时内的停止时刻。';
    $$('[data-auto-minutes]',autoDialog).forEach(b=>b.setAttribute('aria-pressed',String(Number(b.dataset.autoMinutes)===$('#auto-stop-minutes').valueAsNumber)));
  }
  function useAutoStopMinutes(minutes) {
    if(!Number.isInteger(minutes)||minutes<1||minutes>1440){autoError.textContent='请填写1～1440的整数分钟。';autoError.hidden=false;return;}
    $('#auto-stop-minutes').value=minutes;autoTime.value=localDateTime(Date.now()+minutes*60000);autoError.hidden=true;previewAutoStop();
  }
  $('#auto-stop-open').onclick=()=>{
    const active=executionState?.active_segment;if(!active||controlsBusy())return;
    autoStopSegment=active.id;autoStopDate=dateInput.value;autoError.hidden=true;
    $('#auto-stop-minutes').value='';autoTime.value=active.auto_stop_at?localDateTime(active.auto_stop_at):'';
    $('#auto-stop-cancel').disabled=!active.auto_stop_at;previewAutoStop();autoDialog.showModal();
  };
  $$('[data-auto-minutes]',autoDialog).forEach(b=>b.onclick=()=>useAutoStopMinutes(Number(b.dataset.autoMinutes)));
  $('#auto-stop-minutes').oninput=()=>{const minutes=$('#auto-stop-minutes').valueAsNumber;if(Number.isInteger(minutes)&&minutes>=1&&minutes<=1440)useAutoStopMinutes(minutes);};
  autoTime.oninput=()=>{$('#auto-stop-minutes').value='';autoError.hidden=true;previewAutoStop();};
  async function saveAutoStop(cancel=false) {
    if(autoStopBusy)return;
    if(!cancel&&!autoTime.value){autoError.textContent='请先选择停止时间。';autoError.hidden=false;return;}
    const due=cancel?null:new Date(autoTime.value),delta=due?due-Date.now():0;
    if(due&&(!Number.isFinite(delta)||delta<=0||delta>86400000)){autoError.textContent='请选择未来24小时内的停止时间。';autoError.hidden=false;return;}
    autoStopBusy=true;autoError.hidden=true;
    const controls=[...autoDialog.querySelectorAll('button,input')];controls.forEach(c=>c.disabled=true);
    try {
      const result=await executionApi(`/api/daily-execution/${autoStopDate}/auto-stop`,{method:'PUT',body:JSON.stringify({segment_id:autoStopSegment,due_at:due?.toISOString()||null})});
      autoDialog.close();renderExecutionState(result);toast(cancel?'已取消自动停止，继续计时':'自动停止时间已保存');
    }catch(error){autoError.textContent=error.message;autoError.hidden=false;}
    finally {autoStopBusy=false;controls.forEach(c=>c.disabled=false);$('#auto-stop-cancel').disabled=!executionState?.active_segment?.auto_stop_at;updateTimingControls();}
  }
  $('#auto-stop-form').onsubmit=e=>{e.preventDefault();saveAutoStop();};
  $('#auto-stop-cancel').onclick=()=>saveAutoStop(true);
  $('#auto-stop-close').onclick=()=>{if(!autoStopBusy)autoDialog.close();};
  autoDialog.addEventListener('cancel',e=>{if(autoStopBusy)e.preventDefault();});
  autoDialog.addEventListener('close',()=>{if($('#auto-stop-open').getClientRects().length)$('#auto-stop-open').focus({preventScroll:true});});

  function updateClockDigits() {
    if (document.hidden) return;
    const active=executionState?.active_segment,limit=active?.auto_stop_at?Math.max(0,(new Date(active.auto_stop_at)-new Date(active.started_at))/1000):Infinity;
    const seconds = clockActive ? Math.min(limit,Math.max(0, Math.floor(clockSeconds + (performance.now() - clockReceivedAt) / 1000))) : 0;
    if(clockActive&&active?.auto_stop_at&&seconds>=limit){syncLiveExecution();}
    $('#execute-clock').textContent = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
      .map(value => String(value).padStart(2, '0')).join(':');
    $('#execution-mini-clock').textContent=$('#execute-clock').textContent;
    updateGoalProgress();
    chronology.tick();
  }

  function updateGoalProgress() {
    const result = clockSource;
    const active = result?.active_segment;
    const task = result?.tasks?.find(item => String(item.id) === String(active?.task_id ?? selectedTaskId)) || result?.tasks?.[0];
    const root = $('#execute-goal-progress');
    root.hidden = !task;
    if (!task) return;
    const board = result.task_execution_board?.find(item => item.task_id === task.id);
    const advancing = Boolean(active && active.task_id === task.id && active.segment_kind === 'effective' && active.included !== false);
    // 聚合已含当前段截至响应时的秒数，这里只补响应后的经过时间。
    const deadlineRemaining=active?.auto_stop_at?Math.max(0,(new Date(active.auto_stop_at)-new Date(active.started_at))/1000-clockSeconds):Infinity;
    const elapsed = advancing ? Math.min(deadlineRemaining,Math.max(0, (performance.now() - clockReceivedAt) / 1000)) : 0;
    const seconds = Math.max(0, Number(board?.effective_seconds || 0) + elapsed);
    const target = Math.max(0, Number(task.estimated_minutes || 0) * 60);
    const ratio = target ? Math.min(1, seconds / target) : 0;
    const minutes = seconds > 0 && seconds < 60 ? '小于1' : String(Math.floor(seconds / 60));
    $('#execute-goal-label').textContent = `今日${task.title} · 有效 ${minutes}${target ? ` / ${task.estimated_minutes}` : ''} 分`;
    $('#execute-goal-status').textContent = !target ? '未设目标' : ratio >= 1 ? '已达目标' : `${Math.floor(ratio * 100)}%`;
    root.dataset.stage = ratio >= 1 ? 'complete' : ratio >= .8 ? 'near' : ratio >= .5 ? 'middle' : 'early';
    root.classList.toggle('is-running', advancing && !syncFailed && !document.hidden);
    $('#execute-goal-activity').textContent = syncFailed ? '等待同步' : !active ? '已停止'
      : active.included === false ? '当前段未计入有效' : advancing ? '有效计时中'
      : active.time_category === 'distraction' || (!active.time_category && active.segment_kind === 'counted_label') ? '分心中 · 进度保留'
      : active.time_category === 'external' ? '外部打断中 · 进度保留'
      : '休息／事务中 · 进度保留';
    $('#execute-goal-remaining').textContent = !target ? '' : ratio < 1 ? `还差 ${Math.ceil((target - seconds) / 60)} 分`
      : seconds - target >= 60 ? `超出 ${Math.floor((seconds - target) / 60)} 分` : '目标已完成';
    const track = $('#execute-goal-track');
    track.hidden = !target;
    track.setAttribute('aria-valuenow', String(Math.floor(ratio * 100)));
    track.setAttribute('aria-valuetext', `${task.title}，今日有效${minutes}分，目标${task.estimated_minutes}分${ratio >= 1 ? '，已达目标' : ''}`);
    $('#execute-goal-fill').style.width = `${ratio * 100}%`;
  }

  const quickDialog = $('#quick-correction-dialog');
  const quickError = $('#quick-correction-error');
  function updateQuickCorrectionControls() {
    $$('[data-quick-category]',quickDialog).forEach(button=>{
      button.disabled=quickCorrectionBusy;
      button.setAttribute('aria-pressed',String(button.dataset.quickCategory===quickCorrectionCategory));
    });
    $$('[data-quick-minutes], input, [type=submit]',quickDialog).forEach(control=>{control.disabled=quickCorrectionBusy || !quickCorrectionCategory;});
    $('#quick-correction-close').disabled=quickCorrectionBusy;
    $('#quick-correction-form [type=submit]').textContent=quickCorrectionBusy?'保存中…':'保存';
  }
  $('#quick-correction-open').onclick=()=>{
    const active=executionState?.active_segment;
    if(timingPending || !active || active.segment_kind!=='effective' || active.included===false)return;
    quickCorrectionSource=active.id;
    quickCorrectionCategory=null;
    quickCorrectionRequestId=Array.from(crypto.getRandomValues(new Uint8Array(16)),value=>value.toString(16).padStart(2,'0')).join('');
    $('#quick-correction-context').textContent=`从${active.task_title}当前有效段划出，保存后继续。`;
    $('#quick-correction-custom').value='';
    quickError.hidden=true;
    updateQuickCorrectionControls();
    quickDialog.showModal();
  };
  $$('[data-quick-category]',quickDialog).forEach(button=>button.onclick=()=>{
    quickCorrectionCategory=button.dataset.quickCategory;quickError.hidden=true;updateQuickCorrectionControls();
  });
  async function saveQuickCorrection(minutes) {
    if(quickCorrectionBusy || !quickCorrectionCategory)return;
    if(!Number.isInteger(minutes) || minutes<1 || minutes>1440){quickError.textContent='请选择或填写1～1440的整数分钟。';quickError.hidden=false;return;}
    quickCorrectionBusy=true;quickError.hidden=true;updateQuickCorrectionControls();
    try {
      const result=await executionApi(`/api/daily-execution/${dateInput.value}/quick-corrections`,{method:'POST',body:JSON.stringify({request_id:quickCorrectionRequestId,source_segment_id:quickCorrectionSource,time_category:quickCorrectionCategory,minutes})});
      renderExecutionState(result);quickDialog.close();toast('估计补记已保存，继续原学习');
    }catch(error){quickError.textContent=error.message;quickError.hidden=false;}
    finally{quickCorrectionBusy=false;updateQuickCorrectionControls();}
  }
  $$('[data-quick-minutes]',quickDialog).forEach(button=>button.onclick=()=>saveQuickCorrection(Number(button.dataset.quickMinutes)));
  $('#quick-correction-form').onsubmit=event=>{event.preventDefault();saveQuickCorrection(Number($('#quick-correction-custom').value));};
  $('#quick-correction-close').onclick=()=>{if(!quickCorrectionBusy)quickDialog.close();};
  quickDialog.addEventListener('cancel',event=>{if(quickCorrectionBusy)event.preventDefault();});
  quickDialog.addEventListener('click',event=>{
    if(event.target!==quickDialog || quickCorrectionBusy)return;
    const box=quickDialog.getBoundingClientRect();
    if(event.clientX<box.left || event.clientX>box.right || event.clientY<box.top || event.clientY>box.bottom)quickDialog.close();
  });
  quickDialog.addEventListener('close',()=>$('#quick-correction-open').focus({preventScroll:true}));

  function renderLiveExecution(result) {
    const active = result?.active_segment;
    const previous=clockSource?.active_segment;
    if(previous?.auto_stop_at&&!active&&result?.segments?.some(s=>s.id===previous.id&&s.stopped_automatically))toast('已按设定时间自动停止，记录已保存');
    else if(previous?.auto_stop_at&&active&&active.id!==previous.id&&!active.auto_stop_at)toast('已切换计时，原自动停止设置已取消');
    $('#auto-stop-open').hidden=!active||recordsOnly||historyView;
    $('#auto-stop-open').disabled=timingPending;
    $('#auto-stop-caption').textContent=active?.auto_stop_at?`${new Date(active.auto_stop_at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})} 自动停止 · 可修改`:'设置自动停止';
    if (clockSource !== result) {
      clockSource = result;
      clockActive = Boolean(active);
      clockSeconds = Number(active?.seconds || 0);
      clockReceivedAt = receivedTimes.get(result) ?? performance.now();
    }
    $('#execute-active-badge').innerHTML = active
      ? `<span class="execution-current-title">${active.segment_kind === 'effective' ? '正在做：' : '正在切到：'}${esc(active.task_title)}</span>${active.label_name ? `<span class="execution-current-label"> / ${esc(active.label_name)}</span>` : ''}`
      : '当前空闲';
    $('#execute-active-badge').title = $('#execute-active-badge').textContent;
    $('#execute-clock-caption').textContent = active ? '本段已进行' : '选择任务开始';
    updateTimingControls();
    $('#execute-record-status').textContent = syncFailed ? '暂时无法同步；显示的是上次确认的状态，请检查网络。'
      : active ? '开始时间已保存，停止后更新本段时长。'
      : result?.has_execution ? '学习记录已保存，无需另外提交。' : '还没有学习记录，开始后自动记录。';
    $('#execute-review-status').textContent = result?.has_review ? '复盘已保存' : '复盘待填写';
    const reminder = active?.reminder;
    const notice = $('#execute-reminder-status');
    notice.hidden = !reminder;
    if (reminder) {
      const due = new Date(reminder.due_at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});
      notice.textContent = reminder.status === 'pending' ? `${notificationState?.preview ? '预览演示' : '到点提醒'} · ${due}；计时不会自动停止。`
        : reminder.status === 'sent' ? '提醒已交给通知服务；计时继续，手机送达请实际核对。'
        : reminder.status === 'simulated' ? '预览已到提醒时间；没有发送手机通知，计时继续。'
        : reminder.error || '提醒已取消，计时状态以当前记录为准。';
    }
    updateClockDigits();
  }

  // 同步只更新当前计时和保存提示，时间轴、任务设置与输入表单保持原样。
  async function syncLiveExecution() {
    if (document.hidden || !executionState || executionWrites || liveSyncPending) return;
    const target = dateInput.value, revision = executionRevision;
    const sequence = executionLoadSequence;
    liveSyncPending = true;
    try {
      const result = await executionApi(`/api/daily-execution/${target}`);
      if (document.hidden || target !== dateInput.value || revision !== executionRevision || sequence !== executionLoadSequence || executionWrites) return;
      syncFailed = false;
      $('#execute-operation-feedback').hidden = true;
      const activeChanged=executionState?.active_segment?.id!==result.active_segment?.id;
      executionState = result;
      renderLiveExecution(result);
      if(activeChanged&&!recordsOnly&&!historyView){renderExecutionTasks();renderExecutionSubmitList();}
      chronology.update(result,receivedTimes.get(result));
      const runnable = result.plan && ['approved', 'submitted'].includes(result.plan.status);
      $('#execute-submit-panel').classList.toggle('hidden', !runnable);
      $('#execute-submit-panel').hidden=executionTab!=='complete';
    } catch {
      if (target === dateInput.value && revision === executionRevision && sequence === executionLoadSequence) {
        syncFailed = true; renderLiveExecution(executionState);
        showExecutionError('暂时无法同步，当前显示上次确认的记录。请检查网络后重新核对。');
      }
    } finally { liveSyncPending = false; }
  }
  const clockInterval = setInterval(updateClockDigits, 1000);
  const syncInterval = setInterval(() => {
    if (executionState?.active_segment) syncLiveExecution();
  }, 15000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { updateClockDigits(); syncLiveExecution(); }
    else updateGoalProgress();
  });
  window.addEventListener('focus', syncLiveExecution);
  window.addEventListener('pageshow', event => { if (event.persisted) syncLiveExecution(); });
  window.addEventListener('pagehide', event => {
    if (!event.persisted) { clearInterval(clockInterval); clearInterval(syncInterval); }
  });

  function defaultExecutionUiState() {
    return {
      collapsedZeroMain: true,
      collapsedSub: true,
      expandedLabelBucket: null,
      collapsedZeroMinuteSubmit: true,
      effectiveLabelSelections: {},
      expandedTaskDetails: {},
      effectivePickerTaskId: null,
    };
  }
  let executionUiState = defaultExecutionUiState();
  dateInput.value = recordsOnly ? (selectedFromQuery || todayIso()) : (dateInput.value || todayIso());

  function selectedExecutionTask() {
    if (!executionState?.tasks?.length) return null;
    return executionState.tasks.find(task => String(task.id) === String(selectedTaskId)) || executionState.tasks[0];
  }

  function effectiveLabelsForCategory(category) {
    return settings?.effective_labels_by_category?.[category] || [];
  }

  function effectiveLabelsForTask(taskId) {
    const task = (executionState?.tasks || []).find(item => String(item.id) === String(taskId));
    return task ? effectiveLabelsForCategory(task.category) : [];
  }

  function selectedEffectiveLabelId(taskId) {
    const labelId = executionUiState.effectiveLabelSelections[String(taskId)] || '';
    return effectiveLabelsForTask(taskId).some(label => label.id === labelId) ? labelId : '';
  }

  function rememberEffectiveLabelSelection(taskId, labelId='') {
    const key = String(taskId);
    if (!labelId) {
      delete executionUiState.effectiveLabelSelections[key];
      return;
    }
    executionUiState.effectiveLabelSelections[key] = labelId;
  }

  function latestEffectiveLabelIdForTask(taskId) {
    const segments = executionState?.segments || [];
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      const segment = segments[index];
      if (String(segment.task_id) !== String(taskId) || segment.segment_kind !== 'effective') continue;
      if (effectiveLabelsForTask(taskId).some(label => label.id === segment.label_id)) return segment.label_id;
    }
    return '';
  }

  function labelOptionsForKind(kind, taskId, selectedId='', snapshot=null) {
    if (kind === 'learning' || kind === 'effective') {
      const options = ['<option value="">未细分</option>'];
      const category = executionState.tasks.find(task => String(task.id) === String(taskId))?.category;
      const originalCategory = snapshot && executionState.tasks.find(task => task.id === snapshot.task_id)?.category;
      if (snapshot?.segment_kind === 'effective' && category === originalCategory && selectedId && !effectiveLabelsForTask(taskId).some(label => label.id === selectedId)) {
        options.push(`<option value="${esc(selectedId)}" selected>${esc(snapshot.label_name)}（原记录）</option>`);
      }
      effectiveLabelsForTask(taskId).forEach(label => {
        options.push(`<option value="${esc(label.id)}" ${label.id === selectedId ? 'selected' : ''}>${esc(label.name)}</option>`);
      });
      return options.join('');
    }
    const labels = (executionState?.labels || []).filter(label => labelTimeCategory(label) === kind);
    const options = labels.map(label => `<option value="${esc(label.id)}" ${label.id === selectedId ? 'selected' : ''}>${esc(label.name)}</option>`);
    if (snapshot && segmentTimeCategory(snapshot) === kind && snapshot.label_id && !labels.some(label => label.id === snapshot.label_id)) {
      options.unshift(`<option value="${esc(snapshot.label_id)}" ${snapshot.label_id === selectedId ? 'selected' : ''}>${esc(snapshot.label_name)}（原记录）</option>`);
    }
    return options.join('');
  }

  function taskBoardSummary(taskId) {
    return executionState?.task_execution_board?.find(item => String(item.task_id) === String(taskId)) || null;
  }

  function visibleExecutionSubmitTasks(tasks) {
    return tasks.filter(task => Number(task.estimated_minutes) > 0 || Number(task.actual_minutes || 0) > 0);
  }

  function collapsedExecutionSubmitTasks(tasks) {
    return tasks.filter(task => Number(task.estimated_minutes) === 0 && Number(task.actual_minutes || 0) === 0);
  }

  function chooseVocabularySource() {
    return new Promise(resolve => {
      const dialog = document.createElement('dialog');
      dialog.className = 'record-form';
      dialog.innerHTML = '<form method="dialog"><h3>当天已有墨墨录入</h3><p>这次背单词计时与墨墨记录，保留哪份？英语阅读不受影响。</p><label>保留方式<select name="choice"><option value="both">分别学习，保留两份</option><option value="manual">只保留墨墨录入</option><option value="timer">只保留背单词计时</option></select></label><button value="continue" class="primary">确认并开始</button><button value="cancel" class="ghost-button">取消</button></form>';
      document.body.appendChild(dialog);
      dialog.addEventListener('close', () => { const choice = dialog.returnValue === 'continue' ? dialog.querySelector('select').value : null; dialog.remove(); resolve(choice); }, {once:true});
      dialog.showModal();
    });
  }

  async function startEffectiveTask(taskId, successMessage='已开始记录有效时间', labelId=selectedEffectiveLabelId(taskId)) {
    selectedTaskId = taskId;
    executionUiState.expandedLabelBucket = null;
    rememberEffectiveLabelSelection(taskId, labelId || '');
    let duplicateChoice = null;
    if (labelId === 'effective_english_words' && executionState.duration_records?.length) {
      duplicateChoice = await chooseVocabularySource();
      if (!duplicateChoice) return;
    }
    executionState = await executionApi(`/api/daily-execution/${dateInput.value}/tasks/start`, {method:'POST', body:JSON.stringify({task_id:taskId, label_id:labelId || null, duplicate_choice:duplicateChoice})});
    executionUiState.effectivePickerTaskId = null;
    renderExecutionState(executionState);
    if(recordsPageOpen)chronology.showRecords(false);
    openExecutionControls();
    toast(successMessage);
  }

  function segmentEditorHtml(segment, isDraft=false, editorState=null) {
    const original = segment;
    segment = {...segment, ...editorState?.values};
    const taskOptions = (executionState?.tasks || [])
      .map(task => `<option value="${task.id}" ${String(task.id) === String(segment.task_id) ? 'selected' : ''}>${esc(task.title)}</option>`)
      .join('');
    const category = segmentTimeCategory(segment);
    const labelLabel = category === 'learning' ? '细分' : '标签';
    return `
      <article class="timeline-card ${isDraft ? 'draft' : ''}" data-segment-id="${segment.id}" data-original-segment="${esc(JSON.stringify(editorState?.original || original))}">
        ${isDraft ? '' : `<details class="segment-details" ${editorState?.open ? 'open' : ''}>
        <summary class="segment-summary"><span class="segment-summary-time">${esc(segmentTimeRange(original))}</span><span class="segment-summary-task">${esc(original.task_title)}／${esc(original.label_name || (original.segment_kind === 'effective' ? '未细分' : '未命名标签'))}${original.is_estimated ? ' · 补记·估计' : ''}</span><span class="segment-summary-duration">${segmentDuration(original.seconds)}${original.included === false ? ' · 不计入' : ` · ${timeCategoryNames[segmentTimeCategory(original)]}`}</span><span class="segment-summary-action">编辑</span></summary>`}
        <div class="segment-editor">
        ${!isDraft && segment.included === false ? '<p class="muted">此段保留记录，不计入统计</p>' : ''}
        <div class="timeline-form">
          <label>开始<input class="segment-start" type="datetime-local" step="1" value="${toDateTimeInputValue(segment.started_at)}"></label>
          <label>结束${!isDraft&&!original.ended_at?'<input class="segment-end" value="" placeholder="仍在计时" disabled><small>保存后继续计时；结束请点停止。</small>':`<input class="segment-end" type="datetime-local" step="1" value="${toDateTimeInputValue(segment.ended_at)}">`}</label>
          <label>任务<select class="segment-task-id" ${original.is_estimated?'disabled':''}>${taskOptions}</select></label>
          <label>归类<select class="segment-kind" ${original.is_estimated?'disabled':''}>
            ${Object.entries(timeCategoryNames).filter(([key])=>!key.startsWith('legacy') || key===category).map(([key,name])=>`<option value="${key}" ${category===key ? 'selected' : ''}>${name}</option>`).join('')}
          </select></label>
          <label class="segment-label-field"><span class="segment-label-title">${labelLabel}</span>
            <select class="segment-label-id" ${original.is_estimated?'disabled':''}>${labelOptionsForKind(category, segment.task_id, segment.label_id || '', isDraft ? null : original)}</select>
          </label>
        </div>
        <div class="timeline-actions">
          <button class="ghost-button segment-save" type="button">${isDraft ? '补记这一段' : !original.ended_at?'保存并继续计时':'保存修改'}</button>
          ${isDraft ? '' : '<button class="ghost-button segment-cancel" type="button">取消编辑</button>'}
          <button class="ghost-button segment-delete" type="button">${isDraft ? '取消' : original.is_estimated ? '撤销补记' : '删除'}</button>
        </div>
        </div>${isDraft ? '' : '</details>'}
      </article>
    `;
  }

  function segmentTimeRange(segment) {
    if(!segment.ended_at)return `${toDateTimeInputValue(segment.started_at).replace('T',' ')}—正在计时`;
    const start = toDateTimeInputValue(segment.started_at), end = toDateTimeInputValue(segment.ended_at);
    const crossDate = start.slice(0,10) !== end.slice(0,10);
    const seconds = start.slice(17,19) !== '00' || end.slice(17,19) !== '00';
    const text = value => `${crossDate ? `${value.slice(0,10)} ` : ''}${value.slice(11,seconds ? 19 : 16)}`;
    return `${text(start)}—${text(end)}`;
  }

  function segmentDuration(seconds) {
    const value = Math.max(0, Math.floor(Number(seconds || 0)));
    return `${Math.floor(value / 60)} 分${value % 60 ? ` ${value % 60} 秒` : ''}`;
  }

  function openNewSegmentEditor() {
    if(timingPending||segmentEditBusy||!selectedExecutionTask())return;
    const end=new Date(),parts=dateInput.value.split('-').map(Number);
    end.setFullYear(parts[0],parts[1]-1,parts[2]);
    const start=new Date(end.getTime()-30*60000);
    segmentDialogDate=dateInput.value;
    $('#segment-edit-title').textContent='补一段时间';
    $('#segment-edit-context').textContent='补记已经发生的一段时间。';
    $('#segment-edit-error').hidden=true;
    $('#segment-edit-content').innerHTML=segmentEditorHtml({id:'draft',task_id:selectedExecutionTask().id,segment_kind:'effective',label_id:null,started_at:dateToLocalDateTimeValue(start),ended_at:dateToLocalDateTimeValue(end)},true);
    wireSegmentEditors($('#segment-edit-content'));
    segmentDialog.showModal();
  }

  function wireSegmentEditors(list) {
    const syncSegmentLabelField = row => {
      const kind = $('.segment-kind', row).value;
      const taskId = Number($('.segment-task-id', row).value);
      const title = $('.segment-label-title', row);
      const labelSelect = $('.segment-label-id', row);
      title.textContent = kind === 'learning' ? '细分' : '标签';
      const snapshot = executionState.segments.find(segment => String(segment.id) === row.dataset.segmentId);
      labelSelect.innerHTML = labelOptionsForKind(kind, taskId, labelSelect.value || '', snapshot);
    };

    $$('.segment-kind', list).forEach(select => select.onchange = event => {
      syncSegmentLabelField(event.target.closest('.timeline-card'));
    });
    $$('.segment-task-id', list).forEach(select => select.onchange = event => {
      syncSegmentLabelField(event.target.closest('.timeline-card'));
    });

    $$('.segment-save', list).forEach(button => button.onclick = async () => {
      if (button.disabled || segmentEditBusy) return;
      const row = button.closest('.timeline-card');
      const category = $('.segment-kind', row).value;
      const original = row.dataset.segmentId==='draft'?null:JSON.parse(row.dataset.originalSegment);
      const label = executionState.labels.find(item=>item.id===$('.segment-label-id',row).value);
      const keepSnapshot = original && segmentTimeCategory(original)===category && original.label_id===$('.segment-label-id',row).value;
      const segmentKind = keepSnapshot ? original.segment_kind : category === 'learning' ? 'effective' : category.startsWith('legacy') ? original.segment_kind : label?.bucket === 'counted' ? 'counted_label' : 'interrupt_label';
      const body = {
        task_id: Number($('.segment-task-id', row).value),
        segment_kind: segmentKind,
        ...(category.startsWith('legacy') ? {} : {time_category:category}),
        label_id: $('.segment-label-id', row).value || null,
        started_at: fromDateTimeInputValue($('.segment-start', row).value),
        ended_at: original && !original.ended_at ? null : fromDateTimeInputValue($('.segment-end', row).value),
        ...(original?{expected_state:Object.fromEntries(['task_id','segment_kind','label_id','time_category','started_at','ended_at'].map(key=>[key,original[key]]))}:{}),
      };
      if (segmentKind === 'effective') rememberEffectiveLabelSelection(body.task_id, body.label_id || '');
      if (body.label_id === 'effective_english_words' && executionState.duration_records?.length) {
        body.duplicate_choice = await chooseVocabularySource();
        if (!body.duplicate_choice) return;
      }
      const saveDate=dateInput.value;
      try {
        if(segmentDialog.open&&segmentDialogDate!==saveDate)throw new Error('查看日期已变化，请重新打开记录。');
        button.disabled = true;
        segmentEditBusy=true;$('#segment-edit-close').disabled=true;updateTimingControls();
        const updated = row.dataset.segmentId === 'draft'
          ? await executionApi(`/api/daily-execution/${dateInput.value}/segments`, {method:'POST', body:JSON.stringify(body)})
          : await executionApi(`/api/daily-execution/${dateInput.value}/segments/${row.dataset.segmentId}`, {method:'PUT', body:JSON.stringify(body)});
        if(dateInput.value!==saveDate)return;
        executionState=updated;
        segmentDialog.close();
        renderExecutionState(executionState);
        toast(row.dataset.segmentId === 'draft' ? '补记已保存' : '时间段已更新');
      } catch (error) {
        toast(error.message);
        if(segmentDialog.open){$('#segment-edit-error').textContent=error.message;$('#segment-edit-error').hidden=false;}
      }
      finally { button.disabled = false;segmentEditBusy=false;$('#segment-edit-close').disabled=false;updateTimingControls(); }
    });

    $$('.segment-cancel',list).forEach(button=>button.onclick=()=>{if(!segmentEditBusy)segmentDialog.close();});

    $$('.segment-delete', list).forEach(button => button.onclick = async () => {
      if(segmentEditBusy)return;
      const row = button.closest('.timeline-card');
      if (row.dataset.segmentId === 'draft') {
        if(!segmentEditBusy)segmentDialog.close();
        return;
      }
      try {
        if(segmentDialog.contains(button)){
          if(button.dataset.confirmDelete!=='yes'){
            button.dataset.confirmDelete='yes';button.textContent='确认'+button.textContent;
            $('#segment-edit-error').textContent='再点一次确认；取消编辑可保留原记录。';$('#segment-edit-error').hidden=false;return;
          }
        }
        const estimated=executionState.segments.find(item=>String(item.id)===row.dataset.segmentId)?.is_estimated;
        segmentEditBusy=true;button.disabled=true;$('#segment-edit-close').disabled=true;updateTimingControls();
        executionState = await executionApi(`/api/daily-execution/${dateInput.value}/segments/${row.dataset.segmentId}`, {method:'DELETE'});
        segmentDialog.close();
        renderExecutionState(executionState);
        toast(estimated?'补记已撤销，已还原有效学习':'时间段已删除');
      } catch (error) { toast(error.message);$('#segment-edit-error').textContent=error.message;$('#segment-edit-error').hidden=false; }
      finally {segmentEditBusy=false;button.disabled=false;$('#segment-edit-close').disabled=false;updateTimingControls();}
    });

  }

  function executionTaskCardHtml(task) {
    const board = taskBoardSummary(task.id);
    const categoryTitle = settings?.task_titles?.[task.category] || task.category;
    const active = executionState?.active_segment?.task_id === task.id;
    const selected = selectedExecutionTask();
    const selectedClass = selected && String(selected.id) === String(task.id) ? 'selected' : '';
    const disabled = '';
    const effectiveLabels = effectiveLabelsForTask(task.id);
    const selectedLabelId = selectedEffectiveLabelId(task.id);
    const selectedLabel = effectiveLabels.find(label => label.id === selectedLabelId);
    const startLabelSuffix = selectedLabel ? ` · ${selectedLabel.name}` : '';
    const expanded = Boolean(executionUiState.expandedTaskDetails[String(task.id)]);
    const picking = executionUiState.effectivePickerTaskId === task.id;
    const inlineLabelPicker = `
      <div class="effective-label-picker">
        <div class="effective-management-heading"><span class="muted">有效细分</span><button class="ghost-button effective-label-add" type="button" aria-label="新增${esc(categoryTitle)}有效细分">＋</button></div>
        <div class="pill-list">${effectiveLabels.map(label => `
          <button class="ghost-button effective-label-button" type="button" data-effective-label-id="${esc(label.id)}" aria-label="管理${esc(label.name)}标签">${esc(label.name)}</button>
        `).join('') || '<span class="muted">还没有细分标签，点＋添加。</span>'}</div>
      </div>`;
    const startPicker = `<div id="effective-start-${task.id}" class="execution-mobile-label-panel effective-start-panel ${picking ? '' : 'hidden'}" role="group" aria-label="选择${esc(task.title)}的有效细分">
      <p class="effective-start-caption">选择细分，立即开始</p>
      <div class="pill-list">${effectiveLabels.map(label => `<button class="ghost-button effective-start-option ${active && executionState.active_segment.segment_kind === 'effective' && executionState.active_segment.label_id === label.id ? 'active' : ''}" type="button" data-start-label-id="${esc(label.id)}">${esc(label.name)}</button>`).join('') || '<span class="muted">可展开卡片，在有效细分右侧添加标签。</span>'}</div>
      <button class="ghost-button effective-start-option effective-start-unlabelled" type="button" data-start-label-id="">暂不细分，直接开始</button>
    </div>`;
    return `
      <article style="--project-color:${PlanVisuals.color(task.category)}" class="execution-task-card ${selectedClass} ${active ? 'active' : ''}" data-execution-task-id="${task.id}" tabindex="0" aria-expanded="${expanded}" aria-controls="execution-details-${task.id}">
        <div class="execution-task-head">
          <div>
            <h3>${PlanVisuals.symbol(task.category)}<span>${esc(task.title)}</span></h3>
            ${task.title !== categoryTitle ? `<p class="muted">${esc(categoryTitle)}</p>` : ''}
          </div>
          <div class="execution-task-actions">${task.category === 'english' ? '<button class="ghost-button word-count-open" type="button">记词数</button>' : ''}<button class="primary task-start-button" type="button" aria-expanded="${picking}" aria-controls="effective-start-${task.id}" ${disabled} aria-label="开始有效时间${esc(startLabelSuffix)}">开始<span class="task-start-detail">${esc(startLabelSuffix)}</span></button></div>
          ${startPicker}
        </div>
        <div class="execution-task-meta">
          <span>计划 ${task.estimated_minutes} 分</span>
          <span>有效 ${task.actual_minutes || 0} 分</span>
          <span>总计 ${board ? formatMinutes(board.total_minutes, board.total_seconds) : '0 分'}</span>
          ${task.category === 'english' ? `<span class="word-count-summary">${executionState.vocabulary_counts ? `新学 ${executionState.vocabulary_counts.new_words} · 复习 ${executionState.vocabulary_counts.review_words}` : ''}</span>` : ''}
        </div>
        <div id="execution-details-${task.id}" class="execution-task-details" ${expanded ? '' : 'hidden'}>
        <div class="task-type-controls"><label>事项类型<select class="execute-task-type">${taskTypeOptions(task.task_type)}</select></label>
        ${task.task_type === 'habit' ? `<label>当天状态<select class="habit-status"><option value="">未记录</option>${['done','missed','rest'].map(value => `<option value="${value}" ${task.habit_status === value ? 'selected' : ''}>${habitStatusLabel(value)}</option>`).join('')}</select></label>` : ''}
        </div>
        ${inlineLabelPicker}
        </div>
      </article>
    `;
  }

  function executionTaskSectionHtml(sectionKey, title, description, tasks, collapsed) {
    return `
      <section class="execution-task-section" data-execution-section="${sectionKey}">
        <button class="ghost-button execution-section-toggle" type="button" data-section-key="${sectionKey}" aria-expanded="${String(!collapsed)}">
          <span>${title}</span>
          <small>${description}</small>
        </button>
        <div class="execution-task-section-body ${collapsed ? 'hidden' : ''}">
          ${tasks.map(task => executionTaskCardHtml(task)).join('')}
        </div>
      </section>
    `;
  }

  function openEffectiveLabelEditor(taskId, labelId=null) {
    if (document.querySelector('.effective-label-dialog[open]')) return;
    const task = executionState.tasks.find(item => item.id === taskId);
    if (!task) return;
    const label = effectiveLabelsForTask(taskId).find(item => item.id === labelId);
    if (labelId && !label) { toast('标签已变化，请刷新后重试'); return; }
    closeEffectiveStartPicker();
    const categoryName = settings.task_titles?.[task.category] || task.category;
    const dialog = document.createElement('dialog');
    dialog.className = 'effective-label-dialog';
    dialog.setAttribute('aria-labelledby', 'effective-editor-title');
    dialog.innerHTML = `<form>
      <h3 id="effective-editor-title">${label ? '管理有效细分' : '新增有效细分'}</h3>
      <p class="muted">用于${esc(categoryName)}，以后每天都可用。已有计时保留原名称和时长。</p>
      <label>标签名称<input name="label_name" maxlength="50" required autocomplete="off" value="${esc(label?.name || '')}"></label>
      <p class="label-editor-error" role="status" hidden></p>
      <div class="actions"><button class="primary effective-editor-save" type="submit">${label ? '保存名称' : '添加标签'}</button><button class="ghost-button effective-editor-cancel" type="button">取消</button>${label ? '<button class="danger-soft effective-editor-delete" type="button">删除标签</button>' : ''}</div>
    </form>`;
    let busy = false, confirmDelete = false;
    const form = $('form',dialog), input = $('input',dialog), error = $('.label-editor-error',dialog);
    const setBusy = value => {
      busy = value;
      $$('button',dialog).forEach(button => button.disabled = value);
      input.disabled = value;
    };
    const perform = async deleting => {
      if (busy) return;
      error.hidden = true;
      const name = input.value.trim();
      if (!deleting && !name) { error.textContent = '请输入标签名称'; error.hidden = false; input.focus(); return; }
      setBusy(true);
      try {
        const path = `/api/settings/effective-labels/${encodeURIComponent(task.category)}${label ? '/' + encodeURIComponent(label.id) : ''}`;
        const result = await api(path, {method:deleting ? 'DELETE' : label ? 'PATCH' : 'POST', ...(!deleting ? {body:JSON.stringify({name})} : {})});
        settings = result;
        if (deleting) {
          for (const [id, selected] of Object.entries(executionUiState.effectiveLabelSelections)) {
            if (selected === label.id && executionState.tasks.find(item => String(item.id) === id)?.category === task.category) delete executionUiState.effectiveLabelSelections[id];
          }
        }
        renderExecutionTasks();
        renderExecutionToolbar();
        dialog.close();
        toast(deleting ? '细分标签已删除，历史记录保留' : label ? '细分名称已保存' : '细分标签已添加');
      } catch (cause) {
        error.textContent = cause.message; error.hidden = false;
      } finally { setBusy(false); }
    };
    form.onsubmit = event => { event.preventDefault(); perform(false); };
    $('.effective-editor-cancel',dialog).onclick = () => { if (!busy) dialog.close(); };
    if (label) $('.effective-editor-delete',dialog).onclick = () => {
      if (!confirmDelete) {
        confirmDelete = true;
        $('.effective-editor-delete',dialog).textContent = '确认删除';
        error.textContent = `删除“${label.name}”后，以后不再出现在${categoryName}的选框中，已有记录保留。`;
        error.hidden = false;
      } else perform(true);
    };
    input.oninput = () => {
      confirmDelete = false; error.hidden = true;
      if (label) $('.effective-editor-delete',dialog).textContent = '删除标签';
    };
    dialog.addEventListener('cancel',event => { event.stopPropagation(); if (busy) event.preventDefault(); });
    dialog.addEventListener('keydown',event => { if (event.key === 'Escape') event.stopPropagation(); });
    dialog.addEventListener('click',event => {
      if (event.target !== dialog || busy) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    });
    dialog.addEventListener('close',() => {
      dialog.remove();
      const card = $(`[data-execution-task-id="${taskId}"]`);
      const previous = labelId ? $$('.effective-label-button',card || document).find(button => button.dataset.effectiveLabelId === labelId) : null;
      (previous || (card && $('.effective-label-add',card)))?.focus({preventScroll:true});
    },{once:true});
    document.body.appendChild(dialog);dialog.showModal();input.focus();input.select();
  }

  function expandExecutionCard(taskId=null) {
    $$('.execution-task-card').forEach(card => {
      const id = Number(card.dataset.executionTaskId), expanded = id === taskId;
      executionUiState.expandedTaskDetails[String(id)] = expanded;
      $('.execution-task-details',card).hidden = !expanded;
      card.setAttribute('aria-expanded', String(expanded));
      card.classList.toggle('selected', expanded);
    });
    if (taskId !== null) selectedTaskId = taskId;
    updateGoalProgress();
  }

  function closeEffectiveStartPicker() {
    executionUiState.effectivePickerTaskId = null;
    $$('.effective-start-panel').forEach(panel => panel.classList.add('hidden'));
    $$('.task-start-button').forEach(button => button.setAttribute('aria-expanded','false'));
  }

  function bindExecutionTaskCardEvents(root=document) {
    $$('.execution-task-card', root).forEach(card => {
      const open = () => { closeEffectiveStartPicker(); closeExecutionLabelPicker(); expandExecutionCard(Number(card.dataset.executionTaskId)); };
      card.onclick = event => {
        if (event.target.closest('button, select, input, textarea, a, label')) return;
        open();
      };
      card.onkeydown = event => {
        if (event.target !== card || !['Enter',' '].includes(event.key)) return;
        event.preventDefault(); open();
      };
    });
    $$('.effective-label-button', root).forEach(button => button.onclick = event => {
      event.stopPropagation();
      openEffectiveLabelEditor(Number(button.closest('.execution-task-card').dataset.executionTaskId), button.dataset.effectiveLabelId);
    });
    $$('.effective-label-add', root).forEach(button => button.onclick = event => {
      event.stopPropagation();
      openEffectiveLabelEditor(Number(button.closest('.execution-task-card').dataset.executionTaskId));
    });
    $$('.task-start-button', root).forEach(button => button.onclick = event => {
      event.stopPropagation();
      if (switchingEffectiveLabel || timingPending) return;
      const card = button.closest('.execution-task-card');
      const taskId = Number(card.dataset.executionTaskId);
      $$('.execution-task-card').forEach(other => {
        if (other === card) return;
        executionUiState.expandedTaskDetails[other.dataset.executionTaskId] = false;
        $('.execution-task-details',other).hidden = true;
        other.setAttribute('aria-expanded','false');
        other.classList.remove('selected');
      });
      card.classList.add('selected');
      selectedTaskId = taskId;
      const opening = executionUiState.effectivePickerTaskId !== taskId;
      closeEffectiveStartPicker(); closeExecutionLabelPicker();
      if (!opening) return;
      executionUiState.effectivePickerTaskId = taskId;
      const panel = $('.effective-start-panel',card);
      panel.classList.remove('hidden','opens-above');
      panel.style.maxHeight = '';
      const rect = panel.getBoundingClientRect(), head = $('.execution-task-head',card).getBoundingClientRect();
      const below = Math.max(0, innerHeight - head.bottom - 18), above = Math.max(0, head.top - 18);
      const opensAbove = rect.height > below && above > below;
      panel.classList.toggle('opens-above', opensAbove);
      panel.style.maxHeight = `${Math.max(80, Math.min(360, opensAbove ? above : below))}px`;
      button.setAttribute('aria-expanded','true');
      $('.effective-start-option',card)?.focus({preventScroll:true});
    });
    $$('.effective-start-option', root).forEach(button => button.onclick = async event => {
      event.stopPropagation();
      if (switchingEffectiveLabel || timingPending) return;
      const taskId = Number(button.closest('.execution-task-card').dataset.executionTaskId);
      const labelId = button.dataset.startLabelId || null;
      const active = executionState?.active_segment;
      if (active?.task_id === taskId && active.segment_kind === 'effective' && (active.label_id || null) === labelId) {
        closeEffectiveStartPicker();openExecutionControls();return;
      }
      switchingEffectiveLabel = true;
      $$('.effective-start-option, .task-start-button').forEach(item => item.disabled = true);
      try {
        await startEffectiveTask(taskId, labelId ? `已开始${button.textContent.trim()}` : '已开始记录有效时间', labelId);
      } catch (error) {
        toast(error.message);
      } finally {
        switchingEffectiveLabel = false;
        updateTimingControls();
      }
    });
  }

  function executionSubmitCardHtml(task) {
    const canComplete = task.task_type !== 'habit';
    const disabled = !canComplete ? 'disabled' : '';
    const board = (executionState?.task_execution_board || []).find(item => Number(item.task_id) === Number(task.id));
    const totalMinutes = Number(board?.total_minutes || task.actual_minutes || 0);
    const summary = task.is_sub
      ? `<span>有效 ${task.actual_minutes || 0} 分</span><span>总计 ${totalMinutes} 分</span><span>${task.task_type === 'habit' ? habitStatusLabel(task.habit_status) : task.completed ? '已完成' : '未完成'}</span>`
      : `<span>计划 ${task.estimated_minutes} 分</span><span>有效 ${task.actual_minutes || 0} 分</span><span>总计 ${totalMinutes} 分</span>`;
    return `
      <article class="task-card ${task.completed ? 'completed' : ''}" data-submit-task-id="${task.id}">
        <input class="task-check execute-submit-check" type="checkbox" ${task.completed ? 'checked' : ''} ${disabled} aria-label="完成任务">
        <div class="task-content">
          <div class="task-title-row"><strong>${esc(task.title)}</strong></div>
          <div class="task-meta submit-task-meta"><span>${esc(settings?.task_titles?.[task.category] || task.category)}</span>${summary}${task.task_type === 'habit' ? `<span>${habitStatusLabel(task.habit_status)}</span>` : ''}</div>
        </div>
      </article>
    `;
  }

  function bindExecutionSubmitEvents(root) {
    $$('.execute-submit-check', root).forEach(checkbox => checkbox.onchange = async () => {
      const card = checkbox.closest('[data-submit-task-id]');
      try {
        const updated = await executionApi(`/api/tasks/${card.dataset.submitTaskId}`, {method:'PATCH', body:JSON.stringify({completed:checkbox.checked})});
        const task = executionState.plan.tasks.find(item => String(item.id) === String(card.dataset.submitTaskId));
        Object.assign(task, updated);
        card.classList.toggle('completed', updated.completed);
      } catch (error) {
        checkbox.checked = !checkbox.checked;
        toast(error.message);
      }
    });
  }

  function renderExecutionSubmitList() {
    const list = $('#execute-submit-list');
    const zeroGroup = $('#execute-submit-zero-group');
    const zeroToggle = $('#execute-submit-zero-toggle');
    const zeroList = $('#execute-submit-zero-list');
    const tasks = executionState?.plan?.tasks || [];
    const visibleTasks = visibleExecutionSubmitTasks(tasks);
    const hiddenZeroMinuteTasks = collapsedExecutionSubmitTasks(tasks);

    list.innerHTML = visibleTasks.map(executionSubmitCardHtml).join('');
    bindExecutionSubmitEvents(list);

    if (!hiddenZeroMinuteTasks.length) {
      zeroGroup.classList.add('hidden');
      zeroList.innerHTML = '';
      return;
    }

    zeroGroup.classList.remove('hidden');
    zeroToggle.textContent = `${executionUiState.collapsedZeroMinuteSubmit ? '展开' : '收起'}今日原计划为 0 分的项目（${hiddenZeroMinuteTasks.length} 项）`;
    zeroToggle.setAttribute('aria-expanded', String(!executionUiState.collapsedZeroMinuteSubmit));
    zeroList.classList.toggle('hidden', executionUiState.collapsedZeroMinuteSubmit);
    zeroList.innerHTML = hiddenZeroMinuteTasks.map(executionSubmitCardHtml).join('');
    bindExecutionSubmitEvents(zeroList);
  }

  function renderExecutionTasks() {
    const list = $('#execute-task-list');
    const tasks = executionState?.tasks || [];
    const activeTaskId = executionState?.active_segment?.task_id;
    if (!tasks.length) {
      list.innerHTML = '<p class="muted">当前日期还没有任务可执行。</p>';
      return;
    }
    const mainTasks = tasks.filter(task => !task.is_sub);
    const plannedMainTasks = mainTasks.filter(task => Number(task.estimated_minutes) > 0);
    const zeroMinuteMainTasks = mainTasks.filter(task => Number(task.estimated_minutes) === 0);
    const subTasks = tasks.filter(task => task.is_sub);
    const zeroMainCollapsed = executionUiState.collapsedZeroMain && !zeroMinuteMainTasks.some(task => task.id === activeTaskId);
    const subCollapsed = executionUiState.collapsedSub && !subTasks.some(task => task.id === activeTaskId);
    const sections = [];

    if (plannedMainTasks.length) {
      sections.push(plannedMainTasks.map(task => executionTaskCardHtml(task)).join(''));
    }
    if (zeroMinuteMainTasks.length) {
      sections.push(executionTaskSectionHtml(
        'zero-main',
        '今日未安排（随时可以开始）',
        `${zeroMinuteMainTasks.length} 项`,
        zeroMinuteMainTasks,
        zeroMainCollapsed,
      ));
    }
    if (subTasks.length) {
      sections.push(executionTaskSectionHtml(
        'sub-route',
        '副航线',
        `${subTasks.length} 项`,
        subTasks,
        subCollapsed,
      ));
    }

    list.innerHTML = sections.join('');
    $$('.execution-section-toggle', list).forEach(button => button.onclick = () => {
      if (button.dataset.sectionKey === 'zero-main') executionUiState.collapsedZeroMain = !executionUiState.collapsedZeroMain;
      if (button.dataset.sectionKey === 'sub-route') executionUiState.collapsedSub = !executionUiState.collapsedSub;
      renderExecutionTasks();
    });
    bindExecutionTaskCardEvents(list);
    updateTimingControls();
    $$('.word-count-open', list).forEach(button => button.onclick = event => {event.stopPropagation();openWordCounts();});
    $$('.execute-task-type, .habit-status', list).forEach(input => input.onchange = async () => {
      if (!input.value) return;
      const taskId = input.closest('[data-execution-task-id]').dataset.executionTaskId;
      try {
        await executionApi(`/api/tasks/${taskId}`, {method:'PATCH', body:JSON.stringify(input.classList.contains('habit-status') ? {habit_status:input.value} : {task_type:input.value})});
        await loadExecution();
      } catch (error) { toast(error.message); }
    });
  }

  function chooseActivityReminder(label) {
    return new Promise(resolve => {
      const dialog=document.createElement('dialog');dialog.className='record-form activity-reminder-dialog';
      const available=notificationState?.configured || notificationState?.preview;
      dialog.innerHTML=`<form><h3>开始记录${esc(label.name)}</h3><p class="muted">结束当前一段，开始记录${esc(label.name)}。到点只提醒，计时继续。</p><label>多久后提醒（分钟，可留空）<input name="minutes" type="number" min="15" max="1440" step="1" inputmode="numeric" placeholder="留空只记录；最少15分钟"></label><p class="muted">不填就只记录；填写15～1440的整数。提前停止或切换活动，会取消待发提醒。</p><p class="muted">${esc(notificationState?.message || '手机通知状态暂不可用，本次可留空只记录时间。')}</p><div class="actions"><button class="primary" type="submit">开始记录</button><button class="ghost-button reminder-cancel" type="button">取消</button></div></form>`;
      const form=$('form',dialog),minutes=form.elements.namedItem('minutes');
      const validate=()=>{
        const value=minutes.value;
        minutes.setCustomValidity(value && !available ? '手机通知尚未配置，请清空分钟数后只记录。'
          : value && (!Number.isInteger(Number(value)) || Number(value)<15 || Number(value)>1440) ? '请输入15～1440的整数分钟，或留空只记录。' : '');
      };
      minutes.oninput=validate;
      let selection=null;
      form.onsubmit=event=>{event.preventDefault();validate();if(!form.reportValidity())return;selection={reminder_minutes:minutes.value==='' ? null : Number(minutes.value)};dialog.close();};
      $('.reminder-cancel',dialog).onclick=()=>dialog.close();
      dialog.addEventListener('keydown',event=>event.stopPropagation());
      dialog.addEventListener('close',()=>{dialog.remove();resolve(selection);},{once:true});
      document.body.appendChild(dialog);dialog.showModal();minutes.focus();
    });
  }

  function renderExecutionLabelButtons(bucket, rootId) {
    const root = $(rootId);
    if (!root) return;
    const active = executionState?.active_segment;
    const labels = (executionState?.labels || []).filter(label => (labelTimeCategory(label) === 'distraction') === (bucket === 'counted'));
    root.innerHTML = labels.map(label => `
      <button class="ghost-button execution-label-button ${active?.label_id === label.id ? 'active' : ''}" type="button" data-label-id="${esc(label.id)}">
        ${esc(label.name)}${bucket === 'interrupt' ? `<small>${timeCategoryNames[labelTimeCategory(label)]}</small>` : ''}
      </button>
    `).join('') || '<p class="muted">暂无标签，可在设置中添加。</p>';
    $$('.execution-label-button', root).forEach(button => button.onclick = async () => {
      if (timingPending) return;
      const taskId = executionState?.active_segment?.task_id || selectedExecutionTask()?.id;
      const label = executionState.labels.find(item=>item.id===button.dataset.labelId);
      const labelName = label.name;
      if (executionState.active_segment?.label_id === label.id) {closeExecutionLabelPicker();return;}
      try {
        $$('.execution-label-button', toolbarRoot()).forEach(item => item.disabled = true);
        const choice = ['rest','life'].includes(labelTimeCategory(label)) ? await chooseActivityReminder(label) : {reminder_minutes:null};
        if (!choice) {renderExecutionToolbar();return;}
        executionState = await executionApi(`/api/daily-execution/${dateInput.value}/labels/start`, {
          method:'POST',
          body:JSON.stringify({label_id:button.dataset.labelId, task_id:taskId || null, ...choice}),
        });
        executionUiState.expandedLabelBucket = null;
        renderExecutionState(executionState);
        toast(`已切到${labelName}`);
      } catch (error) {
        toast(error.message);
        renderExecutionToolbar();
      }
    });
  }

  function toolbarRoot() { return $('#execute-mobile-toolbar'); }

  function closeExecutionLabelPicker() {
    if (!executionUiState.expandedLabelBucket) return;
    executionUiState.expandedLabelBucket = null;
    renderExecutionToolbar();
  }

  document.addEventListener('click', event => {
    if (!event.target.closest('#execute-mobile-toolbar')) closeExecutionLabelPicker();
    if (event.target.closest('.effective-label-dialog')) return;
    if (!event.target.closest('.execution-task-card')) {
      expandExecutionCard(); closeEffectiveStartPicker();
    } else if (!event.target.closest('.execution-task-head')) closeEffectiveStartPicker();
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
    if (executionUiState.effectivePickerTaskId !== null) {
      const id = executionUiState.effectivePickerTaskId;
      closeEffectiveStartPicker();
      $(`[data-execution-task-id="${id}"] .task-start-button`)?.focus({preventScroll:true});
    } else if (executionUiState.expandedLabelBucket) {
      const trigger = executionUiState.expandedLabelBucket === 'counted' ? $('#mobile-counted-toggle') : $('#mobile-interrupt-toggle');
      closeExecutionLabelPicker(); trigger.focus({preventScroll:true});
    } else if (!document.querySelector('.effective-label-dialog[open]')) expandExecutionCard();
  });

  function renderExecutionToolbar() {
    const toolbar = $('#execute-mobile-toolbar');
    const countedPanel = $('#mobile-counted-panel');
    const interruptPanel = $('#mobile-interrupt-panel');
    if (!toolbar || !countedPanel || !interruptPanel) return;
    toolbar.classList.remove('hidden');
    const active = executionState?.active_segment;
    const canReturnToEffective = Boolean(active && active.segment_kind !== 'effective' && active.task_id);

    $('#mobile-counted-toggle').classList.toggle('active', executionUiState.expandedLabelBucket === 'counted');
    $('#mobile-interrupt-toggle').classList.toggle('active', executionUiState.expandedLabelBucket === 'interrupt');
    $('#mobile-counted-toggle').setAttribute('aria-expanded', String(executionUiState.expandedLabelBucket === 'counted'));
    $('#mobile-interrupt-toggle').setAttribute('aria-expanded', String(executionUiState.expandedLabelBucket === 'interrupt'));
    $('#mobile-return-effective').disabled = timingPending || !canReturnToEffective;

    countedPanel.classList.toggle('hidden', executionUiState.expandedLabelBucket !== 'counted');
    interruptPanel.classList.toggle('hidden', executionUiState.expandedLabelBucket !== 'interrupt');

    renderExecutionLabelButtons('counted', '#mobile-counted-label-list');
    renderExecutionLabelButtons('interrupt', '#mobile-interrupt-label-list');

    $('#mobile-counted-toggle').onclick = () => {
      executionUiState.expandedLabelBucket = executionUiState.expandedLabelBucket === 'counted' ? null : 'counted';
      renderExecutionToolbar();
    };
    $('#mobile-interrupt-toggle').onclick = () => {
      executionUiState.expandedLabelBucket = executionUiState.expandedLabelBucket === 'interrupt' ? null : 'interrupt';
      renderExecutionToolbar();
    };
    $('#mobile-return-effective').onclick = async () => {
      if (!canReturnToEffective || timingPending) return;
      try {
        executionUiState.expandedLabelBucket = null;
        await startEffectiveTask(active.task_id, '已切回有效时间', latestEffectiveLabelIdForTask(active.task_id));
      } catch (error) { toast(error.message); }
    };
    updateTimingControls();
  }

  function renderExecutionState(result) {
    executionRevision++;
    executionState = result;
    syncFailed = false;
    renderLiveExecution(result);
    renderWordCounts();
    if (!selectedTaskId && result?.tasks?.length) selectedTaskId = result.active_segment?.task_id || result.tasks[0].id;
    updateTimingControls();
    const emptyPanel = $('#execute-empty-state');
    const emptyMessage = $('#execute-empty-message');
    const runnable = result?.plan && ['approved', 'submitted'].includes(result.plan.status);
    const readyToClose = runnable;
    $('#execute-panel').hidden=executionTab!=='courses';
    $('#execution-records-empty').hidden=runnable;
    $('#execution-records-empty').textContent=result?.plan?'这一天的清单尚未确认。':'这一天还没有计划或时间记录。';
    $('#execute-panel').classList.toggle('hidden', !runnable);
    currentPanel.classList.toggle('hidden', !runnable);
    $('#execution-support').classList.toggle('hidden', !runnable);
    $('#execute-chronology').classList.toggle('hidden', !runnable);
    $('#execute-mobile-toolbar').classList.toggle('hidden',!runnable);
    if(autoDialog.open&&autoStopDate!==result.date&&!autoStopBusy)autoDialog.close();
    if(segmentDialog.open&&segmentDialogDate!==result.date)segmentDialog.close();
    if(runnable)chronology.update(result,receivedTimes.get(result));
    $('#execute-submit-panel').classList.toggle('hidden', !readyToClose);
    $('#execute-submit-panel').hidden=executionTab!=='complete';
    $('#enter-review').disabled = !runnable;
    emptyPanel.classList.toggle('hidden', runnable);
    if (!result?.plan) {
      emptyMessage.textContent = '当前日期还没有计划。先回今天页生成并确认清单。';
      return;
    }
    if (!runnable) {
      emptyMessage.textContent = '当前日期还是草稿，先回今天页确认后再开始执行。';
      return;
    }
    const active = result.active_segment;
    if (active?.segment_kind === 'effective') rememberEffectiveLabelSelection(active.task_id, active.label_id || '');
    renderExecutionTasks();
    renderExecutionToolbar();
    renderExecutionSubmitList();
  }

  async function loadExecution() {
    const target = dateInput.value, sequence = ++executionLoadSequence;
    const changingDate = executionState?.date !== target;
    $('#execute-load-retry').hidden = true;
    if (changingDate) {
      executionState = null; renderLiveExecution(null);
      renderWordCounts();
      [currentPanel,$('#execution-support'),$('#execute-panel'),$('#execute-chronology'),$('#execute-submit-panel'),$('#execute-mobile-toolbar')].forEach(panel=>panel.classList.add('hidden'));
      $('#execute-empty-state').classList.remove('hidden');
    }
    $('#execute-empty-message').textContent = '正在读取这一天的记录…';
    try {
      const result = await executionApi(`/api/daily-execution/${target}`);
      if (sequence === executionLoadSequence && target === dateInput.value) renderExecutionState(result);
    } catch (error) {
      if (sequence === executionLoadSequence) {
        $('#execute-empty-state').classList.remove('hidden');
        $('#execute-empty-message').textContent = '读取失败，原有记录保留。请检查网络后重新读取。';
        $('#execution-records-empty').hidden=false;$('#execution-records-empty').textContent='读取失败，原有记录保留。请关闭后重新打开记录。';
        $('#execute-load-retry').hidden = false;
        toast(error.message);
      }
    }
  }
  $('#execute-load-retry').onclick = loadExecution;
  $('#execute-sync-retry').onclick = syncLiveExecution;

  let wordCountsBusy = false;
  let confirmingWordCountDelete = false;
  const wordCountDialog = $('#word-count-dialog');
  function renderWordCounts() {
    const counts=executionState?.vocabulary_counts;
    $$('.word-count-open').forEach(button=>{button.disabled=wordCountsBusy || !executionState || executionState.date!==dateInput.value;});
    $$('.word-count-summary').forEach(node=>{node.textContent=counts ? `新学 ${counts.new_words} · 复习 ${counts.review_words}` : '';});
    $('#word-count-delete').disabled=wordCountsBusy || !counts;
  }
  function setWordCountsBusy(value) {
    wordCountsBusy=value;
    $$('#word-count-form input, #word-count-form button').forEach(control=>{control.disabled=value;});
    $('#word-count-form [type=submit]').textContent=value ? '保存中…' : '保存';
    updateTimingControls();renderWordCounts();
  }
  function resetWordCountDelete() {
    confirmingWordCountDelete=false;$('#word-count-delete').textContent='清除';
  }
  function openWordCounts() {
    if(wordCountsBusy || !executionState || executionState.date!==dateInput.value || wordCountDialog.open)return;
    closeEffectiveStartPicker();closeExecutionLabelPicker();
    const form=$('#word-count-form'),counts=executionState.vocabulary_counts;
    form.elements.namedItem('new_words').value=counts?.new_words ?? '';
    form.elements.namedItem('review_words').value=counts?.review_words ?? '';
    $('#word-count-date').textContent=`${dateInput.value} · 当天累计`;
    $('#word-count-status').textContent='留空按0，再次保存会更新当天词数。';
    resetWordCountDelete();renderWordCounts();
    wordCountDialog.showModal();form.elements.namedItem('new_words').focus();
  }
  $('#word-count-close').onclick=()=>wordCountDialog.close();
  wordCountDialog.addEventListener('cancel',event=>{if(wordCountsBusy)event.preventDefault();});
  wordCountDialog.addEventListener('keydown',event=>event.stopPropagation());
  wordCountDialog.addEventListener('click',event=>{
    event.stopPropagation();
    const box=wordCountDialog.getBoundingClientRect();
    if(event.target===wordCountDialog && !wordCountsBusy && (event.clientX<box.left || event.clientX>box.right || event.clientY<box.top || event.clientY>box.bottom))wordCountDialog.close();
  });
  $('#word-count-form').oninput=resetWordCountDelete;
  async function saveWordCounts(method, body) {
    if(wordCountsBusy)return;
    const target=dateInput.value;
    setWordCountsBusy(true);$('#word-count-status').textContent='正在保存…';
    try {
      const result=await executionApi(`/api/vocabulary-counts/${target}`,{method,...(body ? {body:JSON.stringify(body)} : {})});
      invalidateCalendarMonth(target);
      if(target!==dateInput.value)return;
      // 只刷新词数，避免旧计时响应覆盖并发的停止或切换结果。
      if(executionState?.date===target)executionState.vocabulary_counts=result.vocabulary_counts;
      renderWordCounts();renderLiveExecution(executionState);
      $('#word-count-status').textContent=method==='DELETE' ? '当天词数已清除。' : '当天词数已保存。';
      wordCountDialog.close();
      toast(method==='DELETE' ? '词数已清除' : '当天词数已更新');
    } catch(error) {
      if(target===dateInput.value)$('#word-count-status').textContent=`保存失败，输入保留：${error.message}`;
    } finally {setWordCountsBusy(false);resetWordCountDelete();}
  }
  $('#word-count-form').onsubmit=event=>{
    event.preventDefault();const form=event.target;
    const body=Object.fromEntries(['new_words','review_words'].map(name=>[name,form.elements.namedItem(name).value==='' ? 0 : Number(form.elements.namedItem(name).value)]));
    if(!form.reportValidity() || Object.values(body).some(n=>!Number.isInteger(n)||n<0||n>10000))return;
    saveWordCounts('PUT',body);
  };
  $('#word-count-delete').onclick=()=>{
    if(confirmingWordCountDelete){saveWordCounts('DELETE');return;}
    confirmingWordCountDelete=true;$('#word-count-delete').textContent='确认清除';
    $('#word-count-status').textContent='再点一次清除当天词数，计时与已有分钟记录保留。';
  };

  $('#temporary-open').onclick = () => {
    const form = $('#temporary-form');
    form.category.innerHTML = Object.entries(settings.task_titles).map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join('');
    form.classList.remove('hidden');
    form.elements.namedItem('title').focus();
  };
  $('#temporary-form').category.onchange = event => { $('#temporary-form').task_type.value = event.target.value === 'rehab' ? 'habit' : 'daily_goal'; };
  $('#temporary-form').onsubmit = async event => {
    event.preventDefault();
    const form = event.target;
    try {
      const result = await executionApi(`/api/daily-execution/${dateInput.value}/tasks`, {method:'POST', body:JSON.stringify({title:form.elements.namedItem('title').value, category:form.category.value, task_type:form.task_type.value})});
      selectedTaskId = result.tasks[result.tasks.length - 1].id;
      renderExecutionState(result);
      form.classList.add('hidden');
      form.reset();
      toast('活动已添加，点开始即可记录');
    } catch (error) { toast(error.message); }
  };
  $$('.record-cancel').forEach(button => button.onclick = () => button.closest('.record-form').classList.add('hidden'));

  $('#execute-stop').onclick = async () => {
    if (timingPending) return;
    try {
      executionState = await executionApi(`/api/daily-execution/${dateInput.value}/stop`, {method:'POST'});
      renderExecutionState(executionState);
      $('#execute-operation-feedback').hidden = true;
      toast('已停止当前计时');
    } catch (error) { toast(error.message); }
  };

  $('#execute-submit-zero-toggle').onclick = () => {
    executionUiState.collapsedZeroMinuteSubmit = !executionUiState.collapsedZeroMinuteSubmit;
    renderExecutionSubmitList();
  };

  $('#enter-review').onclick = () => {
    if ($('#enter-review').disabled) return;
    window.location.href = `/review?date=${encodeURIComponent(dateInput.value)}`;
  };

  $('#execution-mini-stop').onclick=()=>$('#execute-stop').click();
  PlanUI.tabs($('.execution-section-tabs'),tab=>{executionTab=tab.id==='execution-complete-tab'?'complete':'courses';});
  const executionReady=Promise.all([api('/api/settings'),api('/api/notifications/status').catch(()=>null)]).then(([result,notification])=>{
    settings=result;notificationState=notification;
    if(!recordsOnly)return loadExecution();
  }).catch(error=>{toast(error.message);return false;});
  if(recordsOnly)window.DailyPlanRecords={
    async open(date){
      if(controlsBusy()||segmentDialog.open)return false;
      if(await executionReady===false)return false;
      if(dateInput.value!==date){selectedTaskId=null;executionUiState=defaultExecutionUiState();}
      dateInput.value=date;
      await loadExecution();
      openExecutionControls();
      return true;
    },
    close:closeExecutionControls,
    get busy(){return controlsBusy()||segmentDialog.open||$('#quick-correction-dialog').open||$('#word-count-dialog').open;},
    get date(){return dateInput.value;},
    get isOpen(){return controlsExpanded;},
    get state(){return executionState;},
  };
}

const DAILY_GPT_SYSTEM_PROMPT = `你现在是我的单日复盘搭子，不要急着给大道理。
我会把某一天的计划完成情况、实际投入和复盘内容发给你。
请按下面顺序和我协作：
1. 先用 2-4 句话复述你看到的真实情况，不要夸张。
2. 明确指出今天最值得追问的 1-2 个问题。
3. 给我一个很小的明天调整建议，必须具体到动作。
4. 如果信息还不够，继续追问我，而不是假装已经看清。
回答要自然、诚实、可执行，不要空泛鼓励。`;

const WEEKLY_GPT_SYSTEM_PROMPT = `你现在是我的周整理搭子，不要直接替我下结论。
我会把这一周的完成情况、每日复盘和当前草稿发给你。
请按下面顺序和我协作：
1. 先概括这一周真实发生了什么，别用漂亮空话。
2. 指出最值得深聊的 2-3 个模式或问题。
3. 给出下周执行层面的优先级建议，但不要替我拍板。
4. 如果判断依据不足，请继续追问我需要补充的事实。
回答要像一起整理，而不是像上对下打分。`;

const SYSTEM_PROMPT_DEFAULTS = {
  daily_gpt: {
    id: 'daily_gpt_system_default',
    name: '系统默认',
    content: DAILY_GPT_SYSTEM_PROMPT,
    is_system: true,
  },
  weekly_gpt: {
    id: 'weekly_gpt_system_default',
    name: '系统默认',
    content: WEEKLY_GPT_SYSTEM_PROMPT,
    is_system: true,
  },
};

function deepClone(value) {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function reviewHasContent(review) {
  return Object.values(review || {}).some(value => String(value || '').trim());
}

function normalizeList(items, fallback) {
  const safe = Array.isArray(items) ? items : [];
  return safe.some(item => item.id === fallback.id)
    ? safe.map(item => item.id === fallback.id ? {...item, content: fallback.content, name: fallback.name, is_system: true} : item)
    : [fallback, ...safe];
}

function normalizePromptSettings(raw={}) {
  return {
    daily_gpt_prompts: normalizeList(raw.daily_gpt_prompts, SYSTEM_PROMPT_DEFAULTS.daily_gpt),
    daily_gpt_active_prompt_id: raw.daily_gpt_active_prompt_id || SYSTEM_PROMPT_DEFAULTS.daily_gpt.id,
    weekly_gpt_prompts: normalizeList(raw.weekly_gpt_prompts, SYSTEM_PROMPT_DEFAULTS.weekly_gpt),
    weekly_gpt_active_prompt_id: raw.weekly_gpt_active_prompt_id || SYSTEM_PROMPT_DEFAULTS.weekly_gpt.id,
    weekly_analysis_prompts: raw.weekly_analysis_prompts || [],
    weekly_analysis_active_prompt_id: raw.weekly_analysis_active_prompt_id || 'weekly_analysis_system_default',
    chatgpt_export_prompts: raw.chatgpt_export_prompts || [],
    chatgpt_export_active_prompt_id: raw.chatgpt_export_active_prompt_id || 'chatgpt_export_system_default',
    project_start_date: raw.project_start_date || todayIso(),
  };
}

function currentPromptState(promptSettings, scope) {
  if (!promptSettings) return null;
  return scope === 'daily_gpt'
    ? {
        prompts: promptSettings.daily_gpt_prompts,
        activeId: promptSettings.daily_gpt_active_prompt_id,
      }
    : {
        prompts: promptSettings.weekly_gpt_prompts,
        activeId: promptSettings.weekly_gpt_active_prompt_id,
      };
}

async function persistPromptSettings(promptSettings) {
  if (!settings) settings = await api('/api/settings');
  const payload = {
    ...settings,
    daily_gpt_prompts: promptSettings.daily_gpt_prompts,
    daily_gpt_active_prompt_id: promptSettings.daily_gpt_active_prompt_id,
    weekly_gpt_prompts: promptSettings.weekly_gpt_prompts,
    weekly_gpt_active_prompt_id: promptSettings.weekly_gpt_active_prompt_id,
  };
  settings = await api('/api/settings', {method:'PUT', body:JSON.stringify(payload)});
  return normalizePromptSettings(settings);
}

if (page === 'gpt-workbench') {
  let workbenchState = null;
  let promptScope = 'daily_gpt';

  function renderWorkbenchPrompts() {
    const state = currentPromptState(workbenchState?.prompt_settings, promptScope);
    if (!state) return;
    $('#daily-template-tab').classList.toggle('active', promptScope === 'daily_gpt');
    $('#weekly-template-tab').classList.toggle('active', promptScope === 'weekly_gpt');
    $$('.prompt-scope-tab').forEach(button=>{const active=button.id===(promptScope==='daily_gpt'?'daily-template-tab':'weekly-template-tab');button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;});
    $('#prompt-editor-panel').setAttribute('aria-labelledby',promptScope==='daily_gpt'?'daily-template-tab':'weekly-template-tab');
    PlanUI.indicator($('.prompt-manager-switch'));
    $('#prompt-list').innerHTML = state.prompts.map(prompt => `
      <button type="button" class="prompt-chip ${prompt.id === state.activeId ? 'active' : ''}" data-id="${prompt.id}">
        ${esc(prompt.name)}
      </button>
    `).join('');
    const activePrompt = state.prompts.find(prompt => prompt.id === state.activeId) || state.prompts[0];
    $('#prompt-name-input').value = activePrompt?.name || '';
    $('#prompt-name-input').disabled = Boolean(activePrompt?.is_system);
    $('#prompt-content-input').value = activePrompt?.content || '';
    $('#delete-prompt').disabled = Boolean(activePrompt?.is_system);
    $$('.prompt-chip').forEach(button => button.onclick = async () => {
      const nextId = button.dataset.id;
      const nextSettings = deepClone(workbenchState.prompt_settings);
      if (promptScope === 'daily_gpt') nextSettings.daily_gpt_active_prompt_id = nextId;
      else nextSettings.weekly_gpt_active_prompt_id = nextId;
      workbenchState.prompt_settings = await persistPromptSettings(nextSettings);
      renderWorkbenchPrompts();
    });
  }

  function renderWorkbenchRecords() {
    const records = [
      ...(workbenchState?.daily_records || []).map(item => ({...item, scopeLabel: '单日'})),
      ...(workbenchState?.weekly_records || []).map(item => ({...item, scopeLabel: '单周'})),
    ].sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
    const container = $('#gpt-record-list');
    if (!records.length) {
      container.innerHTML = '<p class="muted">还没有贴回来的 GPT 协作记录。</p>';
      return;
    }
    container.innerHTML = records.map(item => `
      <article class="archive-card">
        <div class="archive-card-head">
          <strong>${esc(item.scopeLabel)}｜${esc(item.date_label || item.anchor_key)}</strong>
          <small>${esc(item.updated_at || '')}</small>
        </div>
        <p><strong>采用内容：</strong>${esc(item.adopted_text || '还没写')}</p>
        <details>
          <summary>查看 GPT 回复全文</summary>
          <pre>${esc(item.response_text || '还没保存回复')}</pre>
        </details>
      </article>
    `).join('');
  }

  async function loadWorkbench() {
    try {
      const result = await api('/api/gpt-workbench');
      workbenchState = {
        ...result,
        prompt_settings: normalizePromptSettings(result.prompt_settings || {}),
      };
      settings = await api('/api/settings');
      renderWorkbenchPrompts();
      renderWorkbenchRecords();
    } catch (error) { toast(error.message); }
  }

  function selectPromptScope(next) {
    if(promptScope===next)return;
    const direction=next==='weekly_gpt'?1:-1;
    promptScope=next;renderWorkbenchPrompts();PlanUI.enter($('#prompt-editor-panel'),direction);
  }
  $('#daily-template-tab').onclick=()=>selectPromptScope('daily_gpt');
  $('#weekly-template-tab').onclick=()=>selectPromptScope('weekly_gpt');
  $$('.prompt-scope-tab').forEach(button=>button.onkeydown=event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();const weekly=event.key==='End'||event.key!=='Home'&&promptScope==='daily_gpt';
    selectPromptScope(weekly?'weekly_gpt':'daily_gpt');$(weekly?'#weekly-template-tab':'#daily-template-tab').focus();
  });
  new ResizeObserver(()=>PlanUI.indicator($('.prompt-manager-switch'))).observe($('.prompt-manager-switch'));

  $('#add-prompt').onclick = async () => {
    const nextSettings = deepClone(workbenchState.prompt_settings);
    const key = promptScope === 'daily_gpt' ? 'daily_gpt_prompts' : 'weekly_gpt_prompts';
    const activeKey = promptScope === 'daily_gpt' ? 'daily_gpt_active_prompt_id' : 'weekly_gpt_active_prompt_id';
    const item = {
      id: `${promptScope}_${Date.now()}`,
      name: `${promptScope === 'daily_gpt' ? '单日模板' : '单周模板'}${nextSettings[key].length}`,
      content: SYSTEM_PROMPT_DEFAULTS[promptScope].content,
      is_system: false,
    };
    nextSettings[key].push(item);
    nextSettings[activeKey] = item.id;
    workbenchState.prompt_settings = await persistPromptSettings(nextSettings);
    renderWorkbenchPrompts();
  };

  $('#delete-prompt').onclick = async () => {
    const state = currentPromptState(workbenchState?.prompt_settings, promptScope);
    const activePrompt = state?.prompts.find(prompt => prompt.id === state.activeId);
    if (!activePrompt || activePrompt.is_system) return;
    const nextSettings = deepClone(workbenchState.prompt_settings);
    const key = promptScope === 'daily_gpt' ? 'daily_gpt_prompts' : 'weekly_gpt_prompts';
    const activeKey = promptScope === 'daily_gpt' ? 'daily_gpt_active_prompt_id' : 'weekly_gpt_active_prompt_id';
    nextSettings[key] = nextSettings[key].filter(prompt => prompt.id !== activePrompt.id);
    nextSettings[activeKey] = SYSTEM_PROMPT_DEFAULTS[promptScope].id;
    workbenchState.prompt_settings = await persistPromptSettings(nextSettings);
    renderWorkbenchPrompts();
  };

  $('#restore-system-prompt').onclick = async () => {
    const nextSettings = deepClone(workbenchState.prompt_settings);
    const key = promptScope === 'daily_gpt' ? 'daily_gpt_prompts' : 'weekly_gpt_prompts';
    nextSettings[key] = nextSettings[key].map(prompt => prompt.id === SYSTEM_PROMPT_DEFAULTS[promptScope].id
      ? {...prompt, ...SYSTEM_PROMPT_DEFAULTS[promptScope]}
      : prompt);
    workbenchState.prompt_settings = await persistPromptSettings(nextSettings);
    renderWorkbenchPrompts();
  };

  $('#prompt-name-input').oninput = async event => {
    const nextSettings = deepClone(workbenchState.prompt_settings);
    const key = promptScope === 'daily_gpt' ? 'daily_gpt_prompts' : 'weekly_gpt_prompts';
    const activeId = promptScope === 'daily_gpt' ? nextSettings.daily_gpt_active_prompt_id : nextSettings.weekly_gpt_active_prompt_id;
    nextSettings[key] = nextSettings[key].map(prompt => prompt.id === activeId && !prompt.is_system ? {...prompt, name:event.target.value} : prompt);
    workbenchState.prompt_settings = await persistPromptSettings(nextSettings);
    renderWorkbenchPrompts();
  };

  $('#prompt-content-input').oninput = async event => {
    const nextSettings = deepClone(workbenchState.prompt_settings);
    const key = promptScope === 'daily_gpt' ? 'daily_gpt_prompts' : 'weekly_gpt_prompts';
    const activeId = promptScope === 'daily_gpt' ? nextSettings.daily_gpt_active_prompt_id : nextSettings.weekly_gpt_active_prompt_id;
    nextSettings[key] = nextSettings[key].map(prompt => prompt.id === activeId ? {...prompt, content:event.target.value || SYSTEM_PROMPT_DEFAULTS[promptScope].content} : prompt);
    workbenchState.prompt_settings = await persistPromptSettings(nextSettings);
    renderWorkbenchPrompts();
  };

  loadWorkbench();
}

if (page === 'settings') {
  const categories = {math:'数学', english:'英语', computer:'408', ai_project:'AI 项目', sleep:'睡眠', vibe_coding:'vibe coding', algorithm:'算法', reading:'阅读', writing:'练字', rehab:'运动'};
  let settingsState = null;

  function renderOtherProjectNames() {
    const selected=new Set(settingsState.main_project_categories);
    $('#task-title-fields').innerHTML=Object.entries({...categories,...settingsState.task_titles}).filter(([key])=>!selected.has(key)).map(([key,label])=>`<label>${esc(label)}<input data-category="${esc(key)}" value="${esc(settingsState.task_titles[key] || label)}"></label>`).join('');
    $$('#task-title-fields input').forEach(input=>input.oninput=()=>{settingsState.task_titles[input.dataset.category]=input.value;});
  }
  function renderMainProjects() {
    const selected=settingsState.main_project_categories;
    $('#main-project-fields').innerHTML=selected.map((category,index)=>`<div class="main-project-row" data-project-category="${esc(category)}">
      <label>项目名称<input data-main-project-name="${esc(category)}" maxlength="100" required value="${esc(settingsState.task_titles[category] || categories[category] || '')}"></label>
      <label>默认分钟<input data-draft-main-category="${esc(category)}" type="number" min="0" max="720" step="1" required value="${settingsState.draft_main_minutes_by_category[category] ?? 0}"></label>
      <div class="main-project-actions"><button class="ghost-button main-project-up" type="button" ${index===0?'disabled':''} aria-label="上移${esc(settingsState.task_titles[category])}">↑</button><button class="ghost-button main-project-down" type="button" ${index===selected.length-1?'disabled':''} aria-label="下移${esc(settingsState.task_titles[category])}">↓</button><button class="ghost-button main-project-remove" type="button" ${selected.length===1?'disabled':''}>移出</button></div></div>`).join('');
    $$('#main-project-fields [data-main-project-name]').forEach(input=>input.oninput=()=>{settingsState.task_titles[input.dataset.mainProjectName]=input.value;});
    $$('#main-project-fields [data-draft-main-category]').forEach(input=>input.oninput=()=>{settingsState.draft_main_minutes_by_category[input.dataset.draftMainCategory]=Number(input.value);});
    $$('#main-project-fields button').forEach(button=>button.onclick=()=>{
      const category=button.closest('[data-project-category]').dataset.projectCategory,index=selected.indexOf(category);
      if(button.classList.contains('main-project-remove'))selected.splice(index,1);
      else {const next=index+(button.classList.contains('main-project-up')?-1:1);[selected[index],selected[next]]=[selected[next],selected[index]];}
      renderMainProjects();
    });
    $('#main-project-add').disabled=selected.length>=11;
    const available=Object.entries({...categories,...settingsState.task_titles}).filter(([category])=>!selected.includes(category));
    $('#main-project-existing').innerHTML='<option value="">从已有项目加入…</option>'+available.map(([category,title])=>`<option value="${esc(category)}">${esc(settingsState.task_titles[category] || title)}</option>`).join('');
    $('#main-project-add-existing').disabled=selected.length>=11||!available.length;
    $('#settings-form').rehab_enabled.checked=selected.includes('rehab');
    renderOtherProjectNames();renderEffectiveLabelFields();
  }
  $('#main-project-add').onclick=()=>{
    if(!settingsState || settingsState.main_project_categories.length>=11)return;
    const input=$('#main-project-new-name'),title=input.value.trim();
    if(!title){input.focus();toast('先填写新项目名称');return;}
    const category=`custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,10)}`;
    settingsState.task_titles[category]=title;settingsState.draft_main_minutes_by_category[category]=0;
    settingsState.main_project_categories.push(category);input.value='';renderMainProjects();
    $(`[data-main-project-name="${category}"]`).focus();
  };
  $('#main-project-add-existing').onclick=()=>{
    const category=$('#main-project-existing').value;
    if(!category || !settingsState || settingsState.main_project_categories.length>=11)return;
    settingsState.task_titles[category] ||= categories[category] || '项目';
    settingsState.draft_main_minutes_by_category[category] ??= 0;
    settingsState.main_project_categories.push(category);renderMainProjects();
  };

  function renderExecutionLabelFields() {
    $('#execution-label-fields').innerHTML = (settingsState?.execution_labels || []).map(label => `
      <div class="execution-label-row" data-label-id="${esc(label.id)}">
        <label>名称<input class="execution-label-name" maxlength="50" required value="${esc(label.name)}"></label>
        <label>归类
          <select class="execution-label-bucket">
            ${['distraction','rest','external','life'].map(category=>`<option value="${category}" ${labelTimeCategory(label)===category ? 'selected' : ''}>${timeCategoryNames[category]}</option>`).join('')}
          </select>
        </label>
        ${label.is_system ? '<span class="status execution-label-origin">默认</span>' : '<button class="ghost-button execution-label-delete" type="button">删除</button>'}
      </div>
    `).join('');
    $$('.execution-label-name').forEach(input => input.oninput = event => {
      const row = event.target.closest('.execution-label-row');
      const item = settingsState.execution_labels.find(label => label.id === row.dataset.labelId);
      if (item) item.name = event.target.value;
    });
    $$('.execution-label-bucket').forEach(select => select.onchange = event => {
      const row = event.target.closest('.execution-label-row');
      const item = settingsState.execution_labels.find(label => label.id === row.dataset.labelId);
      if (item) {item.time_category = event.target.value;item.bucket = item.time_category==='distraction' ? 'counted' : 'interrupt';}
    });
    $$('.execution-label-delete').forEach(button => button.onclick = () => {
      const row = button.closest('.execution-label-row');
      settingsState.execution_labels = settingsState.execution_labels.filter(label => label.id !== row.dataset.labelId);
      renderExecutionLabelFields();
    });
  }

  function addExecutionLabel(bucket) {
    settingsState.execution_labels.push({
      id: `custom_${bucket}_${Date.now()}`,
      name: '新标签',
      time_category:'distraction',
      bucket,
      is_system: false,
    });
    renderExecutionLabelFields();
    const input = $$('.execution-label-name').at(-1);
    input.focus();
    input.select();
  }

  function effectiveLabelsForCategoryState(category) {
    if (!settingsState.effective_labels_by_category) settingsState.effective_labels_by_category = {};
    if (!Array.isArray(settingsState.effective_labels_by_category[category])) {
      settingsState.effective_labels_by_category[category] = [];
    }
    return settingsState.effective_labels_by_category[category];
  }

  function renderEffectiveLabelFields() {
    $('#effective-label-category-fields').innerHTML = Object.entries({...categories,...settingsState.task_titles}).map(([category, label]) => {
      const rows = effectiveLabelsForCategoryState(category).map(item => `
        <div class="effective-label-row" data-category="${esc(category)}" data-label-id="${esc(item.id)}">
          <label>名称<input class="effective-label-name" value="${esc(item.name)}"></label>
          <span class="status">${item.is_system ? '系统默认' : '自定义'}</span>
          <button class="ghost-button effective-label-delete" type="button">删除</button>
        </div>
      `).join('');
      return `
        <section class="effective-label-category-card" data-effective-category="${esc(category)}">
          <div class="effective-label-category-head">
            <div>
              <h3>${esc(label)}</h3>
              <p class="muted">${effectiveLabelsForCategoryState(category).length ? '这些标签会用于该类别的有效时间细分。' : '当前还没有细分标签，可按你的习惯手动补充。'}</p>
            </div>
            <button class="ghost-button add-effective-label" type="button" data-category="${esc(category)}">新增细分标签</button>
          </div>
          <div class="stack">
            ${rows || '<p class="muted">当前为空。</p>'}
          </div>
        </section>
      `;
    }).join('');

    $$('.effective-label-name').forEach(input => input.oninput = event => {
      const row = event.target.closest('.effective-label-row');
      const item = effectiveLabelsForCategoryState(row.dataset.category).find(label => label.id === row.dataset.labelId);
      if (item) item.name = event.target.value;
    });
    $$('.effective-label-delete').forEach(button => button.onclick = () => {
      const row = button.closest('.effective-label-row');
      if (!settingsState.deleted_effective_label_ids) settingsState.deleted_effective_label_ids = {};
      const deleted = settingsState.deleted_effective_label_ids[row.dataset.category] ||= [];
      if (!deleted.includes(row.dataset.labelId)) deleted.push(row.dataset.labelId);
      settingsState.effective_labels_by_category[row.dataset.category] = effectiveLabelsForCategoryState(row.dataset.category)
        .filter(label => label.id !== row.dataset.labelId);
      renderEffectiveLabelFields();
    });
    $$('.add-effective-label').forEach(button => button.onclick = () => {
      const category = button.dataset.category;
      effectiveLabelsForCategoryState(category).push({
        id: `effective_${category}_${Date.now()}`,
        name: '新细分标签',
        is_system: false,
      });
      renderEffectiveLabelFields();
    });
  }

  api('/api/settings').then(result => {
    settingsState = result;
    settingsState.main_project_categories=(result.main_project_categories || ['math','english','computer','rehab']).filter(category=>category!=='rehab'||result.rehab_enabled);
    const form = $('#settings-form');
    form.current_stage.value = result.current_stage;
    form.ai_project_weekly_frequency.value = result.ai_project_weekly_frequency;
    form.rehab_enabled.checked = result.rehab_enabled;
    form.show_energy_selector.checked = Boolean(result.show_energy_selector);
    form.show_day_type_selector.checked = Boolean(result.show_day_type_selector);
    form.project_start_date.value = result.project_start_date || todayIso();
    form.weekly_review_mode.value = result.weekly_review_mode || 'separate';
    form.weekly_review_day.value = String(result.weekly_review_day ?? 6);
    $('#weekly-review-day-field').hidden = form.weekly_review_mode.value !== 'replace_day';
    form.weekly_review_mode.onchange = () => { $('#weekly-review-day-field').hidden = form.weekly_review_mode.value !== 'replace_day'; };
    form.budget_minimum.value = result.budget_minimum || 90;
    form.budget_normal.value = result.budget_normal || 150;
    form.budget_ample.value = result.budget_ample || 210;
    renderMainProjects();
    renderExecutionLabelFields();
    renderEffectiveLabelFields();
  });
  $('#add-execution-label').onclick = () => addExecutionLabel('counted');
  $('#export-backup').onclick = async () => {
    try {
      await downloadBackupFile();
      toast('备份已开始下载');
    } catch (error) { toast(error.message); }
  };
  $('#settings-form').onsubmit = async event => {
    event.preventDefault();
    const task_titles = {...settingsState.task_titles,...Object.fromEntries($$('#main-project-fields [data-main-project-name]').map(input=>[input.dataset.mainProjectName,input.value.trim()]))};
    const draft_main_minutes_by_category = Object.fromEntries($$('[data-draft-main-category]').map(input => [input.dataset.draftMainCategory, Number(input.value || 0)]));
    try {
      settingsState = await api('/api/settings', {method:'PUT', body:JSON.stringify({
        current_stage:event.target.current_stage.value,
        ai_project_weekly_frequency:Number(event.target.ai_project_weekly_frequency.value),
        rehab_enabled:settingsState.main_project_categories.includes('rehab'),
        main_project_categories:settingsState.main_project_categories,
        show_energy_selector:event.target.show_energy_selector.checked,
        show_day_type_selector:event.target.show_day_type_selector.checked,
        project_start_date:event.target.project_start_date.value,
        weekly_review_mode:event.target.weekly_review_mode.value,
        weekly_review_day:Number(event.target.weekly_review_day.value),
        budget_minimum:Number(event.target.budget_minimum.value),
        budget_normal:Number(event.target.budget_normal.value),
        budget_ample:Number(event.target.budget_ample.value),
        task_titles,
        draft_main_minutes_by_category,
        execution_labels: settingsState.execution_labels,
        effective_labels_by_category: settingsState.effective_labels_by_category,
        deleted_effective_label_ids: settingsState.deleted_effective_label_ids || {},
      })});
      invalidateAllCalendarMonths();
      toast('设置已保存');
    } catch (error) { toast(error.message); }
  };
}
