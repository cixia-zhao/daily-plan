/* 项目色与图表共用真实秒数；空值表示无记录，不能当作零值连线。 */
window.PlanVisuals = (() => {
  const palette = ['#b66e55','#99816b','#78685d','#a59172','#b29480','#ac8584'];
  function color(category) {
    const known = {math:0,english:1,computer:2,rehab:3,reading:4,writing:5};
    let index = known[category];
    if (index === undefined) index = [...String(category)].reduce((sum,ch)=>sum+ch.charCodeAt(0),0)%palette.length;
    return palette[index];
  }
  // 数学／英语采用Lucide Calculator／Languages（ISC），许可见icons/LICENSE.lucide.txt。
  // 图标与任务名称配对，不独自承担分类含义。
  function symbol(category) {
    const paths={
      math:'<rect width="16" height="20" x="4" y="2" rx="2" /> <line x1="8" x2="16" y1="6" y2="6" /> <line x1="16" x2="16" y1="14" y2="18" /> <path d="M16 10h.01" /> <path d="M12 10h.01" /> <path d="M8 10h.01" /> <path d="M12 14h.01" /> <path d="M8 14h.01" /> <path d="M12 18h.01" /> <path d="M8 18h.01" />',
      english:'<path d="m5 8 6 6" /> <path d="m4 14 6-6 2-3" /> <path d="M2 5h12" /> <path d="M7 2h1" /> <path d="m22 22-5-10-5 10" /> <path d="M14 18h6" />',
      computer:'<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
      reading:'<path d="M12 6c-3-2-6-2-9-1v14c3-1 6-1 9 1 3-2 6-2 9-1V5c-3-1-6-1-9 1Zm0 0v14"/>',
      rehab:'<path d="M7 10h10M7 14h10M3 7v10M7 5v14M17 5v14M21 7v10"/>',
      writing:'<path d="m5 15 10-10 4 4L9 19l-5 1Zm10-10 2-2 4 4-2 2M5 15l4 4"/>',
      distraction:'<path d="M4 12c4-7 12-7 16 0a19 19 0 0 1-4 4M4 4l16 16M7 16a14 14 0 0 1-3-4"/><path d="M11 9a3 3 0 0 1 4 4"/>',
      life:'<circle cx="12" cy="5" r="2.5"/><path d="M7 12c0-4 10-4 10 0v3h-2v6h-6v-6H7Z"/>',
      rest:'<path d="M8 5v14M16 5v14"/>',
      external:'<path d="M4 5h16v12H9l-5 4Zm4 4h8m-8 4h5"/>',
    };
    return `<svg class="project-symbol" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[category]||'<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8m-8 6h5"/>'}</svg>`;
  }
  const duration = seconds => formatMinutes(Math.floor(Math.abs(seconds)/60),Math.abs(seconds));
  function elapsed(seconds) {
    const value=Math.floor(Math.abs(seconds));
    return value>=3600?`${Math.floor(value/3600)} 小时${value%3600>=60?` ${Math.floor(value%3600/60)} 分`:''}`:duration(value);
  }
  function metric(seconds) {
    if(seconds===null||seconds===undefined)return '—';
    const value=Math.max(0,Math.floor(seconds));
    if(value>0&&value<60)return '<span class="metric-unit">小于 1 分</span>';
    const hours=Math.floor(value/3600),minutes=Math.floor(value%3600/60);
    return `${hours?`${hours}<span class="metric-unit">小时</span>`:''}${minutes||!hours?`${minutes}<span class="metric-unit">分</span>`:''}`;
  }
  function change(value, prefix='比前一天', unit='time') {
    if (value === null || value === undefined) return '暂无可比记录';
    if (Math.abs(value)<.005) return `${prefix}持平`;
    return `${prefix}${unit==='points'?(value>0?'高':'低'):(value>0?'多':'少')} ${unit==='points' ? `${Math.abs(value).toFixed(1)} 个百分点` : elapsed(value)}`;
  }
  function summary(node, data) {
    if (!node || !data) return;
    const entries=Object.entries(data.categories).filter(([,seconds])=>seconds>0);
    node.innerHTML=`<div class="time-summary-heading"><h2>已记录时间去向</h2><span>合计 ${duration(data.recorded_seconds)}</span></div>
      ${entries.length?`<div class="composition-strip" aria-hidden="true">${entries.map(([category,seconds])=>`<span class="time-texture ${category}" style="flex:${seconds}"></span>`).join('')}</div>`:'<p class="muted">还没有时间记录</p>'}
      <dl class="composition-labels">${entries.map(([category,seconds])=>`<div><dt><i class="time-texture ${category}" aria-hidden="true"></i>${esc(timeCategoryNames[category]||category)}</dt><dd>${duration(seconds)}</dd><small>${(seconds/Math.max(1,data.recorded_seconds)*100).toFixed(1)}%</small></div>`).join('')}</dl>
      <p class="chart-footnote">只包含已记录时间，空档不推断为休息。学习有效率 = 有效 ÷（有效 + 分心）。</p>`;
  }
  function projects(node, items, {previous=true, currentHas=true, prefix='比前一天', previousLabel='前一天', details=''}={}) {
    const visible=items.filter(item=>item.current_seconds>0||item.previous_seconds>0);
    const raw=Math.max(60,...visible.flatMap(item=>[item.current_seconds,previous?item.previous_seconds:0]));
    const step=raw>1800?1800:300, max=Math.ceil(raw/step)*step;
    node.innerHTML=`<div class="project-legend"><span><i class="legend-current"></i>有效时间</span>${previous?`<span><i class="legend-previous"></i>${previousLabel}</span>`:''}<span>单位：分钟 · 同一刻度</span></div>
      ${visible.length?visible.map(item=>`<article class="project-comparison" data-category="${esc(item.category)}" style="--project-color:${color(item.category)}">
        <div class="project-comparison-heading"><strong>${esc(item.title)}</strong><span>${currentHas?duration(item.current_seconds):'无记录'}</span></div>
        <div class="project-comparison-track" aria-hidden="true"><span class="project-current" style="width:${item.current_seconds/max*100}%"></span>${previous?`<span class="project-previous" style="left:${Math.min(100,item.previous_seconds/max*100)}%"></span>`:''}</div>
        <div class="project-comparison-note"><span>${previous&&currentHas?change(item.current_seconds-item.previous_seconds,prefix):previous?'当天暂无可比记录':`${previousLabel}暂无记录`}</span></div>
      </article>`).join(''):'<p class="muted">记录后即可查看各项目的有效投入。</p>'}
      ${visible.length?`<div class="project-scale" aria-hidden="true"><span>0</span><span>${max/120}</span><span>${max/60} 分</span></div>`:''}${details}`;
  }
  function daily(result) {
    const comparison=result.comparison||{}, categories=result.time_summary.categories;
    const has=comparison.current_has_execution;
    $('#daily-visual-metrics').innerHTML=[
      ['有效学习',metric(has?categories.learning:null),change(comparison.effective_difference_seconds)],
      ['分心',metric(has?categories.distraction:null),change(comparison.distraction_difference_seconds)],
      ['学习有效率',result.time_summary.effective_ratio===null?'—':`${(result.time_summary.effective_ratio*100).toFixed(1).replace(/\.0$/,'')}%`,change(comparison.efficiency_difference_points,'比前一天','points')],
    ].map(([name,value,delta])=>`<article><span>${name}</span><strong>${value}</strong><small>${delta}</small></article>`).join('');
    $('#daily-comparison-caption').textContent=`${result.date} 对比 ${comparison.previous_date||'前一天'}${comparison.in_progress?' · 今天进行中，前一天为全天记录':''}${!comparison.previous_has_execution?' · 前一天无执行记录':''}`;
    projects($('#daily-project-chart'),comparison.projects||[],{previous:comparison.previous_has_execution,currentHas:has});
    summary($('#daily-time-summary'),result.time_summary);
  }
  function weekly(node,result,mode,onDate) {
    const previous=result.comparison?.previous_days||[];
    const values=result.days.map(day=>day.date>todayIso()||!['approved','submitted'].includes(day.status)||!day.has_execution?null:day.main_actual_seconds);
    const prior=previous.map(day=>day.effective_seconds);
    const max=Math.max(1800,...values.filter(v=>v!==null),...prior.filter(v=>v!==null));
    const ceiling=Math.ceil(max/1800)*1800;
    const width=Math.max(348,Math.round(node.clientWidth || innerWidth-32)), left=36, right=width-4, top=30, bottom=200;
    const barWidth=Math.min(40,(right-left)/7*.62);
    const x=index=>left+((index+.5)/7)*(right-left);
    const y=value=>bottom-value/ceiling*(bottom-top);
    const axes=Array.from({length:4},(_,index)=>{const value=ceiling*index/3;return `<line x1="${left}" x2="${right}" y1="${y(value)}" y2="${y(value)}" class="chart-grid"/><text x="${left-8}" y="${y(value)+4}" text-anchor="end" class="chart-axis">${Math.round(value/60)}</text>`;}).join('');
    function line(series,old) {
      let paths='',points='',path='';
      series.forEach((value,index)=>{
        if(value===null||value===undefined){if(path)paths+=`<path d="${path}"/>`;path='';return;}
        path+=`${path?' L':'M'}${x(index)},${y(value)}`;
        points+=`<circle cx="${x(index)}" cy="${y(value)}" r="${old?3:4}"/>`;
      });
      if(path)paths+=`<path d="${path}"/>`;
      return `<g class="${old?'chart-prior-line':'chart-current-line'}">${paths}${points}</g>`;
    }
    const bars=values.map((value,index)=>value===null?'':`<rect class="chart-current-bar" x="${x(index)-barWidth/2}" y="${y(value)}" width="${barWidth}" height="${Math.max(0,bottom-y(value))}" rx="1"/>`).join('')+
      prior.map((value,index)=>value===null?'':`<line class="chart-prior-tick" x1="${x(index)-barWidth/2-2}" x2="${x(index)+barWidth/2+2}" y1="${y(value)}" y2="${y(value)}"/>`).join('');
    node.dataset.chartMode=mode;
    node.innerHTML=`<div class="weekly-chart-legend"><span><i class="legend-current"></i>本周主航线有效</span><span><i class="legend-previous"></i>上周对应日</span><span>分钟</span></div>
      <div class="weekly-plot-scroll"><div class="weekly-plot"><svg viewBox="0 0 ${width} 216" role="img" aria-label="${mode==='line'?'每日有效时间趋势':'每日有效时间柱形'}，可通过下方日期查看数值">${axes}${mode==='line'?line(prior,true)+line(values,false):bars}</svg>
      <div class="weekly-plot-targets">${result.days.map((day,index)=>`<button type="button" class="weekly-day-bar" data-date="${day.date}" ${day.date>todayIso()?'disabled':''} aria-label="${day.date}，有效${values[index]===null?'无记录':duration(values[index])}，上周${prior[index]==null?'无记录':duration(prior[index])}"><span class="weekly-bar-value">${day.date>todayIso()?'未到':values[index]===null?'无记录':duration(values[index])}</span><span class="weekly-hit-area" aria-hidden="true"></span><strong>周${'一二三四五六日'[index]}</strong><small>${day.date.slice(5).replace('-','/')}</small>${day.date===todayIso()?'<em>进行中</em>':''}</button>`).join('')}</div></div></div>
      <p class="chart-footnote">点日期查看当日复盘。无记录不按零值连线，未来留空。${result.comparison?.in_progress?'今天仍在进行，上周对应日为全天记录。':''}</p>`;
    $$('.weekly-day-bar',node).forEach(button=>button.onclick=()=>onDate(button.dataset.date));
    node._weeklyResize?.disconnect();
    node._weeklyResize=new ResizeObserver(()=>{
      const next=Math.max(348,Math.round(node.clientWidth||innerWidth-32));
      if(next!==width)weekly(node,result,mode,onDate);
    });
    node._weeklyResize.observe(node);
  }
  return {color,symbol,duration,metric,change,summary,projects,daily,weekly};
})();
