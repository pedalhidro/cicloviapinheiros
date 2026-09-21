#!/usr/bin/env python3
"""Baixa a Ciclovia do Rio Pinheiros do OpenStreetMap (Overpass) e grava
`data/ciclovia.geojson` + `data/check.json`.

Roda a cada 6 h no GitHub Actions (.github/workflows/site.yml) e à mão:

    python3 tools/fetch_osm.py

Só biblioteca padrão. O OSM é a fonte da verdade: este script NÃO interpreta
horário nem interdição — copia as tags cruas; quem classifica é o `status.js`,
no navegador, com o relógio de quem visita.

Dois arquivos, de propósito:
  * `ciclovia.geojson` só é reescrito quando as FEIÇÕES mudam, então o
    histórico do git vira o registro de quando o OSM mudou (`changed_at`).
  * `check.json` diz quando foi a última verificação e se deu certo. É
    gitignored: o workflow publica sem commitar.

Um Overpass ruim nunca pode apagar um retrato bom: resposta com `remark`
(timeout/erro vem com HTTP 200!), de espelho ATRASADO, sem tronco, ou com o
tronco encolhido → sai com erro e o GeoJSON anterior fica intacto.
"""

import json
import math
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GEOJSON = ROOT / "data" / "ciclovia.geojson"
CHECK = ROOT / "data" / "check.json"

# Instâncias do Overpass, em ordem de tentativa. Conferidas em 2026-09-21 com um
# nó editado minutos antes: as três primeiras estavam em dia; private.coffee e
# kumi.systems respondiam 200 com OSM de 2 a 4 meses atrás (ver MAX_LAG_H), e
# ficam no fim da fila só pro dia em que voltarem a se atualizar.
ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.openstreetmap.fr/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
USER_AGENT = "cicloviapinheiros/1.0 (+https://ciclopinheiros.pedalhidrografi.co; github.com/pedalhidro/cicloviapinheiros)"

# O que entra no mapa. Relações:
#   2029967  Ciclovia do Rio Pinheiros (tronco + acessos, margem leste)
#   5245330  Ciclovia Rio Pinheiros - Margem Oeste (Parque Bruno Covas etc.)
# (A 5245324, "Ciclopassarela da Marginal Pinheiros e Ciclovia de Ligação", saiu:
# tirando a rua e a way 218402980 — ver EXCLUDE_WAYS — sobravam tocos de 2, 3 e
# 30 m. O que dela encosta no rio continua entrando pelo corredor.)
# MAIS toda way com o nome da ciclovia dentro da caixa Cebolão ↔ Pedreira: o
# trecho Jaguaré → Cebolão (way 51388704) e vários acessos NÃO estão na relação,
# então só a relação não basta.
# MAIS o corredor do rio: toda ciclovia, e todo caminho de pedestre com
# `bicycle` liberado, a até CORRIDOR_M do eixo do Rio Pinheiros. É por aqui que
# entram as passarelas flutuantes, a Erika Sallum, a Ponte Laguna e as estradas
# de terra da beira-rio (Parque Jurubatuba, a margem oposta até o Cebolão) —
# nada disso é membro de relação nem leva o nome da ciclovia. Pra um caminho
# novo aparecer no mapa, basta ele ser `highway=cycleway` na beira do rio.
RELATIONS = {2029967: "trunk", 5245330: "west"}

# Curadoria do Danilo (2026-09-21): caminhos que o corredor do rio pega mas que
# NÃO fazem parte deste mapa — a continuação do acesso do Parque do Povo pro lado
# da cidade (rumo à Faria Lima), a calçada em volta do parque e a Passarela dos
# Estudantes. Nenhuma tag os separa das ligações que ficam, então é lista mesmo.
# O que só se ligava ao mapa através deles cai sozinho na poda (prune_loose).
# Pra tirar mais um: acrescente o id aqui. Pra voltar atrás: apague a linha.
EXCLUDE_WAYS = {
    419504676,   # ciclovia de 183 m na altura da Cidade Jardim (lado da cidade)
    228077212,   # calçada de 32 m ligada à de cima
    172413614,   # calçada de 973 m em volta do Parque do Povo
    218402980,   # "Ciclovia de Ligação", 372 m (era da relação 5245324)
    1395347292,  # 93 m entre o acesso do Parque do Povo e a ligação
    228078144,   # Passarela dos Estudantes (Cidade Universitária)
}
BBOX = (-23.715, -46.78, -23.50, -46.65)  # sul (logo abaixo de Pedreira), oeste, norte, leste
NAME_RE = r"Ciclovia (do )?Rio Pinheiros"
CORRIDOR_M = 150  # o rio tem ~90 m de largura; as pistas ficam no topo do talude
# Do Guarapiranga pra cima (rumo a Pedreira) o mesmo canal se chama, no OSM,
# "Rio Grande (Jurubatuba-Açú)" — o nome antigo do alto Pinheiros. Sem ele o
# corredor para em Santo Amaro e a Estrada do Parque Jurubatuba fica de fora.
RIVER_RE = "Pinheiros|Jurubatuba"
_BBOX = ",".join(str(v) for v in BBOX)

# Os candidatos do corredor saem primeiro da CAIXA (barato, por índice) e só
# depois passam pelo `around` (caro): com o `around` direto o Overpass dava 504
# nas horas cheias. No fim, os nós com `barrier` que estão EM CIMA dos caminhos
# escolhidos: portão fechado isola o que fica atrás dele (ver status.js).
QUERY = f"""[out:json][timeout:90];
rel(id:{",".join(str(r) for r in RELATIONS)})->.rels;
.rels out body;
way["waterway"~"^(river|canal)$"]["name"~"{RIVER_RE}",i]({_BBOX})->.rio;
(
  way["highway"="cycleway"]({_BBOX});
  way["highway"~"^(footway|path|pedestrian|steps)$"]["bicycle"~"^(yes|designated|dismount|permissive)$"]({_BBOX});
)->.cand;
(
  way(r.rels);
  way["name"~"{NAME_RE}",i]({_BBOX});
  way.cand(around.rio:{CORRIDOR_M});
)->.sel;
.sel out meta geom;
node(w.sel)["barrier"];
out meta;
"""

TRUNK_NAME = re.compile(r"^Ciclovia (do )?Rio Pinheiros$", re.I)
ACCESS_NAME = re.compile(r"^Acesso\b", re.I)
WEST_NAME = re.compile(r"Margem Oeste|Parque Bruno Covas", re.I)
LIFECYCLE = ("construction", "proposed", "planned", "disused", "abandoned")

# Encolheu mais que isso de uma rodada pra outra? Desconfia (resposta parcial
# do Overpass ou vandalismo) e não sobrescreve.
MIN_TRUNK_RATIO = 0.7
MIN_TRUNK_WAY_M = 500  # ver role_of
MIN_RIVERSIDE_M = 500  # ver role_of

# "Tirar os caminhos pequenos que não ligam na ciclovia" (Danilo, 2026-09-21): o
# corredor do rio traz dezenas de calçadas soltas. Fica o componente conexo (por
# nó compartilhado) que tem algum caminho escolhido DE PROPÓSITO (relação ou
# nome), e o solto só se for comprido (as estradas de terra da outra margem).
MIN_LOOSE_COMPONENT_M = 1000

# Barreira só importa aqui se disser algo sobre passagem. Portão sem tag nenhuma
# não conta como fechado nem como aberto: não vira feição.
GATE_KEYS = re.compile(r"^(access|vehicle|bicycle|foot|opening_hours)$|:conditional$|^temporary:")

# Espelho do Overpass pode estar MESES atrasado e responder 200 como se nada
# (overpass.private.coffee devolveu dado de 2026-05-06 em 2026-09-21). Aceitar
# isso no fallback desfaria uma interdição recém-mapeada. O servidor principal
# costuma estar a minutos do OSM; um dia de folga cobre manutenção.
MAX_LAG_H = 24


def overpass(query):
    body = urllib.parse.urlencode({"data": query}).encode()
    errors = []
    for attempt in range(2):
        for url in ENDPOINTS:
            req = urllib.request.Request(url, data=body, headers={"User-Agent": USER_AGENT})
            try:
                with urllib.request.urlopen(req, timeout=120) as res:
                    data = json.load(res)
            except (urllib.error.URLError, TimeoutError, ValueError, OSError) as err:
                errors.append(f"{url}: {err}")
                continue
            if data.get("remark"):
                errors.append(f"{url}: remark: {data['remark']}")
                continue
            base = data.get("osm3s", {}).get("timestamp_osm_base", "")
            try:
                lag_h = (datetime.now(timezone.utc) - datetime.fromisoformat(base.replace("Z", "+00:00"))).total_seconds() / 3600
            except ValueError:
                errors.append(f"{url}: sem timestamp_osm_base")
                continue
            if lag_h > MAX_LAG_H:
                errors.append(f"{url}: espelho atrasado, OSM de {base} ({lag_h:.0f} h)")
                continue
            return data, url
        if attempt == 0:
            time.sleep(20)
    raise RuntimeError("todos os espelhos do Overpass falharam:\n  " + "\n  ".join(errors))


def length_m(coords):
    total = 0.0
    for (lon1, lat1), (lon2, lat2) in zip(coords, coords[1:]):
        p1, p2 = math.radians(lat1), math.radians(lat2)
        a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
        total += 2 * 6371008.8 * math.asin(math.sqrt(a))
    return total


# Este é um mapa de caminhos, não de ruas: rua com ciclofaixa que é membro de
# relação (Rua Professor Artur Ramos, way 337854406, `tertiary`) fica de fora —
# pedido do Danilo, 2026-09-21.
PATH_HIGHWAYS = {"cycleway", "footway", "path", "pedestrian", "steps", "track", "bridleway"}


def is_path(tags):
    highway = tags.get("highway")
    if highway in PATH_HIGHWAYS:
        return True
    if highway in LIFECYCLE:  # highway=construction + construction=cycleway
        return tags.get(highway, "cycleway") in PATH_HIGHWAYS
    return any(tags.get(f"{prefix}:highway") in PATH_HIGHWAYS for prefix in LIFECYCLE)


def role_of(way_id, tags, membership, length):
    """trunk = o eixo da margem leste; access = entradas; west = a relação da
    margem oeste; riverside = beira-rio fora das relações; link = o resto."""
    name = tags.get("name", "")
    if WEST_NAME.search(name):
        return "west"
    if ACCESS_NAME.search(name):
        return "access"
    if TRUNK_NAME.match(name):
        # Os ramais da passarela do Parque do Povo (ways 448326478/1126024464,
        # ~150 m, sem horário) levam o nome do tronco sem ser tronco — contados
        # ali, o resumo ganharia "0,3 km aberta 24 h". Tronco de verdade ou é
        # membro da relação, ou é comprido (Jaguaré → Cebolão tem 3,4 km).
        if membership.get(way_id) == "trunk" or length >= MIN_TRUNK_WAY_M:
            return "trunk"
        return "access"
    if way_id in membership:
        role = membership[way_id]
        return "access" if role == "trunk" else role  # membro sem nome da relação do tronco
    # Só o corredor do rio trouxe: caminho comprido é beira-rio por conta própria
    # (estrada de terra do Parque Jurubatuba…); toco curto é ligação/passarela.
    if tags.get("highway") == "cycleway" and length >= MIN_RIVERSIDE_M:
        return "riverside"
    return "link"


def build_features(data):
    membership = {}
    for el in data["elements"]:
        if el["type"] == "relation":
            for member in el.get("members", []):
                if member["type"] == "way":
                    membership.setdefault(member["ref"], RELATIONS[el["id"]])

    features = {}
    chosen = set()  # escolhidos de propósito: membro de relação ou nome da ciclovia
    for el in data["elements"]:
        if el["type"] != "way" or "geometry" not in el:
            continue
        tags = el.get("tags", {})
        if not is_path(tags):
            continue  # rua, ou prédio/área que por acaso leva o nome da ciclovia
        if el["id"] in EXCLUDE_WAYS:
            continue
        if el["id"] in membership or re.search(NAME_RE, tags.get("name", ""), re.I):
            chosen.add(el["id"])
        coords = [[round(p["lon"], 7), round(p["lat"], 7)] for p in el["geometry"]]
        length = round(length_m(coords))
        features[el["id"]] = {
            "type": "Feature",
            "id": f"way/{el['id']}",
            "properties": {
                "way": el["id"],
                "role": role_of(el["id"], tags, membership, length),
                "length_m": length,
                "edited_at": el.get("timestamp"),
                "tags": dict(sorted(tags.items())),
                # ids dos nós, na ordem das coordenadas: é por nó compartilhado que
                # o app sabe o que liga no quê (e onde fica cada portão)
                "nodes": el["nodes"],
            },
            "geometry": {"type": "LineString", "coordinates": coords},
        }

    kept = prune_loose(features, chosen)
    on_kept = {node for way in kept for node in features[way]["properties"]["nodes"]}
    gates = {}
    for el in data["elements"]:
        tags = el.get("tags", {})
        if el["type"] != "node" or "barrier" not in tags or el["id"] not in on_kept:
            continue
        if not any(GATE_KEYS.search(key) for key in tags):
            continue
        gates[el["id"]] = {
            "type": "Feature",
            "id": f"node/{el['id']}",
            "properties": {"node": el["id"], "role": "gate", "edited_at": el.get("timestamp"),
                           "tags": dict(sorted(tags.items()))},
            "geometry": {"type": "Point", "coordinates": [round(el["lon"], 7), round(el["lat"], 7)]},
        }
    return [features[k] for k in sorted(kept)] + [gates[k] for k in sorted(gates)]


def prune_loose(features, chosen):
    """Ids dos caminhos que ficam: ver MIN_LOOSE_COMPONENT_M."""
    parent = {way: way for way in features}

    def find(way):
        while parent[way] != way:
            parent[way] = parent[parent[way]]
            way = parent[way]
        return way

    seen = {}
    for way, feature in features.items():
        for node in feature["properties"]["nodes"]:
            if node in seen:
                parent[find(way)] = find(seen[node])
            else:
                seen[node] = way

    components = {}
    for way in features:
        components.setdefault(find(way), []).append(way)
    kept = set()
    for ways in components.values():
        total = sum(features[w]["properties"]["length_m"] for w in ways)
        if chosen.intersection(ways) or total >= MIN_LOOSE_COMPONENT_M:
            kept.update(ways)
    return kept


def trunk_m(features):
    return sum(f["properties"]["length_m"] for f in features if f["properties"]["role"] == "trunk")


def write_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    tmp.replace(path)


def main():
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    check = {"checked_at": now, "ok": False}
    try:
        data, endpoint = overpass(QUERY)
        features = build_features(data)
        new_trunk = trunk_m(features)
        if not new_trunk:
            raise RuntimeError("a resposta não tem nenhum trecho do tronco")

        previous = json.loads(GEOJSON.read_text(encoding="utf-8")) if GEOJSON.exists() else None
        if previous and "--force" not in sys.argv:
            old_trunk = trunk_m(previous["features"])
            if new_trunk < MIN_TRUNK_RATIO * old_trunk:
                raise RuntimeError(
                    f"tronco encolheu de {old_trunk} m pra {new_trunk} m; se for de verdade, rode com --force"
                )

        changed = not previous or previous["features"] != features
        if changed:
            write_json(GEOJSON, {
                "type": "FeatureCollection",
                "meta": {
                    "changed_at": now,
                    "attribution": "© OpenStreetMap contributors (ODbL)",
                    "source": "Overpass API",
                    "query": QUERY,
                },
                "features": features,
            })
        check.update(ok=True, changed=changed, endpoint=endpoint,
                     osm_base=data.get("osm3s", {}).get("timestamp_osm_base"))
        print(f"ok: {sum(f['properties']['role'] != 'gate' for f in features)} trechos, "
              f"{sum(f['properties']['role'] == 'gate' for f in features)} portões, tronco {new_trunk / 1000:.1f} km, "
              f"{'ATUALIZADO' if changed else 'sem mudança'} (OSM de {check['osm_base']})")
    except Exception as err:  # noqa: BLE001 — qualquer falha vira check.json + exit 1
        check["error"] = str(err)
        print(f"FALHOU: {err}", file=sys.stderr)
    write_json(CHECK, check)
    return 0 if check["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
