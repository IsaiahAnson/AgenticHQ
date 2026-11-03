from tidepool.qc import flat_line, out_of_range, spike


def test_out_of_range_humidity():
    assert out_of_range("humidity_pct", 104.0)
    assert not out_of_range("humidity_pct", 63.5)


def test_flat_line_needs_a_full_window():
    assert not flat_line([12.1] * 5)
    assert flat_line([12.1] * 12)


def test_spike_on_water_level():
    assert spike(1.2, 2.9, limit=0.8)
    assert not spike(1.2, 1.5, limit=0.8)
