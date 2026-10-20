from test_review_workspace import client_for


def test_morning_fields_hidden_by_default_separate_and_legacy_safe(tmp_path):
    client=client_for(tmp_path)
    initial=client.get('/api/settings').json()
    assert initial['show_energy_selector'] is False and initial['show_day_type_selector'] is False
    for energy,day_type in [(True,False),(False,True),(True,True)]:
        updated=client.put('/api/settings',json={**initial,'show_energy_selector':energy,'show_day_type_selector':day_type})
        assert updated.status_code==200,updated.text
        assert updated.json()['show_energy_selector'] is energy
        assert updated.json()['show_day_type_selector'] is day_type
    old={key:value for key,value in initial.items() if key not in ('show_energy_selector','show_day_type_selector')}
    preserved=client.put('/api/settings',json=old).json()
    assert preserved['show_energy_selector'] is True and preserved['show_day_type_selector'] is True
