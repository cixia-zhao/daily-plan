"""分类作为时间段快照；旧记录保持原计总／中断语义。"""
CATEGORY_NAMES = {'learning':'有效学习','distraction':'分心','rest':'主动休息','external':'外部打断','life':'生活活动','legacy_interrupt':'其他非学习（旧记录）'}
DEFAULT_CATEGORIES = {'counted_toilet':'life','counted_walk':'rest','counted_game':'distraction',
                      'interrupt_meal':'life','interrupt_incident':'external','interrupt_pause':'rest'}


def label_category(label):
    return label.get('time_category') or DEFAULT_CATEGORIES.get(label['id'], 'distraction' if label['bucket']=='counted' else 'external')


def record_category(record):
    return record.get('time_category') or ('learning' if record['segment_kind']=='effective' else 'distraction' if record['segment_kind']=='counted_label' else 'legacy_interrupt')


def counts_in_learning_session(record):
    return record_category(record) in ('learning','distraction')


def summarize_categories(categories):
    categories={key:int(categories.get(key,0)) for key in CATEGORY_NAMES}
    denominator=categories['learning']+categories['distraction']
    return {'categories':categories,'recorded_seconds':sum(categories.values()),
            'session_seconds':denominator,'effective_ratio':round(categories['learning']/denominator,4) if denominator else None}


def time_summary(records, legacy_seconds=0):
    categories={key:0 for key in CATEGORY_NAMES}
    categories['learning']=legacy_seconds
    for record in records:
        if record.get('included',True):
            categories[record_category(record)]+=max(0,int(record.get('seconds',(record.get('minutes') or 0)*60)))
    return summarize_categories(categories)


def combine_summaries(summaries):
    return summarize_categories({key:sum(item['categories'][key] for item in summaries) for key in CATEGORY_NAMES})


def summary_text(summary):
    return '已记录时间分类：'+'；'.join(f'{CATEGORY_NAMES[key]} {seconds//60}分{seconds%60}秒' for key,seconds in summary['categories'].items() if seconds)
