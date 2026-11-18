/* GPT 协作工作台：防抖与输入法友好的提示词模板编辑、历史协作留档浏览。 */
if (page === 'gpt-workbench') {
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

  let workbenchState = null;
  let promptScope = 'daily_gpt';
  let isComposing = false;
  let saveTimer = null;
  let saveDirty = false;
  let savePromise = null;

  function setPromptSaveStatus(text) {
    const node = $('#prompt-save-status');
    if (node) node.textContent = text;
  }

  function normalizeList(items, fallback) {
    const safe = Array.isArray(items) ? items : [];
    return safe.some(item => item.id === fallback.id)
      ? safe.map(item => (item.id === fallback.id ? { ...item, name: fallback.name, is_system: true, content: item.content || fallback.content } : item))
      : [fallback, ...safe];
  }

  function normalizePromptSettings(raw = {}) {
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
      ? { prompts: promptSettings.daily_gpt_prompts, activeId: promptSettings.daily_gpt_active_prompt_id }
      : { prompts: promptSettings.weekly_gpt_prompts, activeId: promptSettings.weekly_gpt_active_prompt_id };
  }

  async function persistPromptSettings(promptSettings) {
    const base = await ensureSettings();
    const payload = {
      ...base,
      daily_gpt_prompts: promptSettings.daily_gpt_prompts,
      daily_gpt_active_prompt_id: promptSettings.daily_gpt_active_prompt_id,
      weekly_gpt_prompts: promptSettings.weekly_gpt_prompts,
      weekly_gpt_active_prompt_id: promptSettings.weekly_gpt_active_prompt_id,
    };
    const saved = await api('/api/settings', { method: 'PUT', body: JSON.stringify(payload) });
    setSettings(saved);
    return normalizePromptSettings(saved);
  }

  function renderPromptChips(state) {
    $('#prompt-list').innerHTML = state.prompts.map(prompt => `
      <button type="button" class="prompt-chip ${prompt.id === state.activeId ? 'active' : ''}" data-id="${esc(prompt.id)}">
        ${esc(prompt.name || '未命名模板')}
      </button>
    `).join('');
    $$('.prompt-chip').forEach(button => {
      button.onclick = async () => {
        const nextId = button.dataset.id;
        if (nextId === state.activeId) return;
        await flushPendingSave();
        const nextSettings = deepClone(workbenchState.prompt_settings);
        if (promptScope === 'daily_gpt') nextSettings.daily_gpt_active_prompt_id = nextId;
        else nextSettings.weekly_gpt_active_prompt_id = nextId;
        setPromptSaveStatus('正在切换…');
        try {
          workbenchState.prompt_settings = await persistPromptSettings(nextSettings);
          setPromptSaveStatus('已同步');
          renderWorkbenchPrompts();
        } catch (error) {
          setPromptSaveStatus('切换保存失败');
          toast(error.message);
        }
      };
    });
  }

  function renderWorkbenchPrompts({ preserveActiveInputs = false } = {}) {
    const state = currentPromptState(workbenchState?.prompt_settings, promptScope);
    if (!state) return;
    $('#daily-template-tab').classList.toggle('active', promptScope === 'daily_gpt');
    $('#weekly-template-tab').classList.toggle('active', promptScope === 'weekly_gpt');
    $$('.prompt-scope-tab').forEach(button => {
      const active = button.id === (promptScope === 'daily_gpt' ? 'daily-template-tab' : 'weekly-template-tab');
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
    });
    $('#prompt-editor-panel').setAttribute('aria-labelledby', promptScope === 'daily_gpt' ? 'daily-template-tab' : 'weekly-template-tab');
    PlanUI.indicator($('.prompt-manager-switch'));
    renderPromptChips(state);

    const activePrompt = state.prompts.find(prompt => prompt.id === state.activeId) || state.prompts[0];
    $('#prompt-name-input').disabled = Boolean(activePrompt?.is_system);
    $('#delete-prompt').disabled = Boolean(activePrompt?.is_system);
    if (!preserveActiveInputs) {
      $('#prompt-name-input').value = activePrompt?.name || '';
      $('#prompt-content-input').value = activePrompt?.content || '';
    }
  }

  function syncDraftIntoMemory() {
    if (!workbenchState?.prompt_settings) return;
    const key = promptScope === 'daily_gpt' ? 'daily_gpt_prompts' : 'weekly_gpt_prompts';
    const activeId = promptScope === 'daily_gpt'
      ? workbenchState.prompt_settings.daily_gpt_active_prompt_id
      : workbenchState.prompt_settings.weekly_gpt_active_prompt_id;
    const rawName = $('#prompt-name-input').value;
    const rawContent = $('#prompt-content-input').value;
    workbenchState.prompt_settings[key] = workbenchState.prompt_settings[key].map(prompt => {
      if (prompt.id !== activeId) return prompt;
      return {
        ...prompt,
        name: prompt.is_system ? prompt.name : (rawName.trim() || prompt.name),
        content: rawContent || SYSTEM_PROMPT_DEFAULTS[promptScope].content,
      };
    });
    const state = currentPromptState(workbenchState.prompt_settings, promptScope);
    if (state) renderPromptChips(state);
  }

  async function flushPendingSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (savePromise) await savePromise;
    if (!saveDirty || !workbenchState?.prompt_settings) return;
    saveDirty = false;
    syncDraftIntoMemory();
    const snapshot = deepClone(workbenchState.prompt_settings);
    setPromptSaveStatus('正在自动保存…');
    savePromise = persistPromptSettings(snapshot)
      .then(saved => {
        if (!saveDirty) {
          workbenchState.prompt_settings = saved;
          renderWorkbenchPrompts({ preserveActiveInputs: true });
          setPromptSaveStatus('已自动保存');
        }
      })
      .catch(error => {
        saveDirty = true;
        setPromptSaveStatus('自动保存失败，请检查网络');
        toast(error.message);
      })
      .finally(() => {
        savePromise = null;
      });
    await savePromise;
  }

  function schedulePromptSave() {
    if (!workbenchState?.prompt_settings) return;
    saveDirty = true;
    syncDraftIntoMemory();
    setPromptSaveStatus('未保存修改…');
    if (isComposing) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      flushPendingSave();
    }, 450);
  }

  function renderWorkbenchRecords() {
    const records = [
      ...(workbenchState?.daily_records || []).map(item => ({ ...item, scopeLabel: '单日' })),
      ...(workbenchState?.weekly_records || []).map(item => ({ ...item, scopeLabel: '单周' })),
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
          <small>${esc((item.updated_at || '').replace('T', ' '))}</small>
        </div>
        <p><strong>采纳动作：</strong>${esc(item.adopted_text || '尚未填写')}</p>
        <details>
          <summary>查看 GPT 回复全文</summary>
          <pre>${esc(item.response_text || '尚未保存回复')}</pre>
        </details>
      </article>
    `).join('');
  }

  async function loadWorkbench() {
    try {
      const [result] = await Promise.all([api('/api/gpt-workbench'), ensureSettings()]);
      workbenchState = {
        ...result,
        prompt_settings: normalizePromptSettings(result.prompt_settings || {}),
      };
      renderWorkbenchPrompts();
      renderWorkbenchRecords();
      setPromptSaveStatus('已同步');
    } catch (error) {
      toast(error.message);
    }
  }

  async function selectPromptScope(next) {
    if (promptScope === next) return;
    const direction = next === 'weekly_gpt' ? 1 : -1;
    // 先即时切换页签与动效，若有未保存草稿在后台先落库当前范围
    const pendingFlush = saveDirty ? flushPendingSave() : null;
    promptScope = next;
    renderWorkbenchPrompts();
    PlanUI.enter($('#prompt-editor-panel'), direction);
    if (pendingFlush) await pendingFlush;
  }

  $('#daily-template-tab').onclick = () => selectPromptScope('daily_gpt');
  $('#weekly-template-tab').onclick = () => selectPromptScope('weekly_gpt');
  $$('.prompt-scope-tab').forEach(button => {
    button.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const weekly = event.key === 'End' || (event.key !== 'Home' && promptScope === 'daily_gpt');
      selectPromptScope(weekly ? 'weekly_gpt' : 'daily_gpt');
      $(weekly ? '#weekly-template-tab' : '#daily-template-tab').focus();
    };
  });
  new ResizeObserver(() => PlanUI.indicator($('.prompt-manager-switch'))).observe($('.prompt-manager-switch'));

  $('#add-prompt').onclick = async () => {
    await flushPendingSave();
    const nextSettings = deepClone(workbenchState.prompt_settings);
    const key = promptScope === 'daily_gpt' ? 'daily_gpt_prompts' : 'weekly_gpt_prompts';
    const activeKey = promptScope === 'daily_gpt' ? 'daily_gpt_active_prompt_id' : 'weekly_gpt_active_prompt_id';
    const item = {
      id: `${promptScope}_${Date.now()}`,
      name: `${promptScope === 'daily_gpt' ? '单日模板 ' : '单周模板 '}${nextSettings[key].length}`,
      content: SYSTEM_PROMPT_DEFAULTS[promptScope].content,
      is_system: false,
    };
    nextSettings[key].push(item);
    nextSettings[activeKey] = item.id;
    workbenchState.prompt_settings = await persistPromptSettings(nextSettings);
    setPromptSaveStatus('已新建并同步');
    renderWorkbenchPrompts();
    $('#prompt-name-input').focus();
    $('#prompt-name-input').select();
  };

  $('#delete-prompt').onclick = async () => {
    await flushPendingSave();
    const state = currentPromptState(workbenchState?.prompt_settings, promptScope);
    const activePrompt = state?.prompts.find(prompt => prompt.id === state.activeId);
    if (!activePrompt || activePrompt.is_system) return;
    if (!await confirmAction(`确定删除模板「${activePrompt.name}」吗？删除后将切回系统默认模板，历史协作留档不受影响。`, {
      title: '删除提示词模板？',
      confirmLabel: '确认删除',
    })) return;
    const nextSettings = deepClone(workbenchState.prompt_settings);
    const key = promptScope === 'daily_gpt' ? 'daily_gpt_prompts' : 'weekly_gpt_prompts';
    const activeKey = promptScope === 'daily_gpt' ? 'daily_gpt_active_prompt_id' : 'weekly_gpt_active_prompt_id';
    nextSettings[key] = nextSettings[key].filter(prompt => prompt.id !== activePrompt.id);
    nextSettings[activeKey] = SYSTEM_PROMPT_DEFAULTS[promptScope].id;
    workbenchState.prompt_settings = await persistPromptSettings(nextSettings);
    setPromptSaveStatus('已删除并切回默认');
    renderWorkbenchPrompts();
    toast('模板已删除');
  };

  $('#restore-system-prompt').onclick = async () => {
    await flushPendingSave();
    if (!await confirmAction('将当前范围的「系统默认」模板恢复为初始提示词文本？你自建的其他模板会保留。', {
      title: '恢复系统默认模板？',
      confirmLabel: '恢复默认',
    })) return;
    const nextSettings = deepClone(workbenchState.prompt_settings);
    const key = promptScope === 'daily_gpt' ? 'daily_gpt_prompts' : 'weekly_gpt_prompts';
    const activeKey = promptScope === 'daily_gpt' ? 'daily_gpt_active_prompt_id' : 'weekly_gpt_active_prompt_id';
    nextSettings[key] = nextSettings[key].map(prompt => (
      prompt.id === SYSTEM_PROMPT_DEFAULTS[promptScope].id
        ? { ...prompt, ...SYSTEM_PROMPT_DEFAULTS[promptScope] }
        : prompt
    ));
    nextSettings[activeKey] = SYSTEM_PROMPT_DEFAULTS[promptScope].id;
    workbenchState.prompt_settings = await persistPromptSettings(nextSettings);
    setPromptSaveStatus('已恢复系统默认');
    renderWorkbenchPrompts();
    toast('已恢复系统默认提示词');
  };

  [$('#prompt-name-input'), $('#prompt-content-input')].forEach(field => {
    field.addEventListener('compositionstart', () => { isComposing = true; });
    field.addEventListener('compositionend', () => {
      isComposing = false;
      schedulePromptSave();
    });
    field.addEventListener('input', () => schedulePromptSave());
    field.addEventListener('blur', () => { if (saveDirty && !isComposing) flushPendingSave(); });
  });

  window.addEventListener('pagehide', () => {
    if (saveDirty && !isComposing) flushPendingSave();
  });

  loadWorkbench();
}
