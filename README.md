# ciclopinheiros.pedalhidrografi.co

**A Ciclovia do Rio Pinheiros está aberta?** Um mapa do estado de cada trecho,
do Cebolão à Usina Elevatória de Pedreira:

| cor | estado |
| --- | --- |
| 🔵 azul | aberta 24 h |
| 🟢 verde | aberta agora, mas tem horário |
| 🟡 amarelo (tracejado) | fechada agora, reabre pelo horário |
| 🔴 vermelho (tracejado) | interditada: sem previsão ou até uma data |
| ⚪ cinza (pontilhado) | o OSM tem uma tag de horário que o site não sabe ler |

A fonte da verdade é o **OpenStreetMap**. Este repositório não guarda horário
nem interdição nenhuma: copia as tags do OSM a cada 6 h e as interpreta. Se o
mapa está errado, o conserto é no OSM (e conserta junto todo app que usa o OSM).

Um mapa do [Pedal Hidrográfico](https://pedalhidrografi.co), sem vínculo com a
operadora da ciclovia.

## Como funciona

```
OpenStreetMap
    │  Overpass API, a cada 6 h (GitHub Actions)
    ▼
tools/fetch_osm.py ──► data/ciclovia.geojson   traçado + tags cruas (commit só quando muda)
                   └─► data/check.json         quando foi a última consulta (não vai pro git)
    │  GitHub Pages
    ▼
navegador: status.js classifica cada trecho com o relógio de São Paulo, a cada minuto
```

O dado muda a cada 6 h, mas "aberta **agora**" muda a cada minuto. Por isso o
servidor só copia tags, e quem decide a cor é o navegador.

- `status.js`: das tags ao estado. Puro, sem DOM; testado por `node test-status.mjs`.
- `app.js`: o mapa (Leaflet), o painel, os balões.
- `tools/fetch_osm.py`: a consulta ao Overpass. Só biblioteca padrão.
- `.github/workflows/site.yml`: o cron de 6 h e o deploy. A configuração única
  do Pages e do DNS está no cabeçalho dele.

### O que entra no mapa

As relações [2029967](https://www.openstreetmap.org/relation/2029967) (a
ciclovia), [5245330](https://www.openstreetmap.org/relation/5245330) (margem
oeste) e [5245324](https://www.openstreetmap.org/relation/5245324) (ligação),
**mais** toda way com nome `Ciclovia (do) Rio Pinheiros` entre o Cebolão e
Pedreira. O nome é necessário porque há trecho fora da relação (ver abaixo).

O painel e a coluna de km da legenda contam só o **eixo** da margem leste; o
resto aparece no mapa com linha mais fina.

## Como mapear no OSM pra este mapa reagir

| situação | tags na way |
| --- | --- |
| horário de funcionamento | `opening_hours=05:30-18:30` **ou** `bicycle=no` + `bicycle:conditional=designated @ (05:30-18:30)` |
| horário por dia | `opening_hours=Mo-Fr 05:30-18:30; Sa,Su 06:00-17:00` |
| aberta sempre | `opening_hours=24/7` (ou nenhuma tag de horário) |
| interdição com datas | `access:conditional=no @ (2026 Oct 01-2026 Oct 15)` |
| interdição sem prazo | `access:conditional=no @ (2026 Oct 01+)` ou `bicycle=no` |
| em obras | `highway=construction` + `construction=cycleway` |

Pra interditar só um pedaço, **divida a way** no OSM e ponha a tag no pedaço.

O subconjunto de `opening_hours` que o site lê está descrito no topo do
`status.js`. O que ficar de fora (`sunrise-sunset`, `week`, …) vira cinza, com a
tag crua no balão: o site prefere dizer "não sei" a adivinhar. `PH` (feriado) é
ignorado com aviso. A tag `note` é texto livre: aparece no balão e não muda a cor.

Duas leituras que fogem da letra do wiki, de propósito:

1. `bicycle=designated` + `bicycle:conditional=yes @ (05:30-18:30)`, que é como
   a ciclovia está mapeada hoje, ao pé da letra não restringe nada. O site lê
   como "só nesse horário", que é o que se quis dizer.
2. Uma negação condicional **ativa** fecha o trecho mesmo vinda de tag menos
   específica (`temporary:access=no @ …` por cima de `bicycle=designated`).

## Pendências no OSM (em 21/09/2026)

- **Miguel Yunes → Pedreira não está mapeado** (~1,2 km). O site mostra o buraco
  em pontilhado cinza, com link pra mapear.
- A way [51388704](https://www.openstreetmap.org/way/51388704) (Jaguaré →
  Cebolão, 3,4 km) está **fora da relação** 2029967. Entra aqui pelo nome, mas
  o certo é incluí-la na relação.
- Todas as ways do eixo carregam `temporary:access=no @ (2021-08-18 - 2021-12-31)`,
  vencida e com data fora do padrão do `opening_hours`. Não atrapalha; pode sair.
- A way [841967007](https://www.openstreetmap.org/way/841967007) (Ciclovia dos
  Trabalhadores) tem o horário só na `note` ("07:00 às 19:00"): no mapa sai azul.
- As interdições do mapa da operadora (`assets/*.kmz`: obra do acesso Laguna,
  bloqueio na Ponte Jurubatuba, meia pista na Cidade Jardim) **não estão no
  OSM**, então não aparecem aqui. O KMZ fica no repositório só como referência
  pra quem for mapear; o site não o lê.

## Rodar localmente

```sh
python3 tools/fetch_osm.py      # atualiza data/ a partir do OSM
node test-status.mjs            # testes do classificador
python3 -m http.server 8000     # http://localhost:8000
```

`?agora=2026-09-21T22:00` simula um instante (hora de São Paulo), pra ver o
mapa à noite sem esperar anoitecer. `#way=51392253` abre o balão de um trecho.

O service worker só registra em HTTPS, então não atrapalha o desenvolvimento
local. **Mudou arquivo servido? Suba a `VERSION` no `sw.js`.** A rodada de
dados de 6 h não precisa: `data/*` é sempre buscado da rede primeiro.

## Licença

Código: GPL-3.0 (ver `LICENSE`). Dados: © contribuidores do OpenStreetMap, ODbL.
Leaflet (BSD-2) e IBM Plex Mono (OFL) vão vendorados em `lib/`.
