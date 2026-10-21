"""Optimize the canonical, complete office sets referenced by the frontend (Pillow)."""
import csv
import json
import re
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parents[1]
source = root / 'web/public/mpu-gandring-assets'
output = root / 'web/public/office-assets'
rows = {row['filename'][:-4]: row for row in csv.DictReader((source / 'mpu_gandring_assets_master.csv').open(encoding='utf-8-sig'))}
# These intact high-resolution cutouts match the new references and have no missing bundle props.
intact_sources = {
    'mg_prop_debate_table': '010_wooden-stool.png',
    'mg_prop_office_rug': '016_oval-plate.png',
    'mg_prop_floor_lamp': '013_lampshade_floor-lamp.png',
}
names = set()
for relative in ['web/src/components/Office.tsx', 'web/src/officeSets.ts', 'web/src/styles/office-v2.css']:
    content = (root / relative).read_text(encoding='utf-8')
    names.update(re.findall(r"['\"](mg_[A-Za-z0-9_-]+)['\"]", content))
    names.update(re.findall(r'/office-assets/([A-Za-z0-9_-]+)\.webp', content))
output.mkdir(exist_ok=True)
manifest = []
for name in sorted(names):
    row = rows[name]
    target = output / (name + '.webp')
    preferred = intact_sources.get(name)
    selected = preferred if preferred and (source / preferred).is_file() else row['relative_path']
    image = Image.open(source / selected).convert('RGBA')
    source_width, source_height = image.size
    if name == 'mg_env_floorboard_tile':
        # A repeating surface uses the interior wood grain, without the tile's illustrated rim.
        inset_x, inset_y = round(image.width * .12), round(image.height * .12)
        image = image.crop((inset_x, inset_y, image.width - inset_x, image.height - inset_y))
    image.thumbnail((800, 800), Image.Resampling.LANCZOS)
    image.save(target, 'WEBP', quality=90, method=6)
    manifest.append(dict(file=target.name, source=selected, referenceImage=row['reference_image'], referenceCrop=row['reference_crop'], sourceWidth=source_width, sourceHeight=source_height, bytes=target.stat().st_size))
for old in output.glob('*.webp'):
    if old.stem not in names:
        old.unlink()
(output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
print(f'{len(manifest)} canonical office assets, {sum(item["bytes"] for item in manifest):,} bytes')
