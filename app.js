(() => {
  'use strict';

  const GEO = window.QUAKE_DATA || { epicenters: [], capitals: [], coastalPoints: [], coastlineSegments: [] };
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MAP = { width: 920, height: 760, padX: 42, padY: 35, minLon: 120, maxLon: 172, minLat: 20, maxLat: 60 };
  const INTENSITY_COLORS = ['#c2d2dd', '#79d7a6', '#b6df71', '#f0df61', '#ffbf63', '#ff9769', '#f36b62', '#de477c', '#a92d8c', '#702366'];
  const INTENSITY_LABELS = ['0', '1', '2', '3', '4', '5弱', '5強', '6弱', '6強', '7'];
  const $mapLand = $('#map-land');
  const $mapPoints = $('#map-points');
  const $mapEpicenters = $('#map-epicenters');
  const $mapEmpty = $('#map-empty');
  const $resultsBody = $('#results-body');
  const $toast = $('#toast');

  const state = {
    mode: 'custom',
    layer: 'intensity',
    sources: [],
    nextSourceId: 1,
    lastResults: null,
    resultTab: 'intensity',
    officialRows: [],
    visibleRows: [],
    officialFileName: '',
    toastTimer: null,
  };

  function num(value, fallback = null) {
    if (value === null || value === undefined || String(value).trim() === '') return fallback;
    const n = Number(String(value).replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : fallback;
  }

  function fmt(value, decimals = 1) {
    return Number.isFinite(value) ? value.toLocaleString('ja-JP', { maximumFractionDigits: decimals, minimumFractionDigits: 0 }) : '—';
  }

  function escapeCsv(value) {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function csvParse(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    const source = String(text).replace(/^\uFEFF/, '');
    for (let i = 0; i < source.length; i += 1) {
      const ch = source[i];
      if (inQuotes) {
        if (ch === '"' && source[i + 1] === '"') { field += '"'; i += 1; }
        else if (ch === '"') inQuotes = false;
        else field += ch;
      } else if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (ch !== '\r') field += ch;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    if (!rows.length) return [];
    const headers = rows.shift().map((h) => h.trim());
    return rows.filter((r) => r.some((v) => String(v).trim() !== '')).map((r) => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = (r[i] ?? '').trim(); });
      return obj;
    });
  }

  function firstField(row, candidates, fallback = '') {
    for (const key of candidates) {
      if (row[key] !== undefined && String(row[key]).trim() !== '') return String(row[key]).trim();
      const found = Object.keys(row).find((k) => k.toLowerCase() === key.toLowerCase());
      if (found && String(row[found]).trim() !== '') return String(row[found]).trim();
    }
    return fallback;
  }

  function normalizeSourceType(raw) {
    const val = String(raw || '').trim();
    if (val.includes('実測') || val.includes('観測')) return '実測';
    if (val.includes('公的') || val.includes('想定') || !val) return '公的想定';
    return val;
  }

  function parseIntensity(value) {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    const raw = String(value).trim().replace(/^震度\s*/, '');
    const labelMap = { '0': 0, '1': 1, '2': 2, '3': 3, '4': 4, '5弱': 5, '5強': 6, '6弱': 7, '6強': 8, '7': 9,
      '5-': 5, '5+': 6, '6-': 7, '6+': 8, '5弱相当': 5, '5強相当': 6, '6弱相当': 7, '6強相当': 8 };
    if (Object.hasOwn(labelMap, raw)) return labelMap[raw];
    const n = num(raw, null);
    if (n === null) return null;
    if (n < 0) return null;
    if (n <= 7 && Number.isInteger(n)) return Math.max(0, Math.min(9, Math.round(n)));
    // A numeric calculated seismic intensity is not necessarily a JMA class; use the nearest display class only for color.
    if (n < 0.5) return 0;
    if (n < 1.5) return 1;
    if (n < 2.5) return 2;
    if (n < 3.5) return 3;
    if (n < 4.5) return 4;
    if (n < 5.0) return 5;
    if (n < 5.5) return 6;
    if (n < 6.0) return 7;
    if (n < 6.5) return 8;
    return 9;
  }

  function intensityLabel(rank) {
    return rank === null || rank === undefined ? '—' : INTENSITY_LABELS[Math.max(0, Math.min(9, rank))];
  }

  function intensityColor(rank) {
    return rank === null || rank === undefined ? '#a8b7c2' : INTENSITY_COLORS[Math.max(0, Math.min(9, rank))];
  }

  function rankFromIntensityValue(value) {
    return parseIntensity(value);
  }

  function distanceKm(lat1, lon1, lat2, lon2) {
    const rad = Math.PI / 180;
    const phi1 = lat1 * rad, phi2 = lat2 * rad;
    const dPhi = (lat2 - lat1) * rad, dLambda = (lon2 - lon1) * rad;
    const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
    return 6371.0088 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  }

  // Transparent magnitude-distance screening equation, not a calibrated GMPE.
  // I* = a Mw - b log10(Rhyp) - c. Coefficients are illustrative and must not
  // be interpreted as a validated Japanese ground-motion prediction equation.
  const SCREENING_COEFFICIENTS = { a: 1.35, b: 2.2, c: 1.0 };

  function intensityFromMagnitudeDistance(magnitude, hypocentralKm) {
    const r = Math.max(1, hypocentralKm);
    const { a, b, c } = SCREENING_COEFFICIENTS;
    const index = a * magnitude - b * Math.log10(r) - c;
    let rank = 0;
    if (index < 0.5) rank = 0;
    else if (index < 1.5) rank = 1;
    else if (index < 2.5) rank = 2;
    else if (index < 3.5) rank = 3;
    else if (index < 4.5) rank = 4;
    else if (index < 5.0) rank = 5;
    else if (index < 5.5) rank = 6;
    else if (index < 6.0) rank = 7;
    else if (index < 6.5) rank = 8;
    else rank = 9;
    // This equivalent PGA is display/debug-only; the class is determined by I*.
    const pga = 10 ** Math.max(-3, Math.min(5, (index - 0.94) / 2));
    return { rank, index, pga };
  }

  function createSource(fields) {
    return { id: state.nextSourceId++, name: fields.name, lat: fields.lat, lon: fields.lon,
      magnitude: fields.magnitude, depth: fields.depth, uplift: fields.uplift, radius: fields.radius, waterDepth: fields.waterDepth };
  }

  function currentDraft() {
    return {
      name: $('#epicenter-select').selectedOptions[0]?.textContent || '任意の震源',
      lat: num($('#source-lat').value), lon: num($('#source-lon').value),
      magnitude: num($('#magnitude').value), depth: num($('#depth').value),
      uplift: num($('#uplift').value), radius: num($('#radius').value), waterDepth: num($('#water-depth').value),
    };
  }

  function validateSource(source) {
    return Number.isFinite(source.lat) && source.lat >= 10 && source.lat <= 75 &&
      Number.isFinite(source.lon) && source.lon >= 110 && source.lon <= 180 &&
      Number.isFinite(source.magnitude) && source.magnitude >= 4 &&
      Number.isFinite(source.depth) && source.depth >= 1 && source.depth <= 700 &&
      Number.isFinite(source.uplift) && source.uplift >= 0 && source.uplift <= 20 &&
      Number.isFinite(source.radius) && source.radius >= 5 && source.radius <= 500 &&
      Number.isFinite(source.waterDepth) && source.waterDepth >= 100 && source.waterDepth <= 12000;
  }

  let bathymetryRequestId = 0;
  async function lookupOceanDepth(lat, lon, { silent = false } = {}) {
    const status = $('#bathymetry-status');
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const requestId = ++bathymetryRequestId;
    if (status) status.textContent = 'GEBCO 2020の標高・水深データを問い合わせています…';
    try {
      // OpenTopoData's public GEBCO 2020 endpoint returns elevation in metres:
      // negative elevations are ocean depth. Requires internet and may be rate-limited.
      const url = `https://api.opentopodata.org/v1/gebco2020?locations=${encodeURIComponent(`${lat},${lon}`)}`;
      const response = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (requestId !== bathymetryRequestId) return;
      const elevation = data?.results?.[0]?.elevation;
      if (!Number.isFinite(elevation)) throw new Error('標高・水深データがありません');
      if (elevation >= 0) {
        if (status) status.textContent = `この座標の地表標高は約${Math.round(elevation)}mです。陸上のため海底水深は自動設定できません。沖合の震源を選ぶか、水深を手動入力してください。`;
        return;
      }
      const depth = Math.max(100, Math.min(12000, Math.round(Math.abs(elevation) / 100) * 100));
      $('#water-depth').value = depth;
      if (status) status.textContent = `自動取得：GEBCO 2020の標高値 ${Math.round(elevation)}m → 仮定水深 ${depth}m（震源座標での1点サンプル。沿岸波動計算用の詳細海底地形ではありません）。`;
    } catch (error) {
      if (requestId !== bathymetryRequestId) return;
      if (status) status.textContent = '自動取得できませんでした（通信・CORS・API制限の可能性）。水深は手動入力値を保持します。オンライン環境で再試行してください。';
      if (!silent) toast('水深データを自動取得できませんでした。手動入力も利用できます。', true);
    }
  }

  function populateEpicenterSelect() {
    const select = $('#epicenter-select');
    select.replaceChildren();
    GEO.epicenters.forEach((p, index) => {
      const option = document.createElement('option');
      option.value = String(index); option.textContent = p.name;
      select.append(option);
    });
    const defaultIndex = GEO.epicenters.findIndex((p) => p.name === '南海トラフ想定域');
    select.value = String(defaultIndex >= 0 ? defaultIndex : 0);
    updateEpicenterCoordinates();
  }

  function updateEpicenterCoordinates() {
    const point = GEO.epicenters[Number($('#epicenter-select').value)];
    if (!point) return;
    $('#source-lat').value = point.lat;
    $('#source-lon').value = point.lon;
  }

  function renderSourceList() {
    const list = $('#source-list');
    list.replaceChildren();
    $('#source-count').textContent = String(state.sources.length);
    if (!state.sources.length) {
      const empty = document.createElement('div'); empty.className = 'file-status';
      empty.textContent = '震源がありません。上のフォームから追加してください。'; list.append(empty); return;
    }
    state.sources.forEach((source, index) => {
      const item = document.createElement('div'); item.className = 'source-item';
      const dot = document.createElement('span'); dot.className = 'source-dot'; dot.style.background = ['#e5aa61', '#d96d58', '#6d8ed6', '#67bda2'][index % 4];
      const details = document.createElement('div'); details.className = 'source-details';
      const strong = document.createElement('strong'); strong.textContent = `${source.name} · Mw ${source.magnitude.toFixed(1)}`;
      const small = document.createElement('small'); small.textContent = `深さ ${source.depth} km · (${source.lat.toFixed(2)}, ${source.lon.toFixed(2)}) · 変位仮定 ${source.uplift.toFixed(1)} m`;
      details.append(strong, small);
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'source-remove'; remove.title = 'この震源を削除'; remove.setAttribute('aria-label', `${source.name}を削除`); remove.textContent = '×';
      remove.addEventListener('click', () => { state.sources = state.sources.filter((s) => s.id !== source.id); renderSourceList(); if (state.lastResults?.mode === 'custom') clearCurrentResults('custom'); });
      item.append(dot, details, remove); list.append(item);
    });
  }

  function calcIntensityAt(lat, lon, sources) {
    let best = { rank: 0, pga: 0.1, source: '—', distance: null, index: -1 };
    sources.forEach((source) => {
      const horizontal = distanceKm(lat, lon, source.lat, source.lon);
      const hypocentral = Math.hypot(horizontal, source.depth);
      const estimate = intensityFromMagnitudeDistance(source.magnitude, hypocentral);
      if (estimate.pga > best.pga) best = { ...estimate, source: source.name, distance: hypocentral, index: source.id };
    });
    return best;
  }

  function calcTsunamiAt(point, sources, durationMin) {
    let best = { height: 0, arrivalMin: null, source: '—', distance: null, waterDepth: 4000, uplift: 0 };
    sources.forEach((source) => {
      const horizontal = distanceKm(point.lat, point.lon, source.lat, source.lon);
      // Heuristic radial spreading from a user-assumed initial displacement, not a bathymetry-resolving tsunami solver.
      const radius = Math.max(5, source.radius);
      const height = Math.abs(source.uplift) * Math.sqrt(radius / Math.max(radius, horizontal)) * Math.exp(-horizontal / 1800) * 0.65;
      const speedMps = Math.sqrt(9.80665 * source.waterDepth);
      const speedKmh = speedMps * 3.6;
      const arrivalMin = (horizontal / speedKmh) * 60;
      if (height > best.height) {
        best = { height, arrivalMin: arrivalMin <= durationMin ? arrivalMin : null, source: source.name,
          distance: horizontal, waterDepth: source.waterDepth, uplift: source.uplift, estimatedArrivalAll: arrivalMin };
      }
    });
    return best;
  }

  function rowBase({ name, area, lat, lon, sourceType, scenario, caseName }) {
    return { name, area, lat, lon, sourceType, scenario: scenario || '', caseName: caseName || '', intensityRank: null,
      intensityRaw: '', tsunamiHeight: null, arrivalMin: null, source: '', distanceKm: null, pga: null, observedAt: '', sourceUrl: '' };
  }

  function runCustomSimulation() {
    if (!state.sources.length) { toast('震源が登録されていません。先に震源を追加してください。', true); return; }
    const duration = num($('#duration').value, 180);
    if (duration < 10 || duration > 360) { toast('計算対象時間は10〜360分で設定してください。', true); return; }
    const capitalRows = GEO.capitals.map((p) => {
      const intensity = calcIntensityAt(p.lat, p.lon, state.sources);
      const row = rowBase({ name: p.prefecture, area: '都道府県庁所在地', lat: p.lat, lon: p.lon, sourceType: 'モデル推定' });
      Object.assign(row, { intensityRank: intensity.rank, intensityRaw: intensityLabel(intensity.rank), pga: intensity.pga,
        source: intensity.source, distanceKm: intensity.distance, locationType: 'capital' });
      return row;
    });
    const coastRows = GEO.coastalPoints.map((p) => {
      const intensity = calcIntensityAt(p.lat, p.lon, state.sources);
      const tsunami = calcTsunamiAt(p, state.sources, duration);
      const row = rowBase({ name: p.name, area: '沿岸代表地点', lat: p.lat, lon: p.lon, sourceType: 'モデル推定' });
      Object.assign(row, { intensityRank: intensity.rank, intensityRaw: intensityLabel(intensity.rank), pga: intensity.pga,
        source: tsunami.height >= 0.1 ? tsunami.source : intensity.source, distanceKm: intensity.distance,
        tsunamiHeight: tsunami.height, arrivalMin: tsunami.arrivalMin, arrivalUnclipped: tsunami.estimatedArrivalAll ?? null,
        waterDepth: tsunami.waterDepth, uplift: tsunami.uplift, locationType: 'coast' });
      return row;
    });
    const allRows = [...capitalRows, ...coastRows];
    const intensityRows = allRows.filter((r) => r.intensityRank !== null && r.intensityRank >= 1).sort((a, b) => b.intensityRank - a.intensityRank || a.name.localeCompare(b.name, 'ja'));
    const tsunamiRows = coastRows.filter((r) => Number.isFinite(r.tsunamiHeight) && r.tsunamiHeight >= 0.1).sort((a, b) => b.tsunamiHeight - a.tsunamiHeight);
    state.lastResults = { allRows, intensityRows, tsunamiRows, capitalRows, coastRows, sources: [...state.sources], mode: 'custom', duration };
    state.layer = $('#map-layer-select').value;
    setDataBadge('モデル推定');
    $('#workspace-title').textContent = '日本列島マップ';
    $('#workspace-subtitle').textContent = '自由設定モデルによる参考推定。観測値・公的想定とは別の結果です。';
    updateCustomResults();
    state.resultTab = 'intensity'; selectResultTab('intensity');
    renderMap();
    $('#export-csv').disabled = false;
    // Also make a machine-readable report available in the browser developer console.
    console.group('JAPAN QUAKE LAB / custom model estimate');
    console.info('This is a simplified educational estimate, not an operational earthquake or tsunami forecast.');
    console.table(allRows.map(toExportObject));
    console.groupEnd();
    toast(`計算完了：代表地点 ${allRows.length} 件、震度1以上 ${intensityRows.length} 件、津波10cm以上 ${tsunamiRows.length} 件。`);
  }

  function cleanHeaderKey(key) { return String(key || '').trim().replace(/^\uFEFF/, ''); }

  function normalizeOfficialRow(raw, index, fileName) {
    const row = {};
    for (const [k, v] of Object.entries(raw)) row[cleanHeaderKey(k)] = v;
    const type = normalizeSourceType(firstField(row, ['source_type', 'データ区分', '区分'], '公的想定'));
    const scenario = firstField(row, ['scenario', 'シナリオ', '想定地震'], fileName.replace(/\.csv$/i, ''));
    const caseName = firstField(row, ['case', 'ケース', 'case_name'], '標準');
    const prefecture = firstField(row, ['prefecture', '都道府県', '都道府県名']);
    const municipality = firstField(row, ['municipality', '地点', '市区町村', '観測点', '地点名']);
    let latitude = num(firstField(row, ['latitude', 'lat', '緯度']), null);
    let longitude = num(firstField(row, ['longitude', 'lon', 'lng', '経度']), null);
    const knownCapital = GEO.capitals.find((p) => p.prefecture === prefecture);
    let locationType = 'official';
    if ((!Number.isFinite(latitude) || !Number.isFinite(longitude)) && knownCapital) {
      latitude = knownCapital.lat; longitude = knownCapital.lon; locationType = 'capital-fallback';
    }
    const intensityRaw = firstField(row, ['intensity', '震度', '最大震度']);
    const tsunamiRaw = firstField(row, ['tsunami_height_m', '津波高m', '津波高（m）', '津波高', '最大津波高(m)']);
    const arrivalRaw = firstField(row, ['arrival_min', '到達時間分', '到達時間（分）', '津波到達時間(分)']);
    const arrival1 = num(firstField(row, ['arrival_1m_min', '津波高1m到達時間(分)', '津波高+1m(分)']), null);
    const arrival3 = num(firstField(row, ['arrival_3m_min', '津波高3m到達時間(分)', '津波高+3m(分)']), null);
    const arrival5 = num(firstField(row, ['arrival_5m_min', '津波高5m到達時間(分)', '津波高+5m(分)']), null);
    const arrival10 = num(firstField(row, ['arrival_10m_min', '津波高10m到達時間(分)', '津波高+10m(分)']), null);
    const arrival20 = num(firstField(row, ['arrival_20m_min', '津波高20m到達時間(分)', '津波高+20m(分)']), null);
    const rawIntensityRank = parseIntensity(intensityRaw);
    return {
      rowId: index, name: municipality || prefecture || `地点${index + 1}`, area: prefecture || '地点', prefecture, municipality,
      lat: latitude, lon: longitude, sourceType: type, scenario, caseName,
      intensityRank: rawIntensityRank, intensityRaw: intensityRaw || (rawIntensityRank === null ? '' : intensityLabel(rawIntensityRank)),
      intensityOriginal: intensityRaw, tsunamiHeight: num(tsunamiRaw, null), arrivalMin: num(arrivalRaw, arrival1),
      arrivalByThreshold: { 1: arrival1, 3: arrival3, 5: arrival5, 10: arrival10, 20: arrival20 }, arrivalGeneric: num(arrivalRaw, null),
      observedAt: firstField(row, ['observed_at', '観測日時', '日時']), sourceUrl: firstField(row, ['source_url', '出典URL', '出典']),
      locationType, pga: null, source: scenario, distanceKm: null,
    };
  }

  async function handleOfficialFile(event) {
    const file = event.target.files?.[0]; if (!file) return;
    try {
      const text = await file.text();
      const parsed = csvParse(text);
      if (!parsed.length) throw new Error('データ行がありません。ヘッダー行とデータを確認してください。');
      const rows = parsed.map((row, i) => normalizeOfficialRow(row, i, file.name));
      const hasUsefulValue = rows.some((r) => r.intensityRank !== null || r.tsunamiHeight !== null || r.arrivalMin !== null);
      if (!hasUsefulValue) throw new Error('震度・津波高・到達時間の数値列が見つかりません。CSVテンプレートの列名を確認してください。');
      state.officialRows = rows;
      state.officialFileName = file.name;
      $('#official-file-status').textContent = `${file.name} · ${rows.length.toLocaleString('ja-JP')}行を読み込みました。数値の正しさは元資料と照合してください。`;
      updateOfficialSelectors();
      $('#show-official').disabled = false;
      toast(`CSVを読み込みました（${rows.length}行）。シナリオとケースを選んで表示してください。`);
    } catch (err) {
      $('#official-file-status').textContent = `読込エラー：${err.message}`;
      toast(`CSV読込エラー：${err.message}`, true);
    }
  }

  function fillSelect(select, values, placeholder) {
    const prev = select.value;
    select.replaceChildren();
    if (placeholder !== null) { const o = document.createElement('option'); o.value = ''; o.textContent = placeholder; select.append(o); }
    values.forEach((v) => { const o = document.createElement('option'); o.value = v; o.textContent = v; select.append(o); });
    if (values.includes(prev)) select.value = prev;
    else if (values.length) select.value = values[0];
  }

  function updateOfficialSelectors() {
    const sourceFilter = $('#official-source-filter').value;
    const typeRows = state.officialRows.filter((r) => sourceFilter === 'all' || r.sourceType === sourceFilter);
    const scenarios = [...new Set(typeRows.map((r) => r.scenario).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ja'));
    fillSelect($('#official-scenario-filter'), scenarios, scenarios.length ? 'シナリオを選択' : '該当データなし');
    const scenario = $('#official-scenario-filter').value;
    const cases = [...new Set(typeRows.filter((r) => !scenario || r.scenario === scenario).map((r) => r.caseName).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ja'));
    fillSelect($('#official-case-filter'), cases, 'すべてのケース');
    $('#official-scenario-filter').disabled = scenarios.length === 0;
    $('#official-case-filter').disabled = cases.length === 0;
    $('#show-official').disabled = state.officialRows.length === 0;
  }

  function showOfficialResults() {
    const sourceFilter = $('#official-source-filter').value;
    const scenario = $('#official-scenario-filter').value;
    const caseName = $('#official-case-filter').value;
    const selectedThreshold = Number($('#official-arrival-threshold').value || 1);
    const rawRows = state.officialRows.filter((r) =>
      (sourceFilter === 'all' || r.sourceType === sourceFilter) &&
      (!scenario || r.scenario === scenario) && (!caseName || r.caseName === caseName));
    if (!rawRows.length) { toast('選択条件に一致する行がありません。', true); return; }
    const rows = rawRows.map((r) => ({ ...r, arrivalMin: r.arrivalByThreshold?.[selectedThreshold] ?? r.arrivalGeneric ?? (selectedThreshold === 1 ? r.arrivalMin : null), selectedArrivalThreshold: selectedThreshold }));
    state.lastResults = { mode: 'official', allRows: rows, intensityRows: rows.filter((r) => r.intensityRank !== null && r.intensityRank >= 1).sort((a, b) => b.intensityRank - a.intensityRank),
      tsunamiRows: rows.filter((r) => Number.isFinite(r.tsunamiHeight) && r.tsunamiHeight >= 0.1).sort((a, b) => b.tsunamiHeight - a.tsunamiHeight),
      capitalRows: rows.filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon)), coastRows: rows.filter((r) => Number.isFinite(r.tsunamiHeight)) };
    state.layer = $('#map-layer-select').value;
    const types = new Set(rows.map((r) => r.sourceType));
    setDataBadge(types.size === 1 ? [...types][0] : '混合データ');
    $('#workspace-title').textContent = scenario || '読み込んだデータ';
    $('#workspace-subtitle').textContent = `CSV「${state.officialFileName}」から抽出した${rows.length}行。到達時間：${selectedThreshold}mしきい値（利用可能な場合）。元資料と照合してください。`;
    updateOfficialResults();
    state.resultTab = 'intensity'; selectResultTab('intensity'); renderMap();
    $('#export-csv').disabled = false;
    console.group('JAPAN QUAKE LAB / imported data'); console.info('Imported CSV data; verify against the original official/observed source.'); console.table(rows.map(toExportObject)); console.groupEnd();
    toast(`表示しました：${rows.length}行。元データの出典・ケースを確認してください。`);
  }

  function updateCustomResults() {
    const res = state.lastResults;
    if (!res || res.mode !== 'custom') return;
    const intensityCount = res.intensityRows.length;
    const tsunamiCount = res.tsunamiRows.length;
    const maxIntensityRow = [...res.allRows].filter((r) => r.intensityRank !== null).sort((a, b) => (b.intensityRank ?? -1) - (a.intensityRank ?? -1))[0];
    const maxTsunamiRow = [...res.coastRows].sort((a, b) => (b.tsunamiHeight ?? -1) - (a.tsunamiHeight ?? -1))[0];
    $('#metric-intensity').textContent = String(intensityCount);
    $('#metric-tsunami').textContent = String(tsunamiCount);
    $('#metric-max-intensity').textContent = maxIntensityRow ? `震度${intensityLabel(maxIntensityRow.intensityRank)}` : '—';
    $('#metric-max-place').textContent = maxIntensityRow?.name || '—';
    $('#metric-max-tsunami').textContent = maxTsunamiRow && Number.isFinite(maxTsunamiRow.tsunamiHeight) ? `${fmt(maxTsunamiRow.tsunamiHeight, 2)} m` : '—';
    $('#metric-max-tsunami-place').textContent = maxTsunamiRow?.name || '—';
    $('#tab-count-intensity').textContent = String(intensityCount);
    $('#tab-count-tsunami').textContent = String(tsunamiCount);
    $('#tab-count-all').textContent = String(res.allRows.length);
    $('#map-empty').hidden = false;
    $('#map-empty strong').textContent = 'モデル推定を表示中';
    $('#map-empty p').textContent = '地図の各点に参考推定値を表示しています。公的想定・観測値ではありません。';
    renderResultsTable();
  }

  function updateOfficialResults() {
    const res = state.lastResults;
    if (!res || res.mode !== 'official') return;
    const types = new Set(res.allRows.map((r) => r.sourceType));
    $('#metric-intensity').textContent = String(res.intensityRows.length);
    $('#metric-tsunami').textContent = String(res.tsunamiRows.length);
    const maxInt = [...res.allRows].filter((r) => r.intensityRank !== null).sort((a, b) => b.intensityRank - a.intensityRank)[0];
    const maxWave = [...res.allRows].filter((r) => Number.isFinite(r.tsunamiHeight)).sort((a, b) => b.tsunamiHeight - a.tsunamiHeight)[0];
    $('#metric-max-intensity').textContent = maxInt ? `震度${intensityLabel(maxInt.intensityRank)}` : '—';
    $('#metric-max-place').textContent = maxInt?.name || '該当値なし';
    $('#metric-max-tsunami').textContent = maxWave ? `${fmt(maxWave.tsunamiHeight, 2)} m` : '—';
    $('#metric-max-tsunami-place').textContent = maxWave?.name || '該当値なし';
    $('#tab-count-intensity').textContent = String(res.intensityRows.length);
    $('#tab-count-tsunami').textContent = String(res.tsunamiRows.length);
    $('#tab-count-all').textContent = String(res.allRows.length);
    $('#map-empty').hidden = false;
    $('#map-empty strong').textContent = '読み込んだデータを表示中';
    $('#map-empty p').textContent = '公式資料から整理した値です。元資料の想定ケース・単位・地点と照合してください。';
    renderResultsTable();
  }

  function setDataBadge(type) {
    const badge = $('#data-badge');
    badge.className = 'data-badge';
    if (type === '実測') badge.classList.add('observed');
    else if (type === '公的想定') badge.classList.add('official');
    else if (type === '混合データ') badge.classList.add('mixed');
    else badge.classList.add('estimate');
    badge.replaceChildren();
    const dot = document.createElement('span'); dot.className = 'badge-dot';
    const text = document.createElement('span'); text.textContent = type;
    badge.append(dot, text);
  }

  function selectResultTab(name) {
    state.resultTab = name;
    $$('.result-tab').forEach((tab) => {
      const active = tab.dataset.table === name;
      tab.classList.toggle('active', active); tab.setAttribute('aria-selected', String(active));
    });
    renderResultsTable();
  }

  function currentTableRows() {
    if (!state.lastResults) return [];
    if (state.resultTab === 'intensity') return state.lastResults.intensityRows;
    if (state.resultTab === 'tsunami') return state.lastResults.tsunamiRows;
    return state.lastResults.allRows;
  }

  function renderResultsTable() {
    const rows = currentTableRows();
    $resultsBody.replaceChildren();
    const descs = { intensity: '震度1以上の地点を強い順に表示', tsunami: '津波高・モデル波幅が0.1m以上の沿岸地点', all: '読み込んだ／計算したすべての代表地点' };
    $('#table-description').textContent = descs[state.resultTab];
    $('#row-count').textContent = `${rows.length.toLocaleString('ja-JP')}件`;
    if (!rows.length) {
      const tr = document.createElement('tr'); tr.className = 'placeholder-row'; const td = document.createElement('td'); td.colSpan = 6;
      td.textContent = state.lastResults ? 'この条件に該当する地点はありません。' : 'ここに結果が表示されます。'; tr.append(td); $resultsBody.append(tr); return;
    }
    const frag = document.createDocumentFragment();
    rows.forEach((row) => {
      const tr = document.createElement('tr');
      const loc = document.createElement('td');
      const name = document.createElement('span'); name.className = 'place-name'; name.textContent = row.name || '—'; loc.append(name);
      if (row.area) { const sub = document.createElement('span'); sub.className = 'sub-place'; sub.textContent = row.area; loc.append(sub); }
      tr.append(loc);
      const area = document.createElement('td'); const areaPill = document.createElement('span'); areaPill.className = 'class-pill'; areaPill.textContent = row.locationType === 'capital' || row.area === '都道府県庁所在地' ? '庁所在地' : (row.locationType === 'coast' || row.area === '沿岸代表地点' ? '沿岸地点' : (row.prefecture || row.area || '—')); area.append(areaPill); tr.append(area);
      const intensity = document.createElement('td');
      const rank = row.intensityRank;
      const ipill = document.createElement('span'); ipill.className = 'intensity-pill'; ipill.style.background = rank === null ? '#eef2f5' : `${intensityColor(rank)}38`; ipill.style.color = rank === null ? '#8495a3' : '#213448';
      ipill.textContent = row.intensityRaw || (rank === null ? '—' : intensityLabel(rank)); intensity.append(ipill); tr.append(intensity);
      const height = document.createElement('td'); height.textContent = Number.isFinite(row.tsunamiHeight) ? `${fmt(row.tsunamiHeight, 2)} m` : '—'; tr.append(height);
      const arrival = document.createElement('td');
      if (Number.isFinite(row.arrivalMin)) arrival.textContent = `${fmt(row.arrivalMin, 1)} 分`;
      else if (Number.isFinite(row.arrivalUnclipped)) arrival.textContent = '計算対象時間外';
      else arrival.textContent = '—';
      tr.append(arrival);
      const typ = document.createElement('td'); const pill = document.createElement('span');
      pill.className = `kind-pill ${row.sourceType === '実測' ? 'observed' : (row.sourceType === '公的想定' ? 'official' : '')}`;
      pill.textContent = row.sourceType || '—'; typ.append(pill); tr.append(typ);
      frag.append(tr);
    });
    $resultsBody.append(frag);
  }

  function project(lon, lat) {
    const x = MAP.padX + ((lon - MAP.minLon) / (MAP.maxLon - MAP.minLon)) * (MAP.width - MAP.padX * 2);
    const mercator = (v) => Math.log(Math.tan(Math.PI / 4 + (v * Math.PI / 180) / 2));
    const minY = mercator(MAP.minLat), maxY = mercator(MAP.maxLat), yv = mercator(Math.max(MAP.minLat, Math.min(MAP.maxLat, lat)));
    const y = MAP.padY + ((maxY - yv) / (maxY - minY)) * (MAP.height - MAP.padY * 2);
    return { x, y };
  }

  function svgEl(tag, attrs = {}) {
    const el = document.createElementNS(SVG_NS, tag);
    Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, String(v)));
    return el;
  }

  function drawBaseMap() {
    $mapLand.replaceChildren();
    GEO.coastlineSegments.forEach((segment) => {
      if (!Array.isArray(segment) || segment.length < 3) return;
      const coords = segment.map((pair) => project(pair[0], pair[1]));
      const d = coords.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ') + ' Z';
      const path = svgEl('path', { d, class: 'land-shape' });
      $mapLand.append(path);
    });
    // Soft latitude guides help orient the schematic without implying a projected hazard grid.
    [25, 30, 35, 40, 45].forEach((lat) => {
      const a = project(MAP.minLon, lat), b = project(MAP.maxLon, lat);
      const line = svgEl('path', { d: `M${a.x},${a.y} L${b.x},${b.y}`, class: 'grid-guide' });
      $mapLand.append(line);
    });
  }

  function makePoint({ x, y, r, fill, label, sub, className = 'map-point', title, onClick, showLabel = false, labelDx = 7, labelDy = -7 }) {
    const group = svgEl('g', { class: 'map-point-group' });
    const circle = svgEl('circle', { cx: x, cy: y, r, fill, class: className });
    const titleEl = svgEl('title'); titleEl.textContent = title || label || '';
    circle.append(titleEl);
    if (onClick) circle.addEventListener('click', onClick);
    circle.addEventListener('mouseenter', () => { circle.setAttribute('r', String(r + 1.5)); });
    circle.addEventListener('mouseleave', () => { circle.setAttribute('r', String(r)); });
    group.append(circle);
    if (showLabel && label) {
      const txt = svgEl('text', { x: x + labelDx, y: y + labelDy, class: 'point-label' }); txt.textContent = label; group.append(txt);
    }
    return group;
  }

  function colorForWave(height) {
    if (!Number.isFinite(height)) return '#aab8c3';
    if (height < 0.1) return '#a8c4d0';
    if (height < 0.3) return '#61bdc9';
    if (height < 1) return '#347fd1';
    if (height < 3) return '#565fca';
    if (height < 5) return '#9155bd';
    if (height < 10) return '#c34e98';
    return '#e45a78';
  }

  function rowsForMap() {
    if (!state.lastResults) return { capitals: [], coast: [], official: [] };
    const res = state.lastResults;
    if (res.mode === 'custom') return { capitals: res.capitalRows, coast: res.coastRows, official: [] };
    const withCoords = res.allRows.filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
    const exact = withCoords.filter((r) => r.locationType !== 'capital-fallback');
    const fallback = withCoords.filter((r) => r.locationType === 'capital-fallback');
    const groups = new Map();
    fallback.forEach((r) => {
      const key = r.prefecture || r.area || r.name;
      const old = groups.get(key);
      if (!old) groups.set(key, { ...r, name: key, intensityRank: r.intensityRank, tsunamiHeight: r.tsunamiHeight, count: 1 });
      else {
        old.count += 1;
        if (r.intensityRank !== null && (old.intensityRank === null || r.intensityRank > old.intensityRank)) { old.intensityRank = r.intensityRank; old.intensityRaw = r.intensityRaw; }
        if (Number.isFinite(r.tsunamiHeight) && (!Number.isFinite(old.tsunamiHeight) || r.tsunamiHeight > old.tsunamiHeight)) { old.tsunamiHeight = r.tsunamiHeight; old.arrivalMin = r.arrivalMin; }
      }
    });
    return { capitals: [], coast: [], official: [...exact, ...groups.values()] };
  }

  function renderMap() {
    $mapPoints.replaceChildren(); $mapEpicenters.replaceChildren();
    const mode = state.lastResults?.mode || state.mode;
    const layer = state.mode === 'official' ? state.layer : $('#map-layer-select').value;
    state.layer = layer;
    const { capitals, coast, official } = rowsForMap();
    const showLabels = $('#show-labels').checked;
    let markerCount = 0;
    if (layer === 'epicenters' && mode === 'custom' && state.lastResults) {
      (state.lastResults.sources || []).forEach((source, i) => {
        const p = project(source.lon, source.lat);
        const ring = svgEl('circle', { cx: p.x, cy: p.y, r: 12 + (i % 3) * 3, class: 'epicenter-ring' });
        const point = makePoint({ x: p.x, y: p.y, r: 5, fill: '#e46e55', label: source.name, className: 'epicenter-point', showLabel: true,
          title: `${source.name} / Mw ${source.magnitude.toFixed(1)} / 深さ${source.depth} km` });
        $mapEpicenters.append(ring, point); markerCount += 1;
      });
      $('#map-layer-name').textContent = '登録した震源';
      renderLegend('epicenters');
    } else if (mode === 'official') {
      official.forEach((row) => {
        if (!Number.isFinite(row.lat) || !Number.isFinite(row.lon)) return;
        const p = project(row.lon, row.lat);
        const value = layer === 'tsunami' ? row.tsunamiHeight : row.intensityRank;
        const fill = layer === 'tsunami' ? colorForWave(row.tsunamiHeight) : intensityColor(row.intensityRank);
        const r = layer === 'tsunami' ? Math.min(11, 4 + Math.sqrt(Math.max(0, row.tsunamiHeight || 0)) * 2) : (row.intensityRank === null ? 3.5 : 4.1 + row.intensityRank * .45);
        const label = row.name || row.prefecture || '地点';
        const valText = layer === 'tsunami' ? (Number.isFinite(row.tsunamiHeight) ? `津波高 ${fmt(row.tsunamiHeight, 2)} m` : '津波高 未収録') : `震度 ${row.intensityRaw || intensityLabel(row.intensityRank)}`;
        const point = makePoint({ x: p.x, y: p.y, r, fill, label, className: 'map-point', showLabel: showLabels || (layer === 'intensity' && row.intensityRank !== null && row.intensityRank >= 6) || (layer === 'tsunami' && row.tsunamiHeight >= 1),
          title: `${label} / ${valText} / ${row.sourceType} / ${row.scenario || ''} ${row.caseName || ''}`,
          onClick: () => toast(`${label}：${valText}（${row.sourceType}）`) });
        $mapPoints.append(point); markerCount += 1;
      });
      $('#map-layer-name').textContent = layer === 'tsunami' ? '公的データ／実測データの津波高' : '公的データ／実測データの震度';
      renderLegend(layer);
    } else if (mode === 'custom' && state.lastResults) {
      if (layer === 'tsunami') {
        coast.forEach((row) => {
          const p = project(row.lon, row.lat); const h = row.tsunamiHeight;
          const label = row.name;
          const point = makePoint({ x: p.x, y: p.y, r: Math.min(11, 3.5 + Math.sqrt(Math.max(0, h || 0)) * 2.1), fill: colorForWave(h), label,
            className: 'map-point tsunami-point', showLabel: showLabels || (Number.isFinite(h) && h >= 0.1),
            title: `${label} / 参考モデル波幅 ${Number.isFinite(h) ? `${fmt(h, 2)} m` : '—'} / 到達時間 ${Number.isFinite(row.arrivalMin) ? `${fmt(row.arrivalMin, 1)}分` : (Number.isFinite(row.arrivalUnclipped) ? '計算対象時間外' : '—')}`,
            onClick: () => toast(`${label}：参考モデル波幅 ${fmt(h, 2)} m · 直線距離ベースの到達時間 ${Number.isFinite(row.arrivalMin) ? `${fmt(row.arrivalMin, 1)}分` : '時間外'}`) });
          $mapPoints.append(point); markerCount += 1;
        });
        $('#map-layer-name').textContent = '沿岸代表地点の参考モデル波幅'; renderLegend('tsunami');
      } else {
        capitals.forEach((row) => {
          const p = project(row.lon, row.lat); const rank = row.intensityRank;
          const point = makePoint({ x: p.x, y: p.y, r: rank === null ? 3.5 : 4 + rank * .45, fill: intensityColor(rank), label: row.name,
            className: 'map-point capital-point', showLabel: showLabels || (rank !== null && rank >= 6),
            title: `${row.name} / 参考推定震度 ${intensityLabel(rank)} / PGA ${fmt(row.pga, 1)} gal / 震源 ${row.source}`,
            onClick: () => toast(`${row.name}：参考推定震度 ${intensityLabel(rank)}（PGA ${fmt(row.pga, 1)} gal）`) });
          $mapPoints.append(point); markerCount += 1;
        });
        $('#map-layer-name').textContent = '都道府県庁所在地の参考推定震度'; renderLegend('intensity');
      }
    } else {
      $('#map-layer-name').textContent = layer === 'tsunami' ? '津波高レイヤー' : (layer === 'epicenters' ? '登録した震源' : '地点別の参考震度');
      renderLegend(layer);
    }
    // Keep epicenter markers visible atop whichever data layer is selected for the custom mode.
    if (mode === 'custom' && state.lastResults && layer !== 'epicenters') {
      (state.lastResults.sources || []).forEach((source, i) => {
        const p = project(source.lon, source.lat);
        const ring = svgEl('circle', { cx: p.x, cy: p.y, r: 8 + (i % 3), class: 'epicenter-ring' });
        const dot = svgEl('circle', { cx: p.x, cy: p.y, r: 3.2, class: 'epicenter-point' });
        const title = svgEl('title'); title.textContent = `震源：${source.name} / Mw ${source.magnitude.toFixed(1)}`; dot.append(title);
        $mapEpicenters.append(ring, dot);
      });
    }
    $mapEmpty.hidden = Boolean(state.lastResults && markerCount > 0);
    if (!state.lastResults) {
      $mapEmpty.hidden = false;
      $mapEmpty.querySelector('strong').textContent = 'まだ結果がありません';
      $mapEmpty.querySelector('p').textContent = '震源を登録してシミュレーションを実行するか、公的データのCSVを読み込んでください。';
    }
  }

  function renderLegend(layer) {
    const target = $('#map-legend'); target.replaceChildren();
    const title = document.createElement('span'); title.className = 'legend-title';
    if (layer === 'tsunami') {
      title.textContent = 'モデル波幅'; target.append(title);
      const legend = [['<0.1m', '#a8c4d0'], ['0.1–0.3m', '#61bdc9'], ['0.3–1m', '#347fd1'], ['1–3m', '#565fca'], ['3–5m', '#9155bd'], ['5–10m', '#c34e98'], ['≥10m', '#e45a78']];
      legend.forEach(([label, color]) => addLegendItem(target, label, color));
    } else if (layer === 'epicenters') {
      title.textContent = '震源'; target.append(title); addLegendItem(target, '登録した震源', '#e46e55');
    } else {
      title.textContent = '参考震度'; target.append(title);
      [['0', 0], ['1', 1], ['2', 2], ['3', 3], ['4', 4], ['5弱', 5], ['5強', 6], ['6弱', 7], ['6強', 8], ['7', 9]].forEach(([label, rank]) => addLegendItem(target, label, INTENSITY_COLORS[rank]));
    }
  }

  function addLegendItem(root, label, color) {
    const item = document.createElement('span'); item.className = 'legend-item';
    const swatch = document.createElement('i'); swatch.className = 'legend-swatch'; swatch.style.background = color;
    const text = document.createElement('span'); text.textContent = label; item.append(swatch, text); root.append(item);
  }

  function toExportObject(row) {
    return { source_type: row.sourceType || '', scenario: row.scenario || '', case: row.caseName || '', prefecture: row.prefecture || row.area || '',
      municipality: row.municipality || row.name || '', latitude: row.lat ?? '', longitude: row.lon ?? '', intensity: row.intensityRaw || (row.intensityRank === null ? '' : intensityLabel(row.intensityRank)),
      pga_gal: row.pga ?? '', tsunami_height_m: row.tsunamiHeight ?? '', arrival_min: row.arrivalMin ?? '', observed_at: row.observedAt || '', source_url: row.sourceUrl || '',
      selected_model_source: row.source || '' };
  }

  function exportCsv() {
    if (!state.lastResults) { toast('書き出す結果がありません。', true); return; }
    const rows = state.lastResults.allRows;
    const headers = ['source_type','scenario','case','prefecture','municipality','latitude','longitude','intensity','pga_gal','tsunami_height_m','arrival_min','observed_at','source_url','selected_model_source'];
    const csv = [headers.join(','), ...rows.map((row) => { const o = toExportObject(row); return headers.map((h) => escapeCsv(o[h])).join(','); })].join('\r\n');
    const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url;
    a.download = `japan-quake-lab-${new Date().toISOString().slice(0, 10)}.csv`; document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    toast(`全${rows.length}地点の結果CSVを書き出しました。`);
  }

  function toast(message, isError = false) {
    $toast.textContent = message; $toast.classList.toggle('error', isError); $toast.classList.add('show');
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => $toast.classList.remove('show'), 3500);
  }

  function switchMode(mode) {
    state.mode = mode;
    const official = mode === 'official';
    const epicenterOption = $('#map-layer-select').querySelector('option[value="epicenters"]');
    epicenterOption.disabled = official;
    if (official && $('#map-layer-select').value === 'epicenters') $('#map-layer-select').value = 'intensity';
    $('#tab-official').classList.toggle('active', official); $('#tab-official').setAttribute('aria-selected', String(official));
    $('#tab-custom').classList.toggle('active', !official); $('#tab-custom').setAttribute('aria-selected', String(!official));
    $('#panel-official').hidden = !official; $('#panel-custom').hidden = official;
    if (official) {
      setDataBadge(state.lastResults?.mode === 'official' ? ([...new Set(state.lastResults.allRows.map((r) => r.sourceType))][0] || '公的想定') : '公的想定');
      if (state.lastResults?.mode !== 'official') {
        state.lastResults = null; clearMetrics(); $resultsBody.replaceChildren(); $('#row-count').textContent = '0件'; $('#export-csv').disabled = true;
        $('#results-body').innerHTML = '<tr class="placeholder-row"><td colspan="6">公的データのCSVを読み込んでください。</td></tr>';
      }
      $('#workspace-subtitle').textContent = 'CSVに含まれる公的想定・実測データを、そのまま区分して表示します。';
    } else {
      setDataBadge('モデル推定');
      if (state.lastResults?.mode !== 'custom') {
        state.lastResults = null; clearMetrics(); $resultsBody.replaceChildren(); $('#row-count').textContent = '0件'; $('#export-csv').disabled = true;
        $('#results-body').innerHTML = '<tr class="placeholder-row"><td colspan="6">震源を登録してシミュレーションを実行してください。</td></tr>';
      }
      $('#workspace-subtitle').textContent = '震源と地点ごとの参考値を地図上で確認できます。';
    }
    renderMap();
  }

  function clearCurrentResults(mode) {
    state.lastResults = null;
    clearMetrics();
    $('#export-csv').disabled = true;
    $('#row-count').textContent = '0件';
    $resultsBody.replaceChildren();
    const tr = document.createElement('tr'); tr.className = 'placeholder-row'; const td = document.createElement('td'); td.colSpan = 6;
    td.textContent = mode === 'custom' ? '震源条件を変更しました。シミュレーションを再実行してください。' : 'データを読み込んでください。';
    tr.append(td); $resultsBody.append(tr);
    renderMap();
  }

  function clearMetrics() {
    ['metric-intensity', 'metric-tsunami', 'metric-max-intensity', 'metric-max-place', 'metric-max-tsunami', 'metric-max-tsunami-place'].forEach((id) => { $(`#${id}`).textContent = '—'; });
    ['tab-count-intensity', 'tab-count-tsunami', 'tab-count-all'].forEach((id) => { $(`#${id}`).textContent = '0'; });
  }

  function resetMap() { renderMap(); toast('地図表示をリセットしました。'); }

  function initialize() {
    populateEpicenterSelect();
    state.sources.push(createSource({ name: '南海トラフ想定域（仮設定）', lat: 33.0, lon: 136.5, magnitude: 8.0, depth: 20, uplift: 1.0, radius: 80, waterDepth: 4000 }));
    renderSourceList(); drawBaseMap(); renderLegend('intensity');
    renderMap();
    $('#add-source').addEventListener('click', () => {
      const draft = currentDraft();
      if (!validateSource(draft)) { toast('入力値を確認してください。緯度10–75°、経度110–180°、Mwは4以上の有限値、深さ1–700kmなどの範囲で入力します。', true); return; }
      state.sources.push(createSource(draft)); renderSourceList();
      if (state.lastResults?.mode === 'custom') clearCurrentResults('custom');
      toast(`震源「${draft.name}」を追加しました。合計${state.sources.length}地点です。`);
    });
    $('#run-custom').addEventListener('click', runCustomSimulation);
    $('#epicenter-select').addEventListener('change', () => { updateEpicenterCoordinates(); lookupOceanDepth(num($('#source-lat').value), num($('#source-lon').value), { silent: true }); });
    ['source-lat', 'source-lon'].forEach((id) => { $(`#${id}`).addEventListener('change', () => lookupOceanDepth(num($('#source-lat').value), num($('#source-lon').value), { silent: true })); });
    $('#lookup-water-depth')?.addEventListener('click', () => lookupOceanDepth(num($('#source-lat').value), num($('#source-lon').value))); 
    $('#tab-official').addEventListener('click', () => switchMode('official'));
    $('#tab-custom').addEventListener('click', () => switchMode('custom'));
    $('#official-file').addEventListener('change', handleOfficialFile);
    $('#official-source-filter').addEventListener('change', updateOfficialSelectors);
    $('#official-scenario-filter').addEventListener('change', updateOfficialSelectors);
    $('#show-official').addEventListener('click', showOfficialResults);
    $('#official-arrival-threshold').addEventListener('change', () => { if (state.mode === 'official' && state.lastResults?.mode === 'official') showOfficialResults(); });
    $('#map-layer-select').addEventListener('change', () => { state.layer = $('#map-layer-select').value; renderMap(); });
    $('#show-labels').addEventListener('change', renderMap);
    $('#reset-map').addEventListener('click', resetMap);
    $('#export-csv').addEventListener('click', exportCsv);
    $$('.result-tab').forEach((tab) => tab.addEventListener('click', () => selectResultTab(tab.dataset.table)));
    $('#map-empty').hidden = false;
    $('#map-empty strong').textContent = 'まだ結果がありません';
    $('#map-empty p').textContent = '震源を登録してシミュレーションを実行するか、公的データのCSVを読み込んでください。';
    setDataBadge('モデル推定');
    lookupOceanDepth(num($('#source-lat').value), num($('#source-lon').value), { silent: true });
  }

  initialize();
})();
