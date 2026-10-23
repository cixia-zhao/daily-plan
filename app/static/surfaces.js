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
  const current=document.body.dataset.page==='weekly'?'review':document.body.dataset.page;
  const active=links.find(a=>a.dataset.nav===current);if(active)active.setAttribute('aria-current','page');
  if(nav){const line=document.createElement('span');line.className='primary-nav-indicator';line.setAttribute('aria-hidden','true');nav.append(line);new ResizeObserver(()=>indicator(nav,'[aria-current=page]','.primary-nav-indicator')).observe(nav);indicator(nav,'[aria-current=page]','.primary-nav-indicator');if(!active)line.hidden=true;}
  try {const from=JSON.parse(sessionStorage.getItem('daily-plan:navigation')||'null');sessionStorage.removeItem('daily-plan:navigation');if(from&&Date.now()-from.at<10000){document.documentElement.style.setProperty('--surface-shift',`${from.direction*18}px`);document.querySelector('main')?.classList.add('surface-enter');const prior=links.find(a=>a.dataset.nav===from.from),line=nav?.querySelector('.primary-nav-indicator');if(prior&&line){line.style.transition='none';line.style.transform=`translateX(${prior.offsetLeft}px)`;void line.offsetWidth;line.style.transition='';requestAnimationFrame(()=>indicator(nav,'[aria-current=page]','.primary-nav-indicator'));}}}
  catch {/* 受限存储不影响普通链接跳转。 */}
  document.querySelectorAll('.site-header a').forEach(a=>a.addEventListener('click',event=>{if(event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||event.button!==0)return;const target=new URL(a.href,location.href);if(target.origin!==location.origin)return;const order=['today','execute','review','gpt-workbench','settings'],next=a.dataset.nav||'today';try{sessionStorage.setItem('daily-plan:navigation',JSON.stringify({at:Date.now(),from:current,direction:order.indexOf(next)>=order.indexOf(current)?1:-1}));}catch{}}));
  return {enter,indicator,tabs};
})();
