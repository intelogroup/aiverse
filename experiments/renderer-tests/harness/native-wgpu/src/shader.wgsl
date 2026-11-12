struct U { vp: mat4x4<f32> };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var tb: texture_2d<f32>;
@group(0) @binding(2) var tn: texture_2d<f32>;
@group(0) @binding(3) var tm: texture_2d<f32>;
@group(0) @binding(4) var s: sampler;
struct VO { @builtin(position) p: vec4<f32>, @location(0) w: vec3<f32>, @location(1) n: vec3<f32>, @location(2) uv: vec2<f32> };
@vertex fn vs(@location(0) pos: vec3<f32>, @location(1) nrm: vec3<f32>, @location(2) uv: vec2<f32>) -> VO {
  var o: VO; o.p = u.vp * vec4(pos,1.0); o.w = pos; o.n = nrm; o.uv = uv; return o; }
@fragment fn fs(i: VO) -> @location(0) vec4<f32> {
  let albedo = textureSample(tb, s, i.uv).rgb;
  let mr = textureSample(tm, s, i.uv);
  let metal = mr.b;
  var n = normalize(i.n);
  let dp1 = dpdx(i.w); let dp2 = dpdy(i.w); let du1 = dpdx(i.uv); let du2 = dpdy(i.uv);
  let dp2p = cross(dp2, n); let dp1p = cross(n, dp1);
  let T = dp2p * du1.x + dp1p * du2.x; let B = dp2p * du1.y + dp1p * du2.y;
  let inv = inverseSqrt(max(dot(T,T), dot(B,B)));
  let m = textureSample(tn, s, i.uv).xyz * 2.0 - 1.0;
  n = normalize(mat3x3(T*inv, B*inv, n) * m);
  let l = normalize(vec3(2.0,3.0,4.0));
  let hw = 0.5*n.y + 0.5;
  let hemi = mix(vec3(0.0578,0.0578,0.0908), vec3(1.0), hw) * 2.2;
  let dir = vec3(2.5) * max(dot(n,l), 0.0);
  let c = albedo * (1.0 - metal) * (hemi + dir) / 3.14159265;
  return vec4(c, 1.0);
}
