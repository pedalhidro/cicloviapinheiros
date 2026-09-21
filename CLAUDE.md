# cicloviapinheiros — instruções para assistentes

Leia o `README.md` primeiro; o `../CLAUDE.md` (mapa do workspace) também vale
aqui. Este arquivo guarda só os invariantes deste repo.

## Invariantes

- **O OSM é a fonte da verdade: DECISÃO do Danilo (2026-09-21).** Nada de
  horário, interdição ou traçado escrito neste repo, nem "só por enquanto".
  Dado errado se conserta no OSM. `assets/*.kmz` (mapa da operadora) é
  referência pra quem mapeia: o site não o lê e o workflow não o publica.
- **Quem copia não interpreta.** `tools/fetch_osm.py` grava tags cruas; a cor
  sai do `status.js`, no navegador, porque "aberta agora" depende do relógio.
  Não pré-calcule estado no fetch.
- **Hora de parede**: no `status.js` e no `app.js`, todo instante é um `Date`
  cujos campos **UTC** guardam a hora de São Paulo (`wallClock`). Só
  `getUTC*()`; nunca `getHours()` nem o fuso de quem visita.
- **Cinza antes de chute.** Tag fora do subconjunto lido → `unknown`, com a tag
  crua no balão. Ampliar o parser: caso novo no `test-status.mjs` primeiro.
- **Duas leituras fora da letra do wiki, de propósito** (README, "Como
  mapear"): o idioma só-positivo `yes @ (horário)` vale como "só nesse
  horário", e negação condicional ativa fecha o trecho mesmo vinda de tag menos
  específica. É assim que a ciclovia está mapeada; não "corrija" pra
  precedência formal sem olhar os dados reais.
- **Amarelo × vermelho**: fechado por regra recorrente (hora, dia da semana) é
  amarelo; por data, por tag base (`bicycle=no`) ou por ciclo de vida
  (`highway=construction`) é vermelho. Fechado sem nenhuma reabertura em
  370 dias é vermelho, seja qual for a causa.
- **Tag do OSM é texto de terceiros**: no `app.js`, DOM só pelo `el()`
  (`textContent`). Nada de `innerHTML` com valor de tag.
- **Um Overpass ruim nunca apaga um retrato bom** (`fetch_osm.py`): `remark`
  na resposta (erro vem com HTTP 200), tronco vazio ou encolhido >30% → exit 1
  e o geojson fica como estava. `--force` só à mão.
- **`ciclovia.geojson` só muda quando as feições mudam** (o `git log data/` é
  o histórico do OSM); a hora da consulta vai no `check.json`, gitignored. Por
  isso o deploy é por artefato do Pages, não "from branch". Não ponha
  timestamp volátil dentro do geojson.
- **Papel `trunk`** = nome do eixo **e** (membro da relação 2029967 **ou**
  ≥ 500 m). O painel soma só o `trunk`. A way 51388704 (Jaguaré → Cebolão) está
  fora da relação: se alguém a dividir em pedaço < 500 m, o pedaço vira
  `access` (cor certa, fora da soma). O conserto é incluí-la na relação no OSM.
- **`sw.js` `VERSION`** (`ciclopinheiros-vN`, monotônica): subir a cada mudança
  em arquivo servido, com uma linha no comentário do topo. A rodada de dados
  NÃO sobe: `data/*` é network-first.
- **Cores em dois lugares**: `STATUS` no `app.js` e as variáveis do
  `style.css`. Mudou uma, muda a outra (e o `icon.svg`). Fechado é sempre
  tracejado: a cor não pode ser o único sinal (daltonismo).
- **Sem build, sem CDN**: Leaflet e fontes vendorados em `lib/` (cópia do
  levabici). Sem `package.json`.

## Conferir antes de terminar

`node test-status.mjs`; `python3 -m py_compile tools/fetch_osm.py`; abrir no
navegador de dia e de noite (`?agora=2026-09-21T15:00`, `?agora=…T22:00`) e um
balão (`#way=51392253`). Mudou arquivo servido → `VERSION` do `sw.js`.

Commit só quando pedirem. O workflow commita `data/ciclovia.geojson` sozinho
como `github-actions[bot]`: dê `git pull --rebase` antes de empurrar.
