// Adjustment layers.
//
// Appended to `compositor.wgsl` into one module, so the two files have to stay in the order the
// renderer concatenates them: `compositor.wgsl` declares `AdjustParams` and the group-2 bindings,
// this file uses them.
//
// The formulas are the reference app's, not approximations of them: a Levels black point or a
// Curves handle has to land where Photoshop puts it, or a project graded in one app looks wrong in
// the other. Levels, Curves, Exposure and Invert never reach this file as maths — the CPU bakes
// them into `lutTex`, and the shader does one interpolated fetch per channel.

/// sRGB-encoded values in, linear light out, and back.
fn to_linear(encoded: f32) -> f32 {
  return select(pow((encoded + 0.055) / 1.055, 2.4), encoded / 12.92, encoded <= 0.04045);
}

fn to_encoded(linear_value: f32) -> f32 {
  let v = clamp(linear_value, 0.0, 1.0);
  return select(1.055 * pow(v, 1.0 / 2.4) - 0.055, v * 12.92, v <= 0.0031308);
}

/// HSL, because that is the space Photoshop's Hue/Saturation works in.
fn rgb_to_hsl(c: vec3f) -> vec3f {
  let high = max(c.r, max(c.g, c.b));
  let low = min(c.r, min(c.g, c.b));
  let lightness = (high + low) * 0.5;
  let delta = high - low;
  if (delta <= 0.0) {
    return vec3f(0.0, 0.0, lightness);
  }
  let saturation = min(1.0, delta / max(1.0 - abs(2.0 * lightness - 1.0), 1e-6));
  var hue = 0.0;
  if (high == c.r) {
    hue = (c.g - c.b) / delta;
  } else if (high == c.g) {
    hue = (c.b - c.r) / delta + 2.0;
  } else {
    hue = (c.r - c.g) / delta + 4.0;
  }
  hue = hue * 60.0;
  if (hue < 0.0) {
    hue = hue + 360.0;
  }
  return vec3f(hue, saturation, lightness);
}

fn hue_to_rgb(p: f32, q: f32, t_in: f32) -> f32 {
  var t = t_in;
  if (t < 0.0) {
    t = t + 1.0;
  }
  if (t > 1.0) {
    t = t - 1.0;
  }
  if (t < 1.0 / 6.0) {
    return p + (q - p) * 6.0 * t;
  }
  if (t < 1.0 / 2.0) {
    return q;
  }
  if (t < 2.0 / 3.0) {
    return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
  }
  return p;
}

fn hsl_to_rgb(hsl: vec3f) -> vec3f {
  if (hsl.y <= 0.0) {
    return vec3f(hsl.z);
  }
  let q = select(hsl.z + hsl.y - hsl.z * hsl.y, hsl.z * (1.0 + hsl.y), hsl.z < 0.5);
  let p = 2.0 * hsl.z - q;
  let h = hsl.x / 360.0;
  return vec3f(hue_to_rgb(p, q, h + 1.0 / 3.0), hue_to_rgb(p, q, h), hue_to_rgb(p, q, h - 1.0 / 3.0));
}

/// Photoshop's Saturation: multiplicative both ways, so a neutral grey stays neutral.
fn adjusted_saturation(saturation: f32, amount_percent: f32) -> f32 {
  let amount = clamp(amount_percent / 100.0, -1.0, 1.0);
  if (amount <= 0.0) {
    return max(0.0, saturation * (1.0 + amount));
  }
  if (amount >= 1.0) {
    return select(1.0, 0.0, saturation <= 0.0);
  }
  return min(1.0, saturation / (1.0 - amount));
}

/// The reference's hash and its smooth value noise, so a grain pattern matches.
fn mix32(x_in: u32) -> u32 {
  var x = x_in;
  x = x ^ (x >> 16u);
  x = x * 0x7feb352du;
  x = x ^ (x >> 15u);
  x = x * 0x846ca68bu;
  x = x ^ (x >> 16u);
  return x;
}

fn lattice(ix: i32, iy: i32, seed: u32) -> f32 {
  let h = mix32((u32(ix) * 0x9e3779b1u) ^ mix32((u32(iy) * 0x85ebca77u) ^ seed));
  return f32(h & 0xffffu) / 65535.0 + f32(h >> 16u) / 65535.0 - 1.0;
}

fn grain_field(u: f32, v: f32, scale_in: f32, seed: u32) -> f32 {
  let scale = max(scale_in, 1e-3);
  let cell = floor(vec2f(u, v) / scale);
  var t = vec2f(u, v) / scale - cell;
  t = t * t * (3.0 - 2.0 * t);
  let ix = i32(cell.x);
  let iy = i32(cell.y);
  let n00 = lattice(ix, iy, seed);
  let n10 = lattice(ix + 1, iy, seed);
  let n01 = lattice(ix, iy + 1, seed);
  let n11 = lattice(ix + 1, iy + 1, seed);
  let top = n00 + (n10 - n00) * t.x;
  let bottom = n01 + (n11 - n01) * t.x;
  // Blending neighbouring lattice values narrows the spread; this restores roughly its range.
  return (top + (bottom - top) * t.y) * 1.6;
}

/// A value in -1..1 for a pixel and a seed, for Add Noise.
fn noise_at(pixel: vec2f, seed: u32) -> f32 {
  let h = mix32((u32(i32(pixel.x)) * 0x9e3779b1u) ^ mix32((u32(i32(pixel.y)) * 0x85ebca77u) ^ seed));
  return f32(h & 0xffffu) / 32767.5 - 1.0;
}

/// How much a tone belongs to the shadows, midtones and highlights. Three overlapping curves that
/// sum to about one, so a shift fades in and out rather than banding at a threshold.
fn tonal_weights(v: f32) -> vec3f {
  let a = 0.25;
  let b = 0.333;
  let scale = 0.7;
  let s = clamp((v - b) / -a + 0.5, 0.0, 1.0);
  let h = clamp((v + b - 1.0) / a + 0.5, 0.0, 1.0);
  let m1 = clamp((v - b) / a + 0.5, 0.0, 1.0);
  let m2 = clamp((v + b - 1.0) / -a + 0.5, 0.0, 1.0);
  return vec3f(s, m1 * m2, h) * scale;
}

/// The Black & White weight for the range a channel pair names.
fn bw_weight(index: i32) -> f32 {
  if (index == 0) { return adjust.p6.x; }
  if (index == 1) { return adjust.p6.y; }
  if (index == 2) { return adjust.p6.z; }
  if (index == 3) { return adjust.p6.w; }
  if (index == 4) { return adjust.p7.x; }
  return adjust.p7.y;
}

/// Black & White: a choice of how bright each family of colours becomes in grey, not a desaturation.
fn black_white(c: vec3f) -> vec3f {
  let mx = max(c.r, max(c.g, c.b));
  let mn = min(c.r, min(c.g, c.b));
  let md = c.r + c.g + c.b - mx - mn;

  var primary = 0;
  var secondary = 0;
  if (mx == c.r) {
    primary = 0;
    secondary = select(5, 1, c.g >= c.b);
  } else if (mx == c.g) {
    primary = 2;
    secondary = select(3, 1, c.r >= c.b);
  } else {
    primary = 4;
    secondary = select(5, 3, c.g >= c.r);
  }

  let gray = clamp(
    mn + (md - mn) * bw_weight(secondary) + (mx - md) * bw_weight(primary),
    0.0,
    1.0,
  );

  if (adjust.p7.z <= 0.5) {
    return vec3f(gray);
  }
  // Tint: the grey becomes the lightness of a colour at the chosen hue.
  let tint_saturation = clamp(adjust.p8.x / 100.0, 0.0, 1.0);
  if (tint_saturation <= 0.0) {
    return vec3f(gray);
  }
  let chroma = (1.0 - abs(2.0 * gray - 1.0)) * tint_saturation;
  var hp = adjust.p7.w - floor(adjust.p7.w / 360.0) * 360.0;
  hp = hp / 60.0;
  let x = chroma * (1.0 - abs(hp - 2.0 * floor(hp / 2.0) - 1.0));
  var rgb = vec3f(0.0);
  if (hp < 1.0) {
    rgb = vec3f(chroma, x, 0.0);
  } else if (hp < 2.0) {
    rgb = vec3f(x, chroma, 0.0);
  } else if (hp < 3.0) {
    rgb = vec3f(0.0, chroma, x);
  } else if (hp < 4.0) {
    rgb = vec3f(0.0, x, chroma);
  } else if (hp < 5.0) {
    rgb = vec3f(x, 0.0, chroma);
  } else {
    rgb = vec3f(chroma, 0.0, x);
  }
  let m = gray - chroma * 0.5;
  return clamp(rgb + vec3f(m), vec3f(0.0), vec3f(1.0));
}

fn color_balance(c: vec3f) -> vec3f {
  let before = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
  var out = c;
  let shadows = adjust.p11.xyz;
  let midtones = adjust.p12.xyz;
  let highlights = adjust.p13.xyz;
  for (var i = 0; i < 3; i = i + 1) {
    let value = out[i];
    let w = tonal_weights(value);
    let shift = shadows[i] * w.x + midtones[i] * w.y + highlights[i] * w.z;
    out[i] = clamp(value + shift, 0.0, 1.0);
  }
  if (adjust.p8.z > 0.5) {
    let after = 0.299 * out.r + 0.587 * out.g + 0.114 * out.b;
    if (after > 0.0001) {
      out = clamp(out * (before / after), vec3f(0.0), vec3f(1.0));
    }
  }
  return out;
}

/// One adjustment on an un-premultiplied sRGB colour.
///
/// The kinds are numbered by their position in `ADJUSTMENT_KINDS`, which the TypeScript side packs
/// into the uniform. A test checks this list against that one, because a drift here renders Levels
/// as Curves and says nothing:
///
/// 0 Hue/Saturation, 1 Levels, 2 Curves, 3 Exposure, 4 Gradient Map, 5 Grain,
/// 6 Invert, 7 Black & White, 8 Colour Balance, 9 Gaussian Blur, 10 Motion Blur, 11 Add Noise
///
/// 9 and 10 never reach the switch: they are the blur path above it.
fn adjust_color(c: vec3f, pixel: vec2f, uv: vec2f) -> vec3f {
  let kind = u32(adjust.p0.x);

  switch kind {
    // 0. Hue/Saturation
    case 0u: {      var hsl = rgb_to_hsl(c);
      if (adjust.p1.w > 0.5) {
        hsl = vec3f(adjust.p2.x, clamp(adjust.p2.y / 100.0, 0.0, 1.0), hsl.z);
        let amount = clamp(adjust.p2.z / 100.0, -1.0, 1.0);
        hsl.z = select(hsl.z * (1.0 + amount), hsl.z + (1.0 - hsl.z) * amount, amount >= 0.0);
      } else {
        hsl.x = (hsl.x + adjust.p2.x) - floor((hsl.x + adjust.p2.x) / 360.0) * 360.0;
        hsl.y = adjusted_saturation(hsl.y, adjust.p2.y);
        let amount = clamp(adjust.p2.z / 100.0, -1.0, 1.0);
        hsl.z = select(hsl.z * (1.0 + amount), hsl.z + (1.0 - hsl.z) * amount, amount >= 0.0);
      }
      return hsl_to_rgb(hsl);
    }
    // 1. Levels, 2. Curves, 3. Exposure, 6. Invert: a table the CPU built, interpolated between
    //    neighbouring entries so a shallow curve does not band.
    case 1u, 2u, 3u, 6u: {
      var out = vec3f(0.0);
      for (var channel = 0; channel < 3; channel = channel + 1) {
        let x = clamp(c[channel], 0.0, 1.0) * 255.0;
        let lo = i32(floor(x));
        let hi = min(lo + 1, 255);
        let low = textureLoad(lutTex, vec2i(lo, channel), 0).r;
        let high = textureLoad(lutTex, vec2i(hi, channel), 0).r;
        out[channel] = low + (high - low) * (x - f32(lo));
      }
      return clamp(out, vec3f(0.0), vec3f(1.0));
    }
    // 4. Gradient Map: brightness picks a colour between the two ends.
    case 4u: {
      var dark = adjust.p9.xyz;
      var light = adjust.p10.xyz;
      if (adjust.p8.y > 0.5) {
        let swap = dark;
        dark = light;
        light = swap;
      }
      let level = clamp(dot(c, vec3f(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
      return clamp(dark + (light - dark) * level, vec3f(0.0), vec3f(1.0));
    }
    // 5. Grain
    case 5u: {
      let amount = adjust.p3.x;
      if (amount <= 0.0) {
        return c;
      }
      let size = max(adjust.p3.y, 0.1);
      let rough = clamp(adjust.p3.z / 100.0, 0.0, 1.0);
      let seed = u32(adjust.p3.w);
      let fine_seed = mix32(seed ^ 0xa511e9b3u);
      let detail_size = max(0.5, size * 0.35);
      let broad = grain_field(uv.x, uv.y, size, seed);
      let fine = grain_field(uv.x, uv.y, detail_size, fine_seed);
      let noise = broad + (fine - broad) * rough;
      let strength = clamp(amount, 0.0, 100.0) / 100.0 * 0.35;
      let level = clamp(dot(c, vec3f(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
      // Film grain shows most in the midtones.
      let delta = noise * strength * (0.4 + 2.4 * level * (1.0 - level));
      return clamp(c + vec3f(delta), vec3f(0.0), vec3f(1.0));
    }
    // 7. Black & White
    case 7u: {
      return black_white(c);
    }
    // 8. Colour Balance
    case 8u: {
      return color_balance(c);
    }
    // 11. Add Noise
    case 11u: {
      let strength = clamp(adjust.p4.x, 0.0, 400.0) / 100.0 * 0.5;
      if (strength <= 0.0) {
        return c;
      }
      let seed = u32(adjust.p4.w);
      let gaussian = adjust.p4.y > 0.5;
      let monochromatic = adjust.p4.z > 0.5;
      if (monochromatic) {
        var n = noise_at(pixel, seed);
        if (gaussian) {
          n = n * abs(n);
        }
        return clamp(c + vec3f(n * strength), vec3f(0.0), vec3f(1.0));
      }
      var n = vec3f(
        noise_at(pixel, seed),
        noise_at(pixel, seed ^ 0x9e3779b9u),
        noise_at(pixel, seed ^ 0x85ebca6bu),
      );
      if (gaussian) {
        n = n * abs(n);
      }
      return clamp(c + n * strength, vec3f(0.0), vec3f(1.0));
    }
    default: {
      return c;
    }
  }
}

/// One adjustment layer's pass.
///
/// The accumulation is premultiplied and the adjustments are not, so it is un-premultiplied on the
/// way in and premultiplied again on the way out — which also keeps the operand order the same as
/// every other pixel routine here.
@fragment
fn fs_adjust(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let canvas = vec2f(adjust.p0.z, adjust.p0.w);
  let texel = vec2f(1.0) / max(canvas, vec2f(1.0));
  let radius = adjust.p5.x;
  let direction = vec2f(adjust.p5.y, adjust.p5.z);

  if (radius > 0.01 && (abs(direction.x) + abs(direction.y)) > 0.0) {
    // A fixed number of taps whose spacing grows with the radius: a 250-pixel Gaussian costs the
    // same as a 5-pixel one, which is the only way a live preview stays live.
    var total = vec4f(0.0);
    var weight_sum = 0.0;
    for (var i = -16; i <= 16; i = i + 1) {
      let offset = f32(i) * (radius / 16.0);
      let t = f32(i) / 16.0 * 3.0;
      let weight = exp(-0.5 * t * t);
      let uv = frag.xy * texel + direction * offset * texel;
      total = total + textureSampleLevel(adjustSource, adjustSampler, uv, 0.0) * weight;
      weight_sum = weight_sum + weight;
    }
    return total / max(weight_sum, 1e-6);
  }

  let src = textureLoad(adjustSource, vec2i(i32(frag.x), i32(frag.y)), 0);
  // The adjustment layer's own mask, if it has one: grey scales how much of the adjustment applies,
  // which is what makes a mask on an adjustment layer useful.
  var amount = adjust.p0.y;
  if (adjust.p14.x > 0.5) {
    amount = amount * textureLoad(adjustMaskTex, vec2i(i32(frag.x), i32(frag.y)), 0).r;
  }
  if (src.a <= 0.0 || amount <= 0.0) {
    return src;
  }
  let straight = src.rgb / src.a;
  let adjusted = adjust_color(straight, frag.xy, frag.xy * texel);
  let mixed = clamp(mix(straight, adjusted, amount), vec3f(0.0), vec3f(1.0));
  return vec4f(mixed * src.a, src.a);
}
