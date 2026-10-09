// The canvas compositor.
//
// Two passes. The first composites one layer at a time into an offscreen accumulation texture,
// ping-ponging between two of them because a pass cannot read its own render target. The second
// draws that accumulation onto the swapchain with the checkerboard and the view transform.
//
// Blend maths works on **sRGB-encoded values, not linear light**, exactly as Photoshop and the
// reference app do, and `web/src/model/blend.ts` is the same maths in TypeScript. The mode numbers
// below are positions in `BLEND_MODES`; a test checks the two lists agree.

struct CompositeParams {
  // x, y: canvas size in pixels; z: layer opacity; w: blend mode index
  a: vec4f,
  // x, y: layer origin; z, w: layer size
  b: vec4f,
  // x: rotation in radians; y: flipX; z: flipY; w: 1 when a mask is bound
  c: vec4f,
  // x: 1 when sampling must be nearest; y, z: the source texture's own size in pixels, which is
  // what picks the mip level; w: unused
  d: vec4f,
};

/// One adjustment layer's settings, laid out as `vec4`s so the packing on the TypeScript side is a
/// `Float32Array.set` at fixed offsets rather than a struct-layout negotiation. `adjust.wgsl` reads
/// these fields; the two files are concatenated into one module.
struct AdjustParams {
  // x: kind index, y: opacity, z: canvas width, w: canvas height
  p0: vec4f,
  // exposure, offset, gamma, colorize
  p1: vec4f,
  // hue, saturation, lightness, unused
  p2: vec4f,
  // grain: amount, size, roughness, seed
  p3: vec4f,
  // noise: amount, gaussian, monochromatic, seed
  p4: vec4f,
  // blur: radius, direction x, direction y, 1 when the lookup table is used
  p5: vec4f,
  // black & white: reds, yellows, greens, cyans
  p6: vec4f,
  // black & white: blues, magentas, tint, tint hue
  p7: vec4f,
  // tint saturation, gradient reversed, preserve luminosity, unused
  p8: vec4f,
  // gradient map: shadows
  p9: vec4f,
  // gradient map: highlights
  p10: vec4f,
  // colour balance: shadows
  p11: vec4f,
  // colour balance: midtones
  p12: vec4f,
  // colour balance: highlights
  p13: vec4f,
  // x: 1 when the adjustment layer has a mask
  p14: vec4f,
};

struct DisplayParams {
  // x, y: screen size in pixels; z: zoom
  a: vec4f,
  // x, y: pan, in screen pixels
  b: vec4f,
  // x, y: canvas size in pixels
  c: vec4f,
};

// The two passes use different bind group indices so that one shader module can hold both: WGSL
// requires every (group, binding) pair to be declared once.
@group(0) @binding(0) var<uniform> displayParams: DisplayParams;
@group(0) @binding(1) var accumTex: texture_2d<f32>;

/// Mip generation. WebGPU has no automatic mip chain, so each level is a fullscreen pass reading
/// the level above it through a linear sampler.
///
/// A bilinear fetch at the centre of the four source texels a destination texel covers is exactly
/// that box average — the sampler does the reduction, and it costs one draw per level instead of the
/// 16 taps a hand-written box filter would. Without this every layer drawn smaller than its own
/// pixels was sampled at level 0 alone, which is a point sample of a shrinking image and shimmers:
/// the moiré a downscaled checkerboard shows is that, and no amount of linear filtering at level 0
/// removes it, because the information the filter needs is in the levels that were never built.
@group(3) @binding(0) var mipSource: texture_2d<f32>;
@group(3) @binding(1) var mipSampler: sampler;

@fragment
fn fs_mipgen(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  // Twice the destination pixel's position in the source's own coordinates: the destination has
  // half the texels, so one destination texel spans two source texels and the sample belongs
  // halfway between them. `frag.xy` is already a pixel centre, so this lands on the middle of the
  // two-by-two block rather than on its corner.
  let size = vec2f(textureDimensions(mipSource, 0));
  return textureSampleLevel(mipSource, mipSampler, frag.xy * 2.0 / size, 0.0);
}
@group(0) @binding(2) var displaySampler: sampler;

@group(1) @binding(0) var<uniform> params: CompositeParams;
@group(1) @binding(1) var srcTex: texture_2d<f32>;
@group(1) @binding(2) var dstTex: texture_2d<f32>;
@group(1) @binding(3) var maskTex: texture_2d<f32>;
@group(1) @binding(4) var linearSampler: sampler;
@group(1) @binding(5) var nearestSampler: sampler;

@group(2) @binding(0) var<uniform> adjust: AdjustParams;
@group(2) @binding(1) var adjustSource: texture_2d<f32>;
@group(2) @binding(2) var lutTex: texture_2d<f32>;
@group(2) @binding(3) var adjustSampler: sampler;
@group(2) @binding(4) var adjustMaskTex: texture_2d<f32>;

// MARK: - Blend helpers

fn lum(c: vec3f) -> f32 {
  return 0.3 * c.r + 0.59 * c.g + 0.11 * c.b;
}

fn sat(c: vec3f) -> f32 {
  return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
}

fn clip_color(c: vec3f) -> vec3f {
  let l = lum(c);
  let n = min(c.r, min(c.g, c.b));
  let x = max(c.r, max(c.g, c.b));
  var out = c;
  if (n < 0.0) {
    out = vec3f(l) + (out - vec3f(l)) * l / (l - n);
  }
  if (x > 1.0) {
    out = vec3f(l) + (out - vec3f(l)) * (1.0 - l) / (x - l);
  }
  return out;
}

fn set_lum(c: vec3f, l: f32) -> vec3f {
  return clip_color(c + vec3f(l - lum(c)));
}

fn set_sat(c: vec3f, s: f32) -> vec3f {
  let mn = min(c.r, min(c.g, c.b));
  let mx = max(c.r, max(c.g, c.b));
  if (mx - mn <= 0.0) {
    return vec3f(0.0);
  }
  let k = s / (mx - mn);
  return vec3f((c.r - mn) * k, (c.g - mn) * k, (c.b - mn) * k);
}

fn color_burn(cb: vec3f, cs: vec3f) -> vec3f {
  let burned = vec3f(1.0) - min(vec3f(1.0), (vec3f(1.0) - cb) / max(cs, vec3f(1e-6)));
  return select(burned, vec3f(0.0), cs <= vec3f(0.0));
}

fn color_dodge(cb: vec3f, cs: vec3f) -> vec3f {
  let dodged = min(vec3f(1.0), cb / max(vec3f(1.0) - cs, vec3f(1e-6)));
  return select(dodged, vec3f(1.0), cs >= vec3f(1.0));
}

fn hard_light(cb: vec3f, cs: vec3f) -> vec3f {
  let dark = 2.0 * cb * cs;
  let light = vec3f(1.0) - 2.0 * (vec3f(1.0) - cb) * (vec3f(1.0) - cs);
  return select(light, dark, cs <= vec3f(0.5));
}

fn soft_light(cb: vec3f, cs: vec3f) -> vec3f {
  let curve = select(sqrt(cb), ((16.0 * cb - 12.0) * cb + 4.0) * cb, cb <= vec3f(0.25));
  let dark = cb - (vec3f(1.0) - 2.0 * cs) * cb * (vec3f(1.0) - cb);
  let light = cb + (2.0 * cs - 1.0) * (curve - cb);
  return select(light, dark, cs <= vec3f(0.5));
}

fn vivid_light(cb: vec3f, cs: vec3f) -> vec3f {
  return select(color_dodge(cb, 2.0 * cs - 1.0), color_burn(cb, 2.0 * cs), cs <= vec3f(0.5));
}

fn pin_light(cb: vec3f, cs: vec3f) -> vec3f {
  return select(max(cb, 2.0 * cs - 1.0), min(cb, 2.0 * cs), cs <= vec3f(0.5));
}

fn divide(cb: vec3f, cs: vec3f) -> vec3f {
  let quotients = cb / max(cs, vec3f(1e-6));
  return select(quotients, vec3f(1.0), cs <= vec3f(0.0));
}

// MARK: - The blend function B(Cb, Cs)

fn blend(mode: u32, cb: vec3f, cs: vec3f) -> vec3f {
  switch mode {
    // 0. Normal
    case 0u: { return cs; }
    // 1. Darken
    case 1u: { return min(cb, cs); }
    // 2. Multiply
    case 2u: { return cb * cs; }
    // 3. Color Burn
    case 3u: { return color_burn(cb, cs); }
    // 4. Linear Burn
    case 4u: { return cb + cs - 1.0; }
    // 5. Lighten
    case 5u: { return max(cb, cs); }
    // 6. Screen
    case 6u: { return cb + cs - cb * cs; }
    // 7. Color Dodge
    case 7u: { return color_dodge(cb, cs); }
    // 8. Linear Dodge (Add)
    case 8u: { return cb + cs; }
    // 9. Overlay
    case 9u: { return hard_light(cs, cb); }
    // 10. Soft Light
    case 10u: { return soft_light(cb, cs); }
    // 11. Hard Light
    case 11u: { return hard_light(cb, cs); }
    // 12. Vivid Light
    case 12u: { return vivid_light(cb, cs); }
    // 13. Linear Light
    case 13u: { return cb + 2.0 * cs - 1.0; }
    // 14. Pin Light
    case 14u: { return pin_light(cb, cs); }
    // 15. Hard Mix
    case 15u: {
      return select(vec3f(0.0), vec3f(1.0), cb + 2.0 * cs - 1.0 >= vec3f(0.5));
    }
    // 16. Difference
    case 16u: { return abs(cb - cs); }
    // 17. Exclusion
    case 17u: { return cb + cs - 2.0 * cb * cs; }
    // 18. Subtract
    case 18u: { return cb - cs; }
    // 19. Divide
    case 19u: { return divide(cb, cs); }
    // 20. Hue
    case 20u: { return set_lum(set_sat(cs, sat(cb)), lum(cb)); }
    // 21. Saturation
    case 21u: { return set_lum(set_sat(cb, sat(cs)), lum(cb)); }
    // 22. Color
    case 22u: { return set_lum(cs, lum(cb)); }
    // 23. Luminosity
    case 23u: { return set_lum(cb, lum(cs)); }
    default: { return cs; }
  }
}

// MARK: - Passes

@vertex
fn vs_fullscreen(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  // One oversized triangle rather than two: no vertex buffer, no diagonal seam.
  var corners = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
  return vec4f(corners[index], 0.0, 1.0);
}

/// Composites one layer over `dstTex` and writes the whole canvas back out.
///
/// Pixels outside the layer return the backdrop unchanged, which is why the render target can be
/// cleared on every pass.
@fragment
fn fs_composite(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let dst = textureLoad(dstTex, vec2i(i32(frag.x), i32(frag.y)), 0);

  let opacity = params.a.z;
  let mode = u32(params.a.w);
  let origin = params.b.xy;
  let size = params.b.zw;
  let rotation = params.c.x;
  let flip_x = params.c.y;
  let flip_y = params.c.z;
  let has_mask = params.c.w;
  let nearest = params.d.x;

  // Canvas space has y pointing down, with the document's top-left at the origin, so a pixel's
  // centre is (x + 0.5, y + 0.5) and the layer's top-left corner maps to uv (0, 0).
  let centre = origin + size * 0.5;
  let delta = frag.xy - centre;
  let cos_r = cos(rotation);
  let sin_r = sin(rotation);
  let unrotated = vec2f(delta.x * cos_r + delta.y * sin_r, -delta.x * sin_r + delta.y * cos_r);

  var u = unrotated.x / max(size.x, 1e-6) * 2.0;
  var v = unrotated.y / max(size.y, 1e-6) * 2.0;
  if (flip_x > 0.5) { u = -u; }
  if (flip_y > 0.5) { v = -v; }

  var src = vec4f(0.0);
  var mask = 1.0;
  if (abs(u) <= 1.0 && abs(v) <= 1.0) {
    let uv = vec2f(u * 0.5 + 0.5, v * 0.5 + 0.5);
    if (nearest > 0.5) {
      // Nearest is for editing at 800% and beyond, where a document pixel is many screen pixels
      // and the whole point is to see it as it is rather than as an average of its neighbours.
      src = textureSampleLevel(srcTex, nearestSampler, uv, 0.0);
      if (has_mask > 0.5) { mask = textureSampleLevel(maskTex, nearestSampler, uv, 0.0).r; }
    } else {
      // Which level holds the detail a screen pixel can actually show: how many source texels this
      // layer pixel covers, as a power of two, clamped to the levels that were built. A layer drawn
      // at its own size or larger sits at level 0, so zooming in stays as crisp as it was.
      let source_size = max(params.d.yz, vec2f(1.0));
      let shrink = max(
        source_size.x / max(abs(size.x), 1e-6),
        source_size.y / max(abs(size.y), 1e-6),
      );
      let levels = log2(max(source_size.x, source_size.y));
      // Exactly level 0 when the layer is not being shrunk, rather than a hair above it: a level of
      // 0.001 blends in a thousandth of the level below, which is invisible but enough to move a
      // pixel by a byte and make an exact assertion look like a regression.
      let level = select(0.0, clamp(log2(shrink), 0.0, levels), shrink > 1.0);
      src = textureSampleLevel(srcTex, linearSampler, uv, level);
      if (has_mask > 0.5) { mask = textureSampleLevel(maskTex, linearSampler, uv, level).r; }
    }
  }

  let source_alpha = src.a * opacity * mask;
  if (source_alpha <= 0.0) { return dst; }

  let backdrop_alpha = dst.a;
  let cs = src.rgb;
  let cb = select(vec3f(0.0), dst.rgb / max(backdrop_alpha, 1e-6), backdrop_alpha > 0.0);
  let blended = blend(mode, cb, cs);

  // W3C source-over-with-blend, which is what Photoshop composites in sRGB.
  let out_alpha = source_alpha + backdrop_alpha * (1.0 - source_alpha);
  let out_rgb = source_alpha * (1.0 - backdrop_alpha) * cs
    + source_alpha * backdrop_alpha * blended
    + (1.0 - source_alpha) * backdrop_alpha * cb;
  return select(vec4f(0.0), vec4f(out_rgb, out_alpha), out_alpha > 0.0);
}

/// Draws the accumulation onto the screen: checkerboard first, then the document over it.
@fragment
fn fs_display(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let zoom = displayParams.a.z;
  let pan = displayParams.b.xy;
  let canvas = displayParams.c.xy;

  // The checkerboard is fixed in screen space, as Photoshop's is: zooming does not resize it.
  let cell = floor(frag.xy / 8.0);
  let odd = (i32(cell.x) + i32(cell.y)) & 1;
  var color = vec3f(select(0.92, 0.82, odd == 1));

  let document = (frag.xy - pan) / max(zoom, 1e-6);
  if (document.x >= 0.0 && document.y >= 0.0 && document.x < canvas.x && document.y < canvas.y) {
    // How many document pixels one screen pixel covers, as a power of two: the level holding the
    // detail the screen can actually show. Zoomed out to a quarter that is level 2, which is what
    // removes the moiré a single-level sample of a shrinking image shows; zoomed in it stays at
    // level 0, so nothing is softened that did not have to be.
    let shrink = max(1.0 / max(zoom, 1e-6), 1.0);
    let levels = log2(max(canvas.x, canvas.y));
    let level = select(0.0, clamp(log2(shrink), 0.0, levels), shrink > 1.0);
    let src = textureSampleLevel(accumTex, displaySampler, document / canvas, level);
    // The accumulation is premultiplied, so "over" is one multiply-add.
    color = src.rgb + color * (1.0 - src.a);
  }
  return vec4f(color, 1.0);
}
