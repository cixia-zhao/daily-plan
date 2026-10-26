/* 共用页签与页面过渡；保留原生导航和各页独立的数据生命周期。 */
window.PlanUI = (() => {
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  function enter(panel, direction=1) {
    if (!panel || reduced()) return;
    panel.classList.remove('surface-enter');
    panel.style.setProperty('--surface-shift', `${direction * 18}px`);
    void panel.offsetWidth;
    panel.classList.add('surface-enter');
  }
  function indicator(group, selector='[aria-selected="true"]', lineSelector='.surface-tab-indicator') {
    const active=group?.querySelector(selector),line=group?.querySelector(lineSelector);
    if(!active||!line)return;
    line.style.width=`${active.offsetWidth}px`;
    line.style.transform=`translateX(${active.offsetLeft}px)`;
  }
  function tabs(group, onChange=()=>{}) {
    const buttons=[...group.querySelectorAll('[role=tab]')];
    let selected=buttons.find(b=>b.getAttribute('aria-selected')==='true')||buttons[0];
    function select(button, animate=true) {
      const previous=selected;if(!button||previous===button&&animate)return;
      selected=button;
      buttons.forEach(b=>{const active=b===button;b.setAttribute('aria-selected',String(active));b.tabIndex=active?0:-1;const panel=document.getElementById(b.getAttribute('aria-controls'));if(panel)panel.hidden=!active;});
      indicator(group);onChange(button);
      if(animate)enter(document.getElementById(button.getAttribute('aria-controls')),buttons.indexOf(button)>buttons.indexOf(previous)?1:-1);
    }
    buttons.forEach(b=>{b.onclick=()=>select(b);b.onkeydown=e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const i=buttons.indexOf(b),next=e.key==='Home'?0:e.key==='End'?buttons.length-1:(i+(e.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;select(buttons[next]);buttons[next].focus();};});
    new ResizeObserver(()=>indicator(group)).observe(group);select(selected,false);
    return {select,get selected(){return selected;}};
  }
  const links=[...document.querySelectorAll('.primary-nav>a')],nav=document.querySelector('.primary-nav');
  const current=document.body.dataset.page==='weekly'?'review':document.body.dataset.page==='execution-history'?'execute':document.body.dataset.page;
  const active=links.find(a=>a.dataset.nav===current);if(active)active.setAttribute('aria-current','page');
  if(nav){const line=document.createElement('span');line.className='primary-nav-indicator';line.setAttribute('aria-hidden','true');nav.append(line);new ResizeObserver(()=>indicator(nav,'[aria-current=page]','.primary-nav-indicator')).observe(nav);indicator(nav,'[aria-current=page]','.primary-nav-indicator');if(!active)line.hidden=true;}
  try {const from=JSON.parse(sessionStorage.getItem('daily-plan:navigation')||'null');sessionStorage.removeItem('daily-plan:navigation');if(from&&Date.now()-from.at<10000){document.documentElement.style.setProperty('--surface-shift',`${from.direction*18}px`);document.querySelector('main')?.classList.add('surface-enter');const prior=links.find(a=>a.dataset.nav===from.from),line=nav?.querySelector('.primary-nav-indicator');if(prior&&line){line.style.transition='none';line.style.transform=`translateX(${prior.offsetLeft}px)`;void line.offsetWidth;line.style.transition='';requestAnimationFrame(()=>indicator(nav,'[aria-current=page]','.primary-nav-indicator'));}}}
  catch {/* 受限存储不影响普通链接跳转。 */}
  document.querySelectorAll('.site-header a').forEach(a=>a.addEventListener('click',event=>{if(event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||event.button!==0)return;const target=new URL(a.href,location.href);if(target.origin!==location.origin)return;const order=['today','execute','review','gpt-workbench','settings'],next=a.dataset.nav||'today';try{sessionStorage.setItem('daily-plan:navigation',JSON.stringify({at:Date.now(),from:current,direction:order.indexOf(next)>=order.indexOf(current)?1:-1}));}catch{}}));
  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
    const date=new Date(value+'T12:00:00');
    return !Number.isNaN(date.getTime()) && date.getFullYear()===Number(value.slice(0,4)) && date.getMonth()+1===Number(value.slice(5,7)) && date.getDate()===Number(value.slice(8,10));
  }
  function setDate(value) {
    if (!validDate(value)) return;
    const paths={today:'/?date=',execute:'/execute?date=',review:'/review?date='};
    links.forEach(link=>{if(paths[link.dataset.nav])link.href=paths[link.dataset.nav]+encodeURIComponent(value);});
    document.querySelectorAll('[data-return-today]').forEach(link=>link.hidden=value===new Date().toLocaleDateString('en-CA'));
  }
  setDate(new URLSearchParams(location.search).get('date') || new Date().toLocaleDateString('en-CA'));
  return {enter,indicator,tabs,setDate,validDate};
})();

/* 抽屉仅由拖柄和标题发起手势，内部列表滚动与时间轴横滑保留原生行为。 */
window.ExecutionSheetDrag = class {
  constructor(root, backdrop, allowed, close) {
    this.root=root;this.backdrop=backdrop;this.allowed=allowed;this.close=close;this.gesture=null;
    this.reduced=matchMedia('(prefers-reduced-motion:reduce)');
    for(const zone of root.querySelectorAll('.execution-sheet-handle,.execution-controls-heading')) {
      zone.addEventListener('pointerdown',e=>this.start(e));
      zone.addEventListener('pointermove',e=>this.move(e));
      zone.addEventListener('pointerup',e=>this.finish(e));
      zone.addEventListener('pointercancel',e=>this.finish(e,true));
      zone.addEventListener('lostpointercapture',e=>this.finish(e,true));
      zone.addEventListener('click',e=>{if(performance.now()<(this.suppressUntil||0)){e.preventDefault();e.stopImmediatePropagation();}},true);
    }
  }
  start(e) {
    if(!this.allowed()||!e.isPrimary||e.button!==0||e.target.closest('.execution-controls-heading button'))return;
    this.reset();
    this.root.style.animation='none';this.root.style.transition='none';this.root.style.willChange='transform';
    this.gesture={id:e.pointerId,y:e.clientY,lastY:e.clientY,lastTime:performance.now(),velocity:0,dy:0,zone:e.currentTarget};
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  move(e) {
    const g=this.gesture;if(!g||g.id!==e.pointerId)return;
    if(!this.allowed()){this.finish(e,true);return;}
    const now=performance.now(),dt=now-g.lastTime;
    if(dt>0){g.velocity=(e.clientY-g.lastY)/dt;g.lastY=e.clientY;g.lastTime=now;}
    g.dy=e.clientY-g.y;
    const displacement=g.dy<0?-Math.min(28,Math.sqrt(-g.dy)*2):g.dy;
    if(this.frame)cancelAnimationFrame(this.frame);
    this.frame=requestAnimationFrame(()=>{this.frame=null;this.root.style.transform=`translateY(${displacement}px)`;this.backdrop.style.opacity=String(Math.max(.18,1-Math.max(0,g.dy)/this.root.clientHeight));});
  }
  finish(e,cancel=false) {
    const g=this.gesture;if(!g||g.id!==e.pointerId)return;
    this.gesture=null;
    if(this.frame){cancelAnimationFrame(this.frame);this.frame=null;}
    if(Math.abs(g.dy)>4)this.suppressUntil=performance.now()+350;
    const recent=performance.now()-g.lastTime<100?g.velocity:0;
    const dismiss=!cancel&&g.dy>0&&(g.dy>Math.min(150,this.root.clientHeight*.26)||g.dy>28&&recent>.65);
    if(dismiss&&this.allowed()&&this.close())return;
    const duration=this.reduced.matches?0:380;
    this.root.style.transition=`transform ${duration}ms cubic-bezier(.22,.8,.25,1)`;
    this.backdrop.style.transition=`opacity ${duration}ms ease`;
    this.root.style.transform='translateY(0)';this.backdrop.style.opacity='';
    clearTimeout(this.cleanup);this.cleanup=setTimeout(()=>this.reset(),duration);
  }
  dismiss() {
    if(this.frame)cancelAnimationFrame(this.frame);
    this.frame=null;this.gesture=null;clearTimeout(this.cleanup);
    const start=getComputedStyle(this.root).transform;
    this.backdrop.style.animation='none';
    this.root.style.animation='none';this.root.style.transform=start==='none'?'translateY(0)':start;
    this.root.getBoundingClientRect();
    const duration=this.reduced.matches?0:280;
    this.root.style.transition=`transform ${duration}ms cubic-bezier(.32,.72,0,1)`;
    this.backdrop.style.transition=`opacity ${duration}ms ease`;
    this.root.style.transform=`translateY(${this.root.clientHeight+24}px)`;this.backdrop.style.opacity='0';
    return duration;
  }
  reset() {
    clearTimeout(this.cleanup);if(this.frame)cancelAnimationFrame(this.frame);
    const gesture=this.gesture;this.gesture=null;this.frame=null;
    if(gesture?.zone.hasPointerCapture(gesture.id))gesture.zone.releasePointerCapture(gesture.id);
    for(const name of ['transform','transition','will-change'])this.root.style.removeProperty(name);
    this.root.style.animation='none';
    this.backdrop.style.removeProperty('opacity');this.backdrop.style.removeProperty('transition');this.backdrop.style.removeProperty('animation');
  }
};
