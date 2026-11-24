// Screen-space ambient occlusion for City 3 (desktop only). Without it houses, stalls and trees read as pasted onto the ground: no
// darkening where walls meet the lawn, under eaves or between stalls. N8AO (pmndrs) needs depth only; radius is in world metres.
// Through an EffectComposer three skips the renderer's tone mapping (it only tone-maps when drawing straight to the screen), so AgX
// moves into an effect. The stock ToneMapping effect also tone-mapped the sky dome, whose shader already writes display colour
// (the sky went washed grey-blue): SkyMaskedAgX leaves depth-1.0 pixels (the dome writes no depth) as they were drawn. The canvas's
// own MSAA does not reach the composer's buffers, so the composer multisamples (4x); SMAA instead left thin lines (the plaza's
// string-light cable, the fountain rim) dashed. A/B on desktop: no measurable fps cost (plaza 28 vs 30, cabin 23 vs 27).
import { useMemo } from "react";
import { EffectComposer, N8AO } from "@react-three/postprocessing";
import { BlendFunction, Effect, EffectAttribute } from "postprocessing";

/** `?postfx=0` turns it off (A/B checks). */
export const postFxWanted = (search: string) => new URLSearchParams(search).get("postfx") !== "0";

const FRAG = /* glsl */ `#include <tonemapping_pars_fragment>
vec3 srgbToLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  // sky: undo the composer's final sRGB encode so the dome's display colour comes out unchanged; everything else: AgX (exposure from the renderer)
  outputColor = depth >= 0.999999 ? vec4(srgbToLinear(inputColor.rgb), inputColor.a) : vec4(AgXToneMapping(inputColor.rgb), inputColor.a);
}`;

export class SkyMaskedAgX extends Effect {
  constructor() {
    super("SkyMaskedAgX", FRAG, { blendFunction: BlendFunction.SRC, attributes: EffectAttribute.DEPTH });
  }
}

export function PostFx({ halfRes = false }: { halfRes?: boolean }) {
  const tone = useMemo(() => new SkyMaskedAgX(), []);
  return (
    <EffectComposer multisampling={4}>
      <N8AO aoRadius={2.5} distanceFalloff={1} intensity={3} halfRes={halfRes} />
      <primitive object={tone} />
    </EffectComposer>
  );
}
