[简体中文](README.md) · **English**

---

# VehicleOrbit

A **Wallpaper Engine web wallpaper template**: drop any vehicle model onto an endless grey plane lit by five overhead point lights. The camera is locked to the vehicle and can be orbited freely; after 10 seconds of inactivity it enters a black-fade cinematic orbit loop.

The vehicle name, model file and every tunable parameter are driven by a config file and Wallpaper Engine's property panel — **swapping the model requires no code changes**.

---

## Layout

```
VehicleOrbit/
├─ README.md                      Chinese
├─ README.en.md                   English (this file)
└─ wallpaper/                     ← import THIS folder into Wallpaper Engine
   ├─ index.html                 markup + all styles (font, HUD, slider)
   ├─ project.json               WE project config + user properties
   ├─ config.json                vehicle name / model file
   ├─ js/
   │  ├─ main.js                 scene, lights, camera, cinematic, clock
   │  └─ lib/                    three.js r147 + GLTFLoader (local, offline)
   └─ assets/
      ├─ fonts/                  nameplate font (ChuangKeTieJinGangTi, free for commercial use)
      └─ model.glb               ← your model goes here (empty for now)
```

---

## Quick start

1. Rename your model to `model.glb` and place it in `wallpaper/assets/`
2. Open `wallpaper/config.json` and set `vehicleName` to the text you want to display
3. Open the Wallpaper Engine editor and **drag `wallpaper/index.html` onto the `Create Wallpaper` button**
4. Tweak anything you like in the wallpaper's property panel (see table below)

> You can also keep your own file name — just point `modelFile` in `config.json` at it.

---

## Model requirements

| Item | Requirement |
|---|---|
| Format | **glTF 2.0 Binary (`.glb`)** with textures embedded in a single file |
| Orientation | **+Y up**, front facing **+Z** (see "Model orientation" if different) |
| Units | Metres recommended. Camera, lights and fog auto-adapt to the bounding box, so other scales also work |
| Triangle count | ≤ 150k recommended for an always-on wallpaper; total texture VRAM ≤ 150 MB |
| Materials | Standard glTF PBR (baseColor / normal / occlusion). Custom shaders are not supported |

### Model orientation

The default front direction is `+Z`. If your model differs, edit one line in `js/main.js`:

```js
modelYaw: -0.42,   // radians. +Z = 0; nose +X = -Math.PI/2; nose -Z = Math.PI
```

---

## config.json

```json
{
  "vehicleName": "example",
  "modelFile": "model.glb"
}
```

| Field | Description |
|---|---|
| `vehicleName` | Shown under the clock, top-right. **Leave empty to hide the nameplate** |
| `modelFile` | Model file name. A bare file name is resolved inside `assets/`; a relative path such as `assets/tank.glb` is used as-is |

Read once at startup with `cache: no-cache`, so a refresh picks up changes.

---

## Wallpaper Engine properties

| Property | Type | Default | Purpose |
|---|---|---|---|
| 自动运镜 (Cinematic) | bool | on | Auto cinematic after 10 s idle |
| 显示时钟 (Clock) | bool | on | Top-right clock (time / date / weekday) |
| 显示载具名 (Nameplate) | bool | on | Vehicle name under the clock |
| 载具高度偏移（%） (Height offset) | slider −8..8 | 0 | Lift/sink the model as a percentage of its length — fixes floating or sinking models |
| 整体曝光 (Exposure) | slider 0.55..1.25 | 0.80 | Global brightness |
| 灯光强度 (Light intensity) | slider 0.3..2.5 | 1.00 | Affects only the five overhead lights → contrast |
| 载具亮度 (Model brightness) | slider 0.7..2.0 | 1.38 | Brightens only the model, not floor or background |
| 贴图 UV 映射 (UV mapping) | combo | as exported | Fallback if textures look wrong (mirror V / U / both) |

**Tuning order**: `Exposure` (overall) → `Light intensity` (contrast) → `Model brightness` (model only). They do not interfere.

---

## Controls

- **Left-drag**: orbit around the vehicle (target locked to the model centre, no panning)
- **Right edge slider**: drag vertically to change camera distance (top = closest, bottom = farthest)
- **10 s idle**: cinematic mode (fade to black → close-up shot → constant-height orbit → repeat). Any drag or slider input takes over immediately

The camera has a floor guard: no matter how far you zoom out or how high you lift the vehicle, it never drops below the ground plane. Lifting the vehicle also lets you shoot from lower, more dramatic angles.

---

## FAQ

**Textures misaligned or upside down**
Try the four `UV mapping` options first. If none is right, the model's UVs are broken — re-export from your DCC tool.

**Model floats or sinks into the floor**
Use `Height offset` (±8%). The camera target follows the vehicle, so nothing breaks visually.

**Model too small / too large**
Not a problem — camera distance, light heights, fog density and ground size are all derived from the bounding box.

**Mouse wheel / right-drag does nothing in WE**
Wallpaper Engine's desktop wallpapers do not reliably forward wheel or right-click events. This is a platform limitation — use the right-edge slider.

**Black screen on load**
The model loaded but no file was found. Check that `modelFile` in `config.json` matches the actual file name.

---

## Performance reference (16 m aircraft, 364k triangles, 33 textures)

| Item | Value |
|---|---|
| Texture VRAM | ≈ 108 MB (≈ 145 MB with mipmaps) |
| Draw calls | 204 meshes → 204 draws |
| Resident memory | ≈ 200–300 MB (WE's CEF process) |

For heavier models, decimate geometry and downscale textures to 1024² or less.

---

## Font

`assets/fonts/ChuangKeTieJinGangTi-2.otf` (ChuangKeTie JinGangTi), marked **free for commercial use**. Check the licence if you swap in another font. The font ships a single weight, so bold is synthesised by the browser (`font-weight: 700` + `-webkit-text-stroke`).
