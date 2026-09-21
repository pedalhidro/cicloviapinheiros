// app.js — o mapa. Carrega data/ciclovia.geojson (retrato do OSM, refeito a
// cada 6 h pelo tools/fetch_osm.py) e pinta cada trecho com o estado que o
// status.js calcula pro relógio de São Paulo, de novo a cada minuto.
//
// Tag do OSM é texto de terceiros: NADA daqui entra por innerHTML — todo DOM
// sai do el() via textContent.
(function () {
  'use strict';

  const S = self.CicloStatus;

  // As pontas pedidas pro mapa. O traçado vem do OSM; se ele não chega até a
  // ponta, desenhamos o buraco em vez de inventar ciclovia (ver drawGaps).
  const ENDPOINTS = [
    { label: 'Cebolão', name: 'o Cebolão', latlng: [-23.526107, -46.750433] },
    { label: 'Pedreira', name: 'a Usina Elevatória de Pedreira', latlng: [-23.70316, -46.67451] },
  ];
  const GAP_M = 400;

  // Cor = estado; tracejado repete a informação pra quem não distingue
  // verde de vermelho (fechado é sempre tracejado, aberto é sempre contínuo).
  const STATUS = {
    always: { color: '#1f6fe0', dash: null, label: 'Aberta 24 h' },
    open: { color: '#17a34a', dash: null, label: 'Aberta agora (tem horário)' },
    closed_schedule: { color: '#f5b800', dash: '14 7', label: 'Fechada agora, reabre pelo horário' },
    closed: { color: '#dc2626', dash: '7 5', label: 'Interditada: sem previsão ou até uma data' },
    unknown: { color: '#8b919a', dash: '1 7', label: 'Tag do OSM que não sei interpretar' },
  };
  const ORDER = ['always', 'open', 'closed_schedule', 'closed', 'unknown'];

  const ROLES = {
    trunk: { label: 'Ciclovia (margem leste)', weight: 6 },
    access: { label: 'Acesso', weight: 3.5 },
    west: { label: 'Margem oeste / Parque Bruno Covas', weight: 3.5 },
    link: { label: 'Ligação', weight: 3.5 },
  };

  // Tags que explicam o estado — as únicas mostradas no balão.
  const SHOWN_TAG = /^(highway|construction|proposed|access|vehicle|bicycle|foot|opening_hours|note|description|fixme|check_date|operator|lit|surface)$|:conditional$|^temporary:|^(construction|proposed|disused|abandoned):highway$|^opening_hours:/;

  const STALE_H = 13; // duas rodadas perdidas
  const RELOAD_MS = 30 * 60 * 1000;

  // ── utilidades ───────────────────────────────────────────────────────────
  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (key === 'class') node.className = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else node.setAttribute(key, value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  const two = (n) => String(n).padStart(2, '0');
  const km = (m) => (m / 1000).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' km';
  const meters = (m) => (m >= 1000 ? km(m) : `${Math.round(m)} m`);
  const DAY = 86400000;
  const WEEKDAY = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

  // `when` e `now` são horas de parede (campos UTC — ver status.js).
  function fmtWhen(when, now) {
    const time = `${two(when.getUTCHours())}:${two(when.getUTCMinutes())}`;
    const days = Math.floor(when.getTime() / DAY) - Math.floor(now.getTime() / DAY);
    if (days === 0) return `às ${time}`;
    if (days === 1) return `amanhã às ${time}`;
    if (days < 7) return `${WEEKDAY[when.getUTCDay()]} às ${time}`;
    const year = when.getUTCFullYear() === now.getUTCFullYear() ? '' : `/${when.getUTCFullYear()}`;
    return `em ${two(when.getUTCDate())}/${two(when.getUTCMonth() + 1)}${year} às ${time}`;
  }

  function fmtInstant(iso) {
    return new Date(iso).toLocaleString('pt-BR', { timeZone: S.TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function fmtAgo(ms) {
    const minutes = Math.round(ms / 60000);
    if (minutes < 2) return 'agora há pouco';
    if (minutes < 90) return `há ${minutes} min`;
    const hours = Math.round(minutes / 60);
    return hours < 48 ? `há ${hours} h` : `há ${Math.round(hours / 24)} dias`;
  }

  function sentence(result, now) {
    switch (result.status) {
      case 'always':
        return result.nextChange ? `Aberta 24 h. Interdição marcada pra começar ${fmtWhen(result.nextChange, now)}.` : 'Aberta 24 h.';
      case 'open':
        return `Aberta agora. Fecha ${fmtWhen(result.nextChange, now)}.`;
      case 'closed_schedule':
        return `Fechada agora. Abre ${fmtWhen(result.nextChange, now)}.`;
      case 'closed':
        if (result.cause === 'lifecycle') return 'Em obras, planejada ou fora de uso no OSM.';
        return result.nextChange ? `Interditada. Reabre ${fmtWhen(result.nextChange, now)}.` : 'Fechada, sem previsão de reabertura no OSM.';
      default:
        return 'Não consegui interpretar a tag de horário deste trecho.';
    }
  }

  // ?agora=2026-09-21T22:00 simula um instante (hora de São Paulo) — pra
  // conferir os estados sem esperar anoitecer.
  const simulated = (() => {
    const raw = new URLSearchParams(location.search).get('agora');
    if (!raw) return null;
    const date = new Date(`${raw.length === 16 ? `${raw}:00` : raw}Z`);
    return Number.isNaN(date.getTime()) ? null : date;
  })();
  const wallNow = () => simulated || S.wallClock();

  // ── mapa ─────────────────────────────────────────────────────────────────
  const map = L.map('map', { zoomControl: false, preferCanvas: false }).setView([-23.612, -46.712], 12);
  L.control.zoom({ position: 'topright' }).addTo(map);
  map.attributionControl.setPrefix(false);

  map.createPane('casing').style.zIndex = 410;
  map.createPane('lines').style.zIndex = 420;

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    className: 'basemap',
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  }).addTo(map);

  // Relevo/hidrografia do Pedal (mesma camada do amora; tiles só até z16).
  const relief = L.tileLayer('https://telhas.pedalhidrografi.co/rmsampa-v2/{z}/{x}/{y}.png', {
    maxZoom: 19, maxNativeZoom: 16, opacity: 0.6,
    attribution: 'Topografia: Pedal Hidrográfico',
  });

  const groups = { trunk: L.layerGroup(), access: L.layerGroup(), west: L.layerGroup(), link: L.layerGroup() };
  const secondary = L.layerGroup([groups.access, groups.link]);
  const marks = L.layerGroup().addTo(map);
  groups.trunk.addTo(map);
  groups.west.addTo(map);
  secondary.addTo(map);

  L.control.layers(null, {
    'Margem oeste / Parque Bruno Covas': groups.west,
    'Acessos e ligações': secondary,
    'Relevo e águas (Pedal Hidrográfico)': relief,
  }, { position: 'topright', collapsed: true }).addTo(map);

  let segments = []; // { feature, line, result }

  function popupFor(segment) {
    const { feature, result } = segment;
    const props = feature.properties;
    const tags = props.tags;
    const now = wallNow();
    const rows = Object.keys(tags).filter((k) => SHOWN_TAG.test(k)).map((k) => el('tr', null, el('th', null, k), el('td', null, tags[k])));

    return el('div', { class: 'pop' },
      el('p', { class: 'pop-role' }, ROLES[props.role].label, ' · ', meters(props.length_m)),
      el('h2', null, tags.name || 'Trecho sem nome'),
      el('p', { class: 'pop-status', dataset: { status: result.status } }, sentence(result, now)),
      result.errors.map((e) => el('p', { class: 'pop-warn' }, e)),
      result.warnings.map((w) => el('p', { class: 'pop-warn' }, w)),
      tags.note && el('p', { class: 'pop-note' }, 'A tag “note” é texto livre: aparece aqui, mas não muda a cor do trecho.'),
      el('table', { class: 'pop-tags' }, el('caption', null, 'Tags no OSM'), rows),
      el('p', { class: 'pop-links' },
        el('a', { href: `https://www.openstreetmap.org/way/${props.way}`, target: '_blank', rel: 'noopener' }, 'ver no OSM'),
        ' · ',
        el('a', { href: `https://www.openstreetmap.org/edit?way=${props.way}`, target: '_blank', rel: 'noopener' }, 'editar no OSM'),
        props.edited_at && el('span', null, ` · editado em ${fmtInstant(props.edited_at).slice(0, 10)}`)));
  }

  function draw(collection) {
    for (const group of Object.values(groups)) group.clearLayers();
    segments = collection.features.map((feature) => {
      const role = ROLES[feature.properties.role] ? feature.properties.role : 'link';
      feature.properties.role = role;
      const latlngs = feature.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
      const weight = ROLES[role].weight;
      L.polyline(latlngs, { pane: 'casing', color: '#14202b', weight: weight + 3.5, opacity: 0.9, interactive: false }).addTo(groups[role]);
      const line = L.polyline(latlngs, { pane: 'lines', weight, opacity: 1, lineCap: 'butt' }).addTo(groups[role]);
      // alvo de toque generoso, invisível (linha de 3 px é difícil no celular)
      const hit = L.polyline(latlngs, { pane: 'lines', weight: 22, opacity: 0 }).addTo(groups[role]);
      const segment = { feature, line, hit, result: null };
      hit.bindPopup(() => popupFor(segment), { maxWidth: 320 });
      hit.on('popupopen', () => history.replaceState(null, '', `#way=${feature.properties.way}`));
      hit.on('popupclose', () => history.replaceState(null, '', location.pathname + location.search));
      return segment;
    });
    drawGaps(collection);
  }

  // Ponta pedida que o OSM não alcança: pontilhado cinza até ela, com convite
  // pra mapear. Linha reta de propósito — é "falta dado", não um traçado.
  function drawGaps(collection) {
    marks.clearLayers();
    const vertices = collection.features
      .filter((f) => f.properties.role === 'trunk')
      .flatMap((f) => f.geometry.coordinates.map(([lon, lat]) => L.latLng(lat, lon)));
    for (const end of ENDPOINTS) {
      const target = L.latLng(end.latlng);
      L.marker(target, { icon: L.divIcon({ className: 'endpoint', html: '', iconSize: [14, 14] }), keyboard: false })
        .bindTooltip(end.label, { permanent: true, direction: 'right', offset: [8, 0], className: 'endpoint-label' })
        .addTo(marks);
      if (!vertices.length) continue;
      const nearest = vertices.reduce((best, v) => (target.distanceTo(v) < target.distanceTo(best) ? v : best));
      const distance = target.distanceTo(nearest);
      if (distance < GAP_M) continue;
      const mid = L.latLng((nearest.lat + target.lat) / 2, (nearest.lng + target.lng) / 2);
      L.polyline([nearest, target], { color: '#5b6470', weight: 3, dashArray: '2 8', opacity: 0.9 })
        .bindPopup(() => el('div', { class: 'pop' },
          el('h2', null, 'Sem dados no OSM'),
          el('p', null, `Daqui até ${end.name} (~${meters(distance)} em linha reta) o OpenStreetMap não tem ciclovia mapeada, então não há o que colorir.`),
          el('p', { class: 'pop-links' },
            el('a', { href: `https://www.openstreetmap.org/edit#map=17/${mid.lat.toFixed(5)}/${mid.lng.toFixed(5)}`, target: '_blank', rel: 'noopener' }, 'mapear este trecho no OSM'))))
        .addTo(marks);
    }
  }

  // ── estado: recalcula tudo pro instante atual ────────────────────────────
  const $headline = document.getElementById('headline');
  const $subline = document.getElementById('subline');
  const $legend = document.getElementById('legend');
  const $fresh = document.getElementById('fresh');
  const $simulated = document.getElementById('simulated');

  function refresh() {
    if (!segments.length) return;
    const now = wallNow();
    const totals = Object.fromEntries(ORDER.map((s) => [s, 0]));
    const soonest = {};

    for (const segment of segments) {
      const result = S.classify(segment.feature.properties.tags, now);
      segment.result = result;
      const style = STATUS[result.status];
      segment.line.setStyle({ color: style.color, dashArray: style.dash });
      if (segment.feature.properties.role !== 'trunk') continue;
      totals[result.status] += segment.feature.properties.length_m;
      if (result.nextChange && (!soonest[result.status] || result.nextChange < soonest[result.status])) {
        soonest[result.status] = result.nextChange;
      }
    }

    const openM = totals.always + totals.open;
    const closedM = totals.closed_schedule + totals.closed;
    let status;
    let text;
    if (!closedM && !totals.unknown) {
      status = totals.open ? 'open' : 'always';
      text = totals.open ? `Aberta agora. Fecha ${fmtWhen(soonest.open, now)}.` : 'Aberta 24 h.';
    } else if (!openM && !totals.unknown) {
      status = totals.closed_schedule ? 'closed_schedule' : 'closed';
      if (totals.closed_schedule) text = `Fechada agora. Abre ${fmtWhen(soonest.closed_schedule, now)}.`;
      else text = soonest.closed ? `Interditada. Reabre ${fmtWhen(soonest.closed, now)}.` : 'Interditada, sem previsão de reabertura.';
    } else {
      status = 'mixed';
      text = `Aberta em parte: ${km(openM)} de ${km(openM + closedM + totals.unknown)}.`;
    }
    $headline.dataset.status = status;
    $headline.textContent = text;

    const notes = [];
    if (totals.closed && status !== 'closed') notes.push(`${km(totals.closed)} interditados`);
    if (totals.closed_schedule && status === 'mixed') notes.push(`${km(totals.closed_schedule)} fechados pelo horário`);
    if (totals.unknown) notes.push(`${km(totals.unknown)} com tag que não sei ler`);
    $subline.textContent = `Eixo da margem leste, ${km(openM + closedM + totals.unknown)} no OSM${notes.length ? ` · ${notes.join(' · ')}` : ''}. Hora de São Paulo: ${two(now.getUTCHours())}:${two(now.getUTCMinutes())}.`;

    // A coluna de km conta só o eixo; a cor pode estar no mapa por outro papel
    // (a margem oeste é azul), então só esmaece o estado ausente do mapa todo.
    const onMap = new Set(segments.map((x) => x.result.status));
    const items = ORDER.filter((s) => s !== 'unknown' || onMap.has(s)).map((s) => {
      const swatch = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      swatch.setAttribute('viewBox', '0 0 36 10');
      swatch.setAttribute('class', 'swatch');
      for (const [color, width, dash] of [['#14202b', 8, null], [STATUS[s].color, 5, STATUS[s].dash]]) {
        const stroke = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        stroke.setAttribute('x1', 1); stroke.setAttribute('x2', 35); stroke.setAttribute('y1', 5); stroke.setAttribute('y2', 5);
        stroke.setAttribute('stroke', color); stroke.setAttribute('stroke-width', width);
        if (dash) stroke.setAttribute('stroke-dasharray', dash.split(' ').map((n) => n * 0.6).join(' '));
        swatch.append(stroke);
      }
      return el('li', { class: onMap.has(s) ? '' : 'dim' }, swatch, el('span', null, STATUS[s].label), el('span', { class: 'legend-km' }, totals[s] ? km(totals[s]) : '—'));
    });
    $legend.replaceChildren(el('li', { class: 'legend-head' }, el('span'), el('span'), el('span', null, 'no eixo')), ...items);

    $simulated.hidden = !simulated;
    if (simulated) $simulated.textContent = `Simulando ${two(now.getUTCDate())}/${two(now.getUTCMonth() + 1)}/${now.getUTCFullYear()} ${two(now.getUTCHours())}:${two(now.getUTCMinutes())} (parâmetro ?agora=).`;
  }

  function showFreshness(meta, check) {
    const changed = meta && meta.changed_at ? `Última mudança no traçado ou nas tags: ${fmtInstant(meta.changed_at)}.` : '';
    if (!check) {
      $fresh.textContent = `Fonte: OpenStreetMap. ${changed}`;
      return;
    }
    const age = Date.now() - new Date(check.checked_at).getTime();
    const stale = age > STALE_H * 3600000;
    $fresh.classList.toggle('warn', !check.ok || stale);
    if (!check.ok) $fresh.textContent = `A última consulta ao OSM falhou (${fmtAgo(age)}); o mapa mostra o retrato anterior. ${changed}`;
    else if (stale) $fresh.textContent = `OSM consultado ${fmtAgo(age)}: a atualização automática parece parada. ${changed}`;
    else $fresh.textContent = `OSM consultado ${fmtAgo(age)}; nova consulta a cada 6 h. ${changed}`;
  }

  let fitted = false;
  async function load() {
    try {
      const response = await fetch('data/ciclovia.geojson', { cache: 'no-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const collection = await response.json();
      // check.json só existe depois de uma rodada do fetch_osm.py
      const check = await fetch('data/check.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      draw(collection);
      refresh();
      showFreshness(collection.meta, check);
      if (!fitted) {
        const bounds = L.latLngBounds(ENDPOINTS.map((e) => e.latlng));
        for (const s of segments) bounds.extend(s.line.getBounds());
        const wide = matchMedia('(min-width: 720px)').matches;
        map.fitBounds(bounds, { animate: false, paddingTopLeft: wide ? [380, 24] : [16, 16], paddingBottomRight: wide ? [24, 24] : [16, Math.min(innerHeight * 0.42, 320)] });
        fitted = true;
      }
      // #way=51392253 abre o balão daquele trecho (link pra compartilhar)
      const wanted = /^#way=(\d+)$/.exec(location.hash);
      const target = wanted && segments.find((s) => String(s.feature.properties.way) === wanted[1]);
      if (target) target.hit.openPopup(target.line.getCenter());
    } catch (err) {
      console.error(err);
      if (segments.length) return; // já tem mapa: fica com o que tem
      $headline.dataset.status = 'unknown';
      $headline.textContent = 'Não consegui carregar os dados.';
      $subline.textContent = String(err.message || err);
    }
  }

  load();
  setInterval(refresh, 20000);
  setInterval(load, RELOAD_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
