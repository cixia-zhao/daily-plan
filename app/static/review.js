/* 日复盘与周复盘共用入口；草稿按日期及自然周分别保留。 */
if (page === 'review') {
  const query = new URLSearchParams(location.search);
  const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && !Number.isNaN(new Date(`${value}T12:00:00`).getTime());
  let selectedDate = validDate(query.get('date')) ? query.get('date') : todayIso();
  let selectedScope = query.get('scope') === 'weekly' ? 'weekly' : 'daily';
  let weekState = null;
  let reviewState = null;
  let loaded = null;
  let loadSequence = 0;
  const dailyDrafts = new Map();
  const weeklyDrafts = new Map();
  let serverValues = {};
  const saving = new Set();
  const saveMessages = new Map();
  let storageError = false;
  const storageKey = (scope, key) => `daily-plan:review-draft:v1:${scope}:${key}`;
  const groups = {review:'daily-review-save-status', dailyGPT:'daily-gpt-save-status',
                  final:'weekly-final-save-status', weeklyGPT:'weekly-gpt-save-status'};
  function statusTime(value) {
    const time = new Date(value);
    if (Number.isNaN(time.getTime())) return '';
    const day = time.toLocaleDateString('en-CA');
    return `${day === todayIso() ? '' : `${day} `}${time.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})}`;
  }
  function draftTime(draft, fields) {
    const values = typeof draft.updatedAt === 'string' ? [draft.updatedAt]
      : fields.map(name => draft.updatedAt?.[name]).filter(Boolean);
    return values.length ? statusTime(values.sort().at(-1)) : '';
  }
  function draftFor(scope, key) {
    const drafts = scope === 'daily' ? dailyDrafts : weeklyDrafts;
    if (!drafts.has(key)) {
      try {
        const value = JSON.parse(localStorage.getItem(storageKey(scope,key)) || '{}');
        drafts.set(key, value && typeof value === 'object' && !Array.isArray(value) ? value : {});
      } catch { storageError = true; drafts.set(key, {}); }
    }
    return drafts.get(key);
  }
  function persistDraft(scope, key) {
    const draft = draftFor(scope,key);
    try {
      const hasFields = Object.keys(draft).some(name => name !== 'updatedAt');
      if (hasFields) localStorage.setItem(storageKey(scope,key),JSON.stringify(draft));
      else localStorage.removeItem(storageKey(scope,key));
      storageError = false;
    } catch { storageError = true; }
    renderSaveStatus();
  }
  function renderSaveStatus() {
    if (!loaded) return;
    const scope = loaded.scope, key = scope === 'daily' ? loaded.date : loaded.end;
    const draft = draftFor(scope,key);
    $('#daily-save-summary').hidden = scope !== 'daily';
    if (scope === 'daily') {
      $('#daily-record-status').textContent = reviewState?.has_execution ? '学习记录已保存' : '还没有学习记录';
      const id = `daily:${key}:review`;
      $('#daily-review-state').textContent = saving.has(id) ? '复盘保存中…'
        : saveMessages.get(id)?.startsWith('保存失败') ? '复盘保存失败，草稿已保留'
        : Object.hasOwn(draft,'review') ? '复盘有未保存修改'
        : reviewState?.has_review ? '复盘已保存' : '复盘待填写';
    }
    for (const group of scope === 'daily' ? ['review','dailyGPT'] : ['final','weeklyGPT']) {
      const node = document.getElementById(groups[group]);
      const fields = group === 'review' ? ['review'] : group === 'final' ? ['final'] : ['response','adopted'];
      const dirty = fields.some(field => Object.hasOwn(draft,field));
      const id = `${scope}:${key}:${group}`;
      const localTime = draftTime(draft,fields);
      const localNote = storageError ? '暂存不可用，请勿关闭页面；请保存到服务器。'
        : `已在此设备暂存${localTime ? ` · ${localTime}` : ''}，尚未保存到服务器。`;
      const readTime = loaded.readAt ? ` · 核对于 ${statusTime(loaded.readAt)}` : '';
      node.textContent = saving.has(id) ? '保存中…' : saveMessages.get(id)?.startsWith('保存失败') ? saveMessages.get(id) : dirty
        ? localNote
        : saveMessages.get(id) || (group === 'review'
          ? reviewState?.has_review ? `复盘已保存到服务器${readTime}` : '复盘待填写；学习记录会单独保存。'
          : `已从服务器读取${readTime}`);
      if (saveMessages.get(id)?.startsWith('保存失败')) node.textContent += ` ${localNote}`;
    }
  }

  const dateInput = $('#review-date');
  const dateButton = $('#review-date-button');
  const form = $('#daily-review-form');
  const labels = ['周一','周二','周三','周四','周五','周六','周日'];
  const reviewTabs = $$('.review-section-tab');

  function dateOffset(value, offset) {
    const day = new Date(`${value}T12:00:00`);
    day.setDate(day.getDate() + offset);
    return `${day.getFullYear()}-${String(day.getMonth()+1).padStart(2,'0')}-${String(day.getDate()).padStart(2,'0')}`;
  }
  function weekday(value) { return (new Date(`${value}T12:00:00`).getDay() + 6) % 7; }
  function compactTime(minutes,seconds) {
    if (seconds > 0 && seconds < 60) return '小于 1 分';
    const value = Math.max(0, Math.round(Number(minutes || 0)));
    return value < 60 ? `${value} 分` : `${Math.floor(value / 60)} 小时 ${value % 60} 分`;
  }
  function sameValue(a,b) {
    const ordered = value => value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))) : value;
    return JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
  }
  function currentValues() {
    return loaded.scope === 'daily' ? {
      review:Object.fromEntries(new FormData(form)), response:$('#daily-gpt-response').value, adopted:$('#daily-gpt-adopted').value,
    } : {final:$('#weekly-final-report').value, response:$('#weekly-gpt-response').value, adopted:$('#weekly-gpt-adopted').value};
  }
  function captureDraft() {
    if (!loaded) return;
    const scope = loaded.scope, key = scope === 'daily' ? loaded.date : loaded.end;
    const draft = draftFor(scope,key);
    const times = typeof draft.updatedAt === 'object' && draft.updatedAt ? draft.updatedAt : {};
    const legacyTime = typeof draft.updatedAt === 'string' ? draft.updatedAt : null;
    for (const [name,value] of Object.entries(currentValues())) {
      if (sameValue(value,serverValues[name])) { delete draft[name]; delete times[name]; }
      else {
        if (!sameValue(draft[name],value)) times[name] = new Date().toISOString();
        else if (!times[name] && legacyTime) times[name] = legacyTime;
        draft[name] = value;
      }
    }
    draft.updatedAt = times;
    persistDraft(scope,key);
  }
  $('#review-workspace-content').addEventListener('input', captureDraft);
  $('#review-workspace-content').addEventListener('change', captureDraft);
  window.addEventListener('pagehide',captureDraft);
  document.addEventListener('visibilitychange',()=>{ if (document.hidden) captureDraft(); });

  async function saveGroup(scope,key,group,values,operation) {
    const id = `${scope}:${key}:${group}`;
    saving.add(id); saveMessages.delete(id); renderSaveStatus();
    try {
      await operation();
      const draft = draftFor(scope,key);
      for (const [name,value] of Object.entries(values)) {
        if (sameValue(draft[name],value)) delete draft[name];
      }
      if (loaded?.scope === scope && (scope === 'daily' ? loaded.date : loaded.end) === key) {
        if (scope === 'daily' && group === 'review') reviewState.has_review = true;
        Object.assign(serverValues,values);
        captureDraft();
      } else persistDraft(scope,key);
      saveMessages.set(id,`已保存到服务器 · ${statusTime(new Date().toISOString())}`);
    } catch(error) {
      saveMessages.set(id,'保存失败；已保留草稿，请重试。');
      throw error;
    } finally { saving.delete(id); renderSaveStatus(); }
  }

  function moveTabIndicator() {
    const active = reviewTabs.find(tab => tab.getAttribute('aria-selected') === 'true');
    const parent = active.parentElement.getBoundingClientRect();
    const rect = active.getBoundingClientRect();
    const indicator = $('.review-tab-indicator');
    indicator.style.width = `${rect.width}px`;
    indicator.style.transform = `translateX(${rect.left - parent.left}px)`;
  }
  function selectReviewTab(tab) {
    const previous = reviewTabs.find(item => item.getAttribute('aria-selected') === 'true');
    if (previous === tab) return;
    const direction = reviewTabs.indexOf(tab) > reviewTabs.indexOf(previous) ? 1 : -1;
    reviewTabs.forEach(item => {
      const active = item === tab;
      item.setAttribute('aria-selected', String(active));
      item.tabIndex = active ? 0 : -1;
      const panel = document.getElementById(item.getAttribute('aria-controls'));
      panel.hidden = !active;
      panel.classList.remove('review-panel-enter');
      if (active) {
        panel.style.setProperty('--review-panel-shift', `${direction * 32}px`);
        void panel.offsetWidth;
        panel.classList.add('review-panel-enter');
      }
    });
    moveTabIndicator();
  }
  reviewTabs.forEach(tab => {
    tab.onclick = () => selectReviewTab(tab);
    tab.onkeydown = event => {
      if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      event.preventDefault();
      const index = reviewTabs.indexOf(tab);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : (index + 1) % 2;
      selectReviewTab(reviewTabs[next]); reviewTabs[next].focus();
    };
  });
  new ResizeObserver(moveTabIndicator).observe($('.review-section-tabs'));

  function renderDailyOutcome(outcome) {
    $('#daily-outcome-summary').hidden = !outcome;
    $('#daily-outcome-summary').textContent = outcome ? `今天完成：${outcome}` : '';
  }

  function renderDailyReview(result) {
    reviewState = result;
    renderDailyOutcome(result.review.learning_outcome);
    renderTimeSummary($('#daily-time-summary'), result.time_summary);
    $('#daily-completed').textContent = `${result.main_completed_count} / ${result.main_task_count}`;
    $('#daily-total').textContent = `共 ${result.main_task_count} 项主任务`;
    $('#daily-main-minutes').textContent = `${result.main_planned_minutes} 分`;
    $('#daily-main-actual').textContent = `实际 ${formatMinutes(result.main_actual_minutes,result.main_actual_seconds)}`;
    $('#daily-sub-minutes').textContent = formatMinutes(result.sub_actual_minutes,result.sub_actual_seconds);
    const draft = draftFor('daily',result.date);
    serverValues = {review:result.review, response:result.gpt_record?.response_text ?? '', adopted:result.gpt_record?.adopted_text ?? ''};
    const values = {...result.review, ...(draft?.review || {})};
    Object.entries(values).forEach(([name,value]) => { if (form.elements.namedItem(name)) form.elements.namedItem(name).value = value; });
    $('#daily-gpt-response').value = draft?.response ?? result.gpt_record?.response_text ?? '';
    $('#daily-gpt-adopted').value = draft?.adopted ?? result.gpt_record?.adopted_text ?? '';
    const hasExecution = Boolean(result.task_execution_board.length);
    $('#daily-execution-board-empty').classList.toggle('hidden', hasExecution);
    $('#daily-execution-board').classList.toggle('hidden', !hasExecution);
    renderTaskExecutionBoard($('#daily-execution-board'), result.task_execution_board, '');
    $('#sunday-weekly-guide').hidden = weekday(result.date) !== 6 || settings.weekly_review_mode === 'replace_day';
    $('#reset-day').textContent = result.date === todayIso() ? '重置今天' : '重置这一天';
  }

  function renderWeeklyMetrics(result) {
    renderTimeSummary($('#weekly-time-summary'), result.time_summary);
    let outcomes = $('#weekly-outcomes');
    if (!outcomes) {
      outcomes = document.createElement('section'); outcomes.id = 'weekly-outcomes';
      outcomes.className = 'learning-outcomes';
      $('#weekly-time-summary').after(outcomes);
    }
    const completed = result.days.filter(day=>day.review.learning_outcome);
    outcomes.hidden = !completed.length;
    outcomes.innerHTML = completed.length ? `<h2>这一周完成的事</h2><ul>${completed.map(day=>`<li><button type="button" class="weekly-outcome-link" data-date="${day.date}"><span>${day.date.slice(5).replace('-','/')}</span><span>${esc(day.review.learning_outcome)}</span></button></li>`).join('')}</ul>` : '';
    $$('.weekly-outcome-link',outcomes).forEach(button=>{button.onclick=()=>navigate(button.dataset.date,'daily');});
    $('#weekly-total-time').textContent = compactTime(result.total_minutes,result.total_seconds);
    $('#weekly-effective-ratio').textContent = result.total_seconds ? `${Math.round(result.effective_ratio * 1000) / 10}%` : '—';
    $('#weekly-effective-time').textContent = compactTime(result.actual_minutes,result.actual_seconds);
    $('#weekly-efficiency-fill').style.width = `${Math.min(100, result.effective_ratio * 100)}%`;
    $('#weekly-completion-rate').textContent = result.task_count ? formatPercent(result.completion_rate) : '—';
    $('#weekly-task-count').textContent = `${result.completed_count} / ${result.task_count}`;
    $('#weekly-sub-time').textContent = compactTime(result.total_sub_minutes,result.total_sub_seconds);
    const comparison = result.comparison;
    const summary = $('#weekly-comparison-summary'), range = $('#weekly-comparison-range');
    if (comparison?.available) {
      const previous = compactTime(Math.floor(comparison.previous_seconds / 60), comparison.previous_seconds);
      const difference = comparison.difference_seconds;
      const delta = compactTime(Math.floor(Math.abs(difference) / 60), Math.abs(difference));
      const percent = comparison.change_ratio === null ? '' : `（${Math.abs(comparison.change_ratio * 100).toFixed(1)}%）`;
      summary.textContent = comparison.previous_seconds === 0
        ? '上周同期暂无投入，先记录这一周。'
        : `较上周同期${difference === 0 ? '持平' : `${difference > 0 ? '增加' : '减少'} ${delta}${percent}`} · 上周同期 ${previous}`;
      range.textContent = `主航线投入总计 · ${comparison.start_date}—${comparison.through_date} 对比 ${comparison.previous_start_date}—${comparison.previous_end_date}${comparison.in_progress ? ' · 本周统计截至今天' : ' · 两个完整自然周'}`;
    } else { summary.textContent = '这一周尚未开始'; range.textContent = '开始记录后再与上周同期比较。'; }
    const maximum = Math.max(1, ...result.days.filter(day => day.date <= todayIso()).map(day => day.main_total_seconds));
    $('#weekly-day-bars').innerHTML = result.days.map((day,index) => {
      const future = day.date > todayIso();
      const eligible = ['approved','submitted'].includes(day.status) && !future;
      const total = eligible ? day.main_total_seconds : 0;
      const ratio = total ? day.main_actual_seconds / total : 0;
      const note = future ? '未到' : !eligible || !day.task_execution_board.length ? '无记录' : formatMinutes(Math.floor(total/60),total);
      return `<button type="button" class="weekly-day-bar" data-date="${day.date}" ${future ? 'disabled' : ''} aria-label="${labels[index]} ${day.date}，${esc(note)}，有效 ${eligible ? day.main_actual_minutes : 0} 分">
        <span class="weekly-bar-value">${note}</span><span class="weekly-bar-track"><span class="weekly-bar-total" style="height:${total / maximum * 100}%"><span class="weekly-bar-effective" style="height:${Math.min(100,ratio * 100)}%"></span></span></span><strong>${labels[index]}</strong><small>${day.date.slice(5).replace('-','/')}</small>
      </button>`;
    }).join('');
    $$('.weekly-day-bar').forEach(button => button.onclick = () => navigate(button.dataset.date,'daily'));
    const items = result.task_distribution.filter(item => item.total_seconds > 0);
    $('#weekly-task-distribution').innerHTML = items.length ? items.map(item => `<article class="weekly-distribution-item"><div><strong>${esc(item.title)}</strong><span>${compactTime(item.total_minutes,item.total_seconds)}</span></div><div class="weekly-distribution-track" aria-hidden="true"><span style="width:${result.total_seconds ? item.total_seconds / result.total_seconds * 100 : 0}%"></span></div><small>有效 ${compactTime(item.effective_minutes,item.effective_seconds)}</small></article>`).join('') : '<p class="muted">本周还没有主航线投入记录。</p>';
  }

  function renderWeeklyAnalysis(result) {
    const analysis = result.analysis || {};
    $('#weekly-title-text').textContent = analysis.summary_title || '本周摘要';
    $('#weekly-title-range').textContent = `${result.start_date} — ${result.end_date}`;
    $('#weekly-status-note').textContent = result.analysis_stale ? '已有分析基于较早记录；需要更新时主动生成。' : '查看数据不会调用 AI；生成分析会发送本周记录及复盘正文。';
    const fields = {'weekly-load-advice':'load_advice','weekly-drag-factors':'drag_factors','weekly-effective-patterns':'effective_patterns','weekly-real-progress':'real_progress_assessment','weekly-next-focus':'next_week_focus'};
    Object.entries(fields).forEach(([id,key]) => { $(`#${id}`).textContent = analysis[key] || '尚未填写，可在下方与 GPT 一起整理。'; });
    const draft = draftFor('weekly',result.end_date);
    serverValues = {final:result.final_report_text ?? '', response:result.gpt_record?.response_text ?? '', adopted:result.gpt_record?.adopted_text ?? ''};
    $('#weekly-final-report').value = draft?.final ?? result.final_report_text ?? '';
    $('#weekly-gpt-response').value = draft?.response ?? result.gpt_record?.response_text ?? '';
    $('#weekly-gpt-adopted').value = draft?.adopted ?? result.gpt_record?.adopted_text ?? '';
    $('#weekly-history').innerHTML = (result.history || []).map(item => `<button type="button" class="carryover weekly-history-item" data-end-date="${item.end_date}"><div><strong>${item.start_date} → ${item.end_date}</strong><small>周复盘最终稿${item.has_final_report ? '已保存' : '未保存'}</small></div></button>`).join('') || '<p class="muted">还没有历史周复盘。</p>';
    $$('.weekly-history-item').forEach(button => button.onclick = () => navigate(button.dataset.endDate,'weekly'));
  }

  function renderWeeklyProgress(result) {
    const replace = settings.weekly_review_mode === 'replace_day';
    const replacement = Number(settings.weekly_review_day ?? 6);
    const steps = result.weekday_progress.days.map((day,index) => ({...day, scope:replace && index === replacement ? 'weekly' : 'daily'}));
    if (!replace) steps.push({date:selectedDate, label:'周复盘', scope:'weekly'});
    const hadFocus = document.activeElement?.classList.contains('review-week-step');
    $('#review-week-steps').innerHTML = steps.map(step => {
      const active = selectedScope === step.scope && (step.scope === 'weekly' || selectedDate === step.date);
      const future = step.scope === 'daily' && step.date > todayIso();
      const state = step.has_review ? '已复盘' : step.has_execution ? '已记录' : step.scope === 'weekly' ? '整周' : step.date > todayIso() ? '未到' : '待记录';
      const text = step.scope === 'weekly' ? '周复盘' : step.label;
      return `<div class="review-week-step-slot ${active ? 'is-active' : ''}" role="presentation"><button id="review-step-${step.scope}-${step.date}" type="button" class="review-week-step ${active ? 'is-active' : ''} ${step.date === todayIso() ? 'is-today' : ''} ${step.has_review ? 'has-review' : step.has_execution ? 'has-execution' : ''}" role="tab" aria-selected="${active}" aria-controls="review-workspace-content" tabindex="${active ? 0 : -1}" data-date="${step.date}" data-scope="${step.scope}" ${future ? 'disabled' : ''} aria-label="${text} ${step.date}，${state}"><strong>${text}</strong><small>${replace && step.scope === 'weekly' ? step.label : step.scope === 'weekly' ? '本周' : step.date.slice(5).replace('-','/')}<span class="review-step-dot" aria-hidden="true"></span></small></button></div>`;
    }).join('');
    const buttons = $$('.review-week-step');
    if (!buttons.some(button => button.tabIndex === 0)) buttons.find(button => !button.disabled)?.setAttribute('tabindex','0');
    buttons.forEach(button => {
      button.onclick = () => navigate(button.dataset.scope === 'weekly' ? selectedDate : button.dataset.date, button.dataset.scope);
      button.onkeydown = event => {
        if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
        event.preventDefault();
        const available = buttons.filter(item => !item.disabled);
        const index = available.indexOf(button);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + available.length) % available.length;
        available[next].focus(); available[next].click();
      };
    });
    if (hadFocus) $('.review-week-step.is-active')?.focus({preventScroll:true});
    const active = $('.review-week-step.is-active');
    const strip = $('#review-week-steps');
    if (active) {
      const buttonBox = active.getBoundingClientRect(), stripBox = strip.getBoundingClientRect();
      strip.scrollTo({left:strip.scrollLeft + buttonBox.left - stripBox.left - (strip.clientWidth - buttonBox.width) / 2,behavior:'auto'});
    }
    updateWeekScrollHint();
    const link = $('#replacement-day-link');
    const viewingReplacementDay = selectedScope === 'daily' && selectedDate === result.days[replacement].date;
    link.hidden = !(replace && (selectedScope === 'weekly' || viewingReplacementDay));
    link.textContent = selectedScope === 'weekly' ? `查看${labels[replacement]}的日复盘` : '返回周复盘';
    link.disabled = selectedScope === 'weekly' && result.days[replacement].date > todayIso();
    link.onclick = () => navigate(selectedScope === 'weekly' ? result.days[replacement].date : selectedDate, selectedScope === 'weekly' ? 'daily' : 'weekly');
    $('#review-week-range').textContent = `${result.start_date.replaceAll('-','/')} — ${result.end_date.replaceAll('-','/')}`;
    $('#review-week-range').hidden = selectedScope === 'weekly';
    const inProgress = result.start_date <= todayIso() && todayIso() <= result.end_date;
    $('#review-selected-label').textContent = selectedScope === 'weekly' ? '周复盘 · 整周' : `${labels[weekday(selectedDate)]} · ${selectedDate.replaceAll('-','/')}`;
    const periodStatus = $('#review-period-status');
    periodStatus.hidden = selectedScope !== 'weekly';
    periodStatus.textContent = inProgress ? '本周进行中 · 统计截至今天' : result.start_date > todayIso() ? '这一周尚未开始' : '整周已结束';
    if (selectedScope === 'weekly') {
      dateButton.textContent = `${result.start_date.replaceAll('-','/')} — ${result.end_date.replaceAll('-','/')}`;
      dateButton.setAttribute('aria-label',`周复盘 ${result.start_date} 至 ${result.end_date}，选择日期定位整周`);
    }
    $('#review-next-week').disabled = dateOffset(result.start_date,7) > todayIso();
    $('#review-workspace-content').setAttribute('aria-labelledby',active?.id || 'review-selected-label');
  }

  function updateWeekScrollHint() {
    const strip = $('#review-week-steps'), hint = $('#review-week-scroll-hint');
    const left = strip.scrollLeft > 2;
    const right = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 2;
    hint.hidden = !left && !right;
    hint.textContent = left && right ? '左右滑动查看本周其他日期' : left ? '向左滑动查看本周其他日期' : '向右滑动查看本周其他日期';
  }
  $('#review-week-steps').addEventListener('scroll',updateWeekScrollHint,{passive:true});
  let weekStripWidth = 0;
  new ResizeObserver(()=>{
    const strip = $('#review-week-steps'), active = $('.review-week-step.is-active');
    if (active && strip.clientWidth !== weekStripWidth) {
      const buttonBox = active.getBoundingClientRect(), stripBox = strip.getBoundingClientRect();
      strip.scrollTo({left:strip.scrollLeft + buttonBox.left - stripBox.left - (strip.clientWidth - buttonBox.width)/2,behavior:'auto'});
    }
    weekStripWidth = strip.clientWidth;
    updateWeekScrollHint();
  }).observe($('#review-week-steps'));

  async function loadDailyReview(dateValue) { return api(`/api/daily-review/${dateValue}`); }
  async function loadWorkspace(dateValue, scope, capture=true) {
    if (capture) captureDraft();
    const sequence = ++loadSequence;
    let applied = false;
    selectedDate = dateValue; selectedScope = scope;
    dateInput.value = dateValue; updateDateTrigger(dateButton, dateValue);
    $('#review-loading').hidden = false;
    $('#review-loading').textContent = '正在读取记录…';
    $('#review-retry').hidden = true;
    $('#review-workspace-content').classList.add('is-loading');
    $('#review-workspace-content').setAttribute('aria-busy','true');
    try {
      const [week, daily] = await Promise.all([
        api(`/api/${scope === 'daily' ? 'review-navigation' : 'weekly-review'}?anchor_date=${dateValue}`),
        scope === 'daily' ? loadDailyReview(dateValue) : Promise.resolve(null),
      ]);
      if (sequence !== loadSequence) return;
      weekState = week;
      if (daily) renderDailyReview(daily);
      else { renderWeeklyMetrics(week); renderWeeklyAnalysis(week); }
      ['data','reflection'].forEach(panel => {
        $(`#daily-${panel}-content`).hidden = scope !== 'daily';
        $(`#weekly-${panel}-content`).hidden = scope !== 'weekly';
      });
      $('#reset-day').hidden = scope !== 'daily';
      refreshResetRecovery(scope === 'daily' ? dateValue : null,async()=>{
        dailyDrafts.set(dateValue,{});persistDraft('daily',dateValue);
        if (selectedScope === 'daily' && selectedDate === dateValue) await loadWorkspace(dateValue,'daily',false);
      });
      renderWeeklyProgress(week);
      loaded = {date:dateValue, scope, end:week.end_date, readAt:new Date().toISOString()};
      renderSaveStatus();
      applied = true;
      history.replaceState(null,'',`/review?date=${dateValue}&scope=${scope}`);
    } catch (error) {
      if (sequence === loadSequence) {
        toast(error.message);
        $('#review-loading').textContent = '读取失败，本机草稿保留。请检查网络后重新读取。';
        $('#review-retry').hidden = false;
        return;
      }
    } finally {
      if (sequence === loadSequence) {
        $('#review-workspace-content').classList.toggle('is-loading',!applied);
        $('#review-workspace-content').setAttribute('aria-busy','false');
        $('#review-loading').hidden = applied;
      }
    }
  }
  function navigate(dateValue, scope) { return loadWorkspace(dateValue,scope); }
  $('#review-retry').onclick = () => loadWorkspace(selectedDate,selectedScope,false);
  async function withButton(button, operation) {
    button.disabled = true;
    try { await operation(); } catch(error) { toast(error.message); } finally { button.disabled = false; }
  }

  $('#review-prev-week').onclick = () => { if (weekState) navigate(dateOffset(selectedDate,-7), selectedScope); };
  $('#review-next-week').onclick = () => { if (weekState) { const next = dateOffset(selectedDate,7); navigate(selectedScope === 'daily' && next > todayIso() ? todayIso() : next,selectedScope); } };
  $('#review-this-week').onclick = () => navigate(todayIso(),settings.weekly_review_mode === 'replace_day' && weekday(todayIso()) === Number(settings.weekly_review_day) ? 'weekly' : 'daily');
  $('#open-weekly-review').onclick = () => navigate(selectedDate,'weekly');

  form.onsubmit = event => {
    event.preventDefault();
    const target = loaded?.date;
    if (!target || loaded.scope !== 'daily') return;
    const values = Object.fromEntries(new FormData(form));
    captureDraft();
    return withButton($('button[type=submit]',form), async () => {
      await saveGroup('daily',target,'review',{review:values},()=>api('/api/daily-reviews',{method:'POST',body:JSON.stringify({date:target,...values})}));
      if (loaded?.date === target && loaded.scope === 'daily') renderDailyOutcome(values.learning_outcome);
      invalidateCalendarMonth(target);
      const sequence = loadSequence;
      const navigation = await api(`/api/review-navigation?anchor_date=${target}`);
      if (sequence === loadSequence && selectedDate === target && selectedScope === 'daily') renderWeeklyProgress(navigation);
      toast(`${target} 的复盘已保存`);
    });
  };
  $('#reset-day').onclick = () => withButton($('#reset-day'), async () => {
    const target = loaded?.date;
    if (!target || loaded.scope !== 'daily') return;
    if (!(await resetDailyDataFor(target))) return;
    dailyDrafts.set(target,{});persistDraft('daily',target);
    for (const group of ['review','dailyGPT']) saveMessages.delete(`daily:${target}:${group}`);
    invalidateCalendarMonth(target);
    if (selectedDate === target && selectedScope === 'daily') await loadWorkspace(target,'daily',false);
    toast('这一天的数据已清空');
  });
  $('#copy-daily-gpt-prompt').onclick = () => withButton($('#copy-daily-gpt-prompt'), async () => {
    const result = await loadDailyReview(loaded.date);
    await navigator.clipboard.writeText(result.gpt_prompt_text);toast('已复制到剪贴板');
  });
  $('#copy-chatgpt-prompt').onclick = () => withButton($('#copy-chatgpt-prompt'), async () => {
    await navigator.clipboard.writeText(weekState.gpt_prompt_text);toast('已复制到剪贴板');
  });
  $('#save-daily-gpt-record').onclick = () => {
    const target = loaded?.date;
    if (!target || loaded.scope !== 'daily') return;
    const response = $('#daily-gpt-response').value, adopted = $('#daily-gpt-adopted').value;
    captureDraft();
    return withButton($('#save-daily-gpt-record'), async () => {
      await saveGroup('daily',target,'dailyGPT',{response,adopted},()=>api(`/api/daily-review/${target}/gpt-record`,{method:'PUT',body:JSON.stringify({response_text:response,adopted_text:adopted})}));
      toast('这次 GPT 协作已保存');
    });
  };
  $('#save-weekly-gpt-record').onclick = () => {
    const end = loaded?.end;
    if (!end || loaded.scope !== 'weekly') return;
    const response = $('#weekly-gpt-response').value, adopted = $('#weekly-gpt-adopted').value;
    captureDraft();
    return withButton($('#save-weekly-gpt-record'), async () => {
      await saveGroup('weekly',end,'weeklyGPT',{response,adopted},()=>api(`/api/weekly-review/${end}/gpt-record`,{method:'PUT',body:JSON.stringify({response_text:response,adopted_text:adopted})}));
      toast('这次 GPT 协作已保存');
    });
  };
  $('#save-weekly-report').onclick = () => {
    const end = loaded?.end;
    if (!end || loaded.scope !== 'weekly') return;
    const final = $('#weekly-final-report').value;
    captureDraft();
    return withButton($('#save-weekly-report'), async () => {
      await saveGroup('weekly',end,'final',{final},()=>api(`/api/weekly-reports/${end}`,{method:'PUT',body:JSON.stringify({final_report_text:final})}));
      toast('这周的复盘已保存');
    });
  };
  $('#refresh-weekly-report').onclick = () => {
    const end = loaded?.end, anchor = selectedDate;
    if (!end || loaded.scope !== 'weekly') return;
    captureDraft();
    return withButton($('#refresh-weekly-report'), async () => {
      await api(`/api/weekly-reports/${end}/refresh`,{method:'POST'});
      if (selectedScope === 'weekly' && selectedDate === anchor) { captureDraft(); await loadWorkspace(anchor,'weekly',false); }
      toast('本周 AI 分析已生成');
    });
  };

  api('/api/settings').then(async result => {
    settings = result;
    if (!query.has('scope') && settings.weekly_review_mode === 'replace_day' && weekday(selectedDate) === Number(settings.weekly_review_day)) selectedScope = 'weekly';
    await bindSharedCalendarTrigger(dateButton,()=>selectedDate,nextDate => navigate(nextDate,settings.weekly_review_mode === 'replace_day' && weekday(nextDate) === Number(settings.weekly_review_day) ? 'weekly' : 'daily'),'选择复盘日期');
    await loadWorkspace(selectedDate,selectedScope,false);
    moveTabIndicator();
  }).catch(error => toast(error.message));
}
