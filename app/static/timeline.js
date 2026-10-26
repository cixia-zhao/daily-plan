/* 固定密度的单时序：先选择，再编辑；平移只浏览，不改变记录。 */
window.ExecutionTimeline = class {
  constructor(node, openEditor, addSegment=()=>{}) {
    this.node=node;this.openEditor=openEditor;this.addSegment=addSegment;this.date=null;this.viewHours=2;
    this.viewStart=null;this.selected=null;this.nearby=null;this.followLatest=true;this.recordsScroll=0;
    this.resize=new ResizeObserver(()=>{if(this.result&&this.width!==this.node.clientWidth)this.render();});
    this.resize.observe(node);
  }
  update(result,receivedAt=performance.now()) {
    if(this.date!==result.date){this.viewHours=2;this.viewStart=null;this.selected=null;this.nearby=null;this.followLatest=true;this.recordsScroll=0;}
    if(result.active_segment?.id&&result.active_segment.id!==this.result?.active_segment?.id){this.viewStart=null;this.followLatest=true;}
    this.date=result.date;this.result=result;this.receivedAt=receivedAt;
    if(this.nearby)this.nearby=result.segments.map(s=>s.id);
    if(!result.segments.some(s=>s.id===this.selected))this.selected=null;
    if(this.gesture){this.pendingRender=true;return;}
    this.render();
  }
  end(s) {
    return s.ended_at?new Date(s.ended_at).getTime():Math.min(s.auto_stop_at?new Date(s.auto_stop_at).getTime():Infinity,new Date(s.started_at).getTime()+s.seconds*1000+Math.max(0,performance.now()-this.receivedAt));
  }
  extent() {
    const segments=this.result.segments||[];if(!segments.length)return null;
    const hour=3600000,start=Math.floor(Math.min(...segments.map(s=>new Date(s.started_at).getTime()))/hour)*hour;
    return {start,end:Math.max(start+this.viewHours*hour,Math.ceil(Math.max(...segments.map(s=>this.end(s)))/hour)*hour)};
  }
  time(value,date=false) {
    const d=new Date(value);return `${date?`${d.getMonth()+1}/${d.getDate()} `:''}${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  }
  label(s) {
    return `${s.task_title} · ${timeCategoryNames[segmentTimeCategory(s)]}${s.label_name?`／${s.label_name}`:''}${s.is_estimated?' · 补记·估计':''}${s.stopped_automatically?' · 自动停止':''}${s.included===false?' · 不计入统计':''}`;
  }
  category(s) {
    return this.result.tasks.find(t=>t.id===s.task_id)?.category||'';
  }
  symbol(s) {
    return PlanVisuals.symbol(segmentTimeCategory(s)==='learning'?this.category(s):segmentTimeCategory(s));
  }
  tone(s) {
    return {distraction:'#a8786e',life:'#9b8d79',rest:'#91918c',external:'#8d8176'}[segmentTimeCategory(s)]||PlanVisuals.color(this.category(s));
  }
  timing(s) {
    const cross=new Date(s.started_at).toDateString()!==new Date(this.end(s)).toDateString();
    return `${this.time(s.started_at,cross)}—${s.ended_at?this.time(s.ended_at,cross):'正在计时'} · ${PlanVisuals.duration((this.end(s)-new Date(s.started_at))/1000)}`;
  }
  selectionHtml() {
    const s=this.result.segments.find(s=>s.id===this.selected);if(!s)return '';
    return `<div class="chronology-selection" data-segment-id="${s.id}" style="--segment-color:${this.tone(s)}"><button type="button" class="chronology-selected-record" aria-label="${esc(this.label(s))}，再次点击编辑">${this.symbol(s)}<span><strong>${esc(this.label(s))}</strong><small class="chronology-selected-time">${this.timing(s)}</small></span><span class="chronology-edit-label">再点编辑</span></button><button type="button" class="ghost-button chronology-clear" aria-label="取消选中">×</button></div>`;
  }
  nearbyHtml() {
    if(!this.nearby)return '';
    const segments=this.result.segments.filter(s=>this.nearby.includes(s.id));
    return `<div class="chronology-nearby" aria-label="全部时间记录"><div class="chronology-nearby-heading"><span>全部时间记录 · ${segments.length} 段</span><div><button type="button" class="ghost-button chronology-add" id="add-segment">补一段时间</button><button type="button" class="ghost-button chronology-dismiss">${this.recordsNode?this.recordsReturnLabel||'← 返回计时':'收起'}</button></div></div>${segments.map(s=>`<button type="button" class="chronology-record ${s.id===this.selected?'is-selected':''}" data-segment-id="${s.id}" aria-pressed="${s.id===this.selected}" style="--segment-color:${this.tone(s)}">${this.symbol(s)}<span><strong>${esc(this.label(s))}</strong><small>${this.timing(s)}</small></span><span class="chronology-edit-label">${s.id===this.selected?'再点编辑':'选择'}</span></button>`).join('')}</div>`;
  }
  showRecords(show=true) {
    const list=this.recordsNode?.querySelector('.chronology-nearby');
    if(list?.getClientRects().length)this.recordsScroll=list.scrollTop;
    this.nearby=show?this.result.segments.map(s=>s.id):null;
    this.onRecordsPage?.(show);
    this.render();
  }
  renderRecords() {
    if(!this.recordsNode)return;
    const old=this.recordsNode.querySelector('.chronology-nearby');
    if(old?.getClientRects().length)this.recordsScroll=old.scrollTop;
    const top=this.recordsScroll||0;
    const focused=this.recordsNode.contains(document.activeElement)?document.activeElement:null;
    const key=focused?.dataset.segmentId,wasReturn=focused?.classList.contains('chronology-dismiss');
    this.recordsNode.innerHTML=this.nearbyHtml();
    const list=this.recordsNode.querySelector('.chronology-nearby');
    if(list)list.scrollTop=top;
    if(key)this.recordsNode.querySelector(`[data-segment-id="${key}"]`)?.focus({preventScroll:true});
    else if(wasReturn)this.recordsNode.querySelector('.chronology-dismiss')?.focus({preventScroll:true});
    this.wireDetails();
  }
  render() {
    this.renderRecords();
    if(!this.result||!this.node.getClientRects().length)return;
    this.width=this.node.clientWidth||320;const extent=this.extent(),span=this.viewHours*3600000;
    this.ext=extent;this.scale=this.width/span;
    if(extent){
      if(this.viewStart===null)this.viewStart=extent.end-span;
      this.viewStart=Math.max(extent.start,Math.min(this.viewStart,extent.end-span));
    }
    const graphic=extent?`<div class="chronology-axis" aria-hidden="true"></div><div class="chronology-window"><div class="chronology-scroll" tabindex="0" aria-label="时间轴，左右滑动或用方向键浏览"><div class="chronology-track" style="width:${(extent.end-extent.start)*this.scale}px">${this.result.segments.map(s=>`<span class="chronology-block ${segmentTimeCategory(s)} ${s.id===this.selected?'is-selected':''} ${s.ended_at?'':'is-live'} ${s.included===false?'is-excluded':''}" data-segment-id="${s.id}" style="left:${(new Date(s.started_at)-extent.start)*this.scale}px;width:${Math.max(1,(this.end(s)-new Date(s.started_at))*this.scale)}px;--segment-color:${this.tone(s)}" title="${esc(this.label(s))}"></span>`).join('')}<button class="chronology-surface" type="button" aria-label="点选时间段，选中后再次点击编辑；方向键可浏览"></button></div></div><div class="chronology-labels" aria-hidden="true">${this.result.segments.map(s=>`<span class="chronology-label" data-segment-id="${s.id}">${this.symbol(s)}<span class="chronology-label-text">${esc(segmentTimeCategory(s)==='learning'?s.task_title:timeCategoryNames[segmentTimeCategory(s)])}</span></span>`).join('')}</div></div>`:'<p class="chart-footnote">开始记录后，可在这里选择时间段。</p>';
    this.node.innerHTML=`<div class="chronology-heading"><h2 class="chronology-instruction">点击选中，再点编辑</h2><div><button type="button" class="ghost-button chronology-prev" aria-label="向前查看一小时" ${extent?'':'disabled'}>←</button><button type="button" class="ghost-button chronology-next" aria-label="向后查看一小时" ${extent?'':'disabled'}>→</button><button type="button" class="ghost-button chronology-zoom" aria-label="${this.viewHours===2?'放大为一小时视窗':'还原为两小时视窗'}" aria-pressed="${this.viewHours===1}" ${extent?'':'disabled'}><svg class="timeline-control-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5M7 10h6${this.viewHours===2?'M10 7v6':''}"/></svg></button><button type="button" class="ghost-button chronology-browse" aria-expanded="${!!this.nearby}" aria-label="${this.nearby?'收起':'展开'}全部时间记录" title="全部时间记录"><svg class="timeline-control-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/></svg></button></div></div>${graphic}<div class="chronology-detail" aria-live="polite">${this.selectionHtml()}</div>${this.recordsNode?'':this.nearbyHtml()}`;
    this.node.dataset.viewHours=this.viewHours;
    const scroll=this.node.querySelector('.chronology-scroll');
    if(scroll){
      scroll.scrollLeft=(this.viewStart-extent.start)*this.scale;
      scroll.addEventListener('scroll',()=>{this.viewStart=extent.start+scroll.scrollLeft/this.scale;this.followLatest=scroll.scrollLeft>=scroll.scrollWidth-scroll.clientWidth-3;this.paint();},{passive:true});
      scroll.addEventListener('keydown',e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();this.move(e.key==='ArrowLeft'?-1:1);}else if(e.key==='Home'||e.key==='End'){e.preventDefault();scroll.scrollLeft=e.key==='Home'?0:scroll.scrollWidth;}});
      this.wireGestures(scroll);
      this.node.querySelector('.chronology-surface').onclick=e=>this.pick(e);
      this.paint();
    }
    this.node.querySelector('.chronology-prev').onclick=()=>this.move(-1);
    this.node.querySelector('.chronology-next').onclick=()=>this.move(1);
    this.node.querySelector('.chronology-zoom').onclick=()=>{
      const center=this.viewStart+span/2;this.viewHours=this.viewHours===2?1:2;this.viewStart=center-this.viewHours*1800000;this.render();
    };
    this.node.querySelector('.chronology-browse').onclick=()=>this.showRecords(!this.nearby);
    this.wireDetails();
  }
  wireDetails() {
    const root=this.recordsNode&&this.nearby?this.recordsNode:this.node;
    const add=root.querySelector('.chronology-add');if(add)add.onclick=()=>this.addSegment();
    root.querySelectorAll('.chronology-record').forEach(button=>button.onclick=()=>this.activate(Number(button.dataset.segmentId),true));
    const selected=this.node.querySelector('.chronology-selected-record');if(selected)selected.onclick=()=>this.activate(this.selected);
    const clear=this.node.querySelector('.chronology-clear');if(clear)clear.onclick=()=>{this.selected=null;this.refreshDetails();};
    const dismiss=root.querySelector('.chronology-dismiss');if(dismiss)dismiss.onclick=()=>this.showRecords(false);
  }
  refreshDetails() {
    this.node.querySelector('.chronology-detail').innerHTML=this.selectionHtml();
    this.node.querySelector('.chronology-nearby')?.remove();
    if(this.recordsNode)this.renderRecords();else this.node.insertAdjacentHTML('beforeend',this.nearbyHtml());
    this.node.querySelector('.chronology-browse').setAttribute('aria-expanded',String(!!this.nearby));
    this.node.querySelector('.chronology-browse').setAttribute('aria-label',`${this.nearby?'收起':'展开'}全部时间记录`);
    this.node.querySelectorAll('.chronology-block').forEach(b=>b.classList.toggle('is-selected',Number(b.dataset.segmentId)===this.selected));
    this.wireDetails();
  }
  activate(id,reveal=false) {
    if(this.selected===id){this.openEditor(id);return;}
    this.selected=id;
    if(reveal&&this.node.getClientRects().length){
      const s=this.result.segments.find(s=>s.id===id),scroll=this.node.querySelector('.chronology-scroll'),start=new Date(s.started_at).getTime(),end=this.end(s);
      if(scroll&&(start<this.viewStart||end>this.viewStart+this.viewHours*3600000))scroll.scrollLeft=((start+end)/2-this.viewHours*1800000-this.ext.start)*this.scale;
    }
    this.refreshDetails();
  }
  pick(event) {
    if(performance.now()<(this.suppressClickUntil||0))return;
    if(event.detail===0){this.showRecords();(this.recordsNode||this.node).querySelector('.chronology-record')?.focus({preventScroll:true});return;}
    const box=this.node.querySelector('.chronology-scroll').getBoundingClientRect();
    const at=this.viewStart+(event.clientX-box.left)/this.scale;
    const exact=this.result.segments.find(s=>new Date(s.started_at).getTime()<=at&&this.end(s)>at);
    if(exact&&exact.id===this.selected){this.activate(exact.id);return;}
    if(exact)this.activate(exact.id);else {this.selected=null;this.refreshDetails();}
  }
  move(direction) {
    const scroll=this.node.querySelector('.chronology-scroll');if(scroll)scroll.scrollLeft+=direction*3600000*this.scale;
  }
  paint() {
    const scroll=this.node.querySelector('.chronology-scroll');if(!scroll||!this.ext)return;
    this.viewStart=this.ext.start+scroll.scrollLeft/this.scale;
    const end=this.viewStart+this.viewHours*3600000,step=this.viewHours===2?1800000:900000;
    const cross=new Date(this.viewStart).toDateString()!==new Date(end-1).toDateString();let ticks='';
    for(let t=Math.ceil(this.viewStart/step)*step;t<=end;t+=step){const x=(t-this.viewStart)*this.scale;if(x>3&&x<28||x<this.width-3&&x>this.width-28)continue;ticks+=`<span style="left:${x}px" class="${x<3?'at-start':x>this.width-3?'at-end':''}">${this.time(t,cross)}</span>`;}
    this.node.querySelector('.chronology-axis').innerHTML=ticks;
    this.node.querySelector('.chronology-prev').disabled=scroll.scrollLeft<=1;
    this.node.querySelector('.chronology-next').disabled=scroll.scrollLeft>=scroll.scrollWidth-scroll.clientWidth-1;
    this.node.querySelectorAll('.chronology-label').forEach(label=>{
      const s=this.result.segments.find(s=>s.id===Number(label.dataset.segmentId));
      const left=Math.max(0,(new Date(s.started_at).getTime()-this.viewStart)*this.scale),right=Math.min(this.width,(this.end(s)-this.viewStart)*this.scale),room=right-left;
      const text=label.querySelector('.chronology-label-text'),icon=label.querySelector('.project-symbol');
      label.hidden=false;text.style.display='';icon.style.display='';label.style.visibility='hidden';
      const textWidth=text.getBoundingClientRect().width;
      if(room>=textWidth+40){}else if(room>=textWidth+16)icon.style.display='none';else if(room>=28)text.style.display='none';else {label.hidden=true;return;}
      const width=label.getBoundingClientRect().width;
      if(width>room-4){label.hidden=true;return;}
      label.style.left=`${left+(room-width)/2}px`;label.style.visibility='';
    });
  }
  wireGestures(scroll) {
    scroll.addEventListener('pointerdown',e=>{this.suppressClickUntil=0;this.gesture={id:e.pointerId,x:e.clientX,y:e.clientY,left:scroll.scrollLeft,mouse:e.pointerType==='mouse',moved:false};});
    scroll.addEventListener('pointermove',e=>{const g=this.gesture;if(!g||g.id!==e.pointerId)return;const dx=e.clientX-g.x,dy=e.clientY-g.y;if(Math.abs(dx)>8||Math.abs(dy)>8)g.moved=true;if(g.mouse&&g.moved&&Math.abs(dx)>Math.abs(dy)){scroll.setPointerCapture(e.pointerId);scroll.scrollLeft=g.left-dx;e.preventDefault();}});
    const finish=e=>{const g=this.gesture;if(!g||g.id!==e.pointerId)return;if(g.moved||Math.abs(scroll.scrollLeft-g.left)>4||e.type==='pointercancel')this.suppressClickUntil=performance.now()+450;this.gesture=null;scroll.classList.remove('is-dragging');if(this.pendingRender){this.pendingRender=false;requestAnimationFrame(()=>this.render());}};
    scroll.addEventListener('pointerup',finish);scroll.addEventListener('pointercancel',finish);
    scroll.addEventListener('lostpointercapture',finish);
  }
  tick() {
    if(this.recordsNode&&this.nearby||!this.node.getClientRects().length)return;
    if(!this.result?.active_segment||document.hidden||this.gesture)return;
    const extent=this.extent();
    if(extent?.start!==this.ext?.start||extent?.end!==this.ext?.end){if(this.followLatest)this.viewStart=extent.end-this.viewHours*3600000;this.render();return;}
    const active=this.result.active_segment,block=this.node.querySelector(`.chronology-block[data-segment-id="${active.id}"]`);
    if(block)block.style.width=`${Math.max(1,(this.end(active)-new Date(active.started_at))*this.scale)}px`;
    if(this.selected===active.id){const text=this.node.querySelector('.chronology-selected-time');if(text)text.textContent=this.timing(active);}
    this.paint();
  }
};
