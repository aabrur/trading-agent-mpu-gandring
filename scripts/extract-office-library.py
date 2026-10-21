"""Extract the owner's supplied batch sheets without changing the original artwork.

Requires Pillow. Source JPEGs are retained under docs/office-assets/catalogs.
The extracted PNG library is ignored; the shipped WebPs are prepared separately.
"""
import csv
from collections import deque
from pathlib import Path

from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
CATALOGS = ROOT / 'docs/office-assets/catalogs'
LIBRARY = ROOT / 'web/public/mpu-gandring-assets'
INDEX = ROOT / 'docs/office-assets/mpu_gandring_assets_master.csv'

# Cell order is read directly from the supplied sheets, not guessed from old filenames.
SHEETS = {
    'A': (5, 4, 'prop', '''lead_desk market_workstation research_desk strategy_workbench risk_desk
        execution_terminal debate_table bookshelf coffee_counter whiteboard
        floor_lamp desk_lamp window_frame wall_clock office_rug
        plant_floor plant_succulent plant_hanging plant_desktop'''.split()),
    'B': (7, 4, 'item', '''leadership_journal keris_ornament analyst_headset market_tablet research_newspaper reading_glasses strategy_notebook
        pencil_marker_set approval_stamp order_clipboard execution_stopwatch trading_ticket coffee_mug_terracotta coffee_mug_sage
        coffee_mug_dustyblue espresso_machine analysis_papers desk_calendar desk_organizer ticket_tray cactus_ornament
        rolled_chart bookmarks desk_bell picture_frame soft_cushion desk_lantern token_medallion'''.split()),
    'C': (6, 4, 'icon', '''long short open_position close_position buy sell
        market_chart trend_analysis research strategy risk_review execution
        wallet portfolio profit loss report learning
        debate alert settings auto_trading pause market_scan'''.split()),
    'D': (5, 4, 'ui', '''card_frame_primary panel_secondary modal_frame button_cream button_teal
        button_coral button_gold input_field tab_base badge_chip
        avatar_frame progress_track progress_fill tooltip_frame toast_frame
        nav_strip header_bar divider_line empty_state_panel'''.split()),
    'E': (6, 4, 'fx', '''thinking_sparkles analyze_glow_ring profit_sparkles loss_particles coffee_steam debate_energy
        execution_flash alert_pulse_rings selection_ring busy_spinner celebration_confetti research_glow
        chart_rise_trail ground_shadow floor_highlight activity_bubble connection_line status_dots
        success_check loading_dots risk_pulse ambient_dust trade_token'''.split()),
    'F': (6, 4, 'env', '''wallpaper_panel floorboard_tile baseboard corner_trim curtain window_view
        light_shaft door wall_sconce ceiling_beam pendant_lamp picture_frame
        wall_molding half_wall vignette floating_shelf wall_outlet archway
        leaf_shadow view_fill floor_plank lamp_glow accent_plant'''.split()),
}


def cutout(image, tolerance=18):
    """Remove only border-connected matte pixels; keep enclosed cream/white details."""
    image = image.convert('RGBA')
    pixels = image.load()
    width, height = image.size
    background = pixels[0, 0][:3]
    visited = bytearray(width * height)
    pending = deque()

    def add(x, y):
        index = y * width + x
        if visited[index]:
            return
        visited[index] = 1
        color = pixels[x, y][:3]
        if max(abs(color[c] - background[c]) for c in range(3)) <= tolerance:
            pixels[x, y] = (*color, 0)
            pending.append((x, y))

    for x in range(width):
        add(x, 0)
        add(x, height - 1)
    for y in range(height):
        add(0, y)
        add(width - 1, y)
    while pending:
        x, y = pending.popleft()
        for next_x, next_y in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= next_x < width and 0 <= next_y < height:
                add(next_x, next_y)
    bounds = image.getbbox()
    if bounds is None:
        raise ValueError('An asset cell contains no visible artwork')
    return image.crop(bounds), bounds


def main():
    rows = list(csv.DictReader(INDEX.open(encoding='utf-8-sig')))
    by_name = {row['filename']: row for row in rows}
    evidence = {}
    for batch, (columns, lines, prefix, names) in SHEETS.items():
        sheet_name = f'mg_batch_{batch.lower()}_catalog'
        image = Image.open(CATALOGS / (sheet_name + '.jpg')).convert('RGB')
        directory = LIBRARY / ('mg_batch_' + batch.lower())
        directory.mkdir(exist_ok=True)
        image.save(directory / (sheet_name + '.png'))
        evidence[sheet_name + '.png'] = (directory / (sheet_name + '.png'), sheet_name + '.jpg', '', 'supplied_catalog')
        for index, name in enumerate(names):
            x, y = index % columns, index // columns
            box = (round(x * image.width / columns), round(y * image.height / lines),
                   round((x + 1) * image.width / columns), round((y + 1) * image.height / lines))
            try:
                asset, _ = cutout(image.crop(box), 2 if name == 'ambient_dust' else 18)
            except ValueError as error:
                raise ValueError(f'{batch}/{name}: {error}') from error
            filename = f'mg_{prefix}_{name}.png'
            if batch in ['A', 'B', 'F']:
                # Trim the one-pixel JPEG matte fringe; interior artwork stays untouched.
                asset.putalpha(asset.getchannel('A').filter(ImageFilter.MinFilter(3)))
            target = directory / filename
            asset.save(target)
            evidence[filename] = (target, sheet_name + '.jpg', ','.join(map(str, box)), 'extracted_from_supplied_sheet')

    for kind in ['soft', 'brawl']:
        filename = f'mg_fx_fight_smoke_{kind}.png'
        image, _ = cutout(Image.open(CATALOGS / filename.replace('.png', '.jpg')))
        target = LIBRARY / 'mg_batch_e' / filename
        image.save(target)
        evidence[filename] = (target, filename.replace('.png', '.jpg'), '', 'extracted_from_supplied_image')

    # The reference sheet supplies track and fill separately. Keep the combined variant explicit.
    target = LIBRARY / 'mg_batch_d/mg_ui_progress_combo.png'
    Image.open(LIBRARY / 'mg_batch_d/mg_ui_progress_fill.png').save(target)
    evidence[target.name] = (target, 'mg_batch_d_catalog.jpg', '384,384,576,576', 'derived_combined_reference')
    assert set(evidence) == set(by_name), (set(by_name) - set(evidence), set(evidence) - set(by_name))
    fields = [key for key in rows[0] if key not in ['source_files', 'notes', 'reference_image', 'reference_crop']]
    fields += ['reference_image', 'reference_crop', 'notes']
    for row in rows:
        target, reference, crop, status = evidence[row['filename']]
        image = Image.open(target)
        row.update(relative_path=target.relative_to(LIBRARY).as_posix(), width=image.width,
                   height=image.height, mode=image.mode, size_kb=round(target.stat().st_size / 1024, 1),
                   match_status=status, reference_image=reference, reference_crop=crop,
                   notes='Dimensions describe the extracted artwork, not the unavailable 1408px original.')
        row.pop('source_files', None)
    for target in [INDEX, LIBRARY / 'mpu_gandring_assets_master.csv']:
        with target.open('w', encoding='utf-8', newline='') as output:
            writer = csv.DictWriter(output, fieldnames=fields)
            writer.writeheader()
            writer.writerows(rows)
    print(f'Extracted {len(evidence)} records: 139 assets and 6 catalogs.')


if __name__ == '__main__':
    main()
