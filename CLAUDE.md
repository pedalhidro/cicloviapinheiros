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
- **O que entra no mapa: regra primeiro, lista de exclusão por último**
  (`fetch_osm.py`): relações + nome + corredor de 150 m do rio; saem ruas e
  grupos soltos < 1 km. Pedidos do Danilo (2026-09-21): "tirar a Rua Professor
  Artur Ramos" virou "rua não entra"; "tirar os caminhos pequenos que não ligam
  na ciclovia" virou a poda por componente conexo. Quando ele aponta ways que
  nenhuma tag separa das que ficam, vão pro `EXCLUDE_WAYS` (curadoria dele; é
  seleção, não dado — estado continua vindo só do OSM). Depois de excluir, rode
  e veja o que a poda levou junto. A relação 5245324 saiu por isso. O rio muda de nome no
  OSM (`RIVER_RE`: "Pinheiros|Jurubatuba"): sem o segundo, o corredor para em
  Santo Amaro.
- **Portões = alcançabilidade, não tag** (`effectiveLevels` no `status.js`,
  pedido do Danilo 2026-09-21). Nível 0/1/2; o nível efetivo de uma peça é o
  pior entre o dela e o do melhor caminho até ela a partir de uma fonte (tudo
  que não é `trunk`). É isso que pinta Jaguaré → Cebolão de vermelho; NÃO mude
  a leitura de `access=private` + `bicycle=designated` (= "só bicicleta", é o
  caso da Ciclovia dos Trabalhadores, com teste). As ways vêm com `nodes` (ids
  do OSM) justamente pra isso, e o `app.js` corta cada way em peças nos portões.
- **Ordem de empilhamento: DECISÃO do Danilo (2026-09-21)**: vermelho por cima,
  depois amarelo, verde, azul (`Z_ORDER` no `app.js`). Sem os pontos
  Cebolão/Pedreira no mapa (pedido dele): não reintroduzir marcador de ponta.
- **Espelho atrasado do Overpass** (`MAX_LAG_H`): private.coffee respondeu 200
  com OSM de 2 e de 4 meses antes, no mesmo dia. Resposta com
  `timestamp_osm_base` velho é erro, não dado.
- **Papel `trunk`** = nome do eixo **e** (membro da relação 2029967 **ou**
  ≥ 500 m). O painel soma só o `trunk`. A way 51388704 (Jaguaré → Cebolão) está
  fora da relação: se alguém a dividir em pedaço < 500 m, o pedaço vira
  `access` (cor certa, fora da soma). O conserto é incluí-la na relação no OSM.
- **`sw.js` `VERSION`** (`ciclopinheiros-vN`, monotônica): subir a cada mudança
  em arquivo servido, com uma linha no comentário do topo. A rodada de dados
  NÃO sobe: `data/*` é network-first.
- **Cores em dois lugares**: `STATUS`/`UNPAVED` no `app.js` e as variáveis do
  `style.css`. Mudou uma, muda a outra (e o `icon.svg`). Fechado é sempre
  tracejado (linha) ou × (marcador): a cor não pode ser o único sinal
  (daltonismo). O miolo da linha é o estado; o contorno é o piso (ocre = chão
  solto). São sinais independentes: não misture.
- **Sem build, sem CDN**: Leaflet e fontes vendorados em `lib/` (cópia do
  levabici). Sem `package.json`.

## Conferir antes de terminar

`node test-status.mjs`; `python3 -m py_compile tools/fetch_osm.py`; abrir no
navegador de dia e de noite (`?agora=2026-09-21T15:00`, `?agora=…T22:00`) e um
balão (`#way=51392253`). Mudou arquivo servido → `VERSION` do `sw.js`.

Commit só quando pedirem. O workflow commita `data/ciclovia.geojson` sozinho
como `github-actions[bot]`: dê `git pull --rebase` antes de empurrar.
