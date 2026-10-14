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
  function compactTime(minutes) {
    const value = Math.max(0, Math.round(Number(minutes || 0)));
    return value < 60 ? `${value} 分` : `${Math.floor(value / 60)} 小时 ${value % 60} 分`;
  }
  function captureDraft() {
    if (!loaded) return;
    if (loaded.scope === 'daily') {
      dailyDrafts.set(loaded.date, {
        review: Object.fromEntries(new FormData(form)),
        response: $('#daily-gpt-response').value, adopted: $('#daily-gpt-adopted').value,
      });
    } else {
      weeklyDrafts.set(loaded.end, {
        final: $('#weekly-final-report').value,
        response: $('#weekly-gpt-response').value, adopted: $('#weekly-gpt-adopted').value,
      });
    }
  }
  $('#review-workspace-content').addEventListener('input', captureDraft);
  $('#review-workspace-content').addEventListener('change', captureDraft);

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

  function renderDailyReview(result) {
    reviewState = result;
    $('#daily-completed').textContent = `${result.main_completed_count} / ${result.main_task_count}`;
    $('#daily-total').textContent = `共 ${result.main_task_count} 项主任务`;
    $('#daily-main-minutes').textContent = `${result.main_planned_minutes} 分`;
    $('#daily-main-actual').textContent = `实际 ${result.main_actual_minutes} 分`;
    $('#daily-sub-minutes').textContent = `${result.sub_actual_minutes} 分`;
    const draft = dailyDrafts.get(result.date);
    const values = draft?.review || result.review;
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
    $('#weekly-total-time').textContent = compactTime(result.total_minutes);
    $('#weekly-effective-ratio').textContent = result.total_minutes ? `${Math.round(result.effective_ratio * 1000) / 10}%` : '—';
    $('#weekly-effective-time').textContent = compactTime(result.actual_minutes);
    $('#weekly-efficiency-fill').style.width = `${Math.min(100, result.effective_ratio * 100)}%`;
    $('#weekly-completion-rate').textContent = result.task_count ? formatPercent(result.completion_rate) : '—';
    $('#weekly-task-count').textContent = `${result.completed_count} / ${result.task_count}`;
    $('#weekly-sub-time').textContent = compactTime(result.total_sub_minutes);
    const maximum = Math.max(1, ...result.days.filter(day => day.date <= todayIso()).map(day => day.main_total_minutes));
    $('#weekly-day-bars').innerHTML = result.days.map((day,index) => {
      const future = day.date > todayIso();
      const eligible = ['approved','submitted'].includes(day.status) && !future;
      const total = eligible ? day.main_total_minutes : 0;
      const ratio = total ? day.main_actual_minutes / total : 0;
      const note = future ? '未到' : !eligible || !day.task_execution_board.length ? '无记录' : `${total} 分`;
      return `<button type="button" class="weekly-day-bar" data-date="${day.date}" ${future ? 'disabled' : ''} aria-label="${labels[index]} ${day.date}，${esc(note)}，有效 ${eligible ? day.main_actual_minutes : 0} 分">
        <span class="weekly-bar-value">${note}</span><span class="weekly-bar-track"><span class="weekly-bar-total" style="height:${total / maximum * 100}%"><span class="weekly-bar-effective" style="height:${Math.min(100,ratio * 100)}%"></span></span></span><strong>${labels[index]}</strong><small>${day.date.slice(5).replace('-','/')}</small>
      </button>`;
    }).join('');
    $$('.weekly-day-bar').forEach(button => button.onclick = () => navigate(button.dataset.date,'daily'));
    const items = result.task_distribution.filter(item => item.total_minutes > 0);
    $('#weekly-task-distribution').innerHTML = items.length ? items.map(item => `<article class="weekly-distribution-item"><div><strong>${esc(item.title)}</strong><span>${compactTime(item.total_minutes)}</span></div><div class="weekly-distribution-track" aria-hidden="true"><span style="width:${result.total_minutes ? item.total_minutes / result.total_minutes * 100 : 0}%"></span></div><small>有效 ${compactTime(item.effective_minutes)}</small></article>`).join('') : '<p class="muted">本周还没有主航线投入记录。</p>';
  }

  function renderWeeklyAnalysis(result) {
    const analysis = result.analysis || {};
    $('#weekly-title-text').textContent = analysis.summary_title || '本周摘要';
    $('#weekly-title-range').textContent = `${result.start_date} — ${result.end_date}`;
    $('#weekly-status-note').textContent = '先整理本周事实，再留下你的判断与下一步。';
    const fields = {'weekly-load-advice':'load_advice','weekly-drag-factors':'drag_factors','weekly-effective-patterns':'effective_patterns','weekly-real-progress':'real_progress_assessment','weekly-next-focus':'next_week_focus'};
    Object.entries(fields).forEach(([id,key]) => { $(`#${id}`).textContent = analysis[key] || '尚未填写，可在下方与 GPT 一起整理。'; });
    const draft = weeklyDrafts.get(result.end_date);
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
    if (!replace) steps.push({date:result.end_date, label:'周复盘', scope:'weekly'});
    const hadFocus = document.activeElement?.classList.contains('review-week-step');
    $('#review-week-steps').innerHTML = steps.map(step => {
      const active = selectedScope === step.scope && (step.scope === 'weekly' || selectedDate === step.date);
      const future = step.scope === 'daily' && step.date > todayIso();
      const state = step.has_review ? '已复盘' : step.has_execution ? '已记录' : step.scope === 'weekly' ? '整周' : step.date > todayIso() ? '未到' : '待记录';
      const text = step.scope === 'weekly' ? '周复盘' : step.label;
      return `<button id="review-step-${step.scope}-${step.date}" type="button" class="review-week-step ${active ? 'is-active' : ''} ${step.date === todayIso() ? 'is-today' : ''} ${step.has_review ? 'has-review' : step.has_execution ? 'has-execution' : ''}" role="tab" aria-selected="${active}" aria-controls="review-workspace-content" tabindex="${active ? 0 : -1}" data-date="${step.date}" data-scope="${step.scope}" ${future ? 'disabled' : ''} aria-label="${text} ${step.date}，${state}"><strong>${text}</strong><small>${replace && step.scope === 'weekly' ? step.label : step.scope === 'weekly' ? '本周' : step.date.slice(5).replace('-','/')}<span class="review-step-dot" aria-hidden="true"></span></small></button>`;
    }).join('');
    const buttons = $$('.review-week-step');
    if (!buttons.some(button => button.tabIndex === 0)) buttons.find(button => !button.disabled)?.setAttribute('tabindex','0');
    buttons.forEach(button => {
      button.onclick = () => navigate(button.dataset.date, button.dataset.scope);
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
    if (active) strip.scrollTo({left:active.offsetLeft - strip.offsetLeft - (strip.clientWidth - active.offsetWidth) / 2,behavior:'auto'});
    const link = $('#replacement-day-link');
    const viewingReplacementDay = selectedScope === 'daily' && selectedDate === result.days[replacement].date;
    link.hidden = !(replace && (selectedScope === 'weekly' || viewingReplacementDay));
    link.textContent = selectedScope === 'weekly' ? `查看${labels[replacement]}的日复盘` : '返回周复盘';
    link.disabled = selectedScope === 'weekly' && result.days[replacement].date > todayIso();
    link.onclick = () => navigate(result.days[replacement].date, selectedScope === 'weekly' ? 'daily' : 'weekly');
    $('#review-week-range').textContent = `${result.start_date.replaceAll('-','/')} — ${result.end_date.replaceAll('-','/')}`;
    $('#review-selected-label').textContent = selectedScope === 'weekly' ? '周复盘 · 整周' : `${labels[weekday(selectedDate)]} · ${selectedDate.replaceAll('-','/')}`;
    $('#review-next-week').disabled = dateOffset(result.start_date,7) > todayIso();
    $('#review-workspace-content').setAttribute('aria-labelledby','review-selected-label');
  }

  async function loadDailyReview(dateValue) { return api(`/api/daily-review/${dateValue}`); }
  async function loadWorkspace(dateValue, scope, capture=true) {
    if (capture) captureDraft();
    const sequence = ++loadSequence;
    let applied = false;
    selectedDate = dateValue; selectedScope = scope;
    dateInput.value = dateValue; updateDateTrigger(dateButton, dateValue);
    $('#review-loading').hidden = false;
    $('#review-workspace-content').classList.add('is-loading');
    $('#review-workspace-content').setAttribute('aria-busy','true');
    try {
      const [week, daily] = await Promise.all([
        api(`/api/weekly-review?anchor_date=${dateValue}`),
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
      renderWeeklyProgress(week);
      loaded = {date:dateValue, scope, end:week.end_date};
      applied = true;
      history.replaceState(null,'',`/review?date=${dateValue}&scope=${scope}`);
    } catch (error) {
      if (sequence === loadSequence) {
        toast(error.message);
        $('#review-loading').textContent = '读取失败，请重新选择日期。';
        return;
      }
    } finally {
      if (sequence === loadSequence) {
        $('#review-workspace-content').classList.toggle('is-loading',!applied);
        $('#review-workspace-content').setAttribute('aria-busy','false');
        $('#review-loading').hidden = Boolean(loaded && loaded.date === dateValue && loaded.scope === scope);
      }
    }
  }
  function navigate(dateValue, scope) { return loadWorkspace(dateValue,scope); }
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
      await api('/api/daily-reviews',{method:'POST',body:JSON.stringify({date:target,...values})});
      // 保存当次提交的内容；保存过程中继续输入的草稿仍保留。
      const draft = dailyDrafts.get(target);
      if (draft && JSON.stringify(draft.review) === JSON.stringify(values)) delete draft.review;
      invalidateCalendarMonth(target);
      if (selectedDate === target && selectedScope === 'daily') await loadWorkspace(target,'daily',false);
      toast(`${target} 的复盘已保存`);
    });
  };
  $('#reset-day').onclick = () => withButton($('#reset-day'), async () => {
    const target = loaded?.date;
    if (!target || loaded.scope !== 'daily') return;
    if (!(await resetDailyDataFor(target))) return;
    dailyDrafts.delete(target);invalidateCalendarMonth(target);
    if (selectedDate === target && selectedScope === 'daily') await loadWorkspace(target,'daily',false);
    toast('这一天的数据已清空');
  });
  $('#copy-daily-gpt-prompt').onclick = () => withButton($('#copy-daily-gpt-prompt'), async () => {
    await navigator.clipboard.writeText(reviewState.gpt_prompt_text);toast('已复制到剪贴板');
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
      await api(`/api/daily-review/${target}/gpt-record`,{method:'PUT',body:JSON.stringify({response_text:response,adopted_text:adopted})});
      toast('这次 GPT 协作已保存');
    });
  };
  $('#save-weekly-gpt-record').onclick = () => {
    const end = loaded?.end;
    if (!end || loaded.scope !== 'weekly') return;
    const response = $('#weekly-gpt-response').value, adopted = $('#weekly-gpt-adopted').value;
    captureDraft();
    return withButton($('#save-weekly-gpt-record'), async () => {
      await api(`/api/weekly-review/${end}/gpt-record`,{method:'PUT',body:JSON.stringify({response_text:response,adopted_text:adopted})});
      toast('这次 GPT 协作已保存');
    });
  };
  $('#save-weekly-report').onclick = () => {
    const end = loaded?.end, anchor = selectedDate;
    if (!end || loaded.scope !== 'weekly') return;
    const final = $('#weekly-final-report').value;
    captureDraft();
    return withButton($('#save-weekly-report'), async () => {
      await api(`/api/weekly-reports/${end}`,{method:'PUT',body:JSON.stringify({final_report_text:final})});
      const draft = weeklyDrafts.get(end); if (draft?.final === final) delete draft.final;
      if (selectedScope === 'weekly' && selectedDate === anchor) await loadWorkspace(anchor,'weekly',false);
      toast('这周的复盘已保存');
    });
  };
  $('#refresh-weekly-report').onclick = () => {
    const end = loaded?.end, anchor = selectedDate;
    if (!end || loaded.scope !== 'weekly') return;
    captureDraft();
    return withButton($('#refresh-weekly-report'), async () => {
      await api(`/api/weekly-reports/${end}/refresh`,{method:'POST'});
      if (selectedScope === 'weekly' && selectedDate === anchor) await loadWorkspace(anchor,'weekly',false);
      toast('本周整理已刷新');
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
