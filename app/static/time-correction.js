/* 时间修正：快捷执行与快捷设置分开；手机选择时替换当前内容。 */
class TimeCorrectionDialog {
  constructor(options) {
    this.options = options;
    this.dialog = document.querySelector('#quick-correction-dialog');
    this.body = this.dialog.querySelector('#time-correction-body');
    this.error = this.dialog.querySelector('#quick-correction-error');
    this.title = this.dialog.querySelector('#quick-correction-title');
    this.back = this.dialog.querySelector('#time-correction-back');
    this.close = this.dialog.querySelector('#quick-correction-close');
    this.addControl = this.dialog.querySelector('#time-correction-add');
    this.manageControl = this.dialog.querySelector('#time-correction-manage');
    this.addControl.onclick = event => this.handleClick(event);
    this.manageControl.onclick = event => this.handleClick(event);
    this.opener = document.querySelector('#quick-correction-open');
    this.feedback = document.querySelector('#time-correction-feedback');
    this.mobile = matchMedia('(max-width: 600px)');
    this.opener.onclick = () => this.open();
    this.close.onclick = () => { if (!this.busy) this.dialog.close(); };
    this.back.onclick = () => { if (!this.busy) { if (this.picker) this.picker = null; else this.screen = 'home'; this.show(); } };
    this.dialog.addEventListener('cancel', event => { if (this.busy) event.preventDefault(); });
    this.dialog.addEventListener('close', () => this.opener.focus({preventScroll:true}));
    this.dialog.addEventListener('click', event => {
      if (event.target !== this.dialog || this.busy) return;
      const box = this.dialog.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) this.dialog.close();
    });
    this.body.addEventListener('click', event => this.handleClick(event));
    this.body.addEventListener('change', event => {
      if (this.busy) return;
      const field = event.target.dataset.correctionField;
      if (field === 'activity') this.activity = event.target.value;
      else if (field === 'task') { this.task = Number(event.target.value); this.effectiveLabel = ''; }
      else if (field === 'effectiveLabel') this.effectiveLabel = event.target.value;
      else return;
      this.show();
    });
    this.dialog.querySelector('form').onsubmit = event => {
      event.preventDefault();
      if (this.busy) return;
      if (this.picker) this.pickCustom();
      else if (this.screen === 'add') this.addShortcut();
      else if (this.screen === 'detail') this.saveCorrection();
    };
    this.mobile.addEventListener('change', () => { if (this.dialog.open) this.show(); });
    this.feedback.querySelector('button').onclick = () => this.undo();
  }
  escape(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  icon(name) { return `<svg class="ui-icon" aria-hidden="true" focusable="false"><use href="/static/icons/ui.svg#${name}"></use></svg>`; }
  get state() { return this.options.state(); }
  get activities() { return this.state?.correction_activities || []; }
  get shortcuts() { return this.state?.correction_shortcuts || []; }
  get isLearning() { return this.source?.segment_kind === 'effective'; }
  open() {
    if (this.options.pending() || !this.state?.active_segment || this.state.active_segment.included === false) return;
    this.source = {...this.state.active_segment};
    this.date = this.options.date();
    this.screen = 'home'; this.picker = null; this.page = 0; this.managing = false;
    this.mode = this.isLearning ? 'segment' : 'switch';
    this.activity = this.activities.find(a => a.id === 'interrupt_meal')?.id || this.activities[0]?.id;
    this.minutes = this.isLearning ? 30 : 10; this.offset = 0;
    this.task = this.source.task_id; this.effectiveLabel = '';
    this.lastRequest = null; this.removal = null; this.status = ''; this.setError('');
    this.show(); this.dialog.showModal();
  }
  setError(message) { this.error.textContent = message; this.error.hidden = !message; }
  setBusy(value) {
    this.busy = value; this.options.setBusy(value);
    this.dialog.setAttribute('aria-busy', String(value));
    this.close.disabled = value; this.back.disabled = value;
    this.feedback.querySelector('button').disabled = value;
    this.show();
  }
  field(label, value, action) {
    return `<div class="time-correction-field"><span>${label}</span><button type="button" class="ghost-button" data-correction-action="${action}" aria-label="${label}：${this.escape(value)}"><span>${this.escape(value)}</span>${this.icon('down')}</button></div>`;
  }
  home() {
    const all = this.shortcuts;
    const maxPage = Math.max(0, Math.ceil(all.length / 4) - 1);
    this.page = Math.min(this.page, maxPage);
    const items = all.slice(this.page * 4, this.page * 4 + 4);
    return `<div class="time-correction-shortcuts" role="group" aria-label="常用修正">${items.map(item => {
      const activity = this.activities.find(a => a.id === item.label_id);
      const name = activity?.name || '活动已移除';
      return `<div class="time-correction-shortcut${this.managing ? ' is-editing' : ''}"><button type="button" class="ghost-button time-correction-quick" data-correction-action="quick" data-shortcut-id="${this.escape(item.id)}" aria-label="${this.escape(name)}，划出${item.minutes}分钟" ${!activity || !this.isLearning || this.managing ? 'disabled' : ''}><span class="time-correction-name">${this.escape(name)}</span><span class="time-correction-amount">−${item.minutes}分</span></button>${this.managing ? `<button type="button" class="ui-icon-button ui-shortcut-remove" data-correction-action="remove" data-shortcut-id="${this.escape(item.id)}" aria-label="移除${this.escape(name)}${item.minutes}分钟快捷键" title="移除快捷键">${this.icon('close')}</button>` : ''}</div>`;
    }).join('')}</div>
      ${!items.length ? '<p class="muted time-correction-caption">还没有快捷键，可用右上角加号添加。</p>' : ''}
      ${all.length > 4 ? `<div class="time-correction-pages"><button type="button" class="ui-icon-button" data-correction-action="prev" aria-label="上一组快捷键" ${this.page === 0 ? 'disabled' : ''}>${this.icon('back')}</button><span>${this.page + 1}／${maxPage + 1}</span><button type="button" class="ui-icon-button" data-correction-action="next" aria-label="下一组快捷键" ${this.page === maxPage ? 'disabled' : ''}>${this.icon('next')}</button></div>` : ''}
      <div class="time-correction-home-actions"><button type="button" class="ghost-button time-correction-detail" data-correction-action="detail"><span>${this.isLearning ? '详细修正' : '补回已开始的学习'}</span>${this.icon('next')}</button></div>
      ${!this.isLearning ? '<p class="muted time-correction-caption">当前在记录其他活动，可用“补一次切换”补回最近的学习。</p>' : ''}
      ${this.status ? `<p class="time-correction-status" role="status">${this.escape(this.status)}</p>` : ''}`;
  }
  removeConfirmation() {
    const item = this.removal;
    if (!item) return '';
    const name = this.activities.find(a => a.id === item.label_id)?.name || '此活动';
    return `<div class="time-correction-remove-preview"><span>${this.escape(name)}</span><span>−${item.minutes}分</span></div><p class="time-correction-remove-copy">移除这个快捷按钮？已记录的时间会保留。</p><div class="time-correction-remove-actions"><button type="button" class="ghost-button" data-correction-action="cancel-remove">取消</button><button type="button" class="primary" data-correction-action="confirm-remove">确认移除</button></div>`;
  }
  activitySelect() {
    return `<label class="time-correction-select">${this.screen === 'add' ? '快捷键对应的活动' : '刚才做了什么'}<select data-correction-field="activity">${this.activities.map(a => `<option value="${this.escape(a.id)}" ${a.id === this.activity ? 'selected' : ''}>${this.escape(a.name)} · ${this.escape(({life:'生活',rest:'休息',distraction:'分心',external:'外部打断'})[a.time_category])}</option>`).join('')}</select></label>`;
  }
  detail() {
    const switching = this.mode === 'switch';
    const task = this.state.tasks.find(t => t.id === this.task);
    const labels = this.options.settings()?.effective_labels_by_category?.[task?.category] || [];
    return `<div class="time-correction-modes" role="group" aria-label="修正方式"><button type="button" class="ghost-button" data-correction-action="segment" aria-pressed="${!switching}" ${!this.isLearning ? 'disabled' : ''}>补一段活动</button><button type="button" class="ghost-button" data-correction-action="switch" aria-pressed="${switching}" ${this.isLearning ? 'disabled' : ''}>补一次切换</button></div>
      ${switching ? `<label class="time-correction-select">已经开始学什么<select data-correction-field="task">${this.state.tasks.map(t => `<option value="${t.id}" ${t.id === this.task ? 'selected' : ''}>${this.escape(t.title)}</option>`).join('')}</select></label><label class="time-correction-select">学习细分<select data-correction-field="effectiveLabel"><option value="">沿用此项目上次学习细分</option>${labels.map(l => `<option value="${this.escape(l.id)}" ${l.id === this.effectiveLabel ? 'selected' : ''}>${this.escape(l.name)}</option>`).join('')}</select></label>` : this.activitySelect()}
      ${this.field(switching ? '已经开始多久' : '这段活动持续多久', `${this.minutes} 分钟`, 'duration')}
      ${switching ? '' : this.field('什么时候结束', this.offset ? `${this.offset} 分钟前` : '刚刚结束', 'offset')}
      <p class="time-correction-preview muted">${this.preview()}</p><button type="submit" class="primary time-correction-save">${this.busy ? '保存中…' : '保存修正并继续学习'}</button>`;
  }
  add() {
    const activity = this.activities.find(a => a.id === this.activity);
    return `${this.activitySelect()}${this.field('每次划出多少分钟', `${this.minutes} 分钟`, 'duration')}<p class="time-correction-preview">按钮：${this.escape(activity?.name)} −${this.minutes}分</p><p class="muted time-correction-caption">添加只保存快捷键；下次点击它才执行修正。</p><button type="submit" class="primary time-correction-save">${this.busy ? '保存中…' : '添加快捷键'}</button>`;
  }
  preview() {
    if (this.mode === 'switch') {
      const task = this.state.tasks.find(t => t.id === this.task);
      return `补回最近约${this.minutes}分钟${this.escape(task?.title)}，现在继续计时。`;
    }
    const end = new Date(Date.now() - this.offset * 60000), start = new Date(end - this.minutes * 60000);
    const format = d => d.toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit',hour12:false});
    const activity = this.activities.find(a => a.id === this.activity);
    return `约${format(start)}—${format(end)}改为${this.escape(activity?.name)}；${this.offset ? `保留最后${this.offset}分钟学习。` : '随后继续原学习。'}标为估计。`;
  }
  pickerBody() {
    const offset = this.picker === 'offset';
    const values = offset ? [0,5,10,15,20,30] : [30,20,15,45,10,60];
    return `<div class="time-correction-minute-options" role="group" aria-label="常用分钟">${values.map(value => `<button type="button" class="ghost-button" data-correction-action="pick" data-minutes="${value}" aria-pressed="${value === (offset ? this.offset : this.minutes)}">${offset && value === 0 ? '刚刚结束' : `${value}分${offset ? '钟前' : '钟'}`}</button>`).join('')}</div><div class="time-correction-custom"><label>其他分钟<input id="time-correction-custom" type="number" min="${offset ? 0 : 1}" max="1440" step="1" inputmode="numeric" placeholder="自填"></label><button type="button" class="ghost-button" data-correction-action="custom">确定</button></div>`;
  }
  show() {
    if (!this.source) return;
    const replacing = Boolean(this.picker) && this.mobile.matches;
    this.dialog.dataset.correctionScreen = replacing ? 'picker' : this.screen;
    this.title.textContent = replacing ? (this.picker === 'offset' ? '什么时候结束' : '选择分钟') : ({home:this.managing ? '编辑快捷键' : '修正时间',add:'添加快捷键',detail:'详细修正',remove:'移除快捷键'})[this.screen];
    this.addControl.hidden = this.manageControl.hidden = this.screen !== 'home' || Boolean(this.picker);
    this.addControl.disabled = this.manageControl.disabled = Boolean(this.busy);
    this.manageControl.setAttribute('aria-pressed',String(this.managing));
    this.manageControl.setAttribute('aria-label',this.managing ? '完成编辑' : '编辑快捷键');
    this.manageControl.title = this.managing ? '完成编辑' : '编辑快捷键';
    this.manageControl.innerHTML = this.icon(this.managing ? 'check' : 'edit');
    this.back.hidden = this.screen === 'home' && !this.picker;
    this.dialog.querySelector('#quick-correction-context').textContent = `${this.source.task_title} · ${this.isLearning ? '有效学习' : this.source.label_name || '其他活动'}`;
    this.body.innerHTML = replacing ? this.pickerBody() : this.screen === 'home' ? this.home() : this.screen === 'add' ? this.add() : this.screen === 'remove' ? this.removeConfirmation() : this.detail();
    if (this.picker && !replacing) this.body.insertAdjacentHTML('beforeend', `<div class="time-correction-picker" role="group" aria-label="选择分钟"><div class="time-correction-picker-heading"><span>${this.picker === 'offset' ? '什么时候结束' : '选择分钟'}</span><button type="button" class="ui-icon-button" data-correction-action="close-picker" aria-label="收起分钟选择">${this.icon('close')}</button></div>${this.pickerBody()}</div>`);
    if (this.busy) this.body.querySelectorAll('button,input,select').forEach(control => { control.disabled = true; });
  }
  async handleClick(event) {
    const button = event.target.closest('[data-correction-action]');
    if (!button || button.disabled || this.busy) return;
    const action = button.dataset.correctionAction;
    this.setError('');
    if (action === 'quick') {
      const shortcut = this.shortcuts.find(s => s.id === button.dataset.shortcutId);
      if (shortcut) await this.saveCorrection(shortcut);
      return;
    }
    if (action === 'add') { this.screen = 'add'; this.minutes = 30; this.picker = null; }
    else if (action === 'detail') { this.screen = 'detail'; this.mode = this.isLearning ? 'segment' : 'switch'; this.picker = null; }
    else if (action === 'manage') this.managing = !this.managing;
    else if (action === 'remove') { this.removal = this.shortcuts.find(item=>item.id === button.dataset.shortcutId); if (!this.removal) return; this.screen = 'remove'; }
    else if (action === 'cancel-remove') { this.screen = 'home'; this.removal = null; }
    else if (action === 'confirm-remove') { if (this.removal) await this.removeShortcut(this.removal.id); return; }
    else if (action === 'prev') this.page = Math.max(0, this.page - 1);
    else if (action === 'next') this.page++;
    else if (action === 'duration' || action === 'offset') this.picker = action;
    else if (action === 'close-picker') this.picker = null;
    else if (action === 'pick') { if (this.picker === 'offset') this.offset = Number(button.dataset.minutes); else this.minutes = Number(button.dataset.minutes); this.picker = null; }
    else if (action === 'custom') { this.pickCustom(); return; }
    else if (action === 'segment' || action === 'switch') this.mode = action;
    this.show();
  }
  pickCustom() {
    const input = this.body.querySelector('#time-correction-custom'), value = Number(input?.value);
    if (!input?.value.trim() || !Number.isInteger(value) || value < (this.picker === 'offset' ? 0 : 1) || value > 1440) { this.setError('请选择合适的整数分钟；活动至少1分钟，最多1440分钟。'); return; }
    if (this.picker === 'offset') this.offset = value; else this.minutes = value;
    this.picker = null; this.setError(''); this.show();
  }
  async addShortcut() {
    if (this.busy) return;
    this.setBusy(true); this.setError('');
    try {
      const items = await this.options.request('/api/correction-shortcuts', {method:'POST',body:JSON.stringify({label_id:this.activity,minutes:this.minutes})});
      this.state.correction_shortcuts = items; this.page = Math.floor((items.length - 1) / 4);
      this.screen = 'home'; this.status = '快捷键已保存，还没有扣时间。';
    } catch (error) { this.setError(error.message); }
    finally { this.setBusy(false); }
  }
  async removeShortcut(id) {
    this.setBusy(true); this.setError('');
    try {
      this.state.correction_shortcuts = await this.options.request(`/api/correction-shortcuts/${encodeURIComponent(id)}`, {method:'DELETE'});
      this.screen = 'home'; this.removal = null; this.status = '快捷键已移除，原时间记录保留。';
    }
    catch (error) { this.setError(error.message); }
    finally { this.setBusy(false); }
  }
  async saveCorrection(shortcut=null) {
    if (this.busy) return;
    const body = {source_segment_id:this.source.id,mode:shortcut ? 'segment' : this.mode,minutes:shortcut?.minutes ?? this.minutes,offset_minutes:shortcut ? 0 : (this.mode === 'switch' ? 0 : this.offset),label_id:shortcut?.label_id ?? (this.mode === 'switch' ? null : this.activity),task_id:this.mode === 'switch' && !shortcut ? this.task : null,effective_label_id:this.mode === 'switch' && !shortcut ? this.effectiveLabel || null : null};
    const key = JSON.stringify(body);
    if (this.lastRequest?.key !== key) this.lastRequest = {key,body:{...body,request_id:Array.from(crypto.getRandomValues(new Uint8Array(16)),v=>v.toString(16).padStart(2,'0')).join('')}};
    this.setBusy(true); this.setError('');
    try {
      const result = await this.options.request(`/api/daily-execution/${this.date}/time-corrections`, {method:'POST',body:JSON.stringify(this.lastRequest.body)});
      this.options.render(result);
      this.undoRecord = {date:this.date,id:result.correction_segment_id};
      this.feedback.querySelector('span').textContent = body.mode === 'switch' ? `已补回约${body.minutes}分钟学习。` : `已划出约${body.minutes}分钟，继续原学习。`;
      this.feedback.hidden = false; this.dialog.close(); this.options.notify('时间已修正，继续学习');
    } catch (error) { this.setError(`${error.message}；可用相同操作重试，不会重复扣减。`); }
    finally { this.setBusy(false); }
  }
  async undo() {
    if (this.busy || !this.undoRecord || this.options.pending()) return;
    const record = this.undoRecord;
    if (record.date !== this.options.date()) { this.feedback.hidden = true; return; }
    this.setBusy(true);
    try {
      const result = await this.options.request(`/api/daily-execution/${record.date}/segments/${record.id}`, {method:'DELETE'});
      this.options.render(result); this.undoRecord = null; this.feedback.hidden = true; this.options.notify('已撤销本次时间修正');
    } catch (error) { this.options.notify(error.message); }
    finally { this.setBusy(false); }
  }
}
