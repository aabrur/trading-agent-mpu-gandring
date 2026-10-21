# Trading Agent Mpu Gandring office assets

The owner supplied the six A–F batch sheets and both cartoon fight-cloud references. The canonical CSV now contains all 139 assets and six catalogs with their intended names, actual extracted dimensions, file sizes and source crop coordinates. `legacy_candidate_group` preserves the earlier segmented-file lookup only; the supplied reference images are authoritative.

The office uses six complete furniture bundles: lead desk, market workstation, research desk, strategy workbench, risk desk and execution terminal. The bookshelf is one stocked bundle; the coffee counter includes its espresso machine and plant; the keris includes its matching stand. Loose cups, a notebook and a succulent are placed separately on the centered table.

## Reproduce the runtime artwork

Python and Pillow are needed only when rebuilding artwork, not when running the app:

```sh
python scripts/extract-office-library.py
python scripts/prepare-office-assets.py
```

The first command extracts named PNGs into the ignored local authoring library and updates the CSV. The supplied JPEGs remain unchanged in `catalogs/`. Extraction removes border-connected matte pixels and trims the JPEG edge fringe. These JPEG references do not contain original editable layers or original alpha channels. Faint effects with baked checkerboard backgrounds remain reference material and are not shipped in the office.

The second command exports only the canonical assets used by the scene into `web/public/office-assets/` and records provenance in its manifest. When available, three intact, matching high-resolution local cutouts replace their smaller sheet crops: table `010_wooden-stool.png`, rug `016_oval-plate.png`, and floor lamp `013_lampshade_floor-lamp.png`. When those local cutouts are absent, the same supplied-sheet crops are used instead. The floor texture uses the interior of its supplied tile so illustrated outer edges do not repeat across the room.

Runtime output contains 32 WebPs totaling 330,178 bytes. Old numeric runtime images are removed. Production builds exclude the full authoring library, while the committed runtime images let a clone run without Python or the source exports.

The old exported review desk group `008` belongs to Risk; terminal group `009` belongs to Execution. The earlier inverse assignment is corrected. The new sheets also confirm the previously uncertain names and placements through explicit source cells rather than image-name guesses.
