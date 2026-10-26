// 历史页复用记录编辑，不给历史日期提供新计时或完成勾选入口。
if (page === 'execution-history') {
  const date = $('#execute-date').value;
  let sequence = 0;
  PlanUI.setDate(date);
  updateDateTrigger($('#history-date-button'), date);
  bindSharedCalendarTrigger($('#history-date-button'), () => date, next => {
    if (window.DailyPlanRecords?.busy) { toast('请先保存或取消正在编辑的时间记录。'); return; }
    location.href = '/execute?date='+encodeURIComponent(next);
  }, '选择执行记录日期');
  const duration = seconds => {
    const value = Math.max(0,Math.floor(Number(seconds)||0));
    return value<60 ? (value ? `${value} 秒` : '0 分') : `${Math.floor(value/60)} 分${value%60 ? ` ${value%60} 秒` : ''}`;
  };
  function render(result) {
    const summary=result.time_summary;
    $('#history-metrics').innerHTML=[['有效学习',summary.categories.learning],['分心',summary.categories.distraction],['已记录时长',summary.recorded_seconds]].map(([name,value])=>`<div><span>${name}</span><strong>${duration(value)}</strong></div>`).join('');
    const board=new Map(result.task_execution_board.map(item=>[item.task_id,item]));
    $('#history-task-list').innerHTML=result.tasks.map(task=>{
      const item=board.get(task.id);
      const state=task.task_type==='habit' ? habitStatusLabel(task.habit_status) : task.completed ? '已完成' : '未标记完成';
      return `<article class="history-task" data-history-task-id="${task.id}" style="--project-color:${PlanVisuals.color(task.category)}"><div class="history-task-heading"><h3>${PlanVisuals.symbol(task.category)}${esc(task.title)}</h3><span>${esc(state)}</span></div><div class="history-task-metrics"><span>目标 ${Number(task.estimated_minutes)} 分</span><span>有效 ${duration(item?.effective_seconds ?? Number(task.actual_minutes||0)*60)}</span><span>总计 ${duration(item?.total_seconds ?? Number(task.actual_minutes||0)*60)}</span>${task.is_sub?'<span>其他活动</span>':''}</div></article>`;
    }).join('');
    const empty=!result.plan && !result.has_execution;
    $('#history-empty').hidden=!empty;
    $('#history-content').hidden=empty;
    $('#execution-controls').hidden=empty;
  }
  async function load(initial=true) {
    const request=++sequence;
    $('#history-loading').hidden=false;
    $('#history-error').hidden=true;
    try {
      let result;
      if(initial){
        await window.DailyPlanRecords.open(date);
        result=window.DailyPlanRecords.state;
        if(!result || result.date!==date)throw Error('时间记录尚未读取成功');
      }else result=await api('/api/daily-execution/'+date);
      if(request!==sequence)return;
      render(result);
    }catch(error){if(request===sequence){$('#history-error').hidden=false;$('#history-error p').textContent='读取失败，原记录保留。'+error.message;}}
    finally{if(request===sequence)$('#history-loading').hidden=true;}
  }
  $('#history-retry').onclick=()=>load();
  document.addEventListener('execution-records-changed',event=>{if(event.detail.date===date)load(false);});
  load();
}
