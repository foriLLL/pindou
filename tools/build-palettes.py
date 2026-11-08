"""Trim pypindou's palettes.json (Apache-2.0, HansBug/pypindou) into public/palettes.json."""
import json, pathlib
here = pathlib.Path(__file__).parent
src = json.loads((here / "pypindou-palettes.json").read_text())
WANT = [  # (id, label, bead size mm)
    ("mard-221-alfonse-doudou", "MARD 221色（国内最常见）", 2.6),
    ("mard-291-github", "MARD 291色", 2.6),
    ("coco-291", "COCO 291色", 2.6),
    ("manman-278", "漫漫 278色", 2.6),
    ("panpan-289", "盼盼 289色", 2.6),
    ("mixiaowo-290", "咪小窝 290色", 2.6),
    ("artkal-c-197-official", "优肯 Artkal C 197色", 2.6),
    ("beadcolors-perler", "Perler 103色", 5.0),
    ("beadcolors-hama", "Hama Midi 92色", 5.0),
]
by_id = {p["id"]: p for p in src["palettes"]}
out = []
for pid, label, mm in WANT:
    p = by_id[pid]
    seen, colors = set(), []
    for c in p["colors"]:
        if c.get("unidentified") or c["hex"].upper() in seen:
            continue
        seen.add(c["hex"].upper())
        name = c["name"] if c["name"] != c["code"] else ""
        colors.append([c["code"], c["hex"].upper()] + ([name] if name else []))
    out.append({"id": pid, "label": label, "beadMm": mm, "colors": colors})
    print(pid, len(colors))
(here.parent / "public" / "palettes.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
