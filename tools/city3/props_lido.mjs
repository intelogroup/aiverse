// Lido furniture (deck x 12..58, z 72..122; pool x 20..50, z 90..104 with a 0.5 m coping; deck top y 0.28, bridge_bazaar_open_space.py).
// Both long sides: lounger, parasol, lounger groups every 4.6 m, feet toward the water. Pool ends: striped deck chairs facing the water
// (the deck chair model faces local -z, the lounger's feet point +z).
//   bun tools/city3/props_lido.mjs        (models in ~/Developer/city3-downloads, credits in ASSETS.md)
import { homedir } from "node:os";
import { placeProps } from "./place_props.mjs";

const D = `${homedir()}/Developer/city3-downloads`;
const SOUTH = 87.6, NORTH = 106.4;   // lounger centres: 2.24 m long, feet 0.8 m short of the coping
const groups = [0, 1, 2, 3, 4, 5].map((g) => 22 + 4.6 * g);
const loungers = groups.flatMap((x) => [x, x + 2.5]).flatMap((x) => [[x, SOUTH, 0], [x, NORTH, 180]]);
const parasols = groups.flatMap((x) => [[x + 1.25, SOUTH, 0], [x + 1.25, NORTH, 0]]);
const chairs = [93, 96, 99, 102].flatMap((z) => [[17.4, z, 270], [52.6, z, 90]]);

await placeProps({
  id: "lido", name: "Lido furniture", center: [35, 97], half: 30, y: 0.28,
  props: [
    { name: "lounger", src: `${D}/sun-lounger/model.glb`, scale: 0.01, col: [0.41, 1.12, 0.45], at: loungers },
    { name: "parasol", src: `${D}/patio-umbrella/model.glb`, scale: 1, col: [0.08, 0.08, 2.6], at: parasols },
    { name: "deckchair", src: `${D}/sunchair/model.glb`, scale: 1, col: [0.6, 0.48, 0.9], at: chairs },
  ],
});
