/* 今天页：晨间目标录入、计划草稿微调、航线切换与内联纸面待审池。 */
if (page === 'today') {
  const ROUTE_SLOT_COUNT = 5;
  const SUB_CATEGORY_SHORT_LABELS = {
    计算机网络: '计网',
    操作系统: 'OS',
    计算机组成原理: '计组',
  };

  const dateInput = $('#plan-date');
  const dateButton = $('#plan-date-button');
  const carryoverButton = $('#carryover-button');
  const carryoverPopover = $('#carryover-popover');
  const carryoverClose = $('#carryover-close');
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
  let carryoverInlineState = null;
  let targetEditState = null;
  let targetEditBusy = false;

  function upcomingSundayIso(fromDate) {
    const anchor = new Date(`${fromDate}T12:00:00+08:00`);
    const offset = (7 - anchor.getDay()) % 7 || 7;
    return shiftDays(fromDate, offset);
  }

  function setTodayStage(stage) {
    const checkinStage = $('#today-checkin-stage');
    const reviewStage = $('#today-review-stage');
    const showingReview = stage === 'review';
    checkinStage.classList.toggle('hidden', showingReview);
    reviewStage.classList.toggle('hidden', !showingReview);
    document.body.classList.toggle('today-list-stage', showingReview);
    $('#today-page-header .plan-status-actions').classList.toggle('hidden', !showingReview);
    $('#today-page-header h1').textContent = showingReview
      ? (currentPlan?.status === 'draft' ? '安排今天' : '今天的清单')
      : (targetEditState ? '修改目标时长' : '今天的目标');
    const historical = dateInput.value !== todayIso();
    if (historical && !targetEditState) {
      $('#today-page-header h1').textContent = dateInput.value < todayIso() ? '历史计划' : '所选日期计划';
    }
    $('#reset-day').textContent = historical ? '重置此日' : '重置今天';
    if (showingReview) window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const taskById = id => currentPlan?.tasks.find(task => String(task.id) === String(id));

  function closeCarryoverPopover() {
    carryoverInlineState = null;
    carryoverPopover?.classList.add('hidden');
    carryoverPopover?.setAttribute('aria-hidden', 'true');
    carryoverButton?.setAttribute('aria-expanded', 'false');
  }

  function toggleCarryoverPopover(forceOpen) {
    if (!carryoverPopover || !carryoverButton) return;
    const shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : carryoverPopover.classList.contains('hidden');
    if (!shouldOpen) carryoverInlineState = null;
    carryoverPopover.classList.toggle('hidden', !shouldOpen);
    carryoverPopover.setAttribute('aria-hidden', String(!shouldOpen));
    carryoverButton.setAttribute('aria-expanded', String(shouldOpen));
  }

  function renderCarryoverInlineEditor(item) {
    if (!carryoverInlineState || Number(carryoverInlineState.id) !== Number(item.id)) return '';
    if (carryoverInlineState.mode === 'reschedule') {
      const today = todayIso();
      const tomorrow = shiftDays(today, 1);
      const sunday = upcomingSundayIso(today);
      const defaultDate = carryoverInlineState.value || dateInput.value || today;
      return `
        <div class="carryover-inline-editor" data-inline-mode="reschedule">
          <div class="carryover-quick-dates" role="group" aria-label="快捷重排日期">
            <button type="button" class="ghost-button carryover-quick-date" data-date="${today}">今天</button>
            <button type="button" class="ghost-button carryover-quick-date" data-date="${tomorrow}">明天</button>
            <button type="button" class="ghost-button carryover-quick-date" data-date="${sunday}">本周日</button>
          </div>
          <label>指定日期<input type="date" class="carryover-date-input" value="${esc(defaultDate)}" required></label>
          <div class="carryover-inline-actions">
            <button type="button" class="ghost-button carryover-inline-cancel">取消</button>
            <button type="button" class="primary carryover-inline-confirm">确认重排</button>
          </div>
        </div>
      `;
    }
    if (carryoverInlineState.mode === 'split') {
      return `
        <div class="carryover-inline-editor" data-inline-mode="split">
          <label>拆小后的任务名称<input type="text" class="carryover-split-input" maxlength="100" value="${esc(carryoverInlineState.value ?? item.title)}" placeholder="写一个今天能轻松起步的小步骤" required></label>
          <div class="carryover-inline-actions">
            <button type="button" class="ghost-button carryover-inline-cancel">取消</button>
            <button type="button" class="primary carryover-inline-confirm">确认拆小</button>
          </div>
        </div>
      `;
    }
    return '';
  }

  async function submitCarryoverResolution(id, payload) {
    try {
      await api(`/api/carryovers/${id}/resolve`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      carryoverInlineState = null;
      await loadCarryovers();
      if (payload.target_date === dateInput.value && currentPlan) {
        await loadPlanForDate();
      }
      toggleCarryoverPopover(true);
      toast('待审项已处理');
    } catch (error) {
      toast(error.message);
    }
  }

  function renderCarryoverPopover() {
    if (!carryoverList || !carryoverCount || !carryoverEmpty || !carryoverHint || !carryoverDot) return;
    const hasItems = carryoverItems.length > 0;
    carryoverCount.textContent = carryoverItems.length;
    carryoverDot.classList.toggle('hidden', !hasItems);
    carryoverEmpty.classList.toggle('hidden', hasItems);
    carryoverHint.classList.toggle('hidden', !hasItems);
    carryoverList.innerHTML = hasItems
      ? carryoverItems.map(item => `
        <div class="carryover" data-id="${Number(item.id)}">
          <div>
            <strong>${esc(item.title)}</strong>
            <small>${Number(item.estimated_minutes)} 分钟 · ${esc(categoryMeta(item.category).title)}</small>
          </div>
          <div class="carryover-actions">
            <button type="button" class="ghost-button" data-action="reschedule">重排</button>
            <button type="button" class="ghost-button" data-action="split">拆小</button>
            <button type="button" class="ghost-button" data-action="discard">放下</button>
          </div>
          ${renderCarryoverInlineEditor(item)}
        </div>
      `).join('')
      : '';

    $$('.carryover-actions button', carryoverPopover).forEach(button => {
      button.onclick = async event => {
        event.stopPropagation();
        const card = button.closest('.carryover');
        const id = Number(card.dataset.id);
        const item = carryoverItems.find(entry => Number(entry.id) === id);
        const action = button.dataset.action;
        if (action === 'discard') {
          await submitCarryoverResolution(id, { action: 'discard' });
          return;
        }
        if (carryoverInlineState?.id === id && carryoverInlineState?.mode === action) {
          carryoverInlineState = null;
          renderCarryoverPopover();
          return;
        }
        carryoverInlineState = {
          id,
          mode: action,
          value: action === 'reschedule' ? dateInput.value : (item?.title || ''),
        };
        renderCarryoverPopover();
        const input = $('.carryover-inline-editor input', $(`.carryover[data-id="${id}"]`, carryoverPopover));
        input?.focus();
        if (action === 'split') input?.select?.();
      };
    });

    $$('.carryover-quick-date', carryoverPopover).forEach(button => {
      button.onclick = event => {
        event.stopPropagation();
        const editor = button.closest('.carryover-inline-editor');
        const input = $('.carryover-date-input', editor);
        if (input) input.value = button.dataset.date;
      };
    });

    $$('.carryover-inline-cancel', carryoverPopover).forEach(button => {
      button.onclick = event => {
        event.stopPropagation();
        carryoverInlineState = null;
        renderCarryoverPopover();
      };
    });

    $$('.carryover-inline-confirm', carryoverPopover).forEach(button => {
      button.onclick = async event => {
        event.stopPropagation();
        const card = button.closest('.carryover');
        const id = Number(card.dataset.id);
        const editor = button.closest('.carryover-inline-editor');
        if (editor.dataset.inlineMode === 'reschedule') {
          const targetDate = $('.carryover-date-input', editor)?.value;
          if (!PlanUI.validDate(targetDate)) {
            toast('请选择有效的重排日期');
            return;
          }
          await submitCarryoverResolution(id, { action: 'reschedule', target_date: targetDate });
          return;
        }
        const splitTitle = $('.carryover-split-input', editor)?.value?.trim();
        if (!splitTitle) {
          toast('请填写拆小后的任务名称');
          $('.carryover-split-input', editor)?.focus();
          return;
        }
        await submitCarryoverResolution(id, { action: 'split', split_title: splitTitle });
      };
    });
  }

  if (carryoverClose) {
    carryoverClose.onclick = event => {
      event.stopPropagation();
      closeCarryoverPopover();
      carryoverButton?.focus({ preventScroll: true });
    };
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
        is_sub: Boolean(card.closest('#sub-route-list')),
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
    const values = categoryMeta(task.category).sub_categories || [];
    if (!values.length) return '';
    return `<div class="sub-category-tabs" data-task-id="${task.id}">${values.map(value =>
      `<button type="button" class="tab-btn ${task.sub_category === value ? 'active' : ''}" data-val="${esc(value)}">${esc(SUB_CATEGORY_SHORT_LABELS[value] || value)}</button>`
    ).join('')}</div>`;
  }

  function taskControls(task, index, routeLength) {
    if (currentPlan.status !== 'draft') return '';
    return `<div class="task-controls">
      <button type="button" class="ui-icon-button order-button move-up" ${index === 0 ? 'disabled' : ''} aria-label="上移" title="上移">${uiIcon('up')}</button>
      <button type="button" class="ui-icon-button order-button move-down" ${index === routeLength - 1 ? 'disabled' : ''} aria-label="下移" title="下移">${uiIcon('down')}</button>
      <button type="button" class="ghost-button route-swap-button" data-id="${task.id}">调整航线</button>
      <button type="button" class="ui-icon-button delete-task" aria-label="删除任务" title="删除任务">${uiIcon('close')}</button>
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
          : task.task_type === 'habit'
            ? `<span class="task-index">${habitStatusLabel(task.habit_status)}</span>`
            : `<input class="task-check" type="checkbox" ${task.completed ? 'checked' : ''} aria-label="完成任务">`;
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
      <div class="task-edit-heading"><h3>项目设置</h3><button type="button" class="ui-icon-button ui-icon-button-close task-edit-close" aria-label="完成并关闭" title="完成">${uiIcon('close')}</button></div>
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
    const previous = $('#plan-section').dataset.route;
    $('#plan-section').dataset.route = route;
    $$('.plan-route-tab').forEach(button => {
      const selected = button.dataset.route === route;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    PlanUI.indicator($('.plan-route-tabs'), '[aria-pressed=true]', '.plan-tab-indicator');
    if (previous && previous !== route) PlanUI.enter($('#plan-section .columns-layout'), route === 'sub' ? 1 : -1);
  }
  const planTabs = $('.plan-route-tabs');
  if (planTabs) {
    const line = document.createElement('span');
    line.className = 'plan-tab-indicator surface-tab-indicator';
    planTabs.append(line);
    new ResizeObserver(() => PlanUI.indicator(planTabs, '[aria-pressed=true]', '.plan-tab-indicator')).observe(planTabs);
  }
  $$('.plan-route-tab').forEach(button => { button.onclick = () => selectPlanRoute(button.dataset.route); });

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
    $$('.task-type-input').forEach(input => {
      input.onchange = () => {
        $('.task-kind-caption', input.closest('.task-card')).textContent = taskTypeLabel(input.value);
      };
    });
    $$('.task-edit-dialog').forEach(dialog => bindDialogBackdropClose(dialog));
    $$('.task-edit-open').forEach(button => {
      button.onclick = () => $('.task-edit-dialog', button.closest('.task-card')).showModal();
    });
    $$('.task-edit-close').forEach(button => {
      button.onclick = () => button.closest('dialog').close();
    });

    $$('.sub-category-tabs button').forEach(button => {
      button.onclick = async () => {
        const container = button.closest('.sub-category-tabs');
        const card = button.closest('.task-card');
        $$('button', container).forEach(item => item.classList.remove('active'));
        button.classList.add('active');
        if (currentPlan.status !== 'draft') {
          try {
            await api(`/api/tasks/${card.dataset.taskId}`, {
              method: 'PATCH',
              body: JSON.stringify({ sub_category: button.dataset.val }),
            });
            markPlanDirtyAfterSubmission();
          } catch (error) {
            toast(error.message);
          }
        }
      };
    });

    $$('.route-swap-button').forEach(button => { button.onclick = () => beginSwap(button.dataset.id); });
    $$('.route-target').forEach(button => {
      button.onclick = () => {
        const targetCard = button.closest('.task-card');
        completeSwap(targetCard.dataset.taskId, Boolean(targetCard.closest('#sub-route-list')));
      };
    });
    $$('.placeholder-target').forEach(button => {
      button.onclick = () => {
        completeSwap(null, button.closest('#sub-route-list') !== null);
      };
    });
    $$('.move-up').forEach(button => {
      button.onclick = () => moveWithinRoute(button.closest('.task-card').dataset.taskId, -1);
    });
    $$('.move-down').forEach(button => {
      button.onclick = () => moveWithinRoute(button.closest('.task-card').dataset.taskId, 1);
    });
    $$('.delete-task').forEach(button => {
      button.onclick = () => {
        syncDraftFromDom();
        const id = button.closest('.task-card').dataset.taskId;
        currentPlan.tasks = currentPlan.tasks.filter(task => String(task.id) !== String(id));
        renderPlan(currentPlan);
      };
    });
    $$('.minutes-input').forEach(input => { input.oninput = () => updateTimeSummary(); });

    $$('.task-check').forEach(checkbox => {
      checkbox.onchange = async () => {
        const card = checkbox.closest('.task-card');
        try {
          const updated = await api(`/api/tasks/${card.dataset.taskId}`, {
            method: 'PATCH',
            body: JSON.stringify({ completed: checkbox.checked }),
          });
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
      };
    });

    $$('.actual-minutes-input').forEach(input => {
      input.onchange = async () => {
        const card = input.closest('.task-card');
        try {
          const updated = await api(`/api/tasks/${card.dataset.taskId}`, {
            method: 'PATCH',
            body: JSON.stringify({ actual_minutes: Number(input.value) }),
          });
          card.classList.toggle('completed', updated.completed);
          const checkbox = $('.task-check', card);
          if (checkbox) checkbox.checked = updated.completed;
          Object.assign(taskById(card.dataset.taskId), updated);
          invalidateCalendarMonth(dateInput.value);
          markPlanDirtyAfterSubmission();
        } catch (error) {
          toast(error.message);
        }
      };
    });
  }

  let targetHistory = {};
  let targetHistorySequence = 0;
  let goalSuggestionInput = null;
  let goalSuggestionPanel = null;
  const boundGoalInputs = new WeakSet();

  function closeGoalSuggestions() {
    if (goalSuggestionInput) goalSuggestionInput.setAttribute('aria-expanded', 'false');
    goalSuggestionPanel?.remove();
    goalSuggestionPanel = null;
    goalSuggestionInput = null;
  }

  function positionGoalSuggestions() {
    if (!goalSuggestionInput?.isConnected || !goalSuggestionPanel) {
      closeGoalSuggestions();
      return;
    }
    const box = goalSuggestionInput.getBoundingClientRect();
    const viewport = window.visualViewport;
    const top = viewport?.offsetTop || 0;
    const left = viewport?.offsetLeft || 0;
    const width = viewport?.width || innerWidth;
    const height = viewport?.height || innerHeight;
    goalSuggestionPanel.style.width = `${Math.min(296, width - 24)}px`;
    goalSuggestionPanel.style.maxHeight = `${Math.max(80, Math.min(260, height - 24))}px`;
    const panelHeight = goalSuggestionPanel.getBoundingClientRect().height;
    goalSuggestionPanel.style.left = `${Math.max(left + 12, Math.min(box.left, left + width - goalSuggestionPanel.offsetWidth - 12))}px`;
    const submit = $('#checkin-form [type=submit]')?.getBoundingClientRect();
    const coversSubmit = submit && box.bottom + 6 < submit.bottom && box.bottom + panelHeight + 6 > submit.top;
    goalSuggestionPanel.style.top = `${box.bottom + panelHeight + 8 <= top + height - 12 && !coversSubmit ? box.bottom + 6 : Math.max(top + 12, box.top - panelHeight - 6)}px`;
  }

  function showGoalSuggestions(input) {
    if (input.disabled) return;
    closeGoalSuggestions();
    goalSuggestionInput = input;
    const category = input.dataset.targetCategory || input.dataset.goalCategory;
    const meta = categoryMeta(category);
    const common = meta.common_minutes?.length ? meta.common_minutes : [30, 60, 90, 120];
    const recent = (targetHistory[category] || []).filter(value => !common.includes(value));
    const group = (title, values) => values.length
      ? `<p>${title}</p><div class="target-suggestion-options">${values.map(value => `<button type="button" data-goal-minutes="${value}">${value}</button>`).join('')}</div>`
      : '';
    const panel = document.createElement('div');
    panel.id = 'target-suggestions';
    panel.className = 'target-suggestions';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', `${meta.title}目标分钟候选`);
    panel.innerHTML = group('常用分钟', common) + group('最近用过', recent);
    goalSuggestionPanel = panel;
    input.setAttribute('aria-controls', panel.id);
    input.setAttribute('aria-expanded', 'true');
    $$('button', panel).forEach(button => {
      button.onclick = () => {
        input.value = button.dataset.goalMinutes;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.focus({ preventScroll: true });
        closeGoalSuggestions();
      };
    });
    panel.onkeydown = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        input.focus({ preventScroll: true });
        closeGoalSuggestions();
      }
    };
    document.body.appendChild(panel);
    positionGoalSuggestions();
  }

  function bindGoalSuggestions(inputs) {
    inputs.forEach(input => {
      if (boundGoalInputs.has(input)) return;
      boundGoalInputs.add(input);
      input.step = '15';
      input.setAttribute('aria-haspopup', 'dialog');
      input.setAttribute('aria-expanded', 'false');
      input.addEventListener('focus', () => showGoalSuggestions(input));
      input.addEventListener('click', () => { if (goalSuggestionInput !== input) showGoalSuggestions(input); });
      input.addEventListener('input', () => input.setCustomValidity(''));
      input.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
          closeGoalSuggestions();
          return;
        }
        if (event.altKey && event.key === 'ArrowDown') {
          event.preventDefault();
          goalSuggestionPanel?.querySelector('button')?.focus();
          return;
        }
        if (['ArrowUp', 'ArrowDown'].includes(event.key)) {
          event.preventDefault();
          input.value = Math.max(0, Math.min(720, Number(input.value || 0) + (event.key === 'ArrowUp' ? 15 : -15)));
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
    });
  }

  async function loadTargetHistory() {
    const target = dateInput.value;
    const sequence = ++targetHistorySequence;
    targetHistory = {};
    closeGoalSuggestions();
    try {
      const result = await api(`/api/target-suggestions?before_date=${encodeURIComponent(target)}`);
      if (sequence === targetHistorySequence && target === dateInput.value) targetHistory = result.categories;
    } catch {
      /* 候选历史读取失败仍保留常用值与手动输入。 */
    }
  }

  document.addEventListener('pointerdown', event => {
    if (goalSuggestionPanel && !goalSuggestionPanel.contains(event.target) && event.target !== goalSuggestionInput) {
      closeGoalSuggestions();
    }
  });
  document.addEventListener('focusin', event => {
    if (goalSuggestionPanel && !goalSuggestionPanel.contains(event.target) && event.target !== goalSuggestionInput) {
      closeGoalSuggestions();
    }
  });
  window.addEventListener('resize', positionGoalSuggestions);
  window.addEventListener('scroll', positionGoalSuggestions, { capture: true, passive: true });
  window.visualViewport?.addEventListener('resize', positionGoalSuggestions);

  function validateMorningTargets() {
    for (const input of $$('[data-target-category]')) {
      input.setCustomValidity('');
      if (input.value === '' || !Number.isInteger(Number(input.value)) || Number(input.value) < 0 || Number(input.value) > 720) {
        input.setCustomValidity('请输入0～720的整数分钟。');
        input.reportValidity();
        return false;
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
      .map(category => ({
        category,
        title: categoryMeta(category).title,
        estimated_minutes: settings.draft_main_minutes_by_category?.[category] || 0,
      }));
    $('#morning-targets').innerHTML = fields.map(task => `<label><span class="target-field-label">${esc(task.title)}<small>分钟</small></span><input type="number" min="0" max="720" step="15" required aria-label="${esc(task.title)}目标分钟" data-target-category="${esc(task.category)}" ${task.id ? `data-target-task-id="${Number(task.id)}"` : ''} value="${Number(task.estimated_minutes)}"></label>`).join('');
    const update = () => {
      $('#morning-total').textContent = `计划合计 ${$$('[data-target-category]').reduce((sum, input) => sum + Number(input.value || 0), 0)} 分`;
    };
    $$('[data-target-category]').forEach(input => { input.oninput = update; });
    bindGoalSuggestions($$('[data-target-category]'));
    update();
  }

  function beginTargetEdit() {
    if (targetEditBusy || currentPlan?.status !== 'draft') return;
    closeGoalSuggestions();
    syncDraftFromDom();
    targetEditState = { date: dateInput.value, tasks: taskPayload() };
    configureTargetForm(true);
    renderMorningTargets(currentPlan.tasks.filter(task => !task.is_sub));
    setTodayStage('checkin');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    $('#checkin-title').tabIndex = -1;
    $('#checkin-title').focus({ preventScroll: true });
    window.PlanUI?.enter($('#today-checkin-stage'), -1);
  }

  function setTargetEditBusy(busy) {
    targetEditBusy = busy;
    $('#checkin-form').setAttribute('aria-busy', String(busy));
    $$('#checkin-form input, #checkin-form select, #checkin-form button').forEach(node => { node.disabled = busy; });
    [dateButton, $('#reset-day'), $('#restore-reset'), carryoverButton].forEach(node => {
      if (node) node.disabled = busy;
    });
  }

  async function saveTargetEdit() {
    if (targetEditBusy || !targetEditState) return;
    const edit = targetEditState;
    const minutes = new Map($$('[data-target-task-id]').map(input => [Number(input.dataset.targetTaskId), Number(input.value)]));
    const tasks = edit.tasks.map(task => (minutes.has(task.id) ? { ...task, estimated_minutes: minutes.get(task.id) } : task));
    closeGoalSuggestions();
    $('#target-edit-error').hidden = true;
    setTargetEditBusy(true);
    $('#checkin-submit > span').textContent = '正在保存…';
    try {
      const plan = await api(`/api/daily-plans/${edit.date}`, { method: 'PUT', body: JSON.stringify({ tasks }) });
      invalidateCalendarMonth(edit.date);
      renderPlan(plan);
      $('#adjust-checkin').focus({ preventScroll: true });
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
    $('#adjust-checkin').focus({ preventScroll: true });
    window.PlanUI?.enter($('#today-review-stage'));
  };

  async function loadCarryovers() {
    carryoverItems = await api('/api/carryovers');
    renderCarryoverPopover();
  }

  async function loadPlanForDate() {
    PlanUI.setDate(dateInput.value);
    history.replaceState(null, '', `/?date=${encodeURIComponent(dateInput.value)}`);
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
      if (error.status !== 404) toast(error.message);
    }
    await refreshResetRecovery(dateInput.value, async () => {
      await loadPlanForDate();
      await loadCarryovers();
    });
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
      await refreshResetRecovery(dateInput.value, async () => {
        await loadPlanForDate();
        await loadCarryovers();
      });
      toast(result.message);
    } catch (error) {
      toast(error.message);
    }
  };

  carryoverButton.onclick = event => {
    event.stopPropagation();
    toggleCarryoverPopover();
  };

  $('#checkin-form').onsubmit = async event => {
    event.preventDefault();
    if (targetEditBusy || !validateMorningTargets()) return;
    if (targetEditState) {
      await saveTargetEdit();
      return;
    }
    closeGoalSuggestions();
    const submit = event.submitter;
    if (currentPlan?.status === 'draft') {
      const confirmed = await confirmAction('重新生成会覆盖当前未确认草稿。', { title: '重新生成今天的草稿？', confirmLabel: '重新生成' });
      if (!confirmed) return;
    }
    submit.disabled = true;
    submit.firstElementChild.textContent = '正在生成…';
    try {
      const plan = await api('/api/daily-plans/draft', {
        method: 'POST',
        body: JSON.stringify({
          date: dateInput.value,
          energy: settings.show_energy_selector ? $('input[name=energy]:checked').value : 'normal',
          target_minutes: Object.fromEntries($$('[data-target-category]').map(input => [input.dataset.targetCategory, Number(input.value)])),
          day_type: settings.show_day_type_selector ? $('#day-type').value : 'normal',
        }),
      });
      invalidateCalendarMonth(dateInput.value);
      renderPlan(plan);
      await loadCarryovers();
    } catch (error) {
      toast(error.message);
    } finally {
      submit.disabled = false;
      submit.firstElementChild.textContent = '生成今天的草稿';
    }
  };

  $('#save-draft').onclick = async () => {
    try {
      renderPlan(await api(`/api/daily-plans/${dateInput.value}`, { method: 'PUT', body: JSON.stringify({ tasks: taskPayload() }) }));
      invalidateCalendarMonth(dateInput.value);
      toast('草稿已保存');
    } catch (error) {
      toast(error.message);
    }
  };

  $('#approve-plan').onclick = async () => {
    const button = $('#approve-plan');
    if (button.disabled) return;
    const targetDate = dateInput.value;
    button.disabled = true;
    $('#save-draft').disabled = true;
    try {
      await api(`/api/daily-plans/${targetDate}`, { method: 'PUT', body: JSON.stringify({ tasks: taskPayload() }) });
      await api(`/api/daily-plans/${targetDate}/approve`, { method: 'POST' });
      invalidateCalendarMonth(targetDate);
      window.location.href = `/execute?date=${encodeURIComponent(targetDate)}`;
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
      $('#save-draft').disabled = false;
    }
  };

  $('#adjust-checkin').onclick = beginTargetEdit;
  $('#open-execution-desk').onclick = () => {
    window.location.href = `/execute?date=${encodeURIComponent(dateInput.value)}`;
  };
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      cancelSwap();
      if (carryoverPopover && !carryoverPopover.classList.contains('hidden')) {
        closeCarryoverPopover();
        carryoverButton?.focus({ preventScroll: true });
      }
    }
  });

  ensureSettings()
    .then(async () => {
      renderMorningTargets();
      $('#morning-energy-field').hidden = !settings.show_energy_selector;
      $('#morning-day-type-field').hidden = !settings.show_day_type_selector;
      bindSharedCalendarTrigger(dateButton, () => dateInput.value, async nextDate => {
        if (targetEditBusy || nextDate === dateInput.value) return;
        if (targetEditState && $$('[data-target-task-id]').some(input => Number(input.value) !== targetEditState.tasks.find(task => task.id === Number(input.dataset.targetTaskId))?.estimated_minutes)) {
          if (!await confirmAction('尚未保存的目标时长会丢弃，原清单保持不变。', { title: '放弃修改并切换日期？', confirmLabel: '放弃并切换' })) return;
        }
        dateInput.value = nextDate;
        updateDateTrigger(dateButton, nextDate);
        await loadPlanForDate();
      }, '选择今天页日期');
      await Promise.all([loadCarryovers(), loadPlanForDate()]);
    })
    .catch(error => toast(error.message));
}
