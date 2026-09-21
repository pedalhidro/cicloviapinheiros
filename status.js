// status.js — das tags do OSM ao estado de cada trecho, num instante dado.
//
// Puro (sem DOM, sem rede): o app.js usa no navegador, o test-status.mjs usa
// no node. O dado do OSM é refeito a cada 6 h, mas "aberta AGORA" depende do
// relógio — por isso a classificação roda no cliente, a cada minuto.
//
// RELÓGIO DE PAREDE: todo instante aqui é um Date cujos campos **UTC** guardam
// a hora de parede de São Paulo (ver wallClock). Assim nada depende do fuso de
// quem visita, e os testes são determinísticos. Só use getUTC*() nesses Dates.
//
// Estados (o `status` de classify):
//   always           aberta 24 h                              → azul
//   open             aberta agora, mas com horário            → verde
//   closed_schedule  fechada agora, reabre pelo horário       → amarelo
//   closed           fechada sem previsão ou até uma data     → vermelho
//   unknown          tag fora do subconjunto interpretado     → cinza
// Preferimos `unknown` (mostrando a tag crua) a adivinhar.
(function (root) {
  'use strict';

  const TZ = 'America/Sao_Paulo';
  const MIN = 60000;
  const DAY = 86400000;
  const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Valores de acesso. O que não é permit nem deny (dismount, destination,
  // discouraged…) muda COMO se passa, não SE se passa: neutro pra este mapa.
  const PERMIT = new Set(['yes', 'designated', 'permissive', 'official']);
  const DENY = new Set(['no', 'private']);

  // Do modo menos ao mais específico (a ordem só importa pra tag base).
  const MODES = ['access', 'vehicle', 'bicycle'];
  const LIFECYCLE = ['construction', 'proposed', 'planned', 'disused', 'abandoned', 'razed', 'demolished'];

  const HORIZON_DAYS = 370; // até onde procurar a próxima virada
  const SCHEDULE_DAYS = 8; // fechamento recorrente cabe numa semana

  function wallClock(date) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date || new Date());
    const p = {};
    for (const part of parts) p[part.type] = Number(part.value);
    return new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second));
  }

  // ── Subconjunto de opening_hours ─────────────────────────────────────────
  // Aceita: `24/7`; faixas `HH:MM-HH:MM` (várias por vírgula, podem virar a
  // meia-noite); dias `Mo-Fr`, `Sa,Su`; datas `2026 May 01-2026 Aug 31`,
  // `May 01-Aug 31`, `2026 May 01+`, `Dec 25`, `Jun-Aug` e o ISO fora do
  // padrão que existe no OSM de SP (`2021-08-18 - 2021-12-31`); modificadores
  // `off`/`closed`/`open`; regras separadas por `;` (a última que casa o dia
  // manda). Fora disso (sunrise, week, `||`, regras aditivas…) → Error.
  // `PH` (feriado) é ignorado com aviso: não temos calendário de feriados.

  const WD_RE = '(?:Mo|Tu|We|Th|Fr|Sa|Su|PH)';
  const TIME_RE = '\\d{1,2}:\\d{2}\\s*-\\s*\\d{1,2}:\\d{2}';
  const TIMES_TAIL = new RegExp(`(?:^|\\s)(${TIME_RE}(?:\\s*,\\s*${TIME_RE})*)$`);
  const DAYS_TAIL = new RegExp(`(?:^|\\s)(${WD_RE}(?:\\s*-\\s*${WD_RE})?(?:\\s*,\\s*${WD_RE}(?:\\s*-\\s*${WD_RE})?)*)$`);
  const MON_RE = `(${MONTHS.join('|')})`;
  const DATE_ISO = /^(\d{4})-(\d{2})-(\d{2})(?:\s*-\s*(\d{4})-(\d{2})-(\d{2}))?$/;
  const DATE_DAY = new RegExp(`^(?:(\\d{4})\\s+)?${MON_RE}\\s+(\\d{1,2})(?:\\s*-\\s*(?:(\\d{4})\\s+)?(?:${MON_RE}\\s+)?(\\d{1,2}))?(\\+)?$`);
  const DATE_MONTH = new RegExp(`^(?:(\\d{4})\\s+)?${MON_RE}(?:\\s*-\\s*(?:(\\d{4})\\s+)?${MON_RE})?$`);

  function parseTimes(text) {
    return text.split(',').map((piece) => {
      const m = piece.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
      const start = Number(m[1]) * 60 + Number(m[2]);
      let end = Number(m[3]) * 60 + Number(m[4]);
      if (start > 1440 || end > 1440 || Number(m[2]) > 59 || Number(m[4]) > 59) {
        throw new Error(`hora inválida: "${piece.trim()}"`);
      }
      if (end <= start) end += 1440; // vira a meia-noite
      return [start, end];
    });
  }

  function parseDays(text, warnings) {
    const days = new Set();
    let holiday = false;
    for (const piece of text.split(',')) {
      const [a, b] = piece.trim().split(/\s*-\s*/);
      if (a === 'PH' || b === 'PH') { holiday = true; continue; }
      const from = WEEKDAYS.indexOf(a);
      const to = b ? WEEKDAYS.indexOf(b) : from;
      for (let d = from; ; d = (d + 1) % 7) { days.add(d); if (d === to) break; }
    }
    if (holiday) warnings.push('regra de feriado (PH) ignorada: sem calendário de feriados');
    return days.size ? days : null; // null aqui = só PH → a regra é descartada
  }

  function parseDates(text) {
    let m = text.match(DATE_ISO);
    if (m) {
      const from = [Number(m[1]), Number(m[2]), Number(m[3])];
      return { from, to: m[4] ? [Number(m[4]), Number(m[5]), Number(m[6])] : from, openEnded: false };
    }
    m = text.match(DATE_DAY);
    if (m) {
      const y1 = m[1] ? Number(m[1]) : null;
      const m1 = MONTHS.indexOf(m[2]) + 1;
      const from = [y1, m1, Number(m[3])];
      let to = from;
      if (m[6]) {
        const y2 = m[4] ? Number(m[4]) : y1;
        if ((y1 === null) !== (y2 === null)) throw new Error(`faixa de datas mista: "${text}"`);
        to = [y2, m[5] ? MONTHS.indexOf(m[5]) + 1 : m1, Number(m[6])];
      }
      return { from, to, openEnded: Boolean(m[7]) };
    }
    m = text.match(DATE_MONTH);
    if (m) {
      const y1 = m[1] ? Number(m[1]) : null;
      const y2 = m[3] ? Number(m[3]) : y1;
      const m1 = MONTHS.indexOf(m[2]) + 1;
      const m2 = m[4] ? MONTHS.indexOf(m[4]) + 1 : m1;
      return { from: [y1, m1, 1], to: [y2, m2, 31], openEnded: false };
    }
    throw new Error(`não entendi "${text}"`);
  }

  function parseRule(text, warnings) {
    let rest = text.trim().replace(/\s*"[^"]*"\s*$/, ''); // comentário final
    const rule = { dates: null, days: null, times: null, state: true };
    if (rest === '24/7') return rule;

    let m = rest.match(/(?:^|\s)(off|closed|open)$/i);
    if (m) {
      rule.state = m[1].toLowerCase() === 'open';
      rest = rest.slice(0, m.index).trim();
    }
    m = rest.match(TIMES_TAIL);
    if (m) {
      rule.times = parseTimes(m[1]);
      rest = rest.slice(0, m.index).trim();
    }
    m = rest.match(DAYS_TAIL);
    if (m) {
      rule.days = parseDays(m[1], warnings);
      if (!rule.days) return null; // regra só de feriado
      rest = rest.slice(0, m.index).trim();
    }
    rest = rest.replace(/:$/, '').trim();
    if (rest) rule.dates = parseDates(rest);
    if (!rule.dates && !rule.days && !rule.times && rule.state) {
      throw new Error(`regra vazia: "${text}"`);
    }
    return rule;
  }

  function parseCondition(text) {
    const warnings = [];
    const rules = [];
    for (const piece of String(text).split(';')) {
      if (!piece.trim()) continue;
      const rule = parseRule(piece, warnings);
      if (rule) rules.push(rule);
    }
    if (!rules.length && !warnings.length) throw new Error('condição vazia');
    const points = new Set([0]);
    for (const rule of rules) {
      for (const [start, end] of rule.times || []) { points.add(start % 1440); points.add(end % 1440); }
    }
    return { raw: String(text), rules, warnings, points, dated: rules.some((r) => r.dates) };
  }

  function dateMatches(sel, wall) {
    const y = wall.getUTCFullYear();
    const md = (wall.getUTCMonth() + 1) * 100 + wall.getUTCDate();
    const from = sel.from[1] * 100 + sel.from[2];
    const to = sel.to[1] * 100 + sel.to[2];
    if (sel.from[0] !== null) {
      const cur = y * 10000 + md;
      if (cur < sel.from[0] * 10000 + from) return false;
      return sel.openEnded || cur <= sel.to[0] * 10000 + to;
    }
    if (sel.openEnded) return md >= from;
    return from <= to ? md >= from && md <= to : md >= from || md <= to; // Dec 15-Jan 15
  }

  function dayMatches(rule, wall) {
    if (rule.dates && !dateMatches(rule.dates, wall)) return false;
    return !rule.days || rule.days.has(wall.getUTCDay());
  }

  // → { state, rule }: `rule` é a regra que decidiu (null = nenhuma casou, e
  // em opening_hours o que não está dito é fechado).
  function evalCondition(cond, wall) {
    const minute = (wall.getTime() % DAY) / MIN;
    // sobra de ontem: `Fr 22:00-02:00` ainda vale no sábado à 01:00
    const yesterday = new Date(wall.getTime() - DAY);
    for (let i = cond.rules.length - 1; i >= 0; i--) {
      const rule = cond.rules[i];
      if (!dayMatches(rule, yesterday)) continue;
      if (!rule.times) break;
      if (rule.state) {
        if (rule.times.some(([, end]) => end > 1440 && minute < end - 1440)) return { state: true, rule };
        break;
      }
    }
    for (let i = cond.rules.length - 1; i >= 0; i--) {
      const rule = cond.rules[i];
      if (!dayMatches(rule, wall)) continue;
      if (!rule.times) return { state: rule.state, rule };
      if (rule.times.some(([start, end]) => minute >= start && minute < end)) return { state: rule.state, rule };
      if (rule.state) return { state: false, rule }; // regra de abertura manda no dia
      // `off` com horário que não cobre agora: vale a regra anterior
    }
    return { state: false, rule: null };
  }

  // ── Restrições condicionais: `valor @ (condição); valor @ (condição)` ─────
  function splitTopLevel(text) {
    const pieces = [];
    let depth = 0;
    let current = '';
    for (const ch of text) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ';' && depth === 0) { pieces.push(current); current = ''; } else current += ch;
    }
    pieces.push(current);
    return pieces.map((p) => p.trim()).filter(Boolean);
  }

  function parseConditional(text) {
    return splitTopLevel(String(text)).map((piece) => {
      const at = piece.indexOf('@');
      if (at < 0) throw new Error(`falta "@" em "${piece}"`);
      const value = piece.slice(0, at).trim().toLowerCase();
      let condition = piece.slice(at + 1).trim();
      if (condition.startsWith('(') && condition.endsWith(')')) condition = condition.slice(1, -1).trim();
      return { value, condition: parseCondition(condition) };
    });
  }

  function kindOf(value) {
    if (PERMIT.has(value)) return 'permit';
    if (DENY.has(value)) return 'deny';
    return 'neutral';
  }

  // ── Modelo de um trecho ──────────────────────────────────────────────────
  // Desvio consciente da precedência formal do OSM: uma negação condicional
  // ATIVA fecha o trecho mesmo vindo de tag menos específica (`temporary:access
  // =no @ …` sobre `bicycle=designated`). Quem mapeia uma interdição quer dizer
  // "fechado"; num mapa de status, errar pro lado fechado é o erro barato.
  function analyze(tags) {
    const model = { lifecycle: null, base: null, clauses: [], hours: null, errors: [], warnings: [], points: new Set([0]) };

    const highway = tags.highway;
    if (LIFECYCLE.includes(highway)) model.lifecycle = highway;
    else if (!highway) model.lifecycle = LIFECYCLE.find((prefix) => tags[`${prefix}:highway`]) || null;

    for (const mode of MODES) {
      const value = tags[mode];
      if (value !== undefined && kindOf(value.toLowerCase()) !== 'neutral') {
        model.base = { key: mode, value, permit: kindOf(value.toLowerCase()) === 'permit' };
      }
    }
    if (!model.base) model.base = { key: null, value: null, permit: true };

    const absorb = (cond) => {
      model.warnings.push(...cond.warnings);
      for (const p of cond.points) model.points.add(p);
    };

    for (const mode of MODES) {
      for (const key of [`${mode}:conditional`, `temporary:${mode}`, `temporary:${mode}:conditional`]) {
        if (tags[key] === undefined) continue;
        try {
          for (const { value, condition } of parseConditional(tags[key])) {
            absorb(condition);
            model.clauses.push({ key, value, kind: kindOf(value), condition });
          }
        } catch (err) {
          model.errors.push(`${key}=${tags[key]} — ${err.message}`);
        }
      }
    }

    if (tags.opening_hours !== undefined) {
      try {
        model.hours = parseCondition(tags.opening_hours);
        absorb(model.hours);
      } catch (err) {
        model.errors.push(`opening_hours=${tags.opening_hours} — ${err.message}`);
      }
    }

    // Idioma "só positivo": `bicycle=designated` + `bicycle:conditional=yes @
    // (05:30-18:30)`. Ao pé da letra é um no-op (já era permitido); o que se
    // quis dizer — e é assim que a ciclovia está mapeada — é "só nesse
    // horário". Vale por chave, e só quando TODAS as cláusulas são permissão.
    model.onlyWhen = [];
    if (model.base.permit) {
      const byKey = new Map();
      for (const clause of model.clauses) {
        if (!byKey.has(clause.key)) byKey.set(clause.key, []);
        byKey.get(clause.key).push(clause);
      }
      for (const clauses of byKey.values()) {
        if (clauses.every((c) => c.kind === 'permit')) model.onlyWhen.push(clauses);
      }
    }
    return model;
  }

  // → { open, cause }  cause: lifecycle | dated | schedule | base | null
  function openAt(model, wall) {
    if (model.lifecycle) return { open: false, cause: 'lifecycle' };

    const active = [];
    for (const clause of model.clauses) {
      const result = evalCondition(clause.condition, wall);
      if (result.state) active.push({ clause, dated: Boolean(result.rule && result.rule.dates) });
    }
    const denials = active.filter((a) => a.clause.kind === 'deny');
    if (denials.some((a) => a.dated)) return { open: false, cause: 'dated' };
    if (denials.length) return { open: false, cause: 'schedule' };

    if (model.hours) {
      const result = evalCondition(model.hours, wall);
      if (!result.state) return { open: false, cause: result.rule && result.rule.dates ? 'dated' : 'schedule' };
    }

    if (!model.base.permit) {
      if (active.some((a) => a.clause.kind === 'permit')) return { open: true, cause: null };
      const recurring = model.clauses.some((c) => c.kind === 'permit' && !c.condition.dated);
      return { open: false, cause: recurring ? 'schedule' : 'base' };
    }

    for (const clauses of model.onlyWhen) {
      if (!clauses.some((c) => active.some((a) => a.clause === c))) {
        return { open: false, cause: clauses.every((c) => c.condition.dated) ? 'dated' : 'schedule' };
      }
    }
    return { open: true, cause: null };
  }

  // Próxima virada aberto↔fechado. O estado só muda nas bordas das faixas de
  // horário ou à meia-noite (dia/data), então basta testar esses pontos.
  function nextFlip(model, wall) {
    if (!model.clauses.length && !model.hours) return null;
    const current = openAt(model, wall).open;
    const points = [...model.points].sort((a, b) => a - b);
    const midnight = wall.getTime() - (wall.getTime() % DAY);
    for (let day = 0; day <= HORIZON_DAYS; day++) {
      for (const point of points) {
        const at = midnight + day * DAY + point * MIN;
        if (at <= wall.getTime()) continue;
        const then = openAt(model, new Date(at));
        if (then.open !== current) return { at: new Date(at), cause: then.cause };
      }
    }
    return null;
  }

  function classify(tags, wall) {
    const model = analyze(tags || {});
    const out = { status: 'unknown', open: null, cause: null, nextChange: null, nextCause: null, errors: model.errors, warnings: [...new Set(model.warnings)] };

    if (model.errors.length && !model.lifecycle) return out;

    const now = openAt(model, wall);
    const flip = nextFlip(model, wall);
    out.open = now.open;
    out.cause = now.cause;
    out.nextChange = flip ? flip.at : null;
    out.nextCause = flip ? flip.cause : null;

    if (now.open) {
      const soon = flip && flip.cause === 'schedule' && flip.at.getTime() - wall.getTime() <= SCHEDULE_DAYS * DAY;
      out.status = soon ? 'open' : 'always';
    } else {
      out.status = now.cause === 'schedule' && flip ? 'closed_schedule' : 'closed';
    }
    return out;
  }

  const api = { TZ, wallClock, parseCondition, parseConditional, evalCondition, analyze, openAt, nextFlip, classify };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CicloStatus = api;
})(typeof self !== 'undefined' ? self : this);
