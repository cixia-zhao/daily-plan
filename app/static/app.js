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

async function resetDailyDataFor(dateValue) {
  if (!dateValue) return null;
  const confirmed = await confirmAction(
    `确认清空 ${dateValue} 的计划、完成情况和复盘吗？这会让单日和七日复盘中的该日数据一起消失。`
  );
  if (!confirmed) return null;
  return api(`/api/daily-data/${dateValue}`, {method:'DELETE'});
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

function formatMinutes(value) {
  return `${Number(value || 0)} 分`;
}

function toDateTimeInputValue(value) {
  if (!value) return '';
  return String(value).slice(0, 16);
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
      Number(board.bar_total_minutes || 0),
      Number(board.total_minutes || 0),
      Number(board.interrupt_minutes || 0),
      1,
    );
    return `
      <article class="execution-board-card">
        <div class="execution-board-head">
          <div>
            <h3>${esc(board.task_title)}</h3>
            <p class="muted">${esc(settings?.task_titles?.[board.category] || board.category)}</p>
          </div>
          <strong>${formatMinutes(board.total_minutes)}</strong>
        </div>
        <div class="execution-board-stats">
          <span>有效 ${formatMinutes(board.effective_minutes)}</span>
          <span>计总标签 ${formatMinutes(board.counted_label_minutes)}</span>
          <span>中断 ${formatMinutes(board.interrupt_minutes)}</span>
        </div>
        <div class="execution-bar" aria-hidden="true">
          <span class="execution-bar-effective" style="width:${taskBoardRatio(board.effective_minutes, barBase)}%"></span>
          <span class="execution-bar-counted" style="width:${taskBoardRatio(board.counted_label_minutes, barBase)}%"></span>
          <span class="execution-bar-interrupt" style="width:${taskBoardRatio(board.interrupt_minutes, barBase)}%"></span>
        </div>
        <div class="execution-board-lists">
          <div>
            <h4>计总标签</h4>
            ${board.counted_labels?.length
              ? `<ul>${board.counted_labels.map(label => `<li>${esc(label.label_name)} · ${formatMinutes(label.minutes)} · ${label.count} 次</li>`).join('')}</ul>`
              : '<p class="muted">还没有计总标签记录</p>'}
          </div>
          <div>
            <h4>中断标签</h4>
            ${board.interrupt_labels?.length
              ? `<ul>${board.interrupt_labels.map(label => `<li>${esc(label.label_name)} · ${formatMinutes(label.minutes)} · ${label.count} 次</li>`).join('')}</ul>`
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
      closeCalendar();
      await calendarState.onSelect(nextDate);
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
    summary.textContent = `可用 ${currentPlan.available_minutes} 分 / 当前计划 ${currentEstimatedMinutes()} 分`;
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
      is_sub: task.is_sub ? 1 : 0,
      sub_category: task.sub_category || null,
    }));
  }

  function renderSubmitButton(plan) {
    const button = $('#submit-today');
    const badge = $('#plan-status');
    if (plan.status === 'draft') {
      button.classList.add('hidden');
      badge.className = 'status';
      badge.textContent = '草稿';
    } else if (plan.status === 'approved') {
      button.className = 'primary btn-submit';
      button.disabled = false;
      button.textContent = '进入执行台';
      badge.classList.add('hidden');
    } else {
      button.className = 'secondary btn-submit submitted';
      button.disabled = false;
      button.textContent = '查看执行台';
      badge.classList.add('hidden');
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
      <button type="button" class="route-target hidden" data-id="${task.id}">与此项交换</button>
      ${coreLocked ? '' : '<button type="button" class="delete-task" aria-label="删除任务">×</button>'}
    </div>`;
  }

  function renderTask(task, index, routeLength) {
    const approved = currentPlan.status !== 'draft';
    const isSub = Boolean(task.is_sub);
    const zeroMinuteMain = approved && !isSub && Number(task.estimated_minutes) === 0;
    const lead = isSub
      ? '<span class="task-bullet">•</span>'
      : zeroMinuteMain
        ? '<span class="task-index" aria-hidden="true">—</span>'
        : approved
        ? `<input class="task-check" type="checkbox" ${task.completed ? 'checked' : ''} aria-label="完成任务">`
        : `<span class="task-index">${index + 1}</span>`;
    let timeBlock;
    if (!approved) {
      timeBlock = isSub
        ? '<span class="execution-locked">确认后记录实际时间</span>'
        : `<label class="minutes-label"><input class="minutes-input" type="number" min="5" value="${task.estimated_minutes}"> 分钟</label>`;
    } else if (isSub) {
      timeBlock = `<label class="actual-minutes-label">实际 <input class="actual-minutes-input" type="number" min="0" value="${task.actual_minutes || 0}"> 分钟</label>`;
    } else if (zeroMinuteMain) {
      timeBlock = '<span>计划 0 分钟</span><span class="execution-locked">今天无需打勾或记录时间</span>';
    } else {
      timeBlock = `<span>计划 ${task.estimated_minutes} 分钟</span><span class="actual-minutes-readonly">有效 ${task.actual_minutes || 0} 分</span>`;
    }
    return `<article class="task-card ${task.completed ? 'completed' : ''}" data-task-id="${task.id}" data-category="${esc(task.category)}">
      ${lead}
      <div class="task-content">
        <div class="task-title-row">
          <input class="title-input" type="text" value="${esc(task.title)}" ${approved ? 'readonly' : ''}>
          ${subCategoryTabs(task)}
        </div>
        <div class="task-meta"><span>${esc(taskTitle(task))}</span>${timeBlock}</div>
        ${isSub ? '' : `<input class="criteria-input" type="text" value="${esc(task.completion_criteria)}" ${approved ? 'readonly' : ''} placeholder="完成标准">`}
      </div>
      ${taskControls(task, index, routeLength)}
    </article>`;
  }

  function renderPlaceholder(isSub, paused=false) {
    if (paused) {
      return `<article class="route-placeholder paused-route" aria-label="今日暂停运动">
        <span class="task-index">4</span><div><strong>运动已暂停</strong><small>今天记录了膝盖异常，不计入任务和统计。</small></div>
      </article>`;
    }
    return `<article class="route-placeholder" data-route="${isSub ? 'sub' : 'main'}">
      <button type="button" class="placeholder-target" disabled>空位</button>
    </article>`;
  }

  function renderRoute(list, tasks, isSub) {
    const showPaused = !isSub && currentPlan.safety_notice && !tasks.some(task => task.category === 'rehab');
    const slots = tasks.map((task, index) => renderTask(task, index, tasks.length));
    if (showPaused && slots.length < ROUTE_SLOT_COUNT) slots.push(renderPlaceholder(false, true));
    while (slots.length < ROUTE_SLOT_COUNT) slots.push(renderPlaceholder(isSub));
    list.innerHTML = slots.join('');
  }

  function renderPlan(plan) {
    currentPlan = plan;
    swapSourceId = null;
    $('#plan-section').classList.remove('hidden');
    renderSubmitButton(plan);
    $('#plan-title').textContent = plan.status === 'draft' ? '任务草稿' : '今天就走这条航线';
    $('#draft-actions').classList.toggle('hidden', plan.status !== 'draft');
    $('#safety-notice').classList.toggle('hidden', !plan.safety_notice);
    $('#safety-notice').textContent = plan.safety_notice || '';
    $('#degraded-notice').classList.toggle('hidden', !plan.degraded_reason);
    $('#method-list').innerHTML = plan.methods.map(method => `<li>${esc(method)}</li>`).join('');

    const mainTasks = plan.tasks.filter(task => !task.is_sub);
    const subTasks = plan.tasks.filter(task => task.is_sub);
    renderRoute($('#main-route-list'), mainTasks, false);
    renderRoute($('#sub-route-list'), subTasks, true);
    bindTaskEvents();
    updateTimeSummary();
  }

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
        $('.actual-minutes-input', card).value = updated.actual_minutes || 0;
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

  const updateAvailableMinutes = () => {
    if (!settings) return;
    const energy = $('input[name=energy]:checked').value;
    const budget = settings[`budget_${energy}`] || {minimum:90, normal:150, ample:210}[energy];
    const select = $('#available-minutes');
    if (![...select.options].some(option => Number(option.value) === budget)) {
      const option = document.createElement('option');
      option.value = budget;
      option.textContent = `约 ${(budget / 60).toFixed(1)} 小时 (${budget} 分)`;
      select.appendChild(option);
    }
    select.value = budget;
  };

  async function loadCarryovers() {
    carryoverItems = await api('/api/carryovers');
    renderCarryoverPopover();
  }

  async function loadPlanForDate() {
    cancelSwap();
    currentPlan = null;
    $('#plan-section').classList.add('hidden');
    $('#time-summary').classList.add('hidden');
    updateTimeSummary();
    try {
      renderPlan(await api(`/api/daily-plans/${dateInput.value}`));
    } catch (error) {
      if (error.message !== '计划不存在') toast(error.message);
    }
  }

  $('#reset-day').onclick = async () => {
    try {
      const result = await resetDailyDataFor(dateInput.value);
      if (!result) return;
      invalidateCalendarMonth(dateInput.value);
      cancelSwap();
      currentPlan = null;
      $('#plan-section').classList.add('hidden');
      $('#time-summary').classList.add('hidden');
      await loadCarryovers();
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
    submit.disabled = true;
    submit.firstElementChild.textContent = '正在生成…';
    try {
      const plan = await api('/api/daily-plans/draft', {method:'POST', body:JSON.stringify({
        date:dateInput.value,
        energy:$('input[name=energy]:checked').value,
        available_minutes:Number($('#available-minutes').value),
        day_type:$('#day-type').value,
        knee_alert:$('#knee-alert').checked,
      })});
      invalidateCalendarMonth(dateInput.value);
      renderPlan(plan);
      await loadCarryovers();
      $('#plan-section').scrollIntoView({behavior:'smooth'});
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
    try {
      await api(`/api/daily-plans/${dateInput.value}`, {method:'PUT', body:JSON.stringify({tasks:taskPayload()})});
      renderPlan(await api(`/api/daily-plans/${dateInput.value}/approve`, {method:'POST'}));
      invalidateCalendarMonth(dateInput.value);
      toast('今日清单已确认');
    } catch (error) { toast(error.message); }
  };
  $('#submit-today').onclick = async () => {
    window.location.href = `/execute?date=${encodeURIComponent(dateInput.value)}`;
  };
  document.addEventListener('keydown', event => { if (event.key === 'Escape') cancelSwap(); });

  loadCarryovers();
  api('/api/settings').then(result => {
    settings = result;
    $$('input[name=energy]').forEach(radio => radio.addEventListener('change', updateAvailableMinutes));
    updateAvailableMinutes();
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
  function defaultExecutionUiState() {
    return {
      collapsedZeroMain: true,
      collapsedSub: true,
      expandedLabelBucket: null,
      collapsedTimeline: true,
      collapsedZeroMinuteSubmit: true,
    };
  }
  let executionUiState = defaultExecutionUiState();
  dateInput.value = selectedFromQuery || todayIso();
  updateDateTrigger(dateButton, dateInput.value);

  function selectedExecutionTask() {
    if (!executionState?.tasks?.length) return null;
    return executionState.tasks.find(task => String(task.id) === String(selectedTaskId)) || executionState.tasks[0];
  }

  function labelOptionsForKind(kind, selectedId='') {
    if (kind === 'effective') return '';
    const bucket = kind === 'counted_label' ? 'counted' : 'interrupt';
    return (executionState?.labels || [])
      .filter(label => label.bucket === bucket)
      .map(label => `<option value="${esc(label.id)}" ${label.id === selectedId ? 'selected' : ''}>${esc(label.name)}</option>`)
      .join('');
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

  async function startEffectiveTask(taskId, successMessage='已开始记录有效时间') {
    selectedTaskId = taskId;
    executionUiState.expandedLabelBucket = null;
    executionState = await api(`/api/daily-execution/${dateInput.value}/tasks/start`, {method:'POST', body:JSON.stringify({task_id:taskId})});
    renderExecutionState(executionState);
    toast(successMessage);
  }

  function segmentEditorHtml(segment, isDraft=false) {
    const taskOptions = (executionState?.tasks || [])
      .map(task => `<option value="${task.id}" ${String(task.id) === String(segment.task_id) ? 'selected' : ''}>${esc(task.title)}</option>`)
      .join('');
    const labelFieldHidden = segment.segment_kind === 'effective' ? 'hidden' : '';
    return `
      <article class="timeline-card ${isDraft ? 'draft' : ''}" data-segment-id="${segment.id}">
        <div class="timeline-form">
          <label>开始<input class="segment-start" type="datetime-local" value="${toDateTimeInputValue(segment.started_at)}"></label>
          <label>结束<input class="segment-end" type="datetime-local" value="${toDateTimeInputValue(segment.ended_at)}"></label>
          <label>任务<select class="segment-task-id">${taskOptions}</select></label>
          <label>类型<select class="segment-kind">
            <option value="effective" ${segment.segment_kind === 'effective' ? 'selected' : ''}>有效时间</option>
            <option value="counted_label" ${segment.segment_kind === 'counted_label' ? 'selected' : ''}>计总标签</option>
            <option value="interrupt_label" ${segment.segment_kind === 'interrupt_label' ? 'selected' : ''}>中断标签</option>
          </select></label>
          <label class="segment-label-field ${labelFieldHidden}">标签
            <select class="segment-label-id">${labelOptionsForKind(segment.segment_kind, segment.label_id || '')}</select>
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
              <p class="muted">${segment.segment_kind === 'effective' ? '有效时间' : esc(segment.label_name || '标签')} · 已累计 ${formatMinutes(segment.minutes)}</p>
              <p class="muted">${segment.started_at.replace('T', ' ')}</p>
            </div>
            <div class="timeline-actions"><button class="ghost-button active-segment-stop" type="button">停止</button></div>
          </article>
        `;
      }
      return segmentEditorHtml(segment);
    }));
    list.innerHTML = rows.length ? rows.join('') : '<p class="muted">还没有任何执行记录，先开始一段任务有效时间。</p>';

    $$('.segment-kind', list).forEach(select => select.onchange = event => {
      const row = event.target.closest('.timeline-card');
      const field = $('.segment-label-field', row);
      const labelSelect = $('.segment-label-id', row);
      if (event.target.value === 'effective') {
        field.classList.add('hidden');
        labelSelect.innerHTML = '';
      } else {
        field.classList.remove('hidden');
        labelSelect.innerHTML = labelOptionsForKind(event.target.value);
      }
    });

    $$('.segment-save', list).forEach(button => button.onclick = async () => {
      const row = button.closest('.timeline-card');
      const body = {
        task_id: Number($('.segment-task-id', row).value),
        segment_kind: $('.segment-kind', row).value,
        label_id: $('.segment-kind', row).value === 'effective' ? null : $('.segment-label-id', row).value,
        started_at: fromDateTimeInputValue($('.segment-start', row).value),
        ended_at: fromDateTimeInputValue($('.segment-end', row).value),
      };
      try {
        executionState = row.dataset.segmentId === 'draft'
          ? await api(`/api/daily-execution/${dateInput.value}/segments`, {method:'POST', body:JSON.stringify(body)})
          : await api(`/api/daily-execution/${dateInput.value}/segments/${row.dataset.segmentId}`, {method:'PUT', body:JSON.stringify(body)});
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
        executionState = await api(`/api/daily-execution/${dateInput.value}/segments/${row.dataset.segmentId}`, {method:'DELETE'});
        renderExecutionState(executionState);
        toast('时间段已删除');
      } catch (error) { toast(error.message); }
    });

    $$('.active-segment-stop', list).forEach(button => button.onclick = async () => {
      try {
        executionState = await api(`/api/daily-execution/${dateInput.value}/stop`, {method:'POST'});
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
    const active = executionState?.active_segment?.task_id === task.id;
    const selected = selectedExecutionTask();
    const selectedClass = selected && String(selected.id) === String(task.id) ? 'selected' : '';
    const disabled = Number(task.estimated_minutes) === 0 ? 'disabled' : '';
    return `
      <article class="execution-task-card ${selectedClass} ${active ? 'active' : ''}" data-execution-task-id="${task.id}">
        <div class="execution-task-head">
          <div>
            <h3>${esc(task.title)}</h3>
            <p class="muted">${esc(settings?.task_titles?.[task.category] || task.category)}</p>
          </div>
          <button class="primary task-start-button" type="button" ${disabled}>开始有效时间</button>
        </div>
        <div class="execution-task-meta">
          <span>计划 ${task.estimated_minutes} 分</span>
          <span>有效 ${task.actual_minutes || 0} 分</span>
          <span>总计 ${board ? formatMinutes(board.total_minutes) : '0 分'}</span>
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

  function bindExecutionTaskCardEvents(root=document) {
    $$('.execution-task-card', root).forEach(card => card.onclick = event => {
      if (event.target.closest('.task-start-button')) return;
      selectedTaskId = Number(card.dataset.executionTaskId);
      renderExecutionState(executionState);
    });
    $$('.task-start-button', root).forEach(button => button.onclick = async event => {
      event.stopPropagation();
      const taskId = Number(button.closest('.execution-task-card').dataset.executionTaskId);
      try {
        await startEffectiveTask(taskId);
      } catch (error) { toast(error.message); }
    });
  }

  function executionSubmitCardHtml(task) {
    const canComplete = !task.is_sub && (Number(task.estimated_minutes) > 0 || Number(task.actual_minutes || 0) > 0);
    const disabled = !canComplete ? 'disabled' : '';
    const summary = task.is_sub
      ? `有效 ${task.actual_minutes || 0} 分 · ${task.completed ? '已完成' : '未完成'}`
      : `计划 ${task.estimated_minutes} 分 · 有效 ${task.actual_minutes || 0} 分`;
    return `
      <article class="task-card ${task.completed ? 'completed' : ''}" data-submit-task-id="${task.id}">
        <input class="task-check execute-submit-check" type="checkbox" ${task.completed ? 'checked' : ''} ${disabled} aria-label="完成任务">
        <div class="task-content">
          <div class="task-title-row"><strong>${esc(task.title)}</strong></div>
          <div class="task-meta"><span>${esc(settings?.task_titles?.[task.category] || task.category)}</span><span>${summary}</span></div>
        </div>
      </article>
    `;
  }

  function bindExecutionSubmitEvents(root) {
    $$('.execute-submit-check', root).forEach(checkbox => checkbox.onchange = async () => {
      const card = checkbox.closest('[data-submit-task-id]');
      try {
        const updated = await api(`/api/tasks/${card.dataset.submitTaskId}`, {method:'PATCH', body:JSON.stringify({completed:checkbox.checked})});
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
        '今日暂不执行主航线',
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
    `).join('');
    $$('.execution-label-button', root).forEach(button => button.onclick = async () => {
      const task = selectedExecutionTask();
      try {
        executionState = await api(`/api/daily-execution/${dateInput.value}/labels/start`, {
          method:'POST',
          body:JSON.stringify({label_id:button.dataset.labelId, task_id:task?.id || null}),
        });
        executionUiState.expandedLabelBucket = null;
        renderExecutionState(executionState);
        toast(`已切到${button.textContent}`);
      } catch (error) { toast(error.message); }
    });
  }

  function renderExecutionLabels() {
    renderExecutionLabelButtons('counted', '#counted-label-list');
    renderExecutionLabelButtons('interrupt', '#interrupt-label-list');
  }

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
        await startEffectiveTask(active.task_id, '已切回有效时间');
      } catch (error) { toast(error.message); }
    };
  }

  function renderExecutionState(result) {
    executionState = result;
    if (!selectedTaskId && result?.tasks?.length) selectedTaskId = result.active_segment?.task_id || result.tasks[0].id;
    $('#execute-stop').disabled = !result?.active_segment;
    const emptyPanel = $('#execute-empty-state');
    const emptyMessage = $('#execute-empty-message');
    const runnable = result?.plan && ['approved', 'submitted'].includes(result.plan.status);
    $('#execute-panel').classList.toggle('hidden', !runnable);
    $('#timeline-panel').classList.toggle('hidden', !runnable);
    $('#execute-submit-panel').classList.toggle('hidden', !runnable);
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
    $('#execute-active-badge').textContent = !active
      ? '当前空闲'
      : active.segment_kind === 'effective'
        ? `正在做：${active.task_title}`
        : `正在切到：${active.task_title} / ${active.label_name}`;
    renderExecutionTasks();
    renderExecutionLabels();
    renderExecutionToolbar();
    renderTaskExecutionBoard($('#execute-task-board'), result.task_execution_board, '<p class="muted">开始记录后，这里会出现每个任务的时间结构。</p>');
    renderTimelineSection();
    renderExecutionSubmitList();
  }

  async function loadExecution() {
    try {
      renderExecutionState(await api(`/api/daily-execution/${dateInput.value}`));
    } catch (error) { toast(error.message); }
  }

  $('#execute-stop').onclick = async () => {
    try {
      executionState = await api(`/api/daily-execution/${dateInput.value}/stop`, {method:'POST'});
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

  $('#execute-submit').onclick = async () => {
    try {
      executionState.plan = await api(`/api/daily-plans/${dateInput.value}/submit`, {method:'POST'});
      await loadExecution();
      invalidateCalendarMonth(dateInput.value);
      toast('今日数据已成功提交到复盘页');
    } catch (error) { toast(error.message); }
  };

  api('/api/settings').then(result => {
    settings = result;
    bindSharedCalendarTrigger(dateButton, () => dateInput.value, async nextDate => {
      dateInput.value = nextDate;
      selectedTaskId = null;
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

if (page === 'review') {
  const dateInput = $('#review-date');
  const dateButton = $('#review-date-button');
  const form = $('#daily-review-form');
  let reviewState = null;
  dateInput.value = todayIso();
  updateDateTrigger(dateButton, dateInput.value);

  function renderDailyReview(result) {
    reviewState = result;
    $('#daily-status').textContent = result.status_label;
    $('#daily-status-note').textContent = result.status ? '来自当日计划' : '还没有当天计划';
    $('#daily-completed').textContent = `${result.main_completed_count} / ${result.main_task_count}`;
    $('#daily-total').textContent = `共 ${result.main_task_count} 项主任务`;
    $('#daily-main-minutes').textContent = `${result.main_planned_minutes} 分`;
    $('#daily-main-actual').textContent = `实际 ${result.main_actual_minutes} 分`;
    $('#daily-sub-minutes').textContent = `${result.sub_actual_minutes} 分`;
    form.mood.value = result.review.mood;
    form.hardest_point.value = result.review.hardest_point;
    form.effective_method.value = result.review.effective_method;
    form.optimization_note.value = result.review.optimization_note;
    form.real_progress.value = result.review.real_progress;
    form.tomorrow_focus.value = result.review.tomorrow_focus;
    form.reflection_text.value = result.review.reflection_text;
    $('#daily-gpt-response').value = result.gpt_record?.response_text || '';
    $('#daily-gpt-adopted').value = result.gpt_record?.adopted_text || '';
    $('#daily-execution-board-empty').classList.toggle('hidden', Boolean(result.task_execution_board?.length));
    $('#daily-execution-board').classList.toggle('hidden', !result.task_execution_board?.length);
    renderTaskExecutionBoard($('#daily-execution-board'), result.task_execution_board, '');
  }

  async function loadDailyReview() {
    try {
      renderDailyReview(await api(`/api/daily-review/${dateInput.value}`));
    } catch (error) { toast(error.message); }
  }

  $('#copy-daily-gpt-prompt').onclick = async () => {
    try {
      if (!reviewState?.gpt_prompt_text) throw new Error('当前还没有可复制的单日提示词');
      await navigator.clipboard.writeText(reviewState.gpt_prompt_text);
      toast('已复制到剪贴板，直接粘到 ChatGPT 就行');
    } catch (error) { toast(error.message); }
  };

  $('#save-daily-gpt-record').onclick = async () => {
    try {
      const saved = await api(`/api/daily-review/${dateInput.value}/gpt-record`, {
        method:'PUT',
        body:JSON.stringify({
          response_text: $('#daily-gpt-response').value,
          adopted_text: $('#daily-gpt-adopted').value,
        }),
      });
      reviewState = reviewState ? {...reviewState, gpt_record: saved} : reviewState;
      toast('这次 GPT 协作已保存');
    } catch (error) { toast(error.message); }
  };

  $('#reset-day').onclick = async () => {
    try {
      const result = await resetDailyDataFor(dateInput.value);
      if (!result) return;
      invalidateCalendarMonth(dateInput.value);
      await loadDailyReview();
      toast(result.message);
    } catch (error) { toast(error.message); }
  };

  form.onsubmit = async event => {
    event.preventDefault();
    try {
      await api('/api/daily-reviews', {method:'POST', body:JSON.stringify({date:dateInput.value, ...Object.fromEntries(new FormData(event.target))})});
      invalidateCalendarMonth(dateInput.value);
      await loadDailyReview();
      toast('复盘已保存');
    } catch (error) { toast(error.message); }
  };

  bindSharedCalendarTrigger(dateButton, () => dateInput.value, async nextDate => {
    dateInput.value = nextDate;
    updateDateTrigger(dateButton, nextDate);
    await loadDailyReview();
  }, '选择单日复盘日期');
  loadDailyReview();
}

if (page === 'weekly') {
  let selectedEndDate = todayIso();
  let selectedAnchorDate = todayIso();
  let weeklyState = null;
  let selectedReviewDate = null;
  const weeklyDateInput = $('#weekly-anchor-date');
  const weeklyDateButton = $('#weekly-date-button');
  weeklyDateInput.value = selectedAnchorDate;
  updateDateTrigger(weeklyDateButton, selectedAnchorDate);

  function renderWeeklyMetrics(result) {
    $('#metric-rate').textContent = `${Math.round(result.completion_rate * 100)}%`;
    $('#metric-completed').innerHTML = `<div>${result.completed_count}项 (主)</div><div style="font-size:16px;color:var(--muted)">${result.completed_sub_count || 0}项 (副)</div>`;
    $('#metric-total').textContent = `共 ${result.task_count} 项主任务`;
    $('#metric-time').innerHTML = `<div>${result.actual_minutes}分 (主)</div><div style="font-size:16px;color:var(--muted)">${result.actual_sub_minutes || 0}分 (副)</div>`;
    $('#metric-planned').textContent = `主计划 ${result.planned_minutes} 分`;
    $('#metric-days').textContent = result.review_days;
  }

  function renderWeeklyAnalysis(result) {
    const analysis = result.analysis || {};
    $('#weekly-title-text').textContent = analysis.summary_title || '本周摘要';
    $('#weekly-title-range').textContent = `${result.start_date} - ${result.end_date}`;
    $('#weekly-status-note').textContent = result.ai_status === 'ready'
      ? '系统已经先整理出一版基础摘要，你可以继续复制给 ChatGPT 深聊。'
      : '系统先把本周事实整理好，接下来更适合复制给 ChatGPT 一起往下聊。';
    $('#weekly-load-advice').textContent = analysis.load_advice || '先看真实完成情况，再决定下周是否调量。';
    $('#weekly-drag-factors').textContent = analysis.drag_factors || '这里暂时没有自动摘要时，可以直接依赖 GPT 协作区往下聊。';
    $('#weekly-effective-patterns').textContent = analysis.effective_patterns || '等你把更多事实喂给 GPT 后，再一起提炼有效模式。';
    $('#weekly-real-progress').textContent = analysis.real_progress_assessment || '先不要急着评价好坏，先把这一周真实发生了什么说清楚。';
    $('#weekly-next-focus').textContent = analysis.next_week_focus || '先保留判断，把重点交给本页的 GPT 协作区继续整理。';
    $('#weekly-final-report').value = result.final_report_text || [
      analysis.summary_title,
      analysis.load_advice && `调量建议：${analysis.load_advice}`,
      analysis.drag_factors && `主要拖累因素：${analysis.drag_factors}`,
      analysis.effective_patterns && `有效模式：${analysis.effective_patterns}`,
      analysis.real_progress_assessment && `真实推进判断：${analysis.real_progress_assessment}`,
      analysis.next_week_focus && `下周聚焦点：${analysis.next_week_focus}`,
    ].filter(Boolean).join('\n\n');
    $('#weekly-gpt-response').value = result.gpt_record?.response_text || '';
    $('#weekly-gpt-adopted').value = result.gpt_record?.adopted_text || '';
  }

  function renderWeeklyProgress(result) {
    const progress = result.weekday_progress;
    $('#weekly-progress-summary').textContent = `本周已记录 ${progress.saved_count} / ${progress.total} 天`;
    $('#weekly-progress-fill').style.width = `${progress.progress_ratio * 100}%`;
    $('#weekly-progress-days').innerHTML = progress.days.map(day => {
      const classes = ['weekly-day-node'];
      if (day.has_review) classes.push('has-review');
      if (day.is_future) classes.push('is-future');
      if (!day.is_clickable) classes.push('is-disabled');
      if (selectedReviewDate === day.date) classes.push('is-active');
      return `<button type="button" class="${classes.join(' ')}" data-date="${day.date}" ${day.is_clickable ? '' : 'disabled'}>
        <span class="weekly-day-dot"></span>
        <span class="weekly-day-label">${day.label}</span>
      </button>`;
    }).join('');
    $$('.weekly-day-node').forEach(button => button.onclick = async () => {
      const targetDate = button.dataset.date;
      if (!targetDate) return;
      try {
        const result = await api(`/api/daily-review/${targetDate}`);
        selectedReviewDate = targetDate;
        renderInlineReview(result);
        renderWeeklyProgress(weeklyState);
      } catch (error) { toast(error.message); }
    });
  }

  function renderInlineReview(result) {
    const form = $('#weekly-inline-review-form');
    const hasContent = reviewHasContent(result.review);
    if (result.date) selectedReviewDate = result.date;
    $('#weekly-day-review-title').textContent = hasContent ? `${result.date} 的复盘` : `${result.date || '这一天'} 还没有保存复盘`;
    form.mood.value = result.review.mood;
    form.real_progress.value = result.review.real_progress;
    form.hardest_point.value = result.review.hardest_point;
    form.effective_method.value = result.review.effective_method;
    form.optimization_note.value = result.review.optimization_note;
    form.tomorrow_focus.value = result.review.tomorrow_focus;
    form.reflection_text.value = result.review.reflection_text;
    $$('input, select, textarea, button', form).forEach(node => node.disabled = !hasContent);
    $('#save-inline-review').disabled = !hasContent;
  }

  function renderWeeklyHistory(items) {
    const container = $('#weekly-history');
    if (!items.length) {
      container.innerHTML = '<p class="muted">还没有历史周报。</p>';
      return;
    }
    container.innerHTML = items.map(item => `
      <button type="button" class="carryover weekly-history-item" data-end-date="${item.end_date}">
        <div><strong>${item.start_date} → ${item.end_date}</strong><small>基础摘要 ${item.has_ai_draft ? '已整理' : '未整理'} · 最终稿 ${item.has_final_report ? '已保存' : '未保存'}</small></div>
        <span class="muted">${item.updated_at || ''}</span>
      </button>
    `).join('');
    $$('.weekly-history-item').forEach(button => button.onclick = async () => {
      try {
        const report = await api(`/api/weekly-reports/${button.dataset.endDate}`);
        selectedEndDate = report.end_date;
        selectedAnchorDate = report.end_date;
        weeklyDateInput.value = selectedAnchorDate;
        updateDateTrigger(weeklyDateButton, selectedAnchorDate);
        weeklyState = weeklyState ? {...weeklyState, ...report, analysis: report.deepseek_analysis} : {...report, analysis: report.deepseek_analysis};
        renderWeeklyAnalysis(weeklyState);
        if (report.weekday_progress) {
          selectedReviewDate = report.weekday_progress.days.find(day => day.has_review)?.date || null;
          renderWeeklyProgress(report);
        }
      } catch (error) { toast(error.message); }
    });
  }

  async function loadWeeklyReview() {
    try {
      const result = await api(`/api/weekly-review?anchor_date=${selectedAnchorDate}`);
      weeklyState = result;
      selectedEndDate = result.end_date;
      weeklyDateInput.value = selectedAnchorDate;
      updateDateTrigger(weeklyDateButton, selectedAnchorDate);
      settings = await api('/api/settings');
      renderWeeklyMetrics(result);
      renderWeeklyAnalysis(result);
      if (!result.weekday_progress.days.some(day => day.date === selectedReviewDate)) {
        selectedReviewDate = result.weekday_progress.days.find(day => day.date === selectedAnchorDate)?.date
          || result.weekday_progress.days.find(day => day.has_review)?.date
          || result.weekday_progress.days[0]?.date
          || null;
      }
      renderWeeklyProgress(result);
      if (selectedReviewDate) renderInlineReview(await api(`/api/daily-review/${selectedReviewDate}`));
      else renderInlineReview({date:'', review:{mood:'',real_progress:'',hardest_point:'',effective_method:'',optimization_note:'',tomorrow_focus:'',reflection_text:''}});
      renderWeeklyHistory(result.history || []);
    } catch (error) { toast(error.message); }
  }

  $('#refresh-weekly-report').onclick = async () => {
    try {
      const report = await api(`/api/weekly-reports/${selectedEndDate}/refresh`, {method:'POST'});
      weeklyState = weeklyState ? {...weeklyState, ...report, analysis: report.deepseek_analysis, weekday_progress: report.weekday_progress} : {...report, analysis: report.deepseek_analysis, weekday_progress: report.weekday_progress};
      invalidateCalendarMonth(selectedEndDate);
      renderWeeklyAnalysis(weeklyState);
      renderWeeklyProgress(weeklyState);
      renderWeeklyHistory(await api('/api/weekly-reports'));
      toast('本周整理已刷新');
    } catch (error) { toast(error.message); }
  };

  $('#copy-chatgpt-prompt').onclick = async () => {
    try {
      if (!weeklyState?.gpt_prompt_text) throw new Error('当前还没有可复制的周整理提示词');
      await navigator.clipboard.writeText(weeklyState.gpt_prompt_text);
      toast('已复制到剪贴板，直接粘到 ChatGPT 就行');
    } catch (error) { toast(error.message); }
  };

  $('#save-weekly-gpt-record').onclick = async () => {
    try {
      const saved = await api(`/api/weekly-review/${selectedEndDate}/gpt-record`, {
        method:'PUT',
        body:JSON.stringify({
          response_text: $('#weekly-gpt-response').value,
          adopted_text: $('#weekly-gpt-adopted').value,
        }),
      });
      weeklyState = weeklyState ? {...weeklyState, gpt_record: saved} : weeklyState;
      toast('这次 GPT 协作已保存');
    } catch (error) { toast(error.message); }
  };

  $('#save-weekly-report').onclick = async () => {
    try {
      const saved = await api(`/api/weekly-reports/${selectedEndDate}`, {
        method:'PUT',
        body:JSON.stringify({final_report_text:$('#weekly-final-report').value}),
      });
      weeklyState = weeklyState ? {...weeklyState, ...saved, analysis: saved.deepseek_analysis} : {...saved, analysis: saved.deepseek_analysis};
      renderWeeklyHistory(await api('/api/weekly-reports'));
      toast('这周最终周报已保存');
    } catch (error) { toast(error.message); }
  };

  $('#weekly-inline-review-form').onsubmit = async event => {
    event.preventDefault();
    if (!selectedReviewDate) return;
    try {
      await api('/api/daily-reviews', {
        method:'POST',
        body:JSON.stringify({date:selectedReviewDate, ...Object.fromEntries(new FormData(event.target))}),
      });
      invalidateCalendarMonth(selectedReviewDate);
      const refreshed = await api('/api/daily-review/' + selectedReviewDate);
      renderInlineReview(refreshed);
      const nextWeekly = await api(`/api/weekly-review?anchor_date=${selectedAnchorDate}`);
      weeklyState = {...weeklyState, ...nextWeekly};
      renderWeeklyProgress(weeklyState);
      renderWeeklyMetrics(weeklyState);
      renderWeeklyAnalysis(weeklyState);
      toast('这一天的复盘已保存');
    } catch (error) { toast(error.message); }
  };

  bindSharedCalendarTrigger(weeklyDateButton, () => selectedAnchorDate, async nextDate => {
    selectedAnchorDate = nextDate;
    selectedReviewDate = nextDate;
    weeklyDateInput.value = nextDate;
    updateDateTrigger(weeklyDateButton, nextDate);
    await loadWeeklyReview();
  }, '选择七日复盘日期');

  loadWeeklyReview();
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
  let settingsState = null;

  function renderExecutionLabelFields() {
    $('#execution-label-fields').innerHTML = (settingsState?.execution_labels || []).map(label => `
      <div class="execution-label-row" data-label-id="${esc(label.id)}">
        <label>名称<input class="execution-label-name" value="${esc(label.name)}"></label>
        <label>归类
          <select class="execution-label-bucket" ${label.is_system ? 'disabled' : ''}>
            <option value="counted" ${label.bucket === 'counted' ? 'selected' : ''}>计总标签</option>
            <option value="interrupt" ${label.bucket === 'interrupt' ? 'selected' : ''}>中断标签</option>
          </select>
        </label>
        <span class="status">${label.is_system ? '系统默认' : '自定义'}</span>
        <button class="ghost-button execution-label-delete" type="button" ${label.is_system ? 'disabled' : ''}>删除</button>
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
      name: bucket === 'counted' ? '新计总标签' : '新中断标签',
      bucket,
      is_system: false,
    });
    renderExecutionLabelFields();
  }

  api('/api/settings').then(result => {
    settingsState = result;
    const form = $('#settings-form');
    form.current_stage.value = result.current_stage;
    form.ai_project_weekly_frequency.value = result.ai_project_weekly_frequency;
    form.rehab_enabled.checked = result.rehab_enabled;
    form.project_start_date.value = result.project_start_date || todayIso();
    form.budget_minimum.value = result.budget_minimum || 90;
    form.budget_normal.value = result.budget_normal || 150;
    form.budget_ample.value = result.budget_ample || 210;
    $('#task-title-fields').innerHTML = Object.entries(categories).map(([key, label]) => `<label>${esc(label)}<input data-category="${esc(key)}" value="${esc(result.task_titles?.[key] || label)}"></label>`).join('');
    renderExecutionLabelFields();
  });
  $('#add-counted-label').onclick = () => addExecutionLabel('counted');
  $('#add-interrupt-label').onclick = () => addExecutionLabel('interrupt');
  $('#settings-form').onsubmit = async event => {
    event.preventDefault();
    const task_titles = Object.fromEntries($$('[data-category]').map(input => [input.dataset.category, input.value]));
    try {
      settingsState = await api('/api/settings', {method:'PUT', body:JSON.stringify({
        current_stage:event.target.current_stage.value,
        ai_project_weekly_frequency:Number(event.target.ai_project_weekly_frequency.value),
        rehab_enabled:event.target.rehab_enabled.checked,
        project_start_date:event.target.project_start_date.value,
        budget_minimum:Number(event.target.budget_minimum.value),
        budget_normal:Number(event.target.budget_normal.value),
        budget_ample:Number(event.target.budget_ample.value),
        task_titles,
        execution_labels: settingsState.execution_labels,
      })});
      invalidateAllCalendarMonths();
      toast('设置已保存');
    } catch (error) { toast(error.message); }
  };
}
