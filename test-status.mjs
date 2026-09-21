// node test-status.mjs — regressão do status.js (sem dependências, sem rede).
// Os casos "reais" são tags copiadas do OSM em 2026-09-21.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const S = createRequire(import.meta.url)('./status.js');

// hora de parede de São Paulo (ver o cabeçalho do status.js)
const at = (iso) => new Date(`${iso}:00Z`);
const hhmm = (d) => d.toISOString().slice(0, 16).replace('T', ' ');

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}\n     ${err.message.split('\n').join('\n     ')}`);
  }
}

const TRUNK = {
  highway: 'cycleway', bicycle: 'designated', foot: 'yes',
  'bicycle:conditional': 'yes @ (05:30-18:30)',
  'temporary:access': 'no @ (2021-08-18 - 2021-12-31)',
};

test('tronco real: verde de dia, fecha às 18:30', () => {
  const r = S.classify(TRUNK, at('2026-09-21T15:00')); // segunda
  assert.equal(r.status, 'open');
  assert.equal(hhmm(r.nextChange), '2026-09-21 18:30');
  assert.equal(r.nextCause, 'schedule');
});

test('tronco real: amarelo à noite, reabre 05:30 do dia seguinte', () => {
  const r = S.classify(TRUNK, at('2026-09-21T22:00'));
  assert.equal(r.status, 'closed_schedule');
  assert.equal(hhmm(r.nextChange), '2026-09-22 05:30');
});

test('tronco real: amarelo de madrugada, reabre 05:30 do mesmo dia', () => {
  const r = S.classify(TRUNK, at('2026-09-22T03:10'));
  assert.equal(r.status, 'closed_schedule');
  assert.equal(hhmm(r.nextChange), '2026-09-22 05:30');
});

test('bordas do horário: 05:30 abre, 18:30 já fechou', () => {
  assert.equal(S.classify(TRUNK, at('2026-09-22T05:29')).status, 'closed_schedule');
  assert.equal(S.classify(TRUNK, at('2026-09-22T05:30')).status, 'open');
  assert.equal(S.classify(TRUNK, at('2026-09-22T18:29')).status, 'open');
  assert.equal(S.classify(TRUNK, at('2026-09-22T18:30')).status, 'closed_schedule');
});

test('interdição ISO de 2021 (real) valia na época: vermelho até reabrir', () => {
  const r = S.classify(TRUNK, at('2021-10-05T12:00'));
  assert.equal(r.status, 'closed');
  assert.equal(r.cause, 'dated');
  // acaba 31/12 à meia-noite, mas a ciclovia só abre às 05:30
  assert.equal(hhmm(r.nextChange), '2022-01-01 05:30');
});

test('interdição datada vence o horário também à noite', () => {
  assert.equal(S.classify(TRUNK, at('2021-10-05T23:00')).status, 'closed');
});

test('acesso real com negação noturna `no @ (18:30-05:30)`', () => {
  const tags = { highway: 'cycleway', bicycle: 'yes', 'bicycle:conditional': 'no @ (18:30-05:30)' };
  assert.equal(S.classify(tags, at('2026-09-21T12:00')).status, 'open');
  const night = S.classify(tags, at('2026-09-22T02:00')); // sobra da faixa de ontem
  assert.equal(night.status, 'closed_schedule');
  assert.equal(hhmm(night.nextChange), '2026-09-22 05:30');
});

test('sem restrição nenhuma: azul (margem oeste real)', () => {
  const r = S.classify({ highway: 'cycleway', bicycle: 'designated', horse: 'no' }, at('2026-09-21T03:00'));
  assert.equal(r.status, 'always');
  assert.equal(r.nextChange, null);
});

test('access=no + bicycle=yes (Ciclovia dos Trabalhadores real): bicicleta manda', () => {
  const tags = { highway: 'cycleway', access: 'no', bicycle: 'yes', note: 'Funcionamento das 07:00 ás 19:00' };
  assert.equal(S.classify(tags, at('2026-09-21T23:00')).status, 'always');
});

test('bicycle=dismount é neutro, não é fechamento', () => {
  const tags = { highway: 'cycleway', bicycle: 'dismount', 'bicycle:conditional': 'no @ (18:30-05:30)' };
  assert.equal(S.classify(tags, at('2026-09-21T12:00')).status, 'open');
});

test('bicycle=no sem condicional: vermelho sem previsão', () => {
  const r = S.classify({ highway: 'cycleway', bicycle: 'no' }, at('2026-09-21T12:00'));
  assert.equal(r.status, 'closed');
  assert.equal(r.cause, 'base');
  assert.equal(r.nextChange, null);
});

test('forma canônica: bicycle=no + designated @ horário', () => {
  const tags = { highway: 'cycleway', bicycle: 'no', 'bicycle:conditional': 'designated @ (05:30-18:30)' };
  assert.equal(S.classify(tags, at('2026-09-21T12:00')).status, 'open');
  assert.equal(S.classify(tags, at('2026-09-21T20:00')).status, 'closed_schedule');
});

test('highway=construction: vermelho, mesmo com tag ilegível', () => {
  const r = S.classify({ highway: 'construction', construction: 'cycleway', opening_hours: 'sunrise-sunset' }, at('2026-09-21T12:00'));
  assert.equal(r.status, 'closed');
  assert.equal(r.cause, 'lifecycle');
});

test('prefixo de ciclo de vida sem highway: vermelho', () => {
  assert.equal(S.classify({ 'disused:highway': 'cycleway' }, at('2026-09-21T12:00')).status, 'closed');
});

test('interdição futura no padrão opening_hours: avisa, mas segue verde', () => {
  const tags = { ...TRUNK, 'access:conditional': 'no @ (2026 Oct 01-2026 Oct 15)' };
  const before = S.classify(tags, at('2026-09-30T12:00'));
  assert.equal(before.status, 'open');
  const during = S.classify(tags, at('2026-10-03T12:00'));
  assert.equal(during.status, 'closed');
  assert.equal(hhmm(during.nextChange), '2026-10-16 05:30');
});

test('interdição datada sobre trecho 24 h: azul agora, aviso da data', () => {
  const tags = { highway: 'cycleway', 'bicycle:conditional': 'no @ (2026 Oct 01-2026 Oct 15)' };
  const r = S.classify(tags, at('2026-09-21T12:00'));
  assert.equal(r.status, 'always');
  assert.equal(hhmm(r.nextChange), '2026-10-01 00:00');
  assert.equal(r.nextCause, 'dated');
});

test('interdição sem fim (`+`): vermelho sem previsão', () => {
  const r = S.classify({ highway: 'cycleway', 'bicycle:conditional': 'no @ (2026 May 01+)' }, at('2026-09-21T12:00'));
  assert.equal(r.status, 'closed');
  assert.equal(r.nextChange, null);
});

test('opening_hours por dia da semana; fim de semana fechado é amarelo', () => {
  const tags = { highway: 'cycleway', opening_hours: 'Mo-Fr 06:00-20:00; Sa 07:00-14:00' };
  assert.equal(S.classify(tags, at('2026-09-21T12:00')).status, 'open'); // segunda
  const sunday = S.classify(tags, at('2026-09-20T12:00'));
  assert.equal(sunday.status, 'closed_schedule');
  assert.equal(hhmm(sunday.nextChange), '2026-09-21 06:00');
  const saturday = S.classify(tags, at('2026-09-19T13:00'));
  assert.equal(hhmm(saturday.nextChange), '2026-09-19 14:00');
});

test('opening_hours=24/7 é azul; =closed é vermelho', () => {
  assert.equal(S.classify({ highway: 'cycleway', opening_hours: '24/7' }, at('2026-09-21T03:00')).status, 'always');
  assert.equal(S.classify({ highway: 'cycleway', opening_hours: 'closed' }, at('2026-09-21T12:00')).status, 'closed');
});

test('opening_hours com `off` datado por cima do horário', () => {
  const tags = { highway: 'cycleway', opening_hours: '05:30-18:30; 2026 Dec 24-2026 Dec 25 off' };
  const r = S.classify(tags, at('2026-12-24T12:00'));
  assert.equal(r.status, 'closed');
  assert.equal(r.cause, 'dated');
  assert.equal(hhmm(r.nextChange), '2026-12-26 05:30');
});

test('`off` com horário só fecha aquela janela', () => {
  const tags = { highway: 'cycleway', opening_hours: '05:30-18:30; We 12:00-13:00 off' };
  assert.equal(S.classify(tags, at('2026-09-23T12:30')).status, 'closed_schedule'); // quarta
  assert.equal(S.classify(tags, at('2026-09-23T14:00')).status, 'open');
  assert.equal(S.classify(tags, at('2026-09-22T12:30')).status, 'open'); // terça
});

test('faixa de datas sem ano atravessa a virada do ano', () => {
  const tags = { highway: 'cycleway', 'bicycle:conditional': 'no @ (Dec 20-Jan 05)' };
  assert.equal(S.classify(tags, at('2026-12-31T12:00')).status, 'closed');
  assert.equal(S.classify(tags, at('2027-01-03T12:00')).status, 'closed');
  assert.equal(S.classify(tags, at('2027-01-06T12:00')).status, 'always');
});

test('PH é ignorado com aviso, sem derrubar o resto', () => {
  const r = S.classify({ highway: 'cycleway', opening_hours: '05:30-18:30; PH off' }, at('2026-09-21T12:00'));
  assert.equal(r.status, 'open');
  assert.equal(r.warnings.length, 1);
});

test('fora do subconjunto: cinza, com a tag no erro', () => {
  for (const value of ['sunrise-sunset', 'Mo-Fr 08:00-12:00, Sa 10:00-12:00', 'week 1-20 08:00-12:00', '25:00-26:00']) {
    const r = S.classify({ highway: 'cycleway', opening_hours: value }, at('2026-09-21T12:00'));
    assert.equal(r.status, 'unknown', value);
    assert.match(r.errors[0], /opening_hours=/);
  }
  const r = S.classify({ highway: 'cycleway', 'bicycle:conditional': 'no @ (wet)' }, at('2026-09-21T12:00'));
  assert.equal(r.status, 'unknown');
});

test('várias cláusulas e `;` dentro dos parênteses', () => {
  const tags = { highway: 'cycleway', 'bicycle:conditional': 'no @ (Mo-Fr 22:00-05:00; Sa,Su 20:00-06:00); no @ (2026 Nov 02)' };
  assert.equal(S.classify(tags, at('2026-09-21T23:00')).status, 'closed_schedule'); // segunda
  assert.equal(S.classify(tags, at('2026-09-19T21:00')).status, 'closed_schedule'); // sábado
  assert.equal(S.classify(tags, at('2026-09-19T12:00')).status, 'open');
  assert.equal(S.classify(tags, at('2026-11-02T12:00')).status, 'closed');
});

test('wallClock devolve a hora de parede de São Paulo (UTC−3)', () => {
  assert.equal(hhmm(S.wallClock(new Date('2026-09-21T18:45:00Z'))), '2026-09-21 15:45');
  assert.equal(hhmm(S.wallClock(new Date('2026-09-22T01:10:00Z'))), '2026-09-21 22:10');
});

// ── rede: portões ──────────────────────────────────────────────────────────
// Eixo A—B—C—D em quatro peças; o acesso entra no nó 2; portão no nó 3.
//   nós:  1 ──a── 2 ──b── 3 ──c── 4 ──d── 5
const net = (levels = {}) => [
  { id: 'a', nodes: [1, 2], level: levels.a || 0, source: false },
  { id: 'b', nodes: [2, 3], level: levels.b || 0, source: false },
  { id: 'c', nodes: [3, 4], level: levels.c || 0, source: false },
  { id: 'd', nodes: [4, 5], level: levels.d || 0, source: false },
  { id: 'acesso', nodes: [9, 2], level: levels.acesso || 0, source: true },
];
const levels = (pieces, gates = []) => Object.fromEntries(S.effectiveLevels(pieces, new Map(gates)));

test('rede sem portão: tudo alcançável fica como está', () => {
  assert.deepEqual(levels(net()), { a: 0, b: 0, c: 0, d: 0, acesso: 0 });
});

test('portão interditado isola o que fica atrás (caso Jaguaré → Cebolão)', () => {
  assert.deepEqual(levels(net(), [[3, 2]]), { a: 0, b: 0, c: 2, d: 2, acesso: 0 });
});

test('atrás do portão privado é vermelho também à noite, não amarelo', () => {
  const night = { a: 1, b: 1, c: 1, d: 1 };
  assert.deepEqual(levels(net(night), [[3, 2]]), { a: 1, b: 1, c: 2, d: 2, acesso: 0 });
});

test('portão que só fecha à noite deixa amarelo, não vermelho', () => {
  assert.deepEqual(levels(net(), [[3, 1]]), { a: 0, b: 0, c: 1, d: 1, acesso: 0 });
});

test('trecho interditado no meio isola o resto do eixo', () => {
  assert.deepEqual(levels(net({ b: 2 })), { a: 0, b: 2, c: 2, d: 2, acesso: 0 });
});

test('um segundo acesso do outro lado do portão desfaz o isolamento', () => {
  const pieces = [...net(), { id: 'acesso2', nodes: [8, 5], level: 0, source: true }];
  assert.deepEqual(levels(pieces, [[3, 2]]), { a: 0, b: 0, c: 0, d: 0, acesso: 0, acesso2: 0 });
});

test('acesso interditado não serve de entrada', () => {
  assert.deepEqual(levels(net({ acesso: 2 })), { a: 2, b: 2, c: 2, d: 2, acesso: 2 });
});

test('portão na ponta compartilhada não vaza pro vizinho', () => {
  // o nó 3 é portão fechado e também onde `b` e `c` se tocam: `c` não herda de `b`
  assert.equal(levels(net(), [[3, 2]]).c, 2);
  assert.equal(S.levelOf('closed'), 2);
  assert.equal(S.levelOf('closed_schedule'), 1);
  assert.equal(S.levelOf('always'), 0);
});

console.log(failed ? `\n${failed} falha(s)` : '\ntudo ok');
process.exit(failed ? 1 : 0);
