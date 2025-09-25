import json
from update_rcem import parse_html


SAMPLE_HTML = '''
<html><body>
<table>
<tr><td>2025</td></tr>
<tr><td>styczeń</td></tr>
<tr><td>RCEm</td><td>480,01</td><td>11.02.2025</td></tr>
<tr><td>skorygowana RCEm*</td><td>-</td><td>-</td></tr>
<tr><td>luty</td></tr>
<tr><td>RCEm</td><td>442,02</td><td>11.03.2025</td></tr>
<tr><td>skorygowana RCEm*</td><td>440,00</td><td>11.04.2025</td></tr>
</table>
</body></html>
'''


def test_parse_html_prefers_correction_when_later():
    data = parse_html(SAMPLE_HTML)
    assert '2025' in data
    jan = data['2025'].get('1')
    feb = data['2025'].get('2')
    # january has no valid correction -> should be base RCEm
    assert jan == 480.01
    # february has correction with later date -> should prefer 440.0
    assert feb == 440.0
