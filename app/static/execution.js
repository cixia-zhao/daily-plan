/* 执行台与时间记录层：课程计时、目标周长进度、时间轴交互、快捷修正与背单词词数管理。 */
if (page === 'execute' || $('#execution-overlay')) {
  const historyView = page === 'execution-history';
  const recordsOnly = page !== 'execute';
  let executionTab = 'courses';
  let controlsFocus = null;
  let controlsClosing = false;
  let controlsCloseTimer = null;

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
  let operationUnconfirmed = false;
  let timingPending = false;
  let timingAction = '';
  let autoStopBusy = false;
  let quickCorrectionBusy = false;
  let wordCountsBusy = false;
  let confirmingWordCountDelete = false;
  const receivedTimes = new WeakMap();

  let segmentDialogDate = null;
  let segmentEditBusy = false;
  const segmentDialog = $('#segment-edit-dialog');
  const chronology = new ExecutionTimeline($('#execute-chronology'), openSegmentEditor, openNewSegmentEditor);

  $('#segment-edit-close').onclick = () => { if (!segmentEditBusy) segmentDialog.close(); };
  segmentDialog.addEventListener('close', () => {
    if (segmentDialogDate === dateInput.value) {
      (recordsPageOpen
        ? $('#execution-records-content .chronology-record.is-selected') || $('#execution-records-content .chronology-dismiss')
        : $('#execute-chronology .chronology-surface')
      )?.focus({ preventScroll: true });
    }
  });
  segmentDialog.addEventListener('cancel', event => { if (segmentEditBusy) event.preventDefault(); });
  bindDialogBackdropClose(segmentDialog, () => segmentEditBusy);

  function openSegmentEditor(id) {
    const segment = executionState?.segments.find(item => item.id === id);
    if (!segment || timingPending || segmentEditBusy) return;
    segmentDialogDate = dateInput.value;
    $('#segment-edit-title').textContent = segment.ended_at ? '编辑时间段' : '编辑运行中记录';
    $('#segment-edit-context').textContent = `${segment.task_title} · ${timeCategoryNames[segmentTimeCategory(segment)]}${segment.is_estimated ? ' · 补记·估计' : ''}`;
    $('#segment-edit-error').hidden = true;
    $('#segment-edit-content').innerHTML = segmentEditorHtml(segment, false, { open: true });
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
  const pinnedControls = () => !recordsOnly && !historyView && !phoneSheet.matches;

  function controlsBusy() {
    return timingPending || segmentEditBusy || quickCorrectionBusy || wordCountsBusy || autoStopBusy;
  }

  function beginControlsClose() {
    if (historyView || pinnedControls() || controlsClosing) return;
    controlsClosing = true;
    const closeDuration = phoneSheet.matches ? sheetDrag.dismiss() : matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180;
    controlsRoot.classList.add('is-closing');
    backdrop.classList.add('is-closing');
    controlsCloseTimer = setTimeout(() => {
      controlsClosing = false;
      controlsCloseTimer = null;
      controlsRoot.classList.remove('is-closing');
      backdrop.classList.remove('is-closing');
      sheetDrag.reset();
      updateExecutionControls();
      const fallback = executionState?.active_segment ? $('#execution-mini-open') : recordsOnly ? $('#review-records-open') : controlsFab;
      const restore = controlsFocus?.isConnected && controlsFocus.matches('button,a[href],input,select,textarea,[tabindex]') && controlsFocus.getClientRects().length
        ? controlsFocus
        : fallback;
      restore?.focus({ preventScroll: true });
    }, closeDuration);
  }

  let clockInterval = null;
  let syncInterval = null;

  function syncBackgroundTimers() {
    const shouldTick = !recordsOnly || (controlsExpanded && Boolean(executionState?.active_segment));
    if (shouldTick && !clockInterval) {
      clockInterval = setInterval(updateClockDigits, 1000);
    } else if (!shouldTick && recordsOnly && clockInterval) {
      clearInterval(clockInterval);
      clockInterval = null;
    }
    if (shouldTick && !syncInterval) {
      syncInterval = setInterval(() => {
        if (executionState?.active_segment) syncLiveExecution();
      }, 15000);
    } else if (!shouldTick && recordsOnly && syncInterval) {
      clearInterval(syncInterval);
      syncInterval = null;
    }
  }

  function updateExecutionControls() {
    if (historyView) {
      controlsExpanded = true;
      controlsRoot.hidden = !executionState || (!executionState.plan && !executionState.has_execution);
      controlsRoot.removeAttribute('aria-modal');
      controlsFab.hidden = true;
      mini.hidden = true;
      backdrop.hidden = true;
      $('#execution-controls-title').textContent = '时间轴与记录';
      $('#execution-overlay').classList.toggle('has-running', Boolean(executionState?.active_segment));
      syncBackgroundTimers();
      return;
    }
    const active = executionState?.active_segment;
    const pinned = pinnedControls();
    if (controlsDate !== dateInput.value) {
      controlsDate = dateInput.value;
      controlsExpanded = false;
      controlsHadActive = false;
      resetRecordsPage();
    }
    if ((active && !controlsHadActive) || timingPending || !$('#execute-operation-feedback').hidden) {
      controlsExpanded = true;
    } else if (
      !pinned
      && controlsHadActive
      && !active
      && !segmentDialog.open
      && !$('#quick-correction-dialog').open
      && !$('#word-count-dialog').open
      && !$('#auto-stop-dialog').open
      && !recordsPageOpen
    ) {
      controlsExpanded = false;
      beginControlsClose();
    }
    controlsHadActive = Boolean(active);
    const shown = pinned || controlsExpanded || controlsClosing;
    if (controlsRoot.hidden && shown) controlsRoot.style.removeProperty('animation');
    controlsRoot.hidden = !shown;
    controlsFab.hidden = recordsOnly || shown || active;
    mini.hidden = recordsOnly || shown || !active;
    controlsFab.setAttribute('aria-expanded', String(controlsExpanded));
    controlsFab.disabled = controlsBusy();
    $('#execution-controls-close').hidden = pinned;
    $('#execution-controls-close').disabled = controlsBusy();
    controlsRoot.setAttribute('role', pinned ? 'region' : 'dialog');
    $('#execution-sheet-handle').disabled = controlsBusy();
    $('#execution-mini-stop').disabled = timingPending;
    backdrop.hidden = !shown || !phoneSheet.matches;
    const modal = shown && phoneSheet.matches;
    controlsRoot.setAttribute('aria-modal', String(modal));
    const mainNode = document.querySelector('main');
    if (mainNode) mainNode.inert = modal;
    if (header) header.inert = modal;
    document.body.classList.toggle('execution-sheet-open', modal);
    document.body.classList.toggle('execution-panel-open', shown);
    document.body.classList.toggle('execution-is-running', Boolean(active));
    $('#execution-overlay').classList.toggle('has-running', Boolean(active));
    $('#execution-controls-title').textContent = recordsOnly ? `${dateInput.value} · 时间记录` : '计时与记录';
    $('#execution-mini-title').textContent = active ? `${active.task_title}${active.label_name ? '／' + active.label_name : ''}` : '';
    if (!shown) {
      if (mainNode) mainNode.inert = false;
      if (header) header.inert = false;
    }
    syncBackgroundTimers();
  }

  function openExecutionControls() {
    if (controlsCloseTimer) {
      clearTimeout(controlsCloseTimer);
      controlsCloseTimer = null;
      controlsClosing = false;
      controlsRoot.classList.remove('is-closing');
      backdrop.classList.remove('is-closing');
    }
    if (!controlsExpanded) {
      sheetDrag.reset();
      resetRecordsPage();
      controlsFocus = document.activeElement;
    }
    controlsDate = dateInput.value;
    controlsExpanded = true;
    updateExecutionControls();
    requestAnimationFrame(() => {
      if (!historyView && phoneSheet.matches && !document.querySelector('dialog[open]')) {
        $('#execution-controls-close').focus({ preventScroll: true });
      }
      chronology.render();
    });
  }

  function closeExecutionControls() {
    if (historyView || pinnedControls()) return false;
    if (!controlsExpanded && !controlsClosing) return true;
    if (controlsBusy() || document.querySelector('dialog[open]')) return false;
    controlsExpanded = false;
    operationUnconfirmed = false;
    $('#execute-operation-feedback').hidden = true;
    beginControlsClose();
    updateExecutionControls();
    return true;
  }

  controlsFab.onclick = openExecutionControls;
  $('#execution-mini-open').onclick = openExecutionControls;
  $('#execution-controls-close').onclick = closeExecutionControls;
  $('#execution-sheet-handle').onclick = closeExecutionControls;
  backdrop.onclick = closeExecutionControls;

  const sheetBody = $('.execution-sheet-body', controlsRoot);
  const workPage = $('#execution-workpage');
  const recordsPage = $('#execution-records-page');
  let recordsPageOpen = false;
  let pageAnimation = null;
  let workScroll = 0;

  function resetRecordsPage() {
    pageAnimation?.cancel();
    pageAnimation = null;
    recordsPageOpen = false;
    workPage.hidden = false;
    recordsPage.hidden = true;
    sheetBody.style.removeProperty('height');
    sheetBody.classList.remove('showing-records');
    chronology.nearby = null;
  }

  if (!historyView) {
    chronology.recordsNode = $('#execution-records-content');
    chronology.recordsReturnLabel = recordsOnly ? '← 返回时间轴' : '← 返回计时';
    chronology.onRecordsPage = show => {
      pageAnimation?.cancel();
      if (show && !recordsPageOpen) {
        sheetBody.style.height = `${sheetBody.getBoundingClientRect().height}px`;
        workScroll = sheetBody.scrollTop;
      }
      recordsPageOpen = show;
      workPage.hidden = show;
      recordsPage.hidden = !show;
      sheetBody.classList.toggle('showing-records', show);
      sheetBody.scrollTop = show ? 0 : workScroll;
      const target = show ? recordsPage : workPage;
      if (!matchMedia('(prefers-reduced-motion:reduce)').matches) {
        pageAnimation = target.animate(
          [
            { opacity: 0, transform: `translateX(${show ? 20 : -20}px)` },
            { opacity: 1, transform: 'translateX(0)' },
          ],
          { duration: 240, easing: 'cubic-bezier(.22,.8,.25,1)' }
        );
      }
      requestAnimationFrame(() => {
        if (show) {
          $('#execution-records-content .chronology-dismiss')?.focus({ preventScroll: true });
        } else {
          chronology.render();
          $('#execute-chronology .chronology-browse')?.focus({ preventScroll: true });
        }
      });
    };
  }

  const sheetDrag = new ExecutionSheetDrag(
    controlsRoot,
    backdrop,
    () => !historyView && phoneSheet.matches && controlsExpanded && !controlsClosing && !controlsBusy() && !document.querySelector('dialog[open]'),
    closeExecutionControls,
  );

  phoneSheet.addEventListener('change', () => {
    if (pinnedControls() && controlsCloseTimer) {
      clearTimeout(controlsCloseTimer);
      controlsCloseTimer = null;
      controlsClosing = false;
      controlsRoot.classList.remove('is-closing');
      backdrop.classList.remove('is-closing');
    }
    sheetDrag.reset();
    updateExecutionControls();
  });

  window.addEventListener('resize', () => {
    if (!recordsPageOpen) sheetBody.style.removeProperty('height');
  });

  document.addEventListener('keydown', event => {
    if (historyView || pinnedControls() || !controlsExpanded || document.querySelector('dialog[open]')) return;
    if (event.key === 'Escape') {
      if (executionUiState.expandedLabelBucket || executionUiState.effectivePickerTaskId !== null) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeExecutionControls();
      return;
    }
    if (event.key === 'Tab' && phoneSheet.matches) {
      const focusable = [...controlsRoot.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')]
        .filter(node => node.getClientRects().length);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  });

  function updateExecutionOffsets() {
    if (!header) return;
    const headerHeight = header.getBoundingClientRect().height;
    document.documentElement.style.setProperty('--execution-header-height', `${headerHeight}px`);
    document.body.style.setProperty('--execution-scroll-offset', `${headerHeight + 12}px`);
  }
  const executionResize = new ResizeObserver(updateExecutionOffsets);
  if (header) executionResize.observe(header);
  if (currentPanel) executionResize.observe(currentPanel);

  function updateTimingControls() {
    const active = executionState?.active_segment;
    currentPanel.setAttribute('aria-busy', String(timingPending));
    $('#execute-stop').disabled = timingPending || !active;
    $('#execute-stop').textContent = timingPending && timingAction === '停止' ? '正在停止…' : '停止';
    $('#quick-correction-open').disabled = timingPending || quickCorrectionBusy || !active || active.included === false;
    $$('.task-start-button, .effective-start-option, .execution-label-button, #mobile-counted-toggle, #mobile-interrupt-toggle').forEach(button => {
      button.disabled = timingPending;
    });
    $('#mobile-return-effective').disabled = timingPending || !(active && active.segment_kind !== 'effective' && active.task_id);
    updateExecutionControls();
  }

  function showExecutionError(message) {
    $('#execute-operation-message').textContent = message;
    $('#execute-operation-feedback').hidden = false;
    if (recordsPageOpen) chronology.showRecords(false);
    openExecutionControls();
    requestAnimationFrame(() => $('#execute-operation-feedback').scrollIntoView({ block: 'nearest' }));
  }

  async function executionApi(path, options = {}) {
    const requestDate = dateInput.value;
    const writing = options.method && options.method !== 'GET';
    const timing = writing && (/\/(tasks\/start|labels\/start|stop|quick-corrections|time-corrections|auto-stop)$/.test(path) || (options.method === 'PUT' && path.endsWith(`/segments/${executionState?.active_segment?.id}`)));
    if (timing && timingPending) throw new Error('正在处理当前计时操作，请稍候。');
    if (timing) {
      operationUnconfirmed = false;
      timingPending = true;
      timingAction = path.endsWith('/auto-stop')
        ? '设置自动停止'
        : options.method === 'PUT'
          ? '保存修改'
          : (path.endsWith('/quick-corrections') || path.endsWith('/time-corrections'))
            ? '修正时间'
            : path.endsWith('/stop')
              ? '停止'
              : executionState?.active_segment
                ? '切换'
                : '开始';
      $('#execute-operation-feedback').hidden = true;
      updateTimingControls();
    }
    if (writing) {
      executionWrites++;
      executionRevision++;
      $('#execute-record-status').textContent = timing ? `正在${timingAction}，等待服务器确认…` : '正在保存…';
    }
    try {
      const result = await api(path, options);
      if (result && typeof result === 'object') receivedTimes.set(result, performance.now());
      if (writing && recordsOnly) {
        setTimeout(() => document.dispatchEvent(new CustomEvent('execution-records-changed', { detail: { date: requestDate } })), 0);
      }
      return result;
    } catch (error) {
      if (writing) $('#execute-record-status').textContent = '这次操作未确认保存，请重试；原有记录保留。';
      if (timing) {
        operationUnconfirmed = true;
        showExecutionError(`${error.message}；这次操作未确认，当前仍显示上次确认的计时。可先核对记录再重试。`);
      }
      throw error;
    } finally {
      if (writing) {
        executionWrites--;
        executionRevision++;
      }
      if (timing) {
        timingPending = false;
        updateTimingControls();
      }
    }
  }

  const autoDialog = $('#auto-stop-dialog');
  const autoTime = $('#auto-stop-time');
  const autoError = $('#auto-stop-error');
  let autoStopSegment = null;
  let autoStopDate = null;

  const localDateTime = value => {
    const d = new Date(value);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  };

  function previewAutoStop() {
    const due = new Date(autoTime.value);
    const seconds = (due - Date.now()) / 1000;
    $('#auto-stop-preview').textContent = Number.isFinite(seconds) && seconds > 0
      ? `将在 ${due.toLocaleString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 停止并保存。`
      : '请选择未来24小时内的停止时刻。';
    $$('[data-auto-minutes]', autoDialog).forEach(b => {
      b.setAttribute('aria-pressed', String(Number(b.dataset.autoMinutes) === $('#auto-stop-minutes').valueAsNumber));
    });
  }

  function useAutoStopMinutes(minutes) {
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
      autoError.textContent = '请填写1～1440的整数分钟。';
      autoError.hidden = false;
      return;
    }
    $('#auto-stop-minutes').value = minutes;
    autoTime.value = localDateTime(Date.now() + minutes * 60000);
    autoError.hidden = true;
    previewAutoStop();
  }

  $('#auto-stop-open').onclick = () => {
    const active = executionState?.active_segment;
    if (!active || controlsBusy()) return;
    autoStopSegment = active.id;
    autoStopDate = dateInput.value;
    autoError.hidden = true;
    $('#auto-stop-minutes').value = '';
    autoTime.value = active.auto_stop_at ? localDateTime(active.auto_stop_at) : '';
    $('#auto-stop-cancel').disabled = !active.auto_stop_at;
    previewAutoStop();
    autoDialog.showModal();
  };

  $$('[data-auto-minutes]', autoDialog).forEach(b => { b.onclick = () => useAutoStopMinutes(Number(b.dataset.autoMinutes)); });
  $('#auto-stop-minutes').oninput = () => {
    const minutes = $('#auto-stop-minutes').valueAsNumber;
    if (Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440) useAutoStopMinutes(minutes);
  };
  autoTime.oninput = () => {
    $('#auto-stop-minutes').value = '';
    autoError.hidden = true;
    previewAutoStop();
  };

  async function saveAutoStop(cancel = false) {
    if (autoStopBusy) return;
    if (!cancel && !autoTime.value) {
      autoError.textContent = '请先选择停止时间。';
      autoError.hidden = false;
      return;
    }
    const due = cancel ? null : new Date(autoTime.value);
    const delta = due ? due - Date.now() : 0;
    if (due && (!Number.isFinite(delta) || delta <= 0 || delta > 86400000)) {
      autoError.textContent = '请选择未来24小时内的停止时间。';
      autoError.hidden = false;
      return;
    }
    autoStopBusy = true;
    autoError.hidden = true;
    const controls = [...autoDialog.querySelectorAll('button,input')];
    controls.forEach(c => { c.disabled = true; });
    try {
      const result = await executionApi(`/api/daily-execution/${autoStopDate}/auto-stop`, {
        method: 'PUT',
        body: JSON.stringify({ segment_id: autoStopSegment, due_at: due?.toISOString() || null }),
      });
      autoDialog.close();
      renderExecutionState(result);
      toast(cancel ? '已取消自动停止，继续计时' : '自动停止时间已保存');
    } catch (error) {
      autoError.textContent = error.message;
      autoError.hidden = false;
    } finally {
      autoStopBusy = false;
      controls.forEach(c => { c.disabled = false; });
      $('#auto-stop-cancel').disabled = !executionState?.active_segment?.auto_stop_at;
      updateTimingControls();
    }
  }

  $('#auto-stop-form').onsubmit = e => { e.preventDefault(); saveAutoStop(); };
  $('#auto-stop-cancel').onclick = () => saveAutoStop(true);
  $('#auto-stop-close').onclick = () => { if (!autoStopBusy) autoDialog.close(); };
  autoDialog.addEventListener('cancel', e => { if (autoStopBusy) e.preventDefault(); });
  bindDialogBackdropClose(autoDialog, () => autoStopBusy);
  autoDialog.addEventListener('close', () => {
    if ($('#auto-stop-open').getClientRects().length) $('#auto-stop-open').focus({ preventScroll: true });
  });

  function updateClockDigits() {
    if (document.hidden) return;
    const active = executionState?.active_segment;
    const limit = active?.auto_stop_at ? Math.max(0, (new Date(active.auto_stop_at) - new Date(active.started_at)) / 1000) : Infinity;
    const seconds = clockActive ? Math.min(limit, Math.max(0, Math.floor(clockSeconds + (performance.now() - clockReceivedAt) / 1000))) : 0;
    if (clockActive && active?.auto_stop_at && seconds >= limit) {
      syncLiveExecution();
    }
    $('#execute-clock').textContent = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
      .map(value => String(value).padStart(2, '0'))
      .join(':');
    $('#execution-mini-clock').textContent = $('#execute-clock').textContent;
    updateGoalProgress();
    chronology.tick();
  }

  function resizeGoalBorder() {
    const track = $('#execute-goal-track');
    const width = currentPanel.clientWidth;
    const height = currentPanel.clientHeight;
    if (!width || !height) return;
    const scroller = $('.execution-sheet-body', controlsRoot);
    currentPanel.classList.toggle('is-unpinned', height + 112 > scroller.clientHeight);
    if (track.hasAttribute('hidden')) return;
    const inset = 2;
    const radius = Math.max(0, Math.min(parseFloat(getComputedStyle(currentPanel).borderTopLeftRadius) || 12, width / 2, height / 2) - inset);
    const left = inset;
    const top = inset;
    const right = width - inset;
    const bottom = height - inset;
    const middle = width / 2;
    const path = `M ${middle} ${top} H ${right - radius} A ${radius} ${radius} 0 0 1 ${right} ${top + radius} V ${bottom - radius} A ${radius} ${radius} 0 0 1 ${right - radius} ${bottom} H ${left + radius} A ${radius} ${radius} 0 0 1 ${left} ${bottom - radius} V ${top + radius} A ${radius} ${radius} 0 0 1 ${left + radius} ${top} H ${middle} Z`;
    const viewBox = `0 0 ${width} ${height}`;
    if (track.getAttribute('viewBox') === viewBox) return;
    track.setAttribute('viewBox', viewBox);
    for (const stroke of track.querySelectorAll('path')) stroke.setAttribute('d', path);
  }

  const goalBorderResize = new ResizeObserver(resizeGoalBorder);
  goalBorderResize.observe(currentPanel);
  goalBorderResize.observe($('.execution-sheet-body', controlsRoot));
  const goalBorderMutate = new MutationObserver(resizeGoalBorder);
  goalBorderMutate.observe(currentPanel, { attributes: true, subtree: true, attributeFilter: ['style', 'class', 'hidden'] });

  function updateGoalProgress() {
    const result = clockSource;
    const active = result?.active_segment;
    const task = result?.tasks?.find(item => String(item.id) === String(active?.task_id ?? selectedTaskId)) || result?.tasks?.[0];
    const root = $('#execute-goal-progress');
    root.hidden = !task;
    if (!task) return;
    const board = result.task_execution_board?.find(item => item.task_id === task.id);
    const advancing = Boolean(active && active.task_id === task.id && active.segment_kind === 'effective' && active.included !== false);
    const deadlineRemaining = active?.auto_stop_at
      ? Math.max(0, (new Date(active.auto_stop_at) - new Date(active.started_at)) / 1000 - clockSeconds)
      : Infinity;
    const elapsed = advancing ? Math.min(deadlineRemaining, Math.max(0, (performance.now() - clockReceivedAt) / 1000)) : 0;
    const seconds = Math.max(0, Number(board?.effective_seconds || 0) + elapsed);
    const target = Math.max(0, Number(task.estimated_minutes || 0) * 60);
    const ratio = target ? Math.min(1, seconds / target) : 0;
    const minutes = seconds > 0 && seconds < 60 ? '小于1' : String(Math.floor(seconds / 60));
    $('#execute-goal-label').textContent = `今日${task.title} · 有效 ${minutes}${target ? ` / ${task.estimated_minutes}` : ''} 分`;
    $('#execute-goal-status').textContent = !target ? '未设目标' : ratio >= 1 ? '已达目标' : `${Math.floor(ratio * 100)}%`;
    root.dataset.stage = ratio >= 1 ? 'complete' : ratio >= 0.8 ? 'near' : ratio >= 0.5 ? 'middle' : 'early';
    root.classList.toggle('is-running', advancing && !syncFailed && !document.hidden);
    $('#execute-goal-activity').textContent = syncFailed
      ? '等待同步'
      : !active
        ? '已停止'
        : active.included === false
          ? '当前段未计入有效'
          : advancing
            ? '有效计时中'
            : active.time_category === 'distraction' || (!active.time_category && active.segment_kind === 'counted_label')
              ? '分心中 · 进度保留'
              : active.time_category === 'external'
                ? '外部打断中 · 进度保留'
                : '休息／事务中 · 进度保留';
    $('#execute-goal-remaining').textContent = !target
      ? ''
      : ratio < 1
        ? `还差 ${Math.ceil((target - seconds) / 60)} 分`
        : seconds - target >= 60
          ? `超出 ${Math.floor((seconds - target) / 60)} 分`
          : '目标已完成';
    const track = $('#execute-goal-track');
    track.toggleAttribute('hidden', !target);
    track.setAttribute('aria-valuenow', String(Math.floor(ratio * 100)));
    track.setAttribute('aria-valuetext', `${task.title}，今日有效${minutes}分，目标${task.estimated_minutes}分${ratio >= 1 ? '，已达目标' : ''}`);
    $('#execute-goal-fill').style.strokeDashoffset = String(100 - ratio * 100);
    $('#execute-goal-fill').style.opacity = ratio > 0 ? '1' : '0';
    resizeGoalBorder();
  }

  const timeCorrectionDialog = new TimeCorrectionDialog({
    state: () => executionState,
    date: () => dateInput.value,
    settings: () => settings,
    pending: () => timingPending || segmentEditBusy || autoStopBusy,
    setBusy: value => { quickCorrectionBusy = value; updateTimingControls(); },
    request: executionApi,
    render: renderExecutionState,
    notify: toast,
  });

  function renderLiveExecution(result) {
    const active = result?.active_segment;
    const previous = clockSource?.active_segment;
    if (previous?.auto_stop_at && !active && result?.segments?.some(s => s.id === previous.id && s.stopped_automatically)) {
      toast('已按设定时间自动停止，记录已保存');
    } else if (previous?.auto_stop_at && active && active.id !== previous.id && !active.auto_stop_at) {
      toast('已切换计时，原自动停止设置已取消');
    }
    $('#auto-stop-open').hidden = !active || recordsOnly || historyView;
    $('#auto-stop-open').disabled = timingPending;
    $('#auto-stop-caption').textContent = active?.auto_stop_at
      ? `${new Date(active.auto_stop_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 自动停止 · 可修改`
      : '设置自动停止';
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
    $('#execute-record-status').textContent = syncFailed
      ? '暂时无法同步；显示的是上次确认的状态，请检查网络。'
      : active
        ? '开始时间已保存，停止后更新本段时长。'
        : result?.has_execution
          ? '学习记录已保存，无需另外提交。'
          : '还没有学习记录，开始后自动记录。';
    $('#execute-review-status').textContent = result?.has_review ? '复盘已保存' : '复盘待填写';
    const reminder = active?.reminder;
    const notice = $('#execute-reminder-status');
    notice.hidden = !reminder;
    if (reminder) {
      const due = new Date(reminder.due_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      notice.textContent = reminder.status === 'pending'
        ? `${notificationState?.preview ? '预览演示' : '到点提醒'} · ${due}；计时不会自动停止。`
        : reminder.status === 'sent'
          ? '提醒已交给通知服务；计时继续，手机送达请实际核对。'
          : reminder.status === 'simulated'
            ? '预览已到提醒时间；没有发送手机通知，计时继续。'
            : reminder.error || '提醒已取消，计时状态以当前记录为准。';
    }
    updateClockDigits();
  }

  async function syncLiveExecution({ clearOperationError = false } = {}) {
    if (document.hidden || !executionState || executionWrites || liveSyncPending) return;
    if (recordsOnly && !controlsExpanded) return;
    const target = dateInput.value;
    const revision = executionRevision;
    const sequence = executionLoadSequence;
    liveSyncPending = true;
    try {
      const result = await executionApi(`/api/daily-execution/${target}`);
      if (document.hidden || target !== dateInput.value || revision !== executionRevision || sequence !== executionLoadSequence || executionWrites) return;
      syncFailed = false;
      if (!operationUnconfirmed || clearOperationError) {
        operationUnconfirmed = false;
        $('#execute-operation-feedback').hidden = true;
      }
      const activeChanged = executionState?.active_segment?.id !== result.active_segment?.id;
      executionState = result;
      renderLiveExecution(result);
      if (activeChanged && !recordsOnly && !historyView) {
        renderExecutionTasks();
        renderExecutionSubmitList();
      }
      chronology.update(result, receivedTimes.get(result));
      if (!recordsOnly) {
        const runnable = result.plan && ['approved', 'submitted'].includes(result.plan.status);
        const submitPanel = $('#execute-submit-panel');
        if (submitPanel) {
          submitPanel.classList.toggle('hidden', !runnable);
          submitPanel.hidden = executionTab !== 'complete';
        }
      }
    } catch {
      if (target === dateInput.value && revision === executionRevision && sequence === executionLoadSequence) {
        syncFailed = true;
        renderLiveExecution(executionState);
        showExecutionError('暂时无法同步，当前显示上次确认的记录。请检查网络后重新核对。');
      }
    } finally {
      liveSyncPending = false;
    }
  }

  if (!recordsOnly) {
    syncBackgroundTimers();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        updateClockDigits();
        syncLiveExecution();
      } else {
        updateGoalProgress();
      }
    });
    window.addEventListener('focus', syncLiveExecution);
    window.addEventListener('pageshow', event => {
      if (event.persisted) syncLiveExecution();
    });
  }

  window.addEventListener('pagehide', event => {
    if (!event.persisted) {
      if (clockInterval) clearInterval(clockInterval);
      if (syncInterval) clearInterval(syncInterval);
      clockInterval = null;
      syncInterval = null;
      goalBorderResize.disconnect();
      goalBorderMutate.disconnect();
    }
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
  dateInput.value = recordsOnly ? (selectedFromQuery || dateInput.value || todayIso()) : (dateInput.value || todayIso());

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

  function isWordSegment(taskId, labelId) {
    if (!labelId) return false;
    const task = (executionState?.tasks || []).find(item => String(item.id) === String(taskId));
    const meta = task ? categoryMeta(task.category) : null;
    return Boolean(meta?.supports_word_count && labelId === meta.word_label_id);
  }

  function selectedEffectiveLabelId(taskId) {
    const labelId = executionUiState.effectiveLabelSelections[String(taskId)] || '';
    return effectiveLabelsForTask(taskId).some(label => label.id === labelId) ? labelId : '';
  }

  function rememberEffectiveLabelSelection(taskId, labelId = '') {
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

  function labelOptionsForKind(kind, taskId, selectedId = '', snapshot = null) {
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
      dialog.className = 'vocabulary-choice-dialog';
      dialog.setAttribute('aria-labelledby', 'vocabulary-choice-title');
      dialog.innerHTML = `<form method="dialog">
        <div class="modal-heading">
          <h3 id="vocabulary-choice-title">当天已有墨墨录入</h3>
          <button type="button" class="ui-icon-button ui-icon-button-close vocab-choice-dismiss" aria-label="关闭" title="关闭">${uiIcon('close')}</button>
        </div>
        <p class="muted">这次背单词计时与已有分钟录入保留哪一份？其他细分不受影响。</p>
        <label>保留方式
          <select name="choice">
            <option value="both">分别学习，保留两份</option>
            <option value="manual">只保留墨墨录入</option>
            <option value="timer">只保留背单词计时</option>
          </select>
        </label>
        <div class="actions">
          <button value="cancel" type="button" class="ghost-button vocab-choice-cancel">取消</button>
          <button value="continue" type="submit" class="primary">确认并开始</button>
        </div>
      </form>`;
      let selection = null;
      $('form', dialog).onsubmit = event => {
        event.preventDefault();
        selection = dialog.querySelector('select').value;
        dialog.close();
      };
      $('.vocab-choice-dismiss', dialog).onclick = () => dialog.close();
      $('.vocab-choice-cancel', dialog).onclick = () => dialog.close();
      bindDialogBackdropClose(dialog);
      dialog.addEventListener('close', () => {
        dialog.remove();
        resolve(selection);
      }, { once: true });
      document.body.appendChild(dialog);
      dialog.showModal();
    });
  }

  async function startEffectiveTask(taskId, successMessage = '已开始记录有效时间', labelId = selectedEffectiveLabelId(taskId)) {
    selectedTaskId = taskId;
    executionUiState.expandedLabelBucket = null;
    rememberEffectiveLabelSelection(taskId, labelId || '');
    let duplicateChoice = null;
    if (isWordSegment(taskId, labelId) && executionState.duration_records?.length) {
      duplicateChoice = await chooseVocabularySource();
      if (!duplicateChoice) return;
    }
    executionState = await executionApi(`/api/daily-execution/${dateInput.value}/tasks/start`, {
      method: 'POST',
      body: JSON.stringify({ task_id: taskId, label_id: labelId || null, duplicate_choice: duplicateChoice }),
    });
    executionUiState.effectivePickerTaskId = null;
    renderExecutionState(executionState);
    if (recordsPageOpen) chronology.showRecords(false);
    openExecutionControls();
    toast(successMessage);
  }

  function segmentEditorHtml(segment, isDraft = false, editorState = null) {
    const original = segment;
    segment = { ...segment, ...editorState?.values };
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
          <label>结束${!isDraft && !original.ended_at ? '<input class="segment-end" value="" placeholder="仍在计时" disabled><small>保存后继续计时；结束请点停止。</small>' : `<input class="segment-end" type="datetime-local" step="1" value="${toDateTimeInputValue(segment.ended_at)}">`}</label>
          <label>任务<select class="segment-task-id" ${original.is_estimated ? 'disabled' : ''}>${taskOptions}</select></label>
          <label>归类<select class="segment-kind" ${original.is_estimated ? 'disabled' : ''}>
            ${Object.entries(timeCategoryNames).filter(([key]) => !key.startsWith('legacy') || key === category).map(([key, name]) => `<option value="${key}" ${category === key ? 'selected' : ''}>${name}</option>`).join('')}
          </select></label>
          <label class="segment-label-field"><span class="segment-label-title">${labelLabel}</span>
            <select class="segment-label-id" ${original.is_estimated ? 'disabled' : ''}>${labelOptionsForKind(category, segment.task_id, segment.label_id || '', isDraft ? null : original)}</select>
          </label>
        </div>
        <div class="timeline-actions">
          <button class="ghost-button segment-save" type="button">${isDraft ? '补记这一段' : !original.ended_at ? '保存并继续计时' : '保存修改'}</button>
          ${isDraft ? '' : '<button class="ghost-button segment-cancel" type="button">取消编辑</button>'}
          <button class="ghost-button segment-delete" type="button">${isDraft ? '取消' : original.is_estimated ? '撤销补记' : '删除'}</button>
        </div>
        </div>${isDraft ? '' : '</details>'}
      </article>
    `;
  }

  function segmentTimeRange(segment) {
    if (!segment.ended_at) return `${toDateTimeInputValue(segment.started_at).replace('T', ' ')}—正在计时`;
    const start = toDateTimeInputValue(segment.started_at);
    const end = toDateTimeInputValue(segment.ended_at);
    const crossDate = start.slice(0, 10) !== end.slice(0, 10);
    const seconds = start.slice(17, 19) !== '00' || end.slice(17, 19) !== '00';
    const text = value => `${crossDate ? `${value.slice(0, 10)} ` : ''}${value.slice(11, seconds ? 19 : 16)}`;
    return `${text(start)}—${text(end)}`;
  }

  function segmentDuration(seconds) {
    const value = Math.max(0, Math.floor(Number(seconds || 0)));
    return `${Math.floor(value / 60)} 分${value % 60 ? ` ${value % 60} 秒` : ''}`;
  }

  function openNewSegmentEditor() {
    if (timingPending || segmentEditBusy || !selectedExecutionTask()) return;
    const end = new Date();
    const parts = dateInput.value.split('-').map(Number);
    end.setFullYear(parts[0], parts[1] - 1, parts[2]);
    const start = new Date(end.getTime() - 30 * 60000);
    segmentDialogDate = dateInput.value;
    $('#segment-edit-title').textContent = '补一段时间';
    $('#segment-edit-context').textContent = '补记已经发生的一段时间。';
    $('#segment-edit-error').hidden = true;
    $('#segment-edit-content').innerHTML = segmentEditorHtml({
      id: 'draft',
      task_id: selectedExecutionTask().id,
      segment_kind: 'effective',
      label_id: null,
      started_at: dateToLocalDateTimeValue(start),
      ended_at: dateToLocalDateTimeValue(end),
    }, true);
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

    $$('.segment-kind', list).forEach(select => {
      select.onchange = event => syncSegmentLabelField(event.target.closest('.timeline-card'));
    });
    $$('.segment-task-id', list).forEach(select => {
      select.onchange = event => syncSegmentLabelField(event.target.closest('.timeline-card'));
    });

    $$('.segment-save', list).forEach(button => {
      button.onclick = async () => {
        if (button.disabled || segmentEditBusy) return;
        const row = button.closest('.timeline-card');
        const category = $('.segment-kind', row).value;
        const original = row.dataset.segmentId === 'draft' ? null : JSON.parse(row.dataset.originalSegment);
        const label = executionState.labels.find(item => item.id === $('.segment-label-id', row).value);
        const keepSnapshot = original && segmentTimeCategory(original) === category && original.label_id === $('.segment-label-id', row).value;
        const segmentKind = keepSnapshot
          ? original.segment_kind
          : category === 'learning'
            ? 'effective'
            : category.startsWith('legacy')
              ? original.segment_kind
              : label?.bucket === 'counted'
                ? 'counted_label'
                : 'interrupt_label';
        const body = {
          task_id: Number($('.segment-task-id', row).value),
          segment_kind: segmentKind,
          ...(category.startsWith('legacy') ? {} : { time_category: category }),
          label_id: $('.segment-label-id', row).value || null,
          started_at: fromDateTimeInputValue($('.segment-start', row).value),
          ended_at: original && !original.ended_at ? null : fromDateTimeInputValue($('.segment-end', row).value),
          ...(original
            ? { expected_state: Object.fromEntries(['task_id', 'segment_kind', 'label_id', 'time_category', 'started_at', 'ended_at'].map(key => [key, original[key]])) }
            : {}),
        };
        if (segmentKind === 'effective') rememberEffectiveLabelSelection(body.task_id, body.label_id || '');
        if (segmentKind === 'effective' && isWordSegment(body.task_id, body.label_id) && executionState.duration_records?.length) {
          body.duplicate_choice = await chooseVocabularySource();
          if (!body.duplicate_choice) return;
        }
        const saveDate = dateInput.value;
        try {
          if (segmentDialog.open && segmentDialogDate !== saveDate) throw new Error('查看日期已变化，请重新打开记录。');
          button.disabled = true;
          segmentEditBusy = true;
          $('#segment-edit-close').disabled = true;
          updateTimingControls();
          const updated = row.dataset.segmentId === 'draft'
            ? await executionApi(`/api/daily-execution/${dateInput.value}/segments`, { method: 'POST', body: JSON.stringify(body) })
            : await executionApi(`/api/daily-execution/${dateInput.value}/segments/${row.dataset.segmentId}`, { method: 'PUT', body: JSON.stringify(body) });
          if (dateInput.value !== saveDate) return;
          executionState = updated;
          segmentDialog.close();
          renderExecutionState(executionState);
          toast(row.dataset.segmentId === 'draft' ? '补记已保存' : '时间段已更新');
        } catch (error) {
          toast(error.message);
          if (segmentDialog.open) {
            $('#segment-edit-error').textContent = error.message;
            $('#segment-edit-error').hidden = false;
          }
        } finally {
          button.disabled = false;
          segmentEditBusy = false;
          $('#segment-edit-close').disabled = false;
          updateTimingControls();
        }
      };
    });

    $$('.segment-cancel', list).forEach(button => {
      button.onclick = () => { if (!segmentEditBusy) segmentDialog.close(); };
    });

    $$('.segment-delete', list).forEach(button => {
      button.onclick = async () => {
        if (segmentEditBusy) return;
        const row = button.closest('.timeline-card');
        if (row.dataset.segmentId === 'draft') {
          segmentDialog.close();
          return;
        }
        try {
          if (segmentDialog.contains(button)) {
            if (button.dataset.confirmDelete !== 'yes') {
              button.dataset.confirmDelete = 'yes';
              button.textContent = '确认' + button.textContent;
              $('#segment-edit-error').textContent = '再点一次确认；取消编辑可保留原记录。';
              $('#segment-edit-error').hidden = false;
              return;
            }
          }
          const estimated = executionState.segments.find(item => String(item.id) === row.dataset.segmentId)?.is_estimated;
          segmentEditBusy = true;
          button.disabled = true;
          $('#segment-edit-close').disabled = true;
          updateTimingControls();
          executionState = await executionApi(`/api/daily-execution/${dateInput.value}/segments/${row.dataset.segmentId}`, { method: 'DELETE' });
          segmentDialog.close();
          renderExecutionState(executionState);
          toast(estimated ? '补记已撤销，已还原有效学习' : '时间段已删除');
        } catch (error) {
          toast(error.message);
          $('#segment-edit-error').textContent = error.message;
          $('#segment-edit-error').hidden = false;
        } finally {
          segmentEditBusy = false;
          button.disabled = false;
          $('#segment-edit-close').disabled = false;
          updateTimingControls();
        }
      };
    });
  }

  function executionTaskCardHtml(task) {
    const board = taskBoardSummary(task.id);
    const meta = categoryMeta(task.category);
    const categoryTitle = meta.title;
    const active = executionState?.active_segment?.task_id === task.id;
    const selected = selectedExecutionTask();
    const selectedClass = selected && String(selected.id) === String(task.id) ? 'selected' : '';
    const effectiveLabels = effectiveLabelsForTask(task.id);
    const selectedLabelId = selectedEffectiveLabelId(task.id);
    const selectedLabel = effectiveLabels.find(label => label.id === selectedLabelId);
    const startLabelSuffix = selectedLabel ? ` · ${selectedLabel.name}` : '';
    const expanded = Boolean(executionUiState.expandedTaskDetails[String(task.id)]);
    const picking = executionUiState.effectivePickerTaskId === task.id;
    const inlineLabelPicker = `
      <div class="effective-label-picker">
        <div class="effective-management-heading"><span class="muted">有效细分</span><button class="ui-icon-button effective-label-add" type="button" aria-label="新增${esc(categoryTitle)}有效细分" title="新增有效细分">${uiIcon('plus')}</button></div>
        <div class="pill-list">${effectiveLabels.map(label => `
          <button class="ghost-button effective-label-button" type="button" data-effective-label-id="${esc(label.id)}" aria-label="管理${esc(label.name)}标签">${esc(label.name)}</button>
        `).join('') || '<span class="muted">还没有细分标签，点加号添加。</span>'}</div>
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
          <div class="execution-task-actions">${meta.supports_word_count ? '<button class="ghost-button word-count-open" type="button">记词数</button>' : ''}<button class="primary task-start-button" type="button" aria-expanded="${picking}" aria-controls="effective-start-${task.id}" aria-label="开始有效时间${esc(startLabelSuffix)}">开始<span class="task-start-detail">${esc(startLabelSuffix)}</span></button></div>
          ${startPicker}
        </div>
        <div class="execution-task-meta">
          <span>计划 ${task.estimated_minutes} 分</span>
          <span>有效 ${task.actual_minutes || 0} 分</span>
          <span>总计 ${board ? formatMinutes(board.total_minutes, board.total_seconds) : '0 分'}</span>
          ${meta.supports_word_count ? `<span class="word-count-summary">${executionState.vocabulary_counts ? `新学 ${executionState.vocabulary_counts.new_words} · 复习 ${executionState.vocabulary_counts.review_words}` : ''}</span>` : ''}
        </div>
        <div id="execution-details-${task.id}" class="execution-task-details" ${expanded ? '' : 'hidden'}>
          <div class="task-type-controls"><label>事项类型<select class="execute-task-type">${taskTypeOptions(task.task_type)}</select></label>
            ${task.task_type === 'habit' ? `<label>当天状态<select class="habit-status"><option value="">未记录</option>${['done', 'missed', 'rest'].map(value => `<option value="${value}" ${task.habit_status === value ? 'selected' : ''}>${habitStatusLabel(value)}</option>`).join('')}</select></label>` : ''}
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

  function openEffectiveLabelEditor(taskId, labelId = null) {
    if (document.querySelector('.effective-label-dialog[open]')) return;
    const task = executionState.tasks.find(item => item.id === taskId);
    if (!task) return;
    const label = effectiveLabelsForTask(taskId).find(item => item.id === labelId);
    if (labelId && !label) {
      toast('标签已变化，请刷新后重试');
      return;
    }
    closeEffectiveStartPicker();
    const categoryName = categoryMeta(task.category).title;
    const dialog = document.createElement('dialog');
    dialog.className = 'effective-label-dialog';
    dialog.setAttribute('aria-labelledby', 'effective-editor-title');
    dialog.innerHTML = `<form>
      <div class="modal-heading">
        <h3 id="effective-editor-title">${label ? '管理有效细分' : '新增有效细分'}</h3>
        <button type="button" class="ui-icon-button ui-icon-button-close effective-editor-dismiss" aria-label="关闭" title="关闭">${uiIcon('close')}</button>
      </div>
      <p class="muted">用于${esc(categoryName)}，以后每天都可用。已有计时保留原名称和时长。</p>
      <label>标签名称<input name="label_name" maxlength="50" required autocomplete="off" value="${esc(label?.name || '')}"></label>
      <p class="label-editor-error form-error" role="status" hidden></p>
      <div class="actions"><button class="primary effective-editor-save" type="submit">${label ? '保存名称' : '添加标签'}</button><button class="ghost-button effective-editor-cancel" type="button">取消</button>${label ? '<button class="danger-soft effective-editor-delete" type="button">删除标签</button>' : ''}</div>
    </form>`;
    let busy = false;
    let confirmDelete = false;
    const form = $('form', dialog);
    const input = $('input', dialog);
    const error = $('.label-editor-error', dialog);
    const setBusy = value => {
      busy = value;
      $$('button', dialog).forEach(button => { button.disabled = value; });
      input.disabled = value;
    };
    const perform = async deleting => {
      if (busy) return;
      error.hidden = true;
      const name = input.value.trim();
      if (!deleting && !name) {
        error.textContent = '请输入标签名称';
        error.hidden = false;
        input.focus();
        return;
      }
      setBusy(true);
      try {
        const path = `/api/settings/effective-labels/${encodeURIComponent(task.category)}${label ? '/' + encodeURIComponent(label.id) : ''}`;
        const result = await api(path, {
          method: deleting ? 'DELETE' : label ? 'PATCH' : 'POST',
          ...(!deleting ? { body: JSON.stringify({ name }) } : {}),
        });
        setSettings(result);
        if (deleting) {
          for (const [id, selected] of Object.entries(executionUiState.effectiveLabelSelections)) {
            if (selected === label.id && executionState.tasks.find(item => String(item.id) === id)?.category === task.category) {
              delete executionUiState.effectiveLabelSelections[id];
            }
          }
        }
        renderExecutionTasks();
        renderExecutionToolbar();
        dialog.close();
        toast(deleting ? '细分标签已删除，历史记录保留' : label ? '细分名称已保存' : '细分标签已添加');
      } catch (cause) {
        error.textContent = cause.message;
        error.hidden = false;
      } finally {
        setBusy(false);
      }
    };
    form.onsubmit = event => { event.preventDefault(); perform(false); };
    $('.effective-editor-cancel', dialog).onclick = () => { if (!busy) dialog.close(); };
    $('.effective-editor-dismiss', dialog).onclick = () => { if (!busy) dialog.close(); };
    if (label) {
      $('.effective-editor-delete', dialog).onclick = () => {
        if (!confirmDelete) {
          confirmDelete = true;
          $('.effective-editor-delete', dialog).textContent = '确认删除';
          error.textContent = `删除“${label.name}”后，以后不再出现在${categoryName}的选框中，已有记录保留。`;
          error.hidden = false;
        } else {
          perform(true);
        }
      };
    }
    input.oninput = () => {
      confirmDelete = false;
      error.hidden = true;
      if (label) $('.effective-editor-delete', dialog).textContent = '删除标签';
    };
    dialog.addEventListener('cancel', event => { event.stopPropagation(); if (busy) event.preventDefault(); });
    dialog.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });
    bindDialogBackdropClose(dialog, () => busy);
    dialog.addEventListener('close', () => {
      dialog.remove();
      const card = $(`[data-execution-task-id="${taskId}"]`);
      const previous = labelId ? $$('.effective-label-button', card || document).find(button => button.dataset.effectiveLabelId === labelId) : null;
      (previous || (card && $('.effective-label-add', card)))?.focus({ preventScroll: true });
    }, { once: true });
    document.body.appendChild(dialog);
    dialog.showModal();
    input.focus();
    input.select();
  }

  function expandExecutionCard(taskId = null) {
    $$('.execution-task-card').forEach(card => {
      const id = Number(card.dataset.executionTaskId);
      const expanded = id === taskId;
      executionUiState.expandedTaskDetails[String(id)] = expanded;
      $('.execution-task-details', card).hidden = !expanded;
      card.setAttribute('aria-expanded', String(expanded));
      card.classList.toggle('selected', expanded);
    });
    if (taskId !== null) selectedTaskId = taskId;
    updateGoalProgress();
  }

  function closeEffectiveStartPicker() {
    executionUiState.effectivePickerTaskId = null;
    $$('.effective-start-panel').forEach(panel => panel.classList.add('hidden'));
    $$('.task-start-button').forEach(button => button.setAttribute('aria-expanded', 'false'));
  }

  function bindExecutionTaskCardEvents(root = document) {
    $$('.execution-task-card', root).forEach(card => {
      const open = () => {
        closeEffectiveStartPicker();
        closeExecutionLabelPicker();
        expandExecutionCard(Number(card.dataset.executionTaskId));
      };
      card.onclick = event => {
        if (event.target.closest('button, select, input, textarea, a, label')) return;
        open();
      };
      card.onkeydown = event => {
        if (event.target !== card || !['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        open();
      };
    });
    $$('.effective-label-button', root).forEach(button => {
      button.onclick = event => {
        event.stopPropagation();
        openEffectiveLabelEditor(Number(button.closest('.execution-task-card').dataset.executionTaskId), button.dataset.effectiveLabelId);
      };
    });
    $$('.effective-label-add', root).forEach(button => {
      button.onclick = event => {
        event.stopPropagation();
        openEffectiveLabelEditor(Number(button.closest('.execution-task-card').dataset.executionTaskId));
      };
    });
    $$('.task-start-button', root).forEach(button => {
      button.onclick = event => {
        event.stopPropagation();
        if (switchingEffectiveLabel || timingPending) return;
        const card = button.closest('.execution-task-card');
        const taskId = Number(card.dataset.executionTaskId);
        $$('.execution-task-card').forEach(other => {
          if (other === card) return;
          executionUiState.expandedTaskDetails[other.dataset.executionTaskId] = false;
          $('.execution-task-details', other).hidden = true;
          other.setAttribute('aria-expanded', 'false');
          other.classList.remove('selected');
        });
        card.classList.add('selected');
        selectedTaskId = taskId;
        const opening = executionUiState.effectivePickerTaskId !== taskId;
        closeEffectiveStartPicker();
        closeExecutionLabelPicker();
        if (!opening) return;
        executionUiState.effectivePickerTaskId = taskId;
        const panel = $('.effective-start-panel', card);
        panel.classList.remove('hidden', 'opens-above');
        panel.style.maxHeight = '';
        const rect = panel.getBoundingClientRect();
        const head = $('.execution-task-head', card).getBoundingClientRect();
        const below = Math.max(0, innerHeight - head.bottom - 18);
        const above = Math.max(0, head.top - 18);
        const opensAbove = rect.height > below && above > below;
        panel.classList.toggle('opens-above', opensAbove);
        panel.style.maxHeight = `${Math.max(80, Math.min(360, opensAbove ? above : below))}px`;
        button.setAttribute('aria-expanded', 'true');
        $('.effective-start-option', card)?.focus({ preventScroll: true });
      };
    });
    $$('.effective-start-option', root).forEach(button => {
      button.onclick = async event => {
        event.stopPropagation();
        if (switchingEffectiveLabel || timingPending) return;
        const taskId = Number(button.closest('.execution-task-card').dataset.executionTaskId);
        const labelId = button.dataset.startLabelId || null;
        const active = executionState?.active_segment;
        if (active?.task_id === taskId && active.segment_kind === 'effective' && (active.label_id || null) === labelId) {
          closeEffectiveStartPicker();
          openExecutionControls();
          return;
        }
        switchingEffectiveLabel = true;
        $$('.effective-start-option, .task-start-button').forEach(item => { item.disabled = true; });
        try {
          await startEffectiveTask(taskId, labelId ? `已开始${button.textContent.trim()}` : '已开始记录有效时间', labelId);
        } catch (error) {
          toast(error.message);
        } finally {
          switchingEffectiveLabel = false;
          updateTimingControls();
        }
      };
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
          <div class="task-meta submit-task-meta"><span>${esc(categoryMeta(task.category).title)}</span>${summary}${task.task_type === 'habit' ? `<span>${habitStatusLabel(task.habit_status)}</span>` : ''}</div>
        </div>
      </article>
    `;
  }

  function bindExecutionSubmitEvents(root) {
    $$('.execute-submit-check', root).forEach(checkbox => {
      checkbox.onchange = async () => {
        const card = checkbox.closest('[data-submit-task-id]');
        try {
          const updated = await executionApi(`/api/tasks/${card.dataset.submitTaskId}`, {
            method: 'PATCH',
            body: JSON.stringify({ completed: checkbox.checked }),
          });
          const task = executionState.plan.tasks.find(item => String(item.id) === String(card.dataset.submitTaskId));
          Object.assign(task, updated);
          card.classList.toggle('completed', updated.completed);
        } catch (error) {
          checkbox.checked = !checkbox.checked;
          toast(error.message);
        }
      };
    });
  }

  function renderExecutionSubmitList() {
    if (recordsOnly) return;
    const list = $('#execute-submit-list');
    const zeroGroup = $('#execute-submit-zero-group');
    const zeroToggle = $('#execute-submit-zero-toggle');
    const zeroList = $('#execute-submit-zero-list');
    if (!list || !zeroGroup || !zeroToggle || !zeroList) return;
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
    if (recordsOnly) return;
    const list = $('#execute-task-list');
    if (!list) return;
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
    $$('.execution-section-toggle', list).forEach(button => {
      button.onclick = () => {
        if (button.dataset.sectionKey === 'zero-main') executionUiState.collapsedZeroMain = !executionUiState.collapsedZeroMain;
        if (button.dataset.sectionKey === 'sub-route') executionUiState.collapsedSub = !executionUiState.collapsedSub;
        renderExecutionTasks();
      };
    });
    bindExecutionTaskCardEvents(list);
    updateTimingControls();
    $$('.word-count-open', list).forEach(button => {
      button.onclick = event => { event.stopPropagation(); openWordCounts(); };
    });
    $$('.execute-task-type, .habit-status', list).forEach(input => {
      input.onchange = async () => {
        if (!input.value) return;
        const taskId = input.closest('[data-execution-task-id]').dataset.executionTaskId;
        try {
          await executionApi(`/api/tasks/${taskId}`, {
            method: 'PATCH',
            body: JSON.stringify(input.classList.contains('habit-status') ? { habit_status: input.value } : { task_type: input.value }),
          });
          await loadExecution();
        } catch (error) {
          toast(error.message);
        }
      };
    });
  }

  async function ensureNotificationsStatus() {
    if (notificationState !== null) return notificationState;
    try {
      notificationState = await api('/api/notifications/status');
    } catch {
      notificationState = null;
    }
    return notificationState;
  }

  async function chooseActivityReminder(label) {
    await ensureNotificationsStatus();
    return new Promise(resolve => {
      const dialog = document.createElement('dialog');
      dialog.className = 'record-form activity-reminder-dialog';
      const available = notificationState?.configured || notificationState?.preview;
      dialog.innerHTML = `<form>
        <div class="modal-heading">
          <h3>开始记录${esc(label.name)}</h3>
          <button type="button" class="ui-icon-button ui-icon-button-close reminder-dismiss" aria-label="关闭" title="关闭">${uiIcon('close')}</button>
        </div>
        <p class="muted">结束当前一段，切到${esc(label.name)}。到点只提醒，计时继续。</p>
        <label>多久后提醒（分钟，可留空）
          <input name="minutes" type="number" min="15" max="1440" step="1" inputmode="numeric" placeholder="留空只记录；填写 15～1440 整数">
        </label>
        <p class="muted">${esc(notificationState?.message || '手机通知状态暂不可用，留空即可只记录时间。')}</p>
        <div class="actions">
          <button class="ghost-button reminder-cancel" type="button">取消</button>
          <button class="primary" type="submit">开始记录</button>
        </div>
      </form>`;
      const form = $('form', dialog);
      const minutes = form.elements.namedItem('minutes');
      const validate = () => {
        const value = minutes.value;
        minutes.setCustomValidity(
          value && !available
            ? '手机通知尚未配置，请清空分钟数后只记录。'
            : value && (!Number.isInteger(Number(value)) || Number(value) < 15 || Number(value) > 1440)
              ? '请输入15～1440的整数分钟，或留空只记录。'
              : ''
        );
      };
      minutes.oninput = validate;
      let selection = null;
      form.onsubmit = event => {
        event.preventDefault();
        validate();
        if (!form.reportValidity()) return;
        selection = { reminder_minutes: minutes.value === '' ? null : Number(minutes.value) };
        dialog.close();
      };
      $('.reminder-cancel', dialog).onclick = () => dialog.close();
      $('.reminder-dismiss', dialog).onclick = () => dialog.close();
      bindDialogBackdropClose(dialog);
      dialog.addEventListener('keydown', event => event.stopPropagation());
      dialog.addEventListener('close', () => {
        dialog.remove();
        resolve(selection);
      }, { once: true });
      document.body.appendChild(dialog);
      dialog.showModal();
      minutes.focus();
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
    $$('.execution-label-button', root).forEach(button => {
      button.onclick = async () => {
        if (timingPending) return;
        const taskId = executionState?.active_segment?.task_id || selectedExecutionTask()?.id;
        const label = executionState.labels.find(item => item.id === button.dataset.labelId);
        const labelName = label.name;
        if (executionState.active_segment?.label_id === label.id) {
          closeExecutionLabelPicker();
          return;
        }
        try {
          $$('.execution-label-button', toolbarRoot()).forEach(item => { item.disabled = true; });
          const choice = ['rest', 'life'].includes(labelTimeCategory(label)) ? await chooseActivityReminder(label) : { reminder_minutes: null };
          if (!choice) {
            renderExecutionToolbar();
            return;
          }
          executionState = await executionApi(`/api/daily-execution/${dateInput.value}/labels/start`, {
            method: 'POST',
            body: JSON.stringify({ label_id: button.dataset.labelId, task_id: taskId || null, ...choice }),
          });
          executionUiState.expandedLabelBucket = null;
          renderExecutionState(executionState);
          toast(`已切到${labelName}`);
        } catch (error) {
          toast(error.message);
          renderExecutionToolbar();
        }
      };
    });
  }

  function toolbarRoot() {
    return $('#execute-mobile-toolbar');
  }

  function closeExecutionLabelPicker() {
    if (!executionUiState.expandedLabelBucket) return;
    executionUiState.expandedLabelBucket = null;
    renderExecutionToolbar();
  }

  document.addEventListener('click', event => {
    if (!event.target.closest('#execute-mobile-toolbar')) closeExecutionLabelPicker();
    if (event.target.closest('.effective-label-dialog')) return;
    if (!event.target.closest('.execution-task-card')) {
      expandExecutionCard();
      closeEffectiveStartPicker();
    } else if (!event.target.closest('.execution-task-head')) {
      closeEffectiveStartPicker();
    }
  });

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
    if (executionUiState.effectivePickerTaskId !== null) {
      const id = executionUiState.effectivePickerTaskId;
      closeEffectiveStartPicker();
      $(`[data-execution-task-id="${id}"] .task-start-button`)?.focus({ preventScroll: true });
    } else if (executionUiState.expandedLabelBucket) {
      const trigger = executionUiState.expandedLabelBucket === 'counted' ? $('#mobile-counted-toggle') : $('#mobile-interrupt-toggle');
      closeExecutionLabelPicker();
      trigger?.focus({ preventScroll: true });
    } else if (!document.querySelector('.effective-label-dialog[open]')) {
      expandExecutionCard();
    }
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
      } catch (error) {
        toast(error.message);
      }
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

    const runnable = Boolean(result?.plan && ['approved', 'submitted'].includes(result.plan.status));
    $('#execution-records-empty').hidden = runnable;
    $('#execution-records-empty').textContent = result?.plan ? '这一天的清单尚未确认。' : '这一天还没有计划或时间记录。';
    currentPanel.classList.toggle('hidden', !runnable);
    $('#execution-support').classList.toggle('hidden', !runnable);
    $('#execute-chronology').classList.toggle('hidden', !runnable);
    $('#execute-mobile-toolbar').classList.toggle('hidden', !runnable);

    if (autoDialog.open && autoStopDate !== result.date && !autoStopBusy) autoDialog.close();
    if (segmentDialog.open && segmentDialogDate !== result.date) segmentDialog.close();
    if (runnable) chronology.update(result, receivedTimes.get(result));

    if (!recordsOnly) {
      const emptyPanel = $('#execute-empty-state');
      const emptyMessage = $('#execute-empty-message');
      const executePanel = $('#execute-panel');
      const submitPanel = $('#execute-submit-panel');
      const enterReview = $('#enter-review');
      if (executePanel) {
        executePanel.hidden = executionTab !== 'courses';
        executePanel.classList.toggle('hidden', !runnable);
      }
      if (submitPanel) {
        submitPanel.classList.toggle('hidden', !runnable);
        submitPanel.hidden = executionTab !== 'complete';
      }
      if (enterReview) enterReview.disabled = !runnable;
      if (emptyPanel) emptyPanel.classList.toggle('hidden', runnable);
      if (!result?.plan) {
        if (emptyMessage) emptyMessage.textContent = '当前日期还没有计划。先回今天页生成并确认清单。';
        return;
      }
      if (!runnable) {
        if (emptyMessage) emptyMessage.textContent = '当前日期还是草稿，先回今天页确认后再开始执行。';
        return;
      }
    } else if (!runnable) {
      return;
    }

    const active = result.active_segment;
    if (active?.segment_kind === 'effective') rememberEffectiveLabelSelection(active.task_id, active.label_id || '');
    if (!recordsOnly) {
      renderExecutionTasks();
      renderExecutionSubmitList();
    }
    renderExecutionToolbar();
  }

  async function loadExecution() {
    const target = dateInput.value;
    const sequence = ++executionLoadSequence;
    const changingDate = executionState?.date !== target;
    const retryBtn = $('#execute-load-retry');
    if (retryBtn) retryBtn.hidden = true;
    if (changingDate) {
      executionState = null;
      renderLiveExecution(null);
      renderWordCounts();
      [currentPanel, $('#execution-support'), $('#execute-panel'), $('#execute-chronology'), $('#execute-submit-panel'), $('#execute-mobile-toolbar')]
        .filter(Boolean)
        .forEach(panel => panel.classList.add('hidden'));
      $('#execute-empty-state')?.classList.remove('hidden');
    }
    const emptyMsg = $('#execute-empty-message');
    if (emptyMsg) emptyMsg.textContent = '正在读取这一天的记录…';
    try {
      const result = await executionApi(`/api/daily-execution/${target}`);
      if (sequence === executionLoadSequence && target === dateInput.value) renderExecutionState(result);
    } catch (error) {
      if (sequence === executionLoadSequence) {
        $('#execute-empty-state')?.classList.remove('hidden');
        if (emptyMsg) emptyMsg.textContent = '读取失败，原有记录保留。请检查网络后重新读取。';
        $('#execution-records-empty').hidden = false;
        $('#execution-records-empty').textContent = '读取失败，原有记录保留。请关闭后重新打开记录。';
        if (retryBtn) retryBtn.hidden = false;
        toast(error.message);
      }
    }
  }

  const retryButton = $('#execute-load-retry');
  if (retryButton) retryButton.onclick = loadExecution;
  $('#execute-sync-retry').onclick = () => syncLiveExecution({ clearOperationError: true });

  const wordCountDialog = $('#word-count-dialog');
  function renderWordCounts() {
    const counts = executionState?.vocabulary_counts;
    $$('.word-count-open').forEach(button => {
      button.disabled = wordCountsBusy || !executionState || executionState.date !== dateInput.value;
    });
    $$('.word-count-summary').forEach(node => {
      node.textContent = counts ? `新学 ${counts.new_words} · 复习 ${counts.review_words}` : '';
    });
    $('#word-count-delete').disabled = wordCountsBusy || !counts;
  }

  function setWordCountsBusy(value) {
    wordCountsBusy = value;
    $$('#word-count-form input, #word-count-form button').forEach(control => { control.disabled = value; });
    $('#word-count-form [type=submit]').textContent = value ? '保存中…' : '保存';
    updateTimingControls();
    renderWordCounts();
  }

  function resetWordCountDelete() {
    confirmingWordCountDelete = false;
    $('#word-count-delete').textContent = '清除';
  }

  function openWordCounts() {
    if (wordCountsBusy || !executionState || executionState.date !== dateInput.value || wordCountDialog.open) return;
    closeEffectiveStartPicker();
    closeExecutionLabelPicker();
    const form = $('#word-count-form');
    const counts = executionState.vocabulary_counts;
    form.elements.namedItem('new_words').value = counts?.new_words ?? '';
    form.elements.namedItem('review_words').value = counts?.review_words ?? '';
    $('#word-count-date').textContent = `${dateInput.value} · 当天累计`;
    $('#word-count-status').textContent = '留空按0，再次保存会更新当天词数。';
    resetWordCountDelete();
    renderWordCounts();
    wordCountDialog.showModal();
    form.elements.namedItem('new_words').focus();
  }

  const closeWordDialog = () => { if (!wordCountsBusy) wordCountDialog.close(); };
  $('#word-count-close').onclick = closeWordDialog;
  if ($('#word-count-dismiss')) $('#word-count-dismiss').onclick = closeWordDialog;
  wordCountDialog.addEventListener('cancel', event => { if (wordCountsBusy) event.preventDefault(); });
  wordCountDialog.addEventListener('keydown', event => event.stopPropagation());
  bindDialogBackdropClose(wordCountDialog, () => wordCountsBusy);
  $('#word-count-form').oninput = resetWordCountDelete;

  async function saveWordCounts(method, body) {
    if (wordCountsBusy) return;
    const target = dateInput.value;
    setWordCountsBusy(true);
    $('#word-count-status').textContent = '正在保存…';
    try {
      const result = await executionApi(`/api/vocabulary-counts/${target}`, {
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      invalidateCalendarMonth(target);
      if (target !== dateInput.value) return;
      if (executionState?.date === target) executionState.vocabulary_counts = result.vocabulary_counts;
      renderWordCounts();
      renderLiveExecution(executionState);
      $('#word-count-status').textContent = method === 'DELETE' ? '当天词数已清除。' : '当天词数已保存。';
      wordCountDialog.close();
      toast(method === 'DELETE' ? '词数已清除' : '当天词数已更新');
    } catch (error) {
      if (target === dateInput.value) $('#word-count-status').textContent = `保存失败，输入保留：${error.message}`;
    } finally {
      setWordCountsBusy(false);
      resetWordCountDelete();
    }
  }

  $('#word-count-form').onsubmit = event => {
    event.preventDefault();
    const form = event.target;
    const body = Object.fromEntries(
      ['new_words', 'review_words'].map(name => [
        name,
        form.elements.namedItem(name).value === '' ? 0 : Number(form.elements.namedItem(name).value),
      ])
    );
    if (!form.reportValidity() || Object.values(body).some(n => !Number.isInteger(n) || n < 0 || n > 10000)) return;
    saveWordCounts('PUT', body);
  };

  $('#word-count-delete').onclick = () => {
    if (confirmingWordCountDelete) {
      saveWordCounts('DELETE');
      return;
    }
    confirmingWordCountDelete = true;
    $('#word-count-delete').textContent = '确认清除';
    $('#word-count-status').textContent = '再点一次清除当天词数，计时与已有分钟记录保留。';
  };

  $('#temporary-open').onclick = () => {
    const form = $('#temporary-form');
    const catalogEntries = Object.entries(settings?.category_catalog || {});
    const entries = catalogEntries.length
      ? catalogEntries.map(([key, meta]) => [key, meta.title])
      : Object.entries(settings?.task_titles || {});
    form.category.innerHTML = entries.map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join('');
    form.task_type.value = categoryMeta(form.category.value).default_task_type;
    form.classList.remove('hidden');
    form.elements.namedItem('title').focus();
  };
  $('#temporary-form').category.onchange = event => {
    $('#temporary-form').task_type.value = categoryMeta(event.target.value).default_task_type;
  };
  $('#temporary-form').onsubmit = async event => {
    event.preventDefault();
    const form = event.target;
    try {
      const result = await executionApi(`/api/daily-execution/${dateInput.value}/tasks`, {
        method: 'POST',
        body: JSON.stringify({
          title: form.elements.namedItem('title').value,
          category: form.category.value,
          task_type: form.task_type.value,
        }),
      });
      selectedTaskId = result.tasks[result.tasks.length - 1].id;
      renderExecutionState(result);
      form.classList.add('hidden');
      form.reset();
      toast('活动已添加，点开始即可记录');
    } catch (error) {
      toast(error.message);
    }
  };
  $$('.record-cancel').forEach(button => {
    button.onclick = () => button.closest('.record-form').classList.add('hidden');
  });

  $('#execute-stop').onclick = async () => {
    if (timingPending) return;
    try {
      executionState = await executionApi(`/api/daily-execution/${dateInput.value}/stop`, { method: 'POST' });
      renderExecutionState(executionState);
      $('#execute-operation-feedback').hidden = true;
      toast('已停止当前计时');
    } catch (error) {
      toast(error.message);
    }
  };

  $('#execution-mini-stop').onclick = () => $('#execute-stop').click();

  if (!recordsOnly) {
    const zeroToggle = $('#execute-submit-zero-toggle');
    if (zeroToggle) {
      zeroToggle.onclick = () => {
        executionUiState.collapsedZeroMinuteSubmit = !executionUiState.collapsedZeroMinuteSubmit;
        renderExecutionSubmitList();
      };
    }
    const enterReview = $('#enter-review');
    if (enterReview) {
      enterReview.onclick = () => {
        if (enterReview.disabled) return;
        window.location.href = `/review?date=${encodeURIComponent(dateInput.value)}`;
      };
    }
    const sectionTabs = $('.execution-section-tabs');
    if (sectionTabs) {
      PlanUI.tabs(sectionTabs, tab => {
        executionTab = tab.id === 'execution-complete-tab' ? 'complete' : 'courses';
      });
    }
    Promise.all([ensureSettings(), ensureNotificationsStatus()])
      .then(() => loadExecution())
      .catch(error => toast(error.message));
  } else {
    window.DailyPlanRecords = {
      async open(date) {
        if (controlsBusy() || segmentDialog.open) return false;
        try {
          await ensureSettings();
        } catch (error) {
          toast(error.message);
          return false;
        }
        if (dateInput.value !== date) {
          selectedTaskId = null;
          executionUiState = defaultExecutionUiState();
        }
        dateInput.value = date;
        await loadExecution();
        openExecutionControls();
        return true;
      },
      close: closeExecutionControls,
      get busy() {
        return controlsBusy() || segmentDialog.open || $('#quick-correction-dialog').open || $('#word-count-dialog').open;
      },
      get date() { return dateInput.value; },
      get isOpen() { return controlsExpanded; },
      get state() { return executionState; },
    };
  }
}
