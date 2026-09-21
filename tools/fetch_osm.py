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
(timeout/erro vem com HTTP 200!), sem tronco, ou com o tronco encolhido → sai
com erro e o GeoJSON anterior fica intacto.
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

# Espelhos do Overpass, em ordem de tentativa.
ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
USER_AGENT = "cicloviapinheiros/1.0 (+https://ciclopinheiros.pedalhidrografi.co; github.com/pedalhidro/cicloviapinheiros)"

# O que entra no mapa. Relações:
#   2029967  Ciclovia do Rio Pinheiros (tronco + acessos, margem leste)
#   5245330  Ciclovia Rio Pinheiros - Margem Oeste (Parque Bruno Covas etc.)
#   5245324  Ciclopassarela da Marginal Pinheiros e Ciclovia de Ligação
# MAIS toda way com o nome da ciclovia dentro da caixa Cebolão ↔ Pedreira: o
# trecho Jaguaré → Cebolão (way 51388704) e vários acessos NÃO estão na relação,
# então só a relação não basta.
RELATIONS = {2029967: "trunk", 5245330: "west", 5245324: "link"}
BBOX = (-23.74, -46.78, -23.50, -46.65)  # sul, oeste, norte, leste
NAME_RE = r"Ciclovia (do )?Rio Pinheiros"

QUERY = f"""[out:json][timeout:60];
rel(id:{",".join(str(r) for r in RELATIONS)});
out body;
(
  way(r);
  way["name"~"{NAME_RE}",i]({",".join(str(v) for v in BBOX)});
);
out meta geom;
"""

TRUNK_NAME = re.compile(r"^Ciclovia (do )?Rio Pinheiros$", re.I)
ACCESS_NAME = re.compile(r"^Acesso\b", re.I)
WEST_NAME = re.compile(r"Margem Oeste", re.I)
LIFECYCLE = ("construction", "proposed", "planned", "disused", "abandoned")

# Encolheu mais que isso de uma rodada pra outra? Desconfia (resposta parcial
# do Overpass ou vandalismo) e não sobrescreve.
MIN_TRUNK_RATIO = 0.7
MIN_TRUNK_WAY_M = 500  # ver role_of


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


def is_path(tags):
    return "highway" in tags or any(f"{prefix}:highway" in tags for prefix in LIFECYCLE)


def role_of(way_id, tags, membership, length):
    """trunk = o eixo da margem leste; access = entradas; west/link = o resto."""
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
    role = membership.get(way_id, "link")
    return "access" if role == "trunk" else role  # membro sem nome da relação do tronco


def build_features(data):
    membership = {}
    for el in data["elements"]:
        if el["type"] == "relation":
            for member in el.get("members", []):
                if member["type"] == "way":
                    membership.setdefault(member["ref"], RELATIONS[el["id"]])

    features = {}
    for el in data["elements"]:
        if el["type"] != "way" or "geometry" not in el:
            continue
        tags = el.get("tags", {})
        if not is_path(tags):
            continue  # prédio/área que por acaso leva o nome da ciclovia
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
            },
            "geometry": {"type": "LineString", "coordinates": coords},
        }
    return [features[k] for k in sorted(features)]


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
        print(f"ok: {len(features)} trechos, tronco {new_trunk / 1000:.1f} km, "
              f"{'ATUALIZADO' if changed else 'sem mudança'} (OSM de {check['osm_base']})")
    except Exception as err:  # noqa: BLE001 — qualquer falha vira check.json + exit 1
        check["error"] = str(err)
        print(f"FALHOU: {err}", file=sys.stderr)
    write_json(CHECK, check)
    return 0 if check["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
