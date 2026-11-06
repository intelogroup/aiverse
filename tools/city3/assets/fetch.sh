#!/usr/bin/env bash
# Download the CC0 assets the City 3 interiors use (run from tools/city3/assets).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p polyhaven quaternius
(cd polyhaven && python3 ../fetch_polyhaven.py wooden_bookshelf_worn book_encyclopedia_set_01 desk_lamp_arm_01 \
  vintage_grandfather_clock_01 drawer_cabinet vintage_radio_transceiver WoodenTable_02 ArmChair_01 potted_plant_02 \
  wooden_crate_01 vintage_oil_lamp wall_clock binder_notebook)
if [ ! -d "quaternius/Furniture Pack by @Quaternius" ]; then
  curl -fsSL -o quaternius/pack.zip "https://opengameart.org/sites/default/files/Furniture%20Pack%20by%20%40Quaternius.zip"
  (cd quaternius && python3 -c "import zipfile; zipfile.ZipFile('pack.zip').extractall('.')")
fi
