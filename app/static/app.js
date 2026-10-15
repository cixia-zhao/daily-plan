const $ = (selector, root=document) => root.querySelector(selector);
const $$ = (selector, root=document) => [...root.querySelectorAll(selector)];
const esc = (value='') => String(value).replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
const page = document.body.dataset.page;
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
  const response = await fetch(path, {headers:{'Content-Type':'application/json'}, ...options});
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
      const {tasks,segments,durations,reviews} = snapshot.counts;
      if (!await confirmAction(
        `恢复 ${dateValue} 重置前的 ${tasks} 项任务、${segments} 段计时、${durations} 条分钟录入和 ${reviews} 份日复盘。进行中的计时恢复为重置时停止。若这天已有新数据，会拒绝覆盖；其他日期保持不变。`,
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
          <span>计总标签 ${formatMinutes(board.counted_label_minutes, board.counted_label_seconds)}</span>
          <span>中断 ${formatMinutes(board.interrupt_minutes, board.interrupt_seconds)}</span>
          <span>有效占总计 ${formatPercent(board.effective_ratio)}</span>
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
            <h4>计总标签</h4>
            ${board.counted_labels?.length
              ? `<ul>${board.counted_labels.map(label => `<li>${esc(label.label_name)} · ${formatMinutes(label.minutes, label.seconds)} · ${label.count} 次</li>`).join('')}</ul>`
              : '<p class="muted">还没有计总标签记录</p>'}
          </div>
          <div>
            <h4>中断标签</h4>
            ${board.interrupt_labels?.length
              ? `<ul>${board.interrupt_labels.map(label => `<li>${esc(label.label_name)} · ${formatMinutes(label.minutes, label.seconds)} · ${label.count} 次</li>`).join('')}</ul>`
              : '<p class="muted">还没有中断标签记录</p>'}
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
  const CORE_MAIN_CATEGORIES = new Set(['math', 'english', 'computer']);
  const dateInput = $('#plan-date');
  const dateButton = $('#plan-date-button');
  const carryoverButton = $('#carryover-button');
  const carryoverPopover = $('#carryover-popover');
  const carryoverDot = $('#carryover-dot');
  const carryoverEmpty = $('#carryover-empty');
  const carryoverHint = $('#carryover-hint');
  const carryoverCount = $('#carryover-count');
  const carryoverList = $('#carryover-popover-list');
  dateInput.value = todayIso();
  updateDateTrigger(dateButton, dateInput.value);
  let currentPlan = null;
  let swapSourceId = null;
  let carryoverItems = [];

  function setTodayStage(stage) {
    const checkinStage = $('#today-checkin-stage');
    const reviewStage = $('#today-review-stage');
    const showingReview = stage === 'review';
    checkinStage.classList.toggle('hidden', showingReview);
    reviewStage.classList.toggle('hidden', !showingReview);
    document.body.classList.toggle('today-list-stage', showingReview);
    $('#today-page-header .plan-status-actions').classList.toggle('hidden', !showingReview);
    $('#today-page-header h1').textContent = showingReview
      ? (currentPlan?.status === 'draft' ? '安排今天' : '今天的清单') : '今天的目标';
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
      button.textContent = '进入执行台';
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
    const coreLocked = CORE_MAIN_CATEGORIES.has(task.category) && !task.is_sub;
    return `<div class="task-controls">
      <button type="button" class="order-button move-up" ${index === 0 ? 'disabled' : ''} aria-label="上移">↑</button>
      <button type="button" class="order-button move-down" ${index === routeLength - 1 ? 'disabled' : ''} aria-label="下移">↓</button>
      ${coreLocked ? '<span class="route-locked" title="核心主线不可降级">已锁定</span>' : `<button type="button" class="route-swap-button" data-id="${task.id}">调整航线</button>`}
      ${coreLocked ? '' : '<button type="button" class="delete-task" aria-label="删除任务">×</button>'}
    </div>`;
  }

  function renderTask(task, index, routeLength) {
    const approved = currentPlan.status !== 'draft';
    const isSub = Boolean(task.is_sub);
    const zeroMinuteMain = approved && !isSub && Number(task.estimated_minutes) === 0;
    const subjectMarks = {math:'∑',english:'Aa',computer:'408',rehab:'动',vibe_coding:'⌘',algorithm:'ƒ',reading:'读',writing:'写',ai_project:'AI'};
    const lead = !approved
      ? `<span class="subject-icon subject-${esc(task.category)}" aria-hidden="true">${subjectMarks[task.category] || '·'}</span>`
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
        : `<label class="minutes-label"><input class="minutes-input" aria-label="${esc(task.title)}目标分钟" type="number" min="0" max="720" value="${task.estimated_minutes}"> 分钟</label>`;
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
    return `<article class="task-card task-archive-card ${isSub ? 'sub-route-task' : 'main-route-task'} ${task.completed ? 'completed' : ''}" data-task-id="${task.id}" data-category="${esc(task.category)}">
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
    $('#plan-section').dataset.route = route;
    $$('.plan-route-tab').forEach(button => {
      const selected = button.dataset.route === route;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
  }
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
      const targetWouldDemoteCore = sourceIsSub && CORE_MAIN_CATEGORIES.has(target.category);
      if (!targetWouldDemoteCore) $('.route-target', card)?.classList.remove('hidden');
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

  function renderMorningTargets() {
    $('#morning-targets').innerHTML = ['math', 'english', 'computer', 'rehab'].filter(category => category !== 'rehab' || settings.rehab_enabled).map(category => `<label>${esc(settings.task_titles[category] || category)}目标（分钟）<input type="number" min="0" max="720" required data-target-category="${category}" value="${settings.draft_main_minutes_by_category?.[category] || 0}"></label>`).join('');
    const update = () => { $('#morning-total').textContent = `计划合计 ${$$('[data-target-category]').reduce((sum, input) => sum + Number(input.value || 0), 0)} 分`; };
    $$('[data-target-category]').forEach(input => input.oninput = update);
    update();
  }

  async function loadCarryovers() {
    carryoverItems = await api('/api/carryovers');
    renderCarryoverPopover();
  }

  async function loadPlanForDate() {
    cancelSwap();
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
        energy:$('input[name=energy]:checked').value,
        target_minutes:Object.fromEntries($$('[data-target-category]').map(input => [input.dataset.targetCategory, Number(input.value)])),
        day_type:$('#day-type').value,
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
  $('#adjust-checkin').onclick = () => setTodayStage('checkin');
  const openExecutionDesk = () => {
    window.location.href = `/execute?date=${encodeURIComponent(dateInput.value)}`;
  };
  $('#open-execution-desk').onclick = openExecutionDesk;
  document.addEventListener('keydown', event => { if (event.key === 'Escape') cancelSwap(); });

  loadCarryovers();
  api('/api/settings').then(result => {
    settings = result;
    renderMorningTargets();
    bindSharedCalendarTrigger(dateButton, () => dateInput.value, async nextDate => {
      dateInput.value = nextDate;
      updateDateTrigger(dateButton, nextDate);
      await loadPlanForDate();
    }, '选择今天页日期');
    return loadPlanForDate();
  }).catch(error => toast(error.message));
}

if (page === 'execute') {
  const dateInput = $('#execute-date');
  const dateButton = $('#execute-date-button');
  const selectedFromQuery = new URLSearchParams(window.location.search).get('date');
  let executionState = null;
  let selectedTaskId = null;
  let showDraftSegment = false;
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
  const receivedTimes = new WeakMap();

  async function executionApi(path, options={}) {
    const writing = options.method && options.method !== 'GET';
    if (writing) {
      executionWrites++; executionRevision++;
      $('#execute-record-status').textContent = '正在保存…';
    }
    try {
      const result = await api(path, options);
      if (result && typeof result === 'object') receivedTimes.set(result, performance.now());
      return result;
    } catch (error) {
      if (writing) $('#execute-record-status').textContent = '这次操作未确认保存，请重试；原有记录保留。';
      throw error;
    } finally {
      if (writing) { executionWrites--; executionRevision++; }
    }
  }

  function updateClockDigits() {
    if (document.hidden) return;
    const seconds = clockActive ? Math.max(0, Math.floor(clockSeconds + (performance.now() - clockReceivedAt) / 1000)) : 0;
    $('#execute-clock').textContent = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
      .map(value => String(value).padStart(2, '0')).join(':');
  }

  function renderLiveExecution(result) {
    const active = result?.active_segment;
    if (clockSource !== result) {
      clockSource = result;
      clockActive = Boolean(active);
      clockSeconds = Number(active?.seconds || 0);
      clockReceivedAt = receivedTimes.get(result) ?? performance.now();
    }
    $('#execute-active-badge').textContent = !active ? '当前空闲'
      : active.segment_kind === 'effective' ? `正在做：${active.task_title}${active.label_name ? ` / ${active.label_name}` : ''}`
      : `正在切到：${active.task_title} / ${active.label_name}`;
    $('#execute-clock-caption').textContent = active ? '本段已进行' : '选择任务开始';
    $('#execute-stop').disabled = !active;
    $('#execute-record-status').textContent = syncFailed ? '暂时无法同步；显示的是上次确认的状态，请检查网络。'
      : active ? '开始时间已保存，停止后更新本段时长。'
      : result?.has_execution ? '学习记录已保存，无需另外提交。' : '还没有学习记录，开始后自动记录。';
    $('#execute-review-status').textContent = result?.has_review ? '复盘已保存' : '复盘待填写';
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
      executionState = result;
      renderLiveExecution(result);
      const runnable = result.plan && ['approved', 'submitted'].includes(result.plan.status);
      $('#execute-submit-panel').classList.toggle('hidden', !runnable || Boolean(result.active_segment));
    } catch {
      if (target === dateInput.value && revision === executionRevision && sequence === executionLoadSequence) {
        syncFailed = true; renderLiveExecution(executionState);
      }
    } finally { liveSyncPending = false; }
  }
  const clockInterval = setInterval(updateClockDigits, 1000);
  const syncInterval = setInterval(() => {
    if (executionState?.active_segment) syncLiveExecution();
  }, 15000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { updateClockDigits(); syncLiveExecution(); }
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
      collapsedTimeline: true,
      collapsedZeroMinuteSubmit: true,
      effectiveLabelSelections: {},
      expandedTaskDetails: {},
      effectivePickerTaskId: null,
    };
  }
  let executionUiState = defaultExecutionUiState();
  dateInput.value = selectedFromQuery || todayIso();
  updateDateTrigger(dateButton, dateInput.value);

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
    if (kind === 'effective') {
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
    const bucket = kind === 'counted_label' ? 'counted' : 'interrupt';
    const labels = (executionState?.labels || []).filter(label => label.bucket === bucket);
    const options = labels.map(label => `<option value="${esc(label.id)}" ${label.id === selectedId ? 'selected' : ''}>${esc(label.name)}</option>`);
    if (snapshot?.segment_kind === kind && snapshot.label_id && !labels.some(label => label.id === snapshot.label_id)) {
      options.unshift(`<option value="${esc(snapshot.label_id)}" ${snapshot.label_id === selectedId ? 'selected' : ''}>${esc(snapshot.label_name)}（原归类）</option>`);
    }
    return options.join('');
  }

  function taskBoardSummary(taskId) {
    return executionState?.task_execution_board?.find(item => String(item.task_id) === String(taskId)) || null;
  }

  function timelineToggleText() {
    const segmentCount = (executionState?.segments?.length || 0) + (showDraftSegment ? 1 : 0);
    const countText = segmentCount ? `（${segmentCount} 段）` : '';
    return executionUiState.collapsedTimeline ? `展开时间轴${countText}` : `收起时间轴${countText}`;
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
    toast(successMessage);
  }

  function segmentEditorHtml(segment, isDraft=false) {
    const taskOptions = (executionState?.tasks || [])
      .map(task => `<option value="${task.id}" ${String(task.id) === String(segment.task_id) ? 'selected' : ''}>${esc(task.title)}</option>`)
      .join('');
    const labelLabel = segment.segment_kind === 'effective' ? '细分' : '标签';
    return `
      <article class="timeline-card ${isDraft ? 'draft' : ''}" data-segment-id="${segment.id}">
        <p class="muted">${!isDraft && segment.included === false ? '此段保留记录，不计入统计' : ''}</p>
        <div class="timeline-form">
          <label>开始<input class="segment-start" type="datetime-local" step="1" value="${toDateTimeInputValue(segment.started_at)}"></label>
          <label>结束<input class="segment-end" type="datetime-local" step="1" value="${toDateTimeInputValue(segment.ended_at)}"></label>
          <label>任务<select class="segment-task-id">${taskOptions}</select></label>
          <label>类型<select class="segment-kind">
            <option value="effective" ${segment.segment_kind === 'effective' ? 'selected' : ''}>有效时间</option>
            <option value="counted_label" ${segment.segment_kind === 'counted_label' ? 'selected' : ''}>计总标签</option>
            <option value="interrupt_label" ${segment.segment_kind === 'interrupt_label' ? 'selected' : ''}>中断标签</option>
          </select></label>
          <label class="segment-label-field"><span class="segment-label-title">${labelLabel}</span>
            <select class="segment-label-id">${labelOptionsForKind(segment.segment_kind, segment.task_id, segment.label_id || '', isDraft ? null : segment)}</select>
          </label>
        </div>
        <div class="timeline-actions">
          <button class="ghost-button segment-save" type="button">${isDraft ? '补记这一段' : '保存修改'}</button>
          <button class="ghost-button segment-delete" type="button">${isDraft ? '取消' : '删除'}</button>
        </div>
      </article>
    `;
  }

  function renderTimelineList() {
    const list = $('#timeline-list');
    const rows = [];
    if (showDraftSegment) {
      const end = new Date();
      const start = new Date(end.getTime() - (30 * 60 * 1000));
      rows.push(segmentEditorHtml({
        id: 'draft',
        task_id: selectedExecutionTask()?.id,
        segment_kind: 'effective',
        label_id: null,
        started_at: dateToLocalDateTimeValue(start),
        ended_at: dateToLocalDateTimeValue(end),
      }, true));
    }
    rows.push(...(executionState?.segments || []).map(segment => {
      if (!segment.ended_at) {
        return `
          <article class="timeline-card active" data-segment-id="${segment.id}">
            <div>
              <strong>${esc(segment.task_title)}</strong>
              <p class="muted">${segment.segment_kind === 'effective' ? esc(segment.label_name ? `有效时间 / ${segment.label_name}` : '有效时间') : esc(segment.label_name || '标签')} · 已累计 ${formatMinutes(segment.minutes, segment.seconds)}</p>
              <p class="muted">${segment.included ? '计入统计' : '保留记录，不计入统计'} · ${segment.started_at.replace('T', ' ')}</p>
            </div>
            <div class="timeline-actions"><button class="ghost-button active-segment-stop" type="button">停止</button></div>
          </article>
        `;
      }
      return segmentEditorHtml(segment);
    }));
    list.innerHTML = rows.length ? rows.join('') : '<p class="muted">还没有任何执行记录，先开始一段任务有效时间。</p>';

    const syncSegmentLabelField = row => {
      const kind = $('.segment-kind', row).value;
      const taskId = Number($('.segment-task-id', row).value);
      const title = $('.segment-label-title', row);
      const labelSelect = $('.segment-label-id', row);
      title.textContent = kind === 'effective' ? '细分' : '标签';
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
      const row = button.closest('.timeline-card');
      const segmentKind = $('.segment-kind', row).value;
      const body = {
        task_id: Number($('.segment-task-id', row).value),
        segment_kind: segmentKind,
        label_id: $('.segment-label-id', row).value || null,
        started_at: fromDateTimeInputValue($('.segment-start', row).value),
        ended_at: fromDateTimeInputValue($('.segment-end', row).value),
      };
      if (segmentKind === 'effective') rememberEffectiveLabelSelection(body.task_id, body.label_id || '');
      if (body.label_id === 'effective_english_words' && executionState.duration_records?.length) {
        body.duplicate_choice = await chooseVocabularySource();
        if (!body.duplicate_choice) return;
      }
      try {
        executionState = row.dataset.segmentId === 'draft'
          ? await executionApi(`/api/daily-execution/${dateInput.value}/segments`, {method:'POST', body:JSON.stringify(body)})
          : await executionApi(`/api/daily-execution/${dateInput.value}/segments/${row.dataset.segmentId}`, {method:'PUT', body:JSON.stringify(body)});
        showDraftSegment = false;
        executionUiState.collapsedTimeline = false;
        renderExecutionState(executionState);
        toast(row.dataset.segmentId === 'draft' ? '补记已保存' : '时间段已更新');
      } catch (error) { toast(error.message); }
    });

    $$('.segment-delete', list).forEach(button => button.onclick = async () => {
      const row = button.closest('.timeline-card');
      if (row.dataset.segmentId === 'draft') {
        showDraftSegment = false;
        renderTimelineSection();
        return;
      }
      try {
        executionState = await executionApi(`/api/daily-execution/${dateInput.value}/segments/${row.dataset.segmentId}`, {method:'DELETE'});
        renderExecutionState(executionState);
        toast('时间段已删除');
      } catch (error) { toast(error.message); }
    });

    $$('.active-segment-stop', list).forEach(button => button.onclick = async () => {
      try {
        executionState = await executionApi(`/api/daily-execution/${dateInput.value}/stop`, {method:'POST'});
        renderExecutionState(executionState);
        toast('已停止当前计时');
      } catch (error) { toast(error.message); }
    });
  }

  function renderTimelineSection() {
    const toggle = $('#timeline-toggle');
    const content = $('#timeline-content');
    toggle.textContent = timelineToggleText();
    toggle.setAttribute('aria-expanded', String(!executionUiState.collapsedTimeline));
    content.classList.toggle('hidden', executionUiState.collapsedTimeline);
    renderTimelineList();
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
      <article class="execution-task-card ${selectedClass} ${active ? 'active' : ''}" data-execution-task-id="${task.id}" tabindex="0" aria-expanded="${expanded}" aria-controls="execution-details-${task.id}">
        <div class="execution-task-head">
          <div>
            <h3>${esc(task.title)}</h3>
            ${task.title !== categoryTitle ? `<p class="muted">${esc(categoryTitle)}</p>` : ''}
          </div>
          <button class="primary task-start-button" type="button" aria-expanded="${picking}" aria-controls="effective-start-${task.id}" ${disabled}>开始有效时间${esc(startLabelSuffix)}</button>
          ${startPicker}
        </div>
        <div class="execution-task-meta">
          <span>计划 ${task.estimated_minutes} 分</span>
          <span>有效 ${task.actual_minutes || 0} 分</span>
          <span>总计 ${board ? formatMinutes(board.total_minutes, board.total_seconds) : '0 分'}</span>
        </div>
        <div id="execution-details-${task.id}" class="execution-task-details" ${expanded ? '' : 'hidden'}>
        <div class="task-type-controls"><label>事项类型<select class="execute-task-type">${taskTypeOptions(task.task_type)}</select></label>
        ${task.task_type === 'habit' ? `<label>当天状态<select class="habit-status"><option value="">未记录</option>${['done','missed','rest'].map(value => `<option value="${value}" ${task.habit_status === value ? 'selected' : ''}>${habitStatusLabel(value)}</option>`).join('')}</select></label>` : ''}
        ${task.category === 'english' ? '<button class="ghost-button vocabulary-open" type="button">背单词 · 录入分钟</button>' : ''}</div>
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
      if (switchingEffectiveLabel) return;
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
      if (switchingEffectiveLabel) return;
      const taskId = Number(button.closest('.execution-task-card').dataset.executionTaskId);
      const labelId = button.dataset.startLabelId || null;
      const active = executionState?.active_segment;
      if (active?.task_id === taskId && active.segment_kind === 'effective' && (active.label_id || null) === labelId) {
        closeEffectiveStartPicker(); return;
      }
      switchingEffectiveLabel = true;
      $$('.effective-start-option, .task-start-button').forEach(item => item.disabled = true);
      try {
        await startEffectiveTask(taskId, labelId ? `已开始${button.textContent.trim()}` : '已开始记录有效时间', labelId);
      } catch (error) {
        toast(error.message);
      } finally {
        switchingEffectiveLabel = false;
        $$('.effective-start-option, .task-start-button').forEach(item => item.disabled = false);
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
    $$('.vocabulary-open', list).forEach(button => button.onclick = () => openVocabulary());
    $$('.execute-task-type, .habit-status', list).forEach(input => input.onchange = async () => {
      if (!input.value) return;
      const taskId = input.closest('[data-execution-task-id]').dataset.executionTaskId;
      try {
        await executionApi(`/api/tasks/${taskId}`, {method:'PATCH', body:JSON.stringify(input.classList.contains('habit-status') ? {habit_status:input.value} : {task_type:input.value})});
        await loadExecution();
      } catch (error) { toast(error.message); }
    });
  }

  function renderExecutionLabelButtons(bucket, rootId) {
    const root = $(rootId);
    if (!root) return;
    const active = executionState?.active_segment;
    const labels = (executionState?.labels || []).filter(label => label.bucket === bucket);
    root.innerHTML = labels.map(label => `
      <button class="ghost-button execution-label-button ${active?.label_id === label.id ? 'active' : ''}" type="button" data-label-id="${esc(label.id)}">
        ${esc(label.name)}
      </button>
    `).join('') || '<p class="muted">暂无标签，可在设置中添加。</p>';
    $$('.execution-label-button', root).forEach(button => button.onclick = async () => {
      const taskId = executionState?.active_segment?.task_id || selectedExecutionTask()?.id;
      const labelName = button.textContent.trim();
      try {
        $$('.execution-label-button', toolbarRoot()).forEach(item => item.disabled = true);
        executionState = await executionApi(`/api/daily-execution/${dateInput.value}/labels/start`, {
          method:'POST',
          body:JSON.stringify({label_id:button.dataset.labelId, task_id:taskId || null}),
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
    if (event.key !== 'Escape') return;
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
    $('#mobile-return-effective').disabled = !canReturnToEffective;

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
      if (!canReturnToEffective) return;
      try {
        executionUiState.expandedLabelBucket = null;
        await startEffectiveTask(active.task_id, '已切回有效时间', latestEffectiveLabelIdForTask(active.task_id));
      } catch (error) { toast(error.message); }
    };
  }

  function renderExecutionState(result) {
    executionRevision++;
    executionState = result;
    syncFailed = false;
    renderLiveExecution(result);
    if (!selectedTaskId && result?.tasks?.length) selectedTaskId = result.active_segment?.task_id || result.tasks[0].id;
    $('#execute-stop').disabled = !result?.active_segment;
    const emptyPanel = $('#execute-empty-state');
    const emptyMessage = $('#execute-empty-message');
    const runnable = result?.plan && ['approved', 'submitted'].includes(result.plan.status);
    const readyToClose = runnable && !result?.active_segment;
    $('#execute-panel').classList.toggle('hidden', !runnable);
    $('#timeline-panel').classList.toggle('hidden', !runnable);
    $('#execute-submit-panel').classList.toggle('hidden', !readyToClose);
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
    renderTimelineSection();
    renderExecutionSubmitList();
    renderVocabulary();
  }

  async function loadExecution() {
    const target = dateInput.value, sequence = ++executionLoadSequence;
    try {
      const result = await executionApi(`/api/daily-execution/${target}`);
      if (sequence === executionLoadSequence && target === dateInput.value) renderExecutionState(result);
    } catch (error) {
      if (sequence === executionLoadSequence) toast(error.message);
    }
  }

  let editingVocabularyId = null;
  function openVocabulary(record=null) {
    editingVocabularyId = record?.id || null;
    const form = $('#vocabulary-form');
    form.minutes.value = record?.minutes || '';
    form.duplicate_choice.value = '';
    form.querySelector('[type=submit]').textContent = record ? '保存修改' : '保存时长';
    $('#vocabulary-panel').classList.remove('hidden');
    renderVocabulary();
    form.minutes.focus();
  }
  function renderVocabulary() {
    const words = (executionState?.segments || []).filter(row => row.segment_kind === 'effective' && row.label_id === 'effective_english_words');
    $('#vocabulary-choice-label').classList.toggle('hidden', !words.length);
    $('#vocabulary-form').duplicate_choice.required = Boolean(words.length);
    const records = executionState?.duration_records || [];
    const timerMinutes = words.filter(row => row.included).reduce((sum, row) => sum + row.minutes, 0);
    const manualMinutes = records.filter(row => row.included).reduce((sum, row) => sum + row.minutes, 0);
    $('#vocabulary-summary').textContent = `${dateInput.value} · 背单词合计 ${manualMinutes + timerMinutes} 分（墨墨 ${manualMinutes} / 计时 ${timerMinutes}）。只有分钟数，不生成时间段。`;
    $('#vocabulary-record-list').innerHTML = records.map(row => `<div class="duration-row"><span>墨墨 ${row.minutes} 分 · ${row.included ? '计入统计' : '保留记录，不计入统计'}</span><button type="button" class="ghost-button vocabulary-edit" data-id="${row.id}">修改</button><button type="button" class="ghost-button vocabulary-delete" data-id="${row.id}">删除</button></div>`).join('');
    $$('.vocabulary-edit').forEach(button => button.onclick = () => openVocabulary(records.find(row => String(row.id) === button.dataset.id)));
    $$('.vocabulary-delete').forEach(button => button.onclick = async () => {
      if (!await confirmAction('删除这条背单词时长记录？', {title:'删除时长记录', confirmLabel:'删除'})) return;
      try {
        renderExecutionState(await executionApi(`/api/daily-execution/${dateInput.value}/vocabulary/${button.dataset.id}`, {method:'DELETE'}));
        editingVocabularyId = null;
        $('#vocabulary-form').reset();
        toast('记录已删除');
      } catch (error) { toast(error.message); }
    });
  }
  $('#vocabulary-shortcut').onclick = () => openVocabulary();
  $('#vocabulary-form').onsubmit = async event => {
    event.preventDefault();
    const form = event.target;
    const submit = form.querySelector('[type=submit]');
    submit.disabled = true;
    try {
      const path = `/api/daily-execution/${dateInput.value}/vocabulary${editingVocabularyId ? '/' + editingVocabularyId : ''}`;
      renderExecutionState(await executionApi(path, {method:editingVocabularyId ? 'PUT' : 'POST', body:JSON.stringify({minutes:Number(form.minutes.value), duplicate_choice:form.duplicate_choice.value || null})}));
      editingVocabularyId = null;
      form.reset();
      submit.textContent = '保存时长';
      toast('背单词时长已保存');
    } catch (error) { toast(error.message); }
    finally { submit.disabled = false; }
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
    try {
      executionState = await executionApi(`/api/daily-execution/${dateInput.value}/stop`, {method:'POST'});
      renderExecutionState(executionState);
      toast('已停止当前计时');
    } catch (error) { toast(error.message); }
  };

  $('#add-segment').onclick = () => {
    showDraftSegment = true;
    executionUiState.collapsedTimeline = false;
    renderTimelineSection();
  };

  $('#timeline-toggle').onclick = () => {
    executionUiState.collapsedTimeline = !executionUiState.collapsedTimeline;
    renderTimelineSection();
  };

  $('#execute-submit-zero-toggle').onclick = () => {
    executionUiState.collapsedZeroMinuteSubmit = !executionUiState.collapsedZeroMinuteSubmit;
    renderExecutionSubmitList();
  };

  $('#enter-review').onclick = () => {
    if ($('#enter-review').disabled) return;
    window.location.href = `/review?date=${encodeURIComponent(dateInput.value)}`;
  };

  api('/api/settings').then(result => {
    settings = result;
    bindSharedCalendarTrigger(dateButton, () => dateInput.value, async nextDate => {
      dateInput.value = nextDate;
      selectedTaskId = null;
      editingVocabularyId = null;
      $('#vocabulary-form').reset();
      $('#vocabulary-panel').classList.add('hidden');
      $('#temporary-form').classList.add('hidden');
      showDraftSegment = false;
      executionUiState = defaultExecutionUiState();
      updateDateTrigger(dateButton, nextDate);
      await loadExecution();
    }, '选择执行日期');
    return loadExecution();
  }).catch(error => toast(error.message));

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

  $('#daily-template-tab').onclick = () => {
    promptScope = 'daily_gpt';
    renderWorkbenchPrompts();
  };

  $('#weekly-template-tab').onclick = () => {
    promptScope = 'weekly_gpt';
    renderWorkbenchPrompts();
  };

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
  const draftMainCategories = {math:'数学', english:'英语', computer:'408', rehab:'运动'};
  let settingsState = null;

  function renderExecutionLabelFields() {
    $('#execution-label-fields').innerHTML = (settingsState?.execution_labels || []).map(label => `
      <div class="execution-label-row" data-label-id="${esc(label.id)}">
        <label>名称<input class="execution-label-name" maxlength="50" required value="${esc(label.name)}"></label>
        <label>归类
          <select class="execution-label-bucket">
            <option value="counted" ${label.bucket === 'counted' ? 'selected' : ''}>计总标签</option>
            <option value="interrupt" ${label.bucket === 'interrupt' ? 'selected' : ''}>中断标签</option>
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
      if (item) item.bucket = event.target.value;
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
    $('#effective-label-category-fields').innerHTML = Object.entries(categories).map(([category, label]) => {
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
    const form = $('#settings-form');
    form.current_stage.value = result.current_stage;
    form.ai_project_weekly_frequency.value = result.ai_project_weekly_frequency;
    form.rehab_enabled.checked = result.rehab_enabled;
    form.project_start_date.value = result.project_start_date || todayIso();
    form.weekly_review_mode.value = result.weekly_review_mode || 'separate';
    form.weekly_review_day.value = String(result.weekly_review_day ?? 6);
    $('#weekly-review-day-field').hidden = form.weekly_review_mode.value !== 'replace_day';
    form.weekly_review_mode.onchange = () => { $('#weekly-review-day-field').hidden = form.weekly_review_mode.value !== 'replace_day'; };
    form.budget_minimum.value = result.budget_minimum || 90;
    form.budget_normal.value = result.budget_normal || 150;
    form.budget_ample.value = result.budget_ample || 210;
    $('#draft-main-minute-fields').innerHTML = Object.entries(draftMainCategories)
      .map(([key, label]) => `<label>${esc(label)}<input data-draft-main-category="${esc(key)}" type="number" min="0" max="720" step="5" value="${Number(result.draft_main_minutes_by_category?.[key] ?? 0)}"></label>`)
      .join('');
    $('#task-title-fields').innerHTML = Object.entries(categories).map(([key, label]) => `<label>${esc(label)}<input data-category="${esc(key)}" value="${esc(result.task_titles?.[key] || label)}"></label>`).join('');
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
    const task_titles = Object.fromEntries($$('#task-title-fields input[data-category]').map(input => [input.dataset.category, input.value]));
    const draft_main_minutes_by_category = Object.fromEntries($$('[data-draft-main-category]').map(input => [input.dataset.draftMainCategory, Number(input.value || 0)]));
    try {
      settingsState = await api('/api/settings', {method:'PUT', body:JSON.stringify({
        current_stage:event.target.current_stage.value,
        ai_project_weekly_frequency:Number(event.target.ai_project_weekly_frequency.value),
        rehab_enabled:event.target.rehab_enabled.checked,
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
