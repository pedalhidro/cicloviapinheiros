// app.js — o mapa. Carrega data/ciclovia.geojson (retrato do OSM, refeito a
// cada 6 h pelo tools/fetch_osm.py) e pinta cada trecho com o estado que o
// status.js calcula pro relógio de São Paulo, de novo a cada minuto.
//
// Tag do OSM é texto de terceiros: NADA daqui entra por innerHTML — todo DOM
// sai do el() via textContent.
(function () {
  'use strict';

  const S = self.CicloStatus;

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

  // O miolo da linha é o ESTADO; o contorno é o PISO. Contorno escuro = piso
  // firme (ou sem tag); ocre e mais largo = `surface` de chão solto. São dois
  // sinais independentes: terra aberta é verde com borda ocre.
  const CASING = { color: '#14202b', extra: 3.5 };
  const UNPAVED = { color: '#b9801a', extra: 6, label: 'Contorno ocre: sem pavimento (terra, cascalho)' };
  const UNPAVED_SURFACES = new Set(['unpaved', 'compacted', 'fine_gravel', 'gravel', 'pebblestone', 'dirt', 'earth', 'ground', 'grass', 'mud', 'sand', 'rock', 'woodchips']);
  const isUnpaved = (tags) => UNPAVED_SURFACES.has(String(tags.surface || '').toLowerCase());

  const ROLES = {
    trunk: { label: 'Ciclovia (margem leste)', weight: 6 },
    access: { label: 'Acesso', weight: 3.5 },
    west: { label: 'Margem oeste / Parque Bruno Covas', weight: 3.5 },
    riverside: { label: 'Outro caminho da beira-rio', weight: 3.5 },
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

  // De longe os marcadores viram pontinhos: a 20 px cada, os acessos cobriam a
  // linha inteira no celular (zoom 11). Tamanho cheio e × só a partir do zoom 13.
  const FAR_ZOOM = 13;
  const markZoom = () => map.getContainer().classList.toggle('zoom-far', map.getZoom() < FAR_ZOOM);
  map.on('zoomend', markZoom);
  markZoom();

  map.createPane('casing').style.zIndex = 410;
  map.createPane('lines').style.zIndex = 420;
  map.createPane('hits').style.zIndex = 430; // alvos de toque, por cima de qualquer cor

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

  const groups = { trunk: L.layerGroup(), access: L.layerGroup(), west: L.layerGroup(), riverside: L.layerGroup(), link: L.layerGroup() };
  const secondary = L.layerGroup([groups.access, groups.link]);
  const pinLayer = L.layerGroup().addTo(map);
  const gateLayer = L.layerGroup().addTo(map);
  groups.trunk.addTo(map);
  groups.west.addTo(map);
  groups.riverside.addTo(map);
  secondary.addTo(map);

  L.control.layers(null, {
    'Margem oeste / Parque Bruno Covas': groups.west,
    'Outros caminhos da beira-rio': groups.riverside,
    'Acessos e ligações (linhas)': secondary,
    'Acessos (marcadores)': pinLayer,
    'Portões': gateLayer,
    'Relevo e águas (Pedal Hidrográfico)': relief,
  }, { position: 'topright', collapsed: true }).addTo(map);

  // Do retrato do OSM saem três coisas:
  //   ways    um por way do OSM: tags, papel e o resultado do status.js
  //   pieces  o que se desenha. Uma way é cortada em peças a cada portão que tem
  //           no meio, porque o portão fechado muda a cor só do lado de lá.
  //   gates   nós `barrier=*` com tag de acesso, classificados como um trecho
  //   pins    um marcador por acesso (grupo de peças access/link que toca o eixo)
  let ways = [];
  let pieces = [];
  let gates = [];
  let pins = [];
  let lastOrder = '';

  const LEVEL_STATUS = ['always', 'closed_schedule', 'closed'];
  // de baixo pra cima: o vermelho nunca fica escondido embaixo de outra cor
  const Z_ORDER = ['always', 'open', 'unknown', 'closed_schedule', 'closed'];

  const tagRows = (tags) => el('table', { class: 'pop-tags' }, el('caption', null, 'Tags no OSM'),
    Object.keys(tags).filter((k) => SHOWN_TAG.test(k) || k === 'barrier').map((k) => el('tr', null, el('th', null, k), el('td', null, tags[k]))));

  const osmLinks = (type, id, editedAt) => el('p', { class: 'pop-links' },
    el('a', { href: `https://www.openstreetmap.org/${type}/${id}`, target: '_blank', rel: 'noopener' }, 'ver no OSM'),
    ' · ',
    el('a', { href: `https://www.openstreetmap.org/edit?${type}=${id}`, target: '_blank', rel: 'noopener' }, 'editar no OSM'),
    editedAt && el('span', null, ` · editado em ${fmtInstant(editedAt).slice(0, 10)}`));

  // Cortada do resto por portão ou trecho fechado: a tag dela diz uma coisa, o
  // caminho até ela diz outra (ver effectiveLevels no status.js).
  const CUT_OFF = {
    closed: 'Sem acesso: fica atrás de portão ou trecho interditado.',
    closed_schedule: 'Sem acesso agora: o caminho até aqui está fechado pelo horário.',
  };

  function popupForPiece(piece) {
    const { way } = piece;
    const tags = way.tags;
    const now = wallNow();
    const cut = piece.status !== way.result.status;
    return el('div', { class: 'pop' },
      el('p', { class: 'pop-role' }, ROLES[way.role].label, ' · ', meters(piece.length)),
      el('h2', null, tags.name || 'Trecho sem nome'),
      el('p', { class: 'pop-status', dataset: { status: piece.status } }, cut ? CUT_OFF[piece.status] : sentence(way.result, now)),
      cut && el('p', { class: 'pop-note' }, `Pelas tags deste trecho: ${sentence(way.result, now).toLowerCase()}`),
      isUnpaved(tags) && el('p', { class: 'pop-surface' }, `Sem pavimento (surface=${tags.surface}).`),
      way.result.errors.map((e) => el('p', { class: 'pop-warn' }, e)),
      way.result.warnings.map((w) => el('p', { class: 'pop-warn' }, w)),
      tags.note && el('p', { class: 'pop-note' }, 'A tag “note” é texto livre: aparece aqui, mas não muda a cor do trecho.'),
      tagRows(tags),
      osmLinks('way', way.id, way.editedAt));
  }

  function popupForGate(gate) {
    return el('div', { class: 'pop' },
      el('p', { class: 'pop-role' }, 'Portão / barreira'),
      el('h2', null, gate.tags.name || `barrier=${gate.tags.barrier}`),
      el('p', { class: 'pop-status', dataset: { status: gate.result.status } }, sentence(gate.result, wallNow()).replace(/^(Abert|Fechad|Interditad)a/, '$1o')),
      S.levelOf(gate.result.status) > 0 && el('p', { class: 'pop-note' }, 'Enquanto estiver fechado, o que só se alcança passando por aqui aparece como fechado também.'),
      tagRows(gate.tags),
      osmLinks('node', gate.id, gate.editedAt));
  }

  function popupForPin(pin) {
    const now = wallNow();
    const stairs = pin.pieces.some((p) => p.way.tags.highway === 'steps');
    const seen = new Set();
    const rows = pin.pieces.filter((p) => !seen.has(p.way) && seen.add(p.way)).map((p) => el('tr', null,
      el('th', null, el('a', { href: `https://www.openstreetmap.org/way/${p.way.id}`, target: '_blank', rel: 'noopener' }, p.way.tags.name || p.way.tags.highway)),
      el('td', null, sentence(p.way.result, now))));
    return el('div', { class: 'pop' },
      el('p', { class: 'pop-role' }, 'Acesso'),
      el('h2', null, pin.name),
      el('p', { class: 'pop-status', dataset: { status: pin.status } }, STATUS[pin.status].label, '.'),
      stairs && el('p', { class: 'pop-note' }, 'Tem escada (highway=steps) em algum ponto.'),
      el('table', { class: 'pop-tags' }, el('caption', null, 'Caminhos deste acesso (vale o pior)'), rows));
  }

  // O Leaflet posiciona o marcador com `transform` no próprio elemento, então o
  // encolhimento de longe (.zoom-far, ver style.css) tem que ser num filho.
  // O html é literal fixo: `kind` e `status` vêm das tabelas daqui, nunca do OSM.
  const icon = (kind, status) => L.divIcon({
    className: 'mark',
    html: `<i class="${kind} ${kind}-${status}">${S.levelOf(status) > 0 ? '×' : ''}</i>`,
    iconSize: kind === 'pin' ? [20, 20] : [15, 15],
  });

  // Um acesso = grupo de peças access/link ligadas entre si que encosta no eixo.
  // O marcador fica no nó onde o grupo entra na ciclovia.
  function buildPins() {
    const trunkNodes = new Map();
    for (const piece of pieces) {
      if (piece.way.role === 'trunk') piece.nodes.forEach((node, i) => trunkNodes.set(node, piece.latlngs[i]));
    }
    const members = pieces.filter((p) => p.way.role === 'access' || p.way.role === 'link');
    const parent = new Map(members.map((p) => [p, p]));
    const find = (p) => { while (parent.get(p) !== p) { parent.set(p, parent.get(parent.get(p))); p = parent.get(p); } return p; };
    const owner = new Map();
    for (const piece of members) {
      for (const node of piece.nodes) {
        if (owner.has(node)) parent.set(find(piece), find(owner.get(node)));
        else owner.set(node, piece);
      }
    }
    const clusters = new Map();
    for (const piece of members) {
      const root = find(piece);
      if (!clusters.has(root)) clusters.set(root, []);
      clusters.get(root).push(piece);
    }
    const out = [];
    for (const group of clusters.values()) {
      const touch = group.flatMap((p) => p.nodes).find((node) => trunkNodes.has(node));
      if (touch === undefined) continue;
      const names = group.map((p) => p.way.tags.name).filter(Boolean);
      const name = names.find((n) => /^Acesso/i.test(n)) || names.find((n) => /passarela|ponte/i.test(n)) || names[0] || 'Acesso sem nome no OSM';
      const pin = { name, pieces: group, nodes: new Set(group.flatMap((p) => p.nodes)), status: 'always', marker: null };
      pin.marker = L.marker(trunkNodes.get(touch), { icon: icon('pin', 'always'), title: name, zIndexOffset: 500 })
        .bindPopup(() => popupForPin(pin), { maxWidth: 320 })
        .addTo(pinLayer);
      out.push(pin);
    }
    return out;
  }

  function draw(collection) {
    for (const group of Object.values(groups)) group.clearLayers();
    pinLayer.clearLayers();
    gateLayer.clearLayers();
    lastOrder = '';

    gates = collection.features.filter((f) => f.geometry.type === 'Point').map((f) => {
      const gate = { id: f.properties.node, tags: f.properties.tags, editedAt: f.properties.edited_at, result: null, status: null, marker: null };
      const [lon, lat] = f.geometry.coordinates;
      gate.marker = L.marker([lat, lon], { icon: icon('gate', 'always'), title: 'Portão', zIndexOffset: 800 })
        .bindPopup(() => popupForGate(gate), { maxWidth: 320 })
        .addTo(gateLayer);
      return gate;
    });
    const gateIds = new Set(gates.map((g) => g.id));

    ways = [];
    pieces = [];
    for (const f of collection.features) {
      if (f.geometry.type !== 'LineString') continue;
      const props = f.properties;
      const way = { id: props.way, tags: props.tags, role: ROLES[props.role] ? props.role : 'link', editedAt: props.edited_at, result: null, pieces: [] };
      ways.push(way);
      const latlngs = f.geometry.coordinates.map(([lon, lat]) => L.latLng(lat, lon));
      // retrato antigo, sem ids de nó: cada vértice vira um nó só dele (nada liga em nada)
      const nodes = props.nodes || latlngs.map((_, i) => `${props.way}:${i}`);
      let start = 0;
      for (let i = 1; i < nodes.length; i++) {
        if (i < nodes.length - 1 && !gateIds.has(nodes[i])) continue;
        const piece = { way, nodes: nodes.slice(start, i + 1), latlngs: latlngs.slice(start, i + 1), status: null };
        piece.length = piece.latlngs.reduce((sum, p, k) => (k ? sum + p.distanceTo(piece.latlngs[k - 1]) : 0), 0);
        const weight = ROLES[way.role].weight;
        const casing = isUnpaved(way.tags) ? UNPAVED : CASING;
        const group = groups[way.role];
        piece.casing = L.polyline(piece.latlngs, { pane: 'casing', color: casing.color, weight: weight + casing.extra, opacity: casing === UNPAVED ? 1 : 0.9, interactive: false }).addTo(group);
        piece.line = L.polyline(piece.latlngs, { pane: 'lines', weight, opacity: 1, lineCap: 'butt', interactive: false }).addTo(group);
        // alvo de toque generoso, invisível (linha de 3 px é difícil no celular)
        piece.hit = L.polyline(piece.latlngs, { pane: 'hits', weight: 22, opacity: 0 }).addTo(group);
        piece.hit.bindPopup(() => popupForPiece(piece), { maxWidth: 320 });
        piece.hit.on('popupopen', () => history.replaceState(null, '', `#way=${way.id}`));
        piece.hit.on('popupclose', () => history.replaceState(null, '', location.pathname + location.search));
        way.pieces.push(piece);
        pieces.push(piece);
        start = i;
      }
    }
    pins = buildPins();
  }

  // ── estado: recalcula tudo pro instante atual ────────────────────────────
  const $headline = document.getElementById('headline');
  const $subline = document.getElementById('subline');
  const $legend = document.getElementById('legend');
  const $fresh = document.getElementById('fresh');
  const $simulated = document.getElementById('simulated');

  function refresh() {
    if (!pieces.length) return;
    const now = wallNow();

    for (const way of ways) way.result = S.classify(way.tags, now);
    const gateLevels = new Map();
    for (const gate of gates) {
      gate.result = S.classify(gate.tags, now);
      if (gate.status !== gate.result.status) gate.marker.setIcon(icon('gate', gate.result.status));
      gate.status = gate.result.status;
      gateLevels.set(gate.id, S.levelOf(gate.status));
    }

    // Entra-se por tudo que não é o eixo; o eixo só vale até onde dá pra chegar.
    const network = pieces.map((piece) => ({ id: piece, nodes: piece.nodes, level: S.levelOf(piece.way.result.status), source: piece.way.role !== 'trunk' }));
    const effective = S.effectiveLevels(network, gateLevels);

    const totals = Object.fromEntries(ORDER.map((s) => [s, 0]));
    const soonest = {};
    for (const piece of pieces) {
      const own = piece.way.result;
      const cut = effective.get(piece) > S.levelOf(own.status);
      piece.status = cut ? LEVEL_STATUS[effective.get(piece)] : own.status;
      const style = STATUS[piece.status];
      piece.line.setStyle({ color: style.color, dashArray: style.dash });
      if (piece.way.role !== 'trunk') continue;
      totals[piece.status] += piece.length;
      if (!cut && own.nextChange && (!soonest[piece.status] || own.nextChange < soonest[piece.status])) soonest[piece.status] = own.nextChange;
    }

    // Empilha por estado (o SVG desenha na ordem do DOM). Só quando algo mudou.
    const order = pieces.map((p) => p.status).join();
    if (order !== lastOrder) {
      lastOrder = order;
      for (const status of Z_ORDER) {
        for (const piece of pieces) {
          if (piece.status === status) { piece.casing.bringToFront(); piece.line.bringToFront(); }
        }
      }
    }

    for (const pin of pins) {
      let level = Math.max(...pin.pieces.map((p) => S.levelOf(p.way.result.status)));
      for (const gate of gates) if (pin.nodes.has(gate.id)) level = Math.max(level, S.levelOf(gate.status));
      let status = LEVEL_STATUS[level];
      if (level === 0) status = pin.pieces.some((p) => p.way.result.status === 'open') ? 'open' : pin.pieces.some((p) => p.way.result.status === 'unknown') ? 'unknown' : 'always';
      if (status !== pin.status || !pin.drawn) pin.marker.setIcon(icon('pin', status));
      pin.status = status;
      pin.drawn = true;
    }

    const openM = totals.always + totals.open;
    const closedM = totals.closed_schedule + totals.closed;
    const allM = openM + closedM + totals.unknown;
    let status;
    let text;
    if (!closedM && !totals.unknown) {
      status = totals.open ? 'open' : 'always';
      text = totals.open ? `Aberta agora. Fecha ${fmtWhen(soonest.open, now)}.` : 'Aberta 24 h.';
    } else if (!openM && !totals.unknown) {
      status = totals.closed_schedule ? 'closed_schedule' : 'closed';
      if (totals.closed_schedule) text = `Fechada agora. Abre ${fmtWhen(soonest.closed_schedule, now)}.`;
      else text = soonest.closed ? `Interditada. Reabre ${fmtWhen(soonest.closed, now)}.` : 'Interditada, sem previsão de reabertura.';
    } else if (openM && soonest.open) {
      status = 'mixed';
      text = `Aberta em ${km(openM)} de ${km(allM)}. Fecha ${fmtWhen(soonest.open, now)}.`;
    } else if (!openM && soonest.closed_schedule) {
      status = 'closed_schedule';
      text = `Fechada agora. Abre ${fmtWhen(soonest.closed_schedule, now)}.`;
    } else {
      status = 'mixed';
      text = `Aberta em ${km(openM)} de ${km(allM)}.`;
    }
    $headline.dataset.status = status;
    $headline.textContent = text;

    const notes = [];
    if (totals.closed && status !== 'closed') notes.push(`${km(totals.closed)} interditados ou sem acesso`);
    if (totals.closed_schedule && status === 'mixed') notes.push(`${km(totals.closed_schedule)} fechados pelo horário`);
    if (totals.unknown) notes.push(`${km(totals.unknown)} com tag que não sei ler`);
    $subline.textContent = `Eixo da margem leste, ${km(allM)} no OSM${notes.length ? ` · ${notes.join(' · ')}` : ''}. Hora de São Paulo: ${two(now.getUTCHours())}:${two(now.getUTCMinutes())}.`;

    // A coluna de km conta só o eixo; a cor pode estar no mapa por outro papel
    // (a margem oeste é azul), então só esmaece o estado ausente do mapa todo.
    const onMap = new Set(pieces.map((p) => p.status));
    // amostra = as mesmas duas camadas do mapa: contorno embaixo, miolo em cima
    const swatchOf = (casing, core) => {
      const swatch = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      swatch.setAttribute('viewBox', '0 0 36 12');
      swatch.setAttribute('class', 'swatch');
      for (const [color, width, dash] of [[casing.color, casing === UNPAVED ? 11 : 8, null], [core.color, 5, core.dash]]) {
        const stroke = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        stroke.setAttribute('x1', 1); stroke.setAttribute('x2', 35); stroke.setAttribute('y1', 6); stroke.setAttribute('y2', 6);
        stroke.setAttribute('stroke', color); stroke.setAttribute('stroke-width', width);
        if (dash) stroke.setAttribute('stroke-dasharray', dash.split(' ').map((n) => n * 0.6).join(' '));
        swatch.append(stroke);
      }
      return swatch;
    };
    const items = ORDER.filter((s) => s !== 'unknown' || onMap.has(s)).map((s) =>
      el('li', { class: onMap.has(s) ? '' : 'dim' }, swatchOf(CASING, STATUS[s]), el('span', null, STATUS[s].label), el('span', { class: 'legend-km' }, totals[s] ? km(totals[s]) : '—')));
    // O piso só entra na legenda quando há chão solto no mapa. Miolo neutro na
    // amostra: o ocre é o contorno, qualquer que seja o estado por dentro.
    const loose = pieces.filter((p) => isUnpaved(p.way.tags));
    const extras = [];
    if (loose.length) {
      const looseTrunk = loose.filter((p) => p.way.role === 'trunk').reduce((sum, p) => sum + p.length, 0);
      extras.push(el('li', null, swatchOf(UNPAVED, { color: '#fbfaf7', dash: null }), el('span', null, UNPAVED.label), el('span', { class: 'legend-km' }, looseTrunk ? km(looseTrunk) : '—')));
    }
    if (pins.length || gates.length) {
      extras.push(el('li', null, el('span', { class: 'legend-marks' }, el('i', { class: 'pin pin-open' }), el('i', { class: 'gate gate-closed' }, '×')),
        el('span', null, 'Bolinha: acesso. Quadrado: portão. A cor é o estado; × é fechado.'), el('span')));
    }
    if (extras.length) extras[0].classList.add('legend-surface');
    $legend.replaceChildren(el('li', { class: 'legend-head' }, el('span'), el('span'), el('span', null, 'no eixo')), ...items, ...extras);

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
        const bounds = L.latLngBounds([]);
        for (const piece of pieces) bounds.extend(piece.line.getBounds());
        const wide = matchMedia('(min-width: 720px)').matches;
        map.fitBounds(bounds, { animate: false, paddingTopLeft: wide ? [380, 24] : [16, 16], paddingBottomRight: wide ? [24, 24] : [16, Math.min(innerHeight * 0.42, 320)] });
        fitted = true;
      }
      // #way=51392253 abre o balão daquele trecho (link pra compartilhar)
      const wanted = /^#way=(\d+)$/.exec(location.hash);
      const target = wanted && pieces.find((p) => String(p.way.id) === wanted[1]);
      if (target) target.hit.openPopup(target.line.getCenter());
    } catch (err) {
      console.error(err);
      if (pieces.length) return; // já tem mapa: fica com o que tem
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
