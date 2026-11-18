/* 设置页：主航线项目配置、晨间显示偏好、执行与有效细分折叠管理、数据库备份。 */
if (page === 'settings') {
  let settingsState = null;
  const openEffectiveCategories = new Set();

  function markDirty(dirty = true) {
    const hint = $('#settings-dirty-hint');
    if (hint) hint.hidden = !dirty;
  }

  function knownCategoryTitles() {
    const catalog = settingsState?.category_catalog || {};
    const titles = {};
    Object.entries(catalog).forEach(([key, meta]) => {
      titles[key] = meta.title || meta.default_title || key;
    });
    Object.entries(settingsState?.task_titles || {}).forEach(([key, label]) => {
      titles[key] = label || titles[key] || key;
    });
    return titles;
  }

  function renderOtherProjectNames() {
    const selected = new Set(settingsState.main_project_categories);
    const allTitles = knownCategoryTitles();
    $('#task-title-fields').innerHTML = Object.entries(allTitles)
      .filter(([key]) => !selected.has(key))
      .map(([key, label]) => `<label>${esc(settingsState?.category_catalog?.[key]?.default_title || label)}<input data-category="${esc(key)}" value="${esc(settingsState.task_titles[key] || label)}"></label>`)
      .join('');
    $$('#task-title-fields input').forEach(input => {
      input.oninput = () => {
        settingsState.task_titles[input.dataset.category] = input.value;
        markDirty(true);
      };
    });
  }

  function renderMainProjects() {
    const selected = settingsState.main_project_categories;
    const allTitles = knownCategoryTitles();
    $('#main-project-fields').innerHTML = selected.map((category, index) => {
      const displayName = settingsState.task_titles[category] || allTitles[category] || '';
      return `<div class="main-project-row" data-project-category="${esc(category)}">
        <label>项目名称<input data-main-project-name="${esc(category)}" maxlength="100" required value="${esc(displayName)}"></label>
        <label>默认分钟<input data-draft-main-category="${esc(category)}" type="number" min="0" max="720" step="1" required value="${settingsState.draft_main_minutes_by_category[category] ?? 0}"></label>
        <div class="main-project-actions">
          <button class="ghost-button main-project-up" type="button" ${index === 0 ? 'disabled' : ''} aria-label="上移${esc(displayName)}" title="上移">${uiIcon('up')}</button>
          <button class="ghost-button main-project-down" type="button" ${index === selected.length - 1 ? 'disabled' : ''} aria-label="下移${esc(displayName)}" title="下移">${uiIcon('down')}</button>
          <button class="ghost-button main-project-remove" type="button" ${selected.length === 1 ? 'disabled' : ''}>移出</button>
        </div>
      </div>`;
    }).join('');

    $$('#main-project-fields [data-main-project-name]').forEach(input => {
      input.oninput = () => {
        settingsState.task_titles[input.dataset.mainProjectName] = input.value;
        markDirty(true);
      };
    });
    $$('#main-project-fields [data-draft-main-category]').forEach(input => {
      input.oninput = () => {
        settingsState.draft_main_minutes_by_category[input.dataset.draftMainCategory] = Number(input.value);
        markDirty(true);
      };
    });
    $$('#main-project-fields button').forEach(button => {
      button.onclick = () => {
        const category = button.closest('[data-project-category]').dataset.projectCategory;
        const index = selected.indexOf(category);
        if (button.classList.contains('main-project-remove')) {
          selected.splice(index, 1);
        } else {
          const next = index + (button.classList.contains('main-project-up') ? -1 : 1);
          [selected[index], selected[next]] = [selected[next], selected[index]];
        }
        markDirty(true);
        renderMainProjects();
      };
    });

    $('#main-project-add').disabled = selected.length >= 11;
    const available = Object.entries(knownCategoryTitles()).filter(([category]) => !selected.includes(category));
    $('#main-project-existing').innerHTML = '<option value="">从已有项目加入…</option>'
      + available.map(([category, title]) => `<option value="${esc(category)}">${esc(settingsState.task_titles[category] || title)}</option>`).join('');
    $('#main-project-add-existing').disabled = selected.length >= 11 || !available.length;
    $('#settings-form').rehab_enabled.checked = selected.includes('rehab');
    renderOtherProjectNames();
    renderEffectiveLabelFields();
  }

  $('#main-project-add').onclick = () => {
    if (!settingsState || settingsState.main_project_categories.length >= 11) return;
    const input = $('#main-project-new-name');
    const title = input.value.trim();
    if (!title) {
      input.focus();
      toast('先填写新项目名称');
      return;
    }
    const category = `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    settingsState.task_titles[category] = title;
    settingsState.draft_main_minutes_by_category[category] = 0;
    settingsState.main_project_categories.push(category);
    input.value = '';
    markDirty(true);
    renderMainProjects();
    $(`[data-main-project-name="${category}"]`)?.focus();
  };

  $('#main-project-add-existing').onclick = () => {
    const category = $('#main-project-existing').value;
    if (!category || !settingsState || settingsState.main_project_categories.length >= 11) return;
    const allTitles = knownCategoryTitles();
    settingsState.task_titles[category] ||= allTitles[category] || '项目';
    settingsState.draft_main_minutes_by_category[category] ??= 0;
    settingsState.main_project_categories.push(category);
    markDirty(true);
    renderMainProjects();
  };

  function renderExecutionLabelFields() {
    $('#execution-label-fields').innerHTML = (settingsState?.execution_labels || []).map(label => `
      <div class="execution-label-row" data-label-id="${esc(label.id)}">
        <label>名称<input class="execution-label-name" maxlength="50" required value="${esc(label.name)}"></label>
        <label>归类
          <select class="execution-label-bucket">
            ${['distraction', 'rest', 'external', 'life'].map(category => `<option value="${category}" ${labelTimeCategory(label) === category ? 'selected' : ''}>${timeCategoryNames[category]}</option>`).join('')}
          </select>
        </label>
        ${label.is_system ? '<span class="status execution-label-origin">默认</span>' : '<button class="ghost-button execution-label-delete" type="button">删除</button>'}
      </div>
    `).join('');

    $$('.execution-label-name').forEach(input => {
      input.oninput = event => {
        const row = event.target.closest('.execution-label-row');
        const item = settingsState.execution_labels.find(label => label.id === row.dataset.labelId);
        if (item) {
          item.name = event.target.value;
          markDirty(true);
        }
      };
    });
    $$('.execution-label-bucket').forEach(select => {
      select.onchange = event => {
        const row = event.target.closest('.execution-label-row');
        const item = settingsState.execution_labels.find(label => label.id === row.dataset.labelId);
        if (item) {
          item.time_category = event.target.value;
          item.bucket = item.time_category === 'distraction' ? 'counted' : 'interrupt';
          markDirty(true);
        }
      };
    });
    $$('.execution-label-delete').forEach(button => {
      button.onclick = () => {
        const row = button.closest('.execution-label-row');
        settingsState.execution_labels = settingsState.execution_labels.filter(label => label.id !== row.dataset.labelId);
        markDirty(true);
        renderExecutionLabelFields();
      };
    });
  }

  function addExecutionLabel(bucket) {
    settingsState.execution_labels.push({
      id: `custom_${bucket}_${Date.now()}`,
      name: '新标签',
      time_category: 'distraction',
      bucket,
      is_system: false,
    });
    markDirty(true);
    renderExecutionLabelFields();
    const input = $$('.execution-label-name').at(-1);
    input?.focus();
    input?.select();
  }

  function effectiveLabelsForCategoryState(category) {
    if (!settingsState.effective_labels_by_category) settingsState.effective_labels_by_category = {};
    if (!Array.isArray(settingsState.effective_labels_by_category[category])) {
      settingsState.effective_labels_by_category[category] = [];
    }
    return settingsState.effective_labels_by_category[category];
  }

  function renderEffectiveLabelFields() {
    const allTitles = knownCategoryTitles();
    $('#effective-label-category-fields').innerHTML = Object.entries(allTitles).map(([category, label]) => {
      const items = effectiveLabelsForCategoryState(category);
      const isOpen = openEffectiveCategories.has(category);
      const rows = items.map(item => `
        <div class="effective-label-row" data-category="${esc(category)}" data-label-id="${esc(item.id)}">
          <label>名称<input class="effective-label-name" maxlength="50" value="${esc(item.name)}"></label>
          <span class="status">${item.is_system ? '默认' : '自建'}</span>
          <button class="ghost-button effective-label-delete" type="button">删除</button>
        </div>
      `).join('');
      return `
        <details class="effective-label-category-card" data-effective-category="${esc(category)}" ${isOpen ? 'open' : ''}>
          <summary class="effective-label-category-summary">
            <h3>${esc(settingsState.task_titles[category] || label)}</h3>
            <span class="badge">${items.length ? `${items.length} 个细分` : '未设细分'}</span>
          </summary>
          <div class="effective-label-category-body">
            <div class="effective-label-category-head">
              <span class="muted">${items.length ? '用于该科目的有效学习细分。' : '当前为空，可按需补充。'}</span>
              <button class="ghost-button add-effective-label" type="button" data-category="${esc(category)}">新增细分标签</button>
            </div>
            <div class="stack">
              ${rows}
            </div>
          </div>
        </details>
      `;
    }).join('');

    $$('.effective-label-category-card').forEach(details => {
      details.ontoggle = () => {
        const cat = details.dataset.effectiveCategory;
        if (details.open) openEffectiveCategories.add(cat);
        else openEffectiveCategories.delete(cat);
      };
    });

    $$('.effective-label-name').forEach(input => {
      input.oninput = event => {
        const row = event.target.closest('.effective-label-row');
        const item = effectiveLabelsForCategoryState(row.dataset.category).find(label => label.id === row.dataset.labelId);
        if (item) {
          item.name = event.target.value;
          markDirty(true);
        }
      };
    });
    $$('.effective-label-delete').forEach(button => {
      button.onclick = () => {
        const row = button.closest('.effective-label-row');
        if (!settingsState.deleted_effective_label_ids) settingsState.deleted_effective_label_ids = {};
        const deleted = (settingsState.deleted_effective_label_ids[row.dataset.category] ||= []);
        if (!deleted.includes(row.dataset.labelId)) deleted.push(row.dataset.labelId);
        settingsState.effective_labels_by_category[row.dataset.category] = effectiveLabelsForCategoryState(row.dataset.category)
          .filter(label => label.id !== row.dataset.labelId);
        markDirty(true);
        renderEffectiveLabelFields();
      };
    });
    $$('.add-effective-label').forEach(button => {
      button.onclick = () => {
        const category = button.dataset.category;
        openEffectiveCategories.add(category);
        effectiveLabelsForCategoryState(category).push({
          id: `effective_${category}_${Date.now()}`,
          name: '新细分标签',
          is_system: false,
        });
        markDirty(true);
        renderEffectiveLabelFields();
        const card = $(`.effective-label-category-card[data-effective-category="${category}"]`);
        const lastInput = $$('.effective-label-name', card).at(-1);
        lastInput?.focus();
        lastInput?.select();
      };
    });
  }

  ensureSettings(true).then(result => {
    settingsState = deepClone(result);
    settingsState.main_project_categories = (result.main_project_categories || ['math', 'english', 'computer', 'rehab'])
      .filter(category => category !== 'rehab' || result.rehab_enabled);
    Object.entries(settingsState.effective_labels_by_category || {}).forEach(([cat, items]) => {
      if (Array.isArray(items) && items.length > 0) openEffectiveCategories.add(cat);
    });

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
    form.weekly_review_mode.onchange = () => {
      $('#weekly-review-day-field').hidden = form.weekly_review_mode.value !== 'replace_day';
      markDirty(true);
    };
    form.addEventListener('input', event => {
      if (event.target.id === 'main-project-new-name') return;
      markDirty(true);
    });
    form.addEventListener('change', event => {
      if (event.target.id === 'main-project-existing') return;
      markDirty(true);
    });

    renderMainProjects();
    renderExecutionLabelFields();
    markDirty(false);
  }).catch(error => toast(error.message));

  $('#add-execution-label').onclick = () => addExecutionLabel('counted');
  $('#export-backup').onclick = async () => {
    try {
      await downloadBackupFile();
      toast('备份已开始下载');
    } catch (error) {
      toast(error.message);
    }
  };

  $('#settings-form').onsubmit = async event => {
    event.preventDefault();
    const form = event.target;
    const task_titles = {
      ...settingsState.task_titles,
      ...Object.fromEntries($$('#main-project-fields [data-main-project-name]').map(input => [input.dataset.mainProjectName, input.value.trim()])),
    };
    const draft_main_minutes_by_category = {
      ...settingsState.draft_main_minutes_by_category,
      ...Object.fromEntries($$('[data-draft-main-category]').map(input => [input.dataset.draftMainCategory, Number(input.value || 0)])),
    };
    try {
      const saved = await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          current_stage: form.current_stage.value,
          ai_project_weekly_frequency: Number(form.ai_project_weekly_frequency.value),
          rehab_enabled: settingsState.main_project_categories.includes('rehab'),
          main_project_categories: settingsState.main_project_categories,
          show_energy_selector: form.show_energy_selector.checked,
          show_day_type_selector: form.show_day_type_selector.checked,
          project_start_date: form.project_start_date.value,
          weekly_review_mode: form.weekly_review_mode.value,
          weekly_review_day: Number(form.weekly_review_day.value),
          budget_minimum: Number(settingsState.budget_minimum || 90),
          budget_normal: Number(settingsState.budget_normal || 150),
          budget_ample: Number(settingsState.budget_ample || 210),
          task_titles,
          draft_main_minutes_by_category,
          execution_labels: settingsState.execution_labels,
          effective_labels_by_category: settingsState.effective_labels_by_category,
          deleted_effective_label_ids: settingsState.deleted_effective_label_ids || {},
        }),
      });
      setSettings(saved);
      settingsState = deepClone(saved);
      settingsState.main_project_categories = (saved.main_project_categories || ['math', 'english', 'computer', 'rehab'])
        .filter(category => category !== 'rehab' || saved.rehab_enabled);
      renderMainProjects();
      renderExecutionLabelFields();
      invalidateAllCalendarMonths();
      markDirty(false);
      toast('设置已保存');
    } catch (error) {
      toast(error.message);
    }
  };
}
