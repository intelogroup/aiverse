import { useEffect, useMemo } from "react";
import * as THREE from "three";
import type { Plate } from "./namePlates";
import { drawName } from "./SpeechBubble";

/** Same hue as --hud-energy: your agents are green on the plate and on the minimap. */
const MINE = "#5ee07a";

export function NamePlate({ text, mine }: Plate) {
  const map = useMemo(() => new THREE.CanvasTexture(drawName(text, mine ? MINE : "#fff")), [text, mine]);
  useEffect(() => () => map.dispose(), [map]);
  return (
    <sprite name={`plate:${text}`} scale={[1.8, 0.338, 1]} renderOrder={20}>
      <spriteMaterial map={map} transparent depthWrite={false} toneMapped={false} />
    </sprite>
  );
}
