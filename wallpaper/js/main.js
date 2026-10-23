'use strict';
/* J-10C on an endless grey plane — orbit-locked camera.
 * three.js r147 (UMD) + GLTFLoader (legacy UMD), no build step.
 */
(function () {

  var CONFIG = {
    url: 'assets/model.glb',      // 被 config.json 的 modelFile 覆盖；这里只是兜底默认值

    // 场景
    bg: 0x14161a,
    // 雾密度按「模型长度」归一：实际 density = fogDensity / 模型最大边长
    fogDensity: 0.13,
    groundColor: 0x2b2e33,
    groundRoughness: 0.88,
    groundMetalness: 0.0,

    // 模型摆位（模型正面朝 +Z，yaw 为负值让正面转向左前方 3/4 视角）
    modelYaw: -0.42,
    modelScale: 1.0,            // GLB 已归一化，最大边 = 1.0
    modelLift: 0.0,

    // 相机（视点锁定在模型中心，只允许环绕）
    // 相机参照灰色机库预设：fov 70、机位低角度、视点在模型上部
    // 我们是定距环绕，所以把 fov 收到 55 换取更安全的环绕半径
    fov: 55,
    radiusFactor: 1.05,         // 距离 = 模型最大边 × 该系数（环绕时不穿模）
    phi: 1.45,                  // 初始俯仰（弧度 / 自 Y 轴起算，≈7° 仰角）
    theta: 0.95,                // 初始方位
    minPhi: 0.42,               // 最高视角
    maxPhi: 1.75,               // 硬上限（100°）；实际下限由 maxPhiLimit() 按半径/焦点动态收
    targetHeight: 0.32,         // 视点高度 = 模型高度 × 该系数（对应机库的 1.77）
    damping: 7.0,               // 阻尼（越大越跟手）

    // 交互
    dragSensitivity: 0.0042,
    zoomStep: 1.12,             // 每格滚轮的缩放比
    minRadiusFactor: 0.62,      // 最近距离（避免穿模，模型半长 = 0.5L）
    maxRadiusFactor: 2.00,      // 最远距离
    minCamHeightFactor: 0.035,  // 相机离地下限 = 该系数 × 模型长度，防止沉到灰面之下
    vehicleOffsetPct: 0,        // 载具高度偏移（模型长度的百分比，正=抬高）

    // 自动运镜（战争雷霆机库风格）
    idleDelay: 10000,           // 无操作多久后开始运镜（ms）
    fadeOut: 0.90,              // 黑屏淡出时长（s）
    fadeIn: 1.10,               // 黑屏淡入时长（s）——淡入时镜头已经在运动
    radiusRange: [0.60, 0.76],  // 运镜机位距离（× 模型长度，比手动默认更近）
    elevRange: [-8, 12],        // 仰角范围（度，负=仰视，0=平视）
    sweepRange: [55, 135],      // 单次水平运镜角度（度）
    sweepSpeed: 4.5,            // 运镜角速度（度/秒，恒定无缓动）

    // 曝光（整体明暗总开关）
    exposure: 0.80,

    // 灯光（只有中间的几个点光源）
    lightIntensity: 1.0,

    // 原生 glTF：不再套用手写 OBJ 转换时的法线/材质修补
    nativeModel: true,

    // 只提亮载具本身（乘算 albedo），不影响地面与背景
    modelBrightness: 1.38,

    // 法线贴图绿通道是否需要翻转（仅 nativeModel=false 时生效）
    normalFlipY: true
  };

  var container = document.getElementById('app');
  var loaderEl = document.getElementById('loader');
  var barEl = document.querySelector('#bar > i');
  var hintEl = document.getElementById('hint');
  var errEl = document.getElementById('err');
  var titleEl = document.getElementById('title');

  // ---------- renderer / scene ----------
  var renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = CONFIG.exposure;
  // 必须开物理光照：否则 PointLight 在 distance=0 时完全不衰减，
  // 而灯光强度是按模型尺寸的平方缩放的，米制模型（16~17 单位）会被直接打成全白
  renderer.physicallyCorrectLights = true;
  container.appendChild(renderer.domElement);

  var scene = new THREE.Scene();
  scene.background = new THREE.Color(CONFIG.bg);
  scene.fog = new THREE.FogExp2(CONFIG.bg, CONFIG.fogDensity);

  var camera = new THREE.PerspectiveCamera(CONFIG.fov, window.innerWidth / window.innerHeight, 0.04, 60);

  // ---------- 程序化环境贴图（IBL）----------
  // 没有环境反射时，PBR 材质只剩点光源的直射高光，所有平面就会呈现同一种
  // "均匀发亮但没有细节"的反射 —— 也就是塑料感。这里用一个渐变天空球
  // + 一块顶部高光灯板，烘成 PMREM 供所有材质使用。
  function buildEnvironment() {
    var envScene = new THREE.Scene();

    var skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: {
        cTop: { value: new THREE.Color(0x9ba2aa) },
        cMid: { value: new THREE.Color(0x484d54) },
        cBot: { value: new THREE.Color(0x121417) }
      },
      vertexShader: [
        'varying vec3 vPos;',
        'void main() { vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }'
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 cTop; uniform vec3 cMid; uniform vec3 cBot;',
        'varying vec3 vPos;',
        'void main() {',
        '  float h = normalize(vPos).y;',
        '  vec3 c = h > 0.0 ? mix(cMid, cTop, pow(h, 0.65)) : mix(cMid, cBot, pow(-h, 0.55));',
        '  gl_FragColor = vec4(c, 1.0);',
        '}'
      ].join('\n')
    });
    envScene.add(new THREE.Mesh(new THREE.SphereGeometry(60, 24, 12), skyMat));

    // 顶部高光灯板：让金属面出现一条明确的反射带，而不是一片死光
    var panelMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3.0, 3.0, 3.1) });
    var panel = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), panelMat);
    panel.position.set(0, 42, 0);
    panel.rotation.x = Math.PI / 2;
    envScene.add(panel);

    var pmrem = new THREE.PMREMGenerator(renderer);
    var rt = pmrem.fromScene(envScene, 0.02);
    pmrem.dispose();
    envScene.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    return rt.texture;
  }
  scene.environment = buildEnvironment();

  // ---------- 一望无际的灰色平面 ----------
  var groundGeo = new THREE.PlaneGeometry(600, 600, 1, 1);
  var groundMat = new THREE.MeshStandardMaterial({
    envMapIntensity: 0.30,     // 地面只吃一点点环境反射，保持哑光无机感
    color: CONFIG.groundColor,
    roughness: CONFIG.groundRoughness,
    metalness: CONFIG.groundMetalness
  });
  var ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  // 灯光组：参照 Grey Hangar 预设（5 盏 light_indoor_football 呈十字排布，高度 40m）
  // 归一化到模型长度 L：横向 ±0.92L，高度 2.44L
  var lightRig = new THREE.Group();
  scene.add(lightRig);

  var HANGAR = { spread: 0.92, height: 2.44, power: 2.30, color: 0xe9f1ff };

  var overLights = [];
  [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (o) {
    var l = new THREE.PointLight(HANGAR.color, HANGAR.power, 0, 2);
    l.position.set(o[0] * HANGAR.spread, HANGAR.height, o[1] * HANGAR.spread);
    lightRig.add(l);
    overLights.push(l);
  });

  // 一盏弱轮廓光，把载具从背景里"剥"出来（机库预设里由灰色背景板提供，这里用灯补偿）
  var rimLight = new THREE.PointLight(0xffffff, 0.60, 0, 2);
  rimLight.position.set(-0.10, 0.70, -1.00);
  lightRig.add(rimLight);

  // 环境补光：机库里的墙面反弹光。没有它，地面只有灯光池，其余部分是死黑
  // 第二参数是"地面反射色"：它决定机腹/机翼下表面能收到多少反弹光
  var hemi = new THREE.HemisphereLight(0x8f9dae, 0x3a3f46, 0.75);
  scene.add(hemi);

  // 极弱环境光，避免背光面完全死黑
  var ambient = new THREE.AmbientLight(0x9fb4d0, 0.14);
  scene.add(ambient);

  // ---------- 假接触阴影（贴地渐变，不代表真实阴影，开销近零） ----------
  function makeShadowTexture() {
    var s = 512;
    var cv = document.createElement('canvas');
    cv.width = cv.height = s;
    var ctx = cv.getContext('2d');
    var g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0.0, 'rgba(0,0,0,0.70)');
    g.addColorStop(0.40, 'rgba(0,0,0,0.30)');
    g.addColorStop(1.0, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    var tex = new THREE.CanvasTexture(cv);
    tex.encoding = THREE.sRGBEncoding;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    return tex;
  }
  var shadowMat = new THREE.MeshBasicMaterial({
    map: makeShadowTexture(),
    transparent: true,
    depthWrite: false,
    opacity: 0.85,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4
  });
  var shadowPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), shadowMat);
  shadowPlane.rotation.x = -Math.PI / 2;
  shadowPlane.position.y = 0.004;
  shadowPlane.renderOrder = 1;
  shadowPlane.visible = !/[?&]noshadow=1/.test(window.location.search);
  scene.add(shadowPlane);

  // ---------- 相机环绕状态 ----------
  var target = new THREE.Vector3(0, 0.2, 0);
  var state = { theta: CONFIG.theta, phi: CONFIG.phi, radius: 2.0 };
  var goal = { theta: CONFIG.theta, phi: CONFIG.phi, radius: 2.0 };

  // 自动运镜状态机：idle → out(淡出) → in(淡入) → orbit(运镜) → out …（用户操作则 resume → idle）
  var CINE = {
    enabled: !/[?&]cine=0/.test(window.location.search),
    phase: 'idle',
    opacity: 0,
    fadeSpeed: 0,          // 当前淡入/淡出速度（1/s）
    angle: 0,              // 当前镜头已转过的角度（rad）
    hasShot: false,
    theta0: 0,
    sweep: 0,
    dir: 1,
    phi: 1.40,
    radius: 15
  };
  var fadeEl = document.getElementById('fade');

  var lastInput = performance.now();
  var dragging = false;
  var lastPointer = { x: 0, y: 0 };

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  // 相机离地下限（跟模型尺度绑定）
  function minCamHeight() {
    return Math.max(0.05, modelDim * CONFIG.minCamHeightFactor);
  }

  // 俯仰下限随「半径 + 焦点高度」动态变化：
  // 半径越大、或载具被压低，允许的最低视角就越往上收，保证相机不会沉到地面之下。
  // 反过来，用户抬高载具时同一角度下相机也会跟着升高，可以放心压低视角仰拍。
  function maxPhiLimit(r) {
    var lim = (minCamHeight() - target.y) / Math.max(r, 0.001);
    lim = Math.max(-0.995, Math.min(0.995, lim));
    return Math.max(CONFIG.minPhi, Math.min(CONFIG.maxPhi, Math.acos(lim)));
  }

  function placeCamera() {
    // 每帧再兜一次底：拉远时如果当前俯角会穿到地面下，就自动抬回来
    var lim = maxPhiLimit(state.radius);
    if (state.phi > lim) { state.phi = lim; goal.phi = Math.min(goal.phi, lim); }

    var sp = Math.sin(state.phi), cp = Math.cos(state.phi);
    camera.position.set(
      target.x + state.radius * sp * Math.sin(state.theta),
      target.y + state.radius * cp,
      target.z + state.radius * sp * Math.cos(state.theta)
    );
    camera.lookAt(target);
  }

  function onDown(e) {
    abortCinematic();
    dragging = true;
    document.body.classList.add('dragging');
    lastPointer.x = e.clientX;
    lastPointer.y = e.clientY;
    lastInput = performance.now();
    if (hintEl) hintEl.classList.add('hide');
  }
  function onMove(e) {
    if (!dragging) return;
    var dx = e.clientX - lastPointer.x;
    var dy = e.clientY - lastPointer.y;
    lastPointer.x = e.clientX;
    lastPointer.y = e.clientY;
    goal.theta -= dx * CONFIG.dragSensitivity;
    goal.phi = clamp(goal.phi - dy * CONFIG.dragSensitivity * 0.85,
                     CONFIG.minPhi, maxPhiLimit(goal.radius));
    lastInput = performance.now();
  }
  function onUp() {
    dragging = false;
    document.body.classList.remove('dragging');
    lastInput = performance.now();
  }

  if (window.PointerEvent) {
    renderer.domElement.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  } else {
    // 老版本 CEF 兜底
    renderer.domElement.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }
  // 滚轮控制镜头距离（视点仍然锁定在模型中心）
  var modelDim = 1;

  function onWheel(e) {
    e.preventDefault();
    abortCinematic();
    var step = e.deltaY > 0 ? CONFIG.zoomStep : 1 / CONFIG.zoomStep;
    goal.radius = clamp(
      goal.radius * step,
      modelDim * CONFIG.minRadiusFactor,
      modelDim * CONFIG.maxRadiusFactor
    );
    // 拉远后允许的最低视角会变高，这里同步收一下当前俯角
    goal.phi = Math.min(goal.phi, maxPhiLimit(goal.radius));
    lastInput = performance.now();
    if (hintEl) hintEl.classList.add('hide');
  }
  // 挂在 window 上：WE 里事件目标可能是 body 或 canvas，冒泡都能收到
  window.addEventListener('wheel', onWheel, { passive: false });

  // ---------- 右侧贴边垂直滑条：镜头距离 ----------
  // WE 桌面壁纸对滚轮 / 右键的支持不可靠，这里给一个纯左键拖拽的滑条，
  // 和环绕用同一套事件通道，必定可用。
  var zoomTrack = document.getElementById('zoomtrack');
  var zoomThumb = document.getElementById('zoomthumb');
  var zoomDragging = false;
  var zoomShownT = -1;

  function radiusRange() {
    return [modelDim * CONFIG.minRadiusFactor, modelDim * CONFIG.maxRadiusFactor];
  }

  function syncZoomThumb() {
    if (!zoomThumb) return;
    var rr = radiusRange();
    var t = clamp((goal.radius - rr[0]) / Math.max(rr[1] - rr[0], 1e-6), 0, 1);
    if (Math.abs(t - zoomShownT) < 0.002) return;
    zoomShownT = t;
    zoomThumb.style.top = (t * 100).toFixed(2) + '%';
  }

  function setRadiusFromPointer(clientY) {
    if (!zoomTrack) return;
    var rect = zoomTrack.getBoundingClientRect();
    var rr = radiusRange();
    var t = clamp((clientY - rect.top) / Math.max(rect.height, 1), 0, 1);
    goal.radius = rr[0] + t * (rr[1] - rr[0]);
    goal.phi = Math.min(goal.phi, maxPhiLimit(goal.radius));
    syncZoomThumb();
  }

  function zoomStart(e) {
    e.preventDefault();
    e.stopPropagation();
    abortCinematic();
    zoomDragging = true;
    zoomTrack.classList.add('active');
    if (e.pointerId !== undefined && zoomTrack.setPointerCapture) {
      try { zoomTrack.setPointerCapture(e.pointerId); } catch (err) { }
    }
    setRadiusFromPointer(e.clientY);
    if (hintEl) hintEl.classList.add('hide');
  }

  function zoomMove(e) {
    if (!zoomDragging) return;
    setRadiusFromPointer(e.clientY);
    lastInput = performance.now();
  }

  function zoomEnd() {
    if (!zoomDragging) return;
    zoomDragging = false;
    if (zoomTrack) zoomTrack.classList.remove('active');
    lastInput = performance.now();
  }

  if (zoomTrack) {
    if (window.PointerEvent) {
      zoomTrack.addEventListener('pointerdown', zoomStart);
      window.addEventListener('pointermove', zoomMove);
      window.addEventListener('pointerup', zoomEnd);
      window.addEventListener('pointercancel', zoomEnd);
    } else {
      zoomTrack.addEventListener('mousedown', zoomStart);
      window.addEventListener('mousemove', zoomMove);
      window.addEventListener('mouseup', zoomEnd);
    }
  }

  // 右键用于变焦，必须屏蔽浏览器/CEF 的右键菜单（挂在 document 上兜底）
  document.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  window.addEventListener('resize', function () {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ---------- 加载模型 ----------
  var model = null;

  // 可运行时调整的"仅模型"亮度（WE 用户属性 / ?mb= 参数都会走这里）
  var brightMats = [];
  function applyModelBrightness(f) {
    CONFIG.modelBrightness = f;
    for (var i = 0; i < brightMats.length; i++) {
      brightMats[i].color.copy(brightMats[i].userData.baseColor).multiplyScalar(f);
    }
  }
  window.setModelBrightness = applyModelBrightness;

  // 调试参数：?nm=0 关闭法线贴图 / ?ao=0 关闭 AO / ?rough=1 全粗糙 / ?r=1.2 相机距离系数
  var qs = window.location.search;
  var DBG = {
    noNormal: /[?&]nm=0/.test(qs),
    noAO: /[?&]ao=0/.test(qs),
    flat: /[?&]flat=1/.test(qs),      // 无光照纯 albedo，用于检查贴图是否对位
    still: /[?&]still=1/.test(qs),    // 只渲染一帧，截图用
    rough: (function () { var m = /[?&]rough=([\d.]+)/.exec(qs); return m ? parseFloat(m[1]) : null; })(),
    radius: (function () { var m = /[?&]r=([\d.]+)/.exec(qs); return m ? parseFloat(m[1]) : null; })(),
    phi: (function () { var m = /[?&]phi=([\d.]+)/.exec(qs); return m ? parseFloat(m[1]) : null; })(),
    theta: (function () { var m = /[?&]theta=(-?[\d.]+)/.exec(qs); return m ? parseFloat(m[1]) : null; })()
  };
  if (DBG.radius) CONFIG.radiusFactor = DBG.radius;
  (function () {
    var m = /[?&]mb=([\d.]+)/.exec(qs);
    if (m) CONFIG.modelBrightness = parseFloat(m[1]);
  })();
  if (DBG.phi !== null) CONFIG.phi = DBG.phi;
  if (DBG.theta !== null) CONFIG.theta = DBG.theta;

  // UV 约定可在运行时切换（URL: ?uv=mirrorV，或 WE 用户属性），便于锁定正确映射
  var uvMode = 'none';
  var mUv = /[?&]uv=(none|mirrorV|mirrorU|mirrorUV)/i.exec(qs);
  if (mUv) uvMode = mUv[1];

  function applyUvMode(mode) {
    uvMode = mode || 'none';
    if (!model) return;
    model.traverse(function (o) {
      if (!o.isMesh) return;
      var g = o.geometry;
      var base = g.userData.uvBase;
      var attr = g.attributes.uv;
      if (!base || !base.length || !attr) return;
      // 交错缓冲（InterleavedBufferAttribute）无法按元素直接改写，跳过
      if (attr.isInterleavedBufferAttribute) return;
      var flipU = (mode === 'mirrorU' || mode === 'mirrorUV');
      var flipV = (mode === 'mirrorV' || mode === 'mirrorUV');
      var arr = attr.array;
      for (var i = 0; i < base.length; i += 2) {
        arr[i] = flipU ? 1 - base[i] : base[i];
        arr[i + 1] = flipV ? 1 - base[i + 1] : base[i + 1];
      }
      attr.needsUpdate = true;
    });
  }
  window.setUvMode = applyUvMode;

  function frameModel(root) {
    root.rotation.y = CONFIG.modelYaw;
    root.scale.setScalar(CONFIG.modelScale);
    root.position.set(0, 0, 0);          // 每次都从零开始算，保证可反复调用（幂等）
    root.updateMatrixWorld(true);

    var box = new THREE.Box3().setFromObject(root);
    var size = box.getSize(new THREE.Vector3());
    var center = box.getCenter(new THREE.Vector3());
    var dim = Math.max(size.x, size.y, size.z);

    // 水平居中 + 底面落到 y = 0，再叠加用户配置的高度偏移（按模型长度百分比）
    root.position.set(-center.x, -box.min.y + CONFIG.modelLift, -center.z);
    root.position.y += (CONFIG.vehicleOffsetPct / 100) * dim;
    root.updateMatrixWorld(true);

    // 偏移后重新取包围盒：相机焦点要跟着载具走，而不是固定在原地面
    box = new THREE.Box3().setFromObject(root);
    size = box.getSize(new THREE.Vector3());
    var bottom = box.min.y;

    modelDim = dim;
    state.radius = goal.radius = dim * CONFIG.radiusFactor;
    // 焦点 = 载具底面 + 自身高度的一部分，载具抬高/下沉时焦点一起移动
    target.set(0, bottom + size.y * CONFIG.targetHeight, 0);

    // 关键：雾、地面尺寸、相机远近平面都必须跟着模型尺度走。
    // 原生 GLB 以米为单位（本模型 16.4 单位），若沿用 1 单位归一化时的雾密度，
    // 模型会被雾吃掉 95%，看起来就是「一个灰模没有贴图」
    scene.fog.density = CONFIG.fogDensity / dim;
    ground.scale.setScalar(dim);
    camera.near = Math.max(0.02, dim * 0.005);
    camera.far = dim * 40;
    camera.updateProjectionMatrix();

    // 贴地假阴影：载具被抬高时阴影变大变淡，避免"悬浮却没影子"的错觉
    var lift = Math.max(0, bottom);
    var liftRatio = lift / dim;
    shadowPlane.scale.set(
      size.x * (1.35 + liftRatio * 1.2),
      size.z * (1.15 + liftRatio * 1.2),
      1
    );
    shadowPlane.position.y = dim * 0.004;
    shadowPlane.position.x = 0;
    shadowPlane.position.z = 0;
    shadowMat.opacity = Math.max(0.25, 0.85 - liftRatio * 2.2);

    // 光源跟着模型尺度走
    var s = dim;
    var offs = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
    for (var li = 0; li < overLights.length; li++) {
      overLights[li].position.set(
        offs[li][0] * HANGAR.spread * s,
        HANGAR.height * s,
        offs[li][1] * HANGAR.spread * s
      );
      overLights[li].intensity = HANGAR.power * CONFIG.lightIntensity * s * s;
    }
    rimLight.position.set(-0.10 * s, 0.70 * s, -1.00 * s);
    rimLight.intensity = 0.60 * CONFIG.lightIntensity * s * s;

    placeCamera();
  }

  // ---------- 载入进度 ----------
  // 不能只依赖 evt.total：WE / 某些 http 服务不给 Content-Length 时它恒为 0，
  // 进度条会一直是 0% —— 看起来就像"载入动画丢了"。这里让进度条自己跑渐近曲线，
  // 真实进度只用来往里"插值"，并且强制最短显示 0.9s，避免一闪而过。
  var loadStart = performance.now();
  var loadP = 0;
  var loadFinished = false;

  function setBar(p) {
    loadP = Math.max(loadP, Math.min(1, p));
    if (barEl) barEl.style.width = (loadP * 100).toFixed(1) + '%';
  }

  (function loadTick() {
    if (loadFinished) return;
    var el = (performance.now() - loadStart) / 1000;
    setBar(Math.min(0.9, 1 - Math.exp(-el / 1.6)));   // 渐近到 90%，等加载完成再补满
    requestAnimationFrame(loadTick);
  })();

  function finishLoading() {
    loadFinished = true;
    setBar(1);
    var wait = Math.max(0, 900 - (performance.now() - loadStart));
    window.setTimeout(function () {
      loaderEl.classList.add('done');
      window.setTimeout(function () { loaderEl.style.display = 'none'; }, 800);
    }, wait);
  }

  var gltfLoader = new THREE.GLTFLoader();

  function loadModel() {
    gltfLoader.load(
    CONFIG.url,
    function (gltf) {
      model = gltf.scene;

      var maxAniso = renderer.capabilities.getMaxAnisotropy();
      model.traverse(function (o) {
        if (!o.isMesh) return;
        o.frustumCulled = true;

        // 保留原始 UV，供运行时切换 UV 约定
        var uvAttr = o.geometry.attributes.uv;
        var uvArr = uvAttr
          ? (uvAttr.isInterleavedBufferAttribute ? uvAttr.data.array : uvAttr.array)
          : null;
        if (uvArr && !o.geometry.userData.uvBase) {
          o.geometry.userData.uvBase = new Float32Array(uvArr);
        }

        var mats = Array.isArray(o.material) ? o.material : [o.material];

        if (DBG.flat) {   // 纯 albedo 模式：检查贴图是否对位
          var src = mats[0];
          o.material = new THREE.MeshBasicMaterial({
            map: src && src.map ? src.map : null,
            color: src && !src.map ? (src.color || 0xffffff) : 0xffffff
          });
          return;
        }

        mats.forEach(function (m) {
          if (!m) return;
          if (DBG.noNormal) m.normalMap = null;
          if (DBG.noAO) m.aoMap = null;

          if (m.map) {
            m.map.anisotropy = maxAniso;
            m.map.needsUpdate = true;
          }
          if (m.normalMap) {
            if (!CONFIG.nativeModel) {
              // 手写转换的 OBJ 路线才需要翻绿通道；原生 glTF 已按规范导出
              m.normalScale.set(CONFIG.normalFlipY ? 1 : -1, CONFIG.normalFlipY ? -1 : 1);
            }
            m.normalMap.anisotropy = maxAniso;
            m.normalMap.generateMipmaps = true;
            m.normalMap.minFilter = THREE.LinearMipmapLinearFilter;
            m.normalMap.needsUpdate = true;
          }
          if (m.aoMap) {
            m.aoMap.anisotropy = maxAniso;
            m.aoMap.needsUpdate = true;
          }

          if (!CONFIG.nativeModel) {
            m.metalness = 0.0;
            m.roughness = DBG.rough !== null ? DBG.rough : Math.max(m.roughness, 0.72);
          }
          if (DBG.rough !== null) m.roughness = DBG.rough;

          // 环境反射（消除塑料感的关键）
          m.envMapIntensity = 0.90;
          // 这份 glTF 没带粗糙度贴图，全部写成 1.0（完全漫反射）→ 表面发闷发假；
          // 给漆面一个合理的轻微光泽
          if (m.roughness !== undefined && m.roughness >= 0.95) m.roughness = 0.58;
          if (m.metalness !== undefined && m.metalness < 0.02) m.metalness = 0.06;

          // 玻璃：源文件里是「纯黑 + alpha 0.1」，在暗座舱前必然显示为纯黑，
          // 这里替换成淡蓝灰半透明，才是玻璃该有的样子
          var isGlass = m.transparent && m.opacity < 0.45 &&
                        m.color && m.color.r + m.color.g + m.color.b < 0.35;

          if (isGlass) {
            m.color.setRGB(0.56, 0.65, 0.74);
            m.opacity = 0.32;
            m.roughness = 0.12;
            m.metalness = 0.0;
            m.depthWrite = false;
            m.side = THREE.DoubleSide;
          } else if (m.color && !m.userData.baseColor) {
            // 提亮载具本体：WT 的 albedo 本身偏暗，而地面/背景已经够亮，
            // 乘算 material.color 是唯一只影响模型、不影响环境的做法。
            // 注意：材质在多个 mesh 间共享，必须以 baseColor 作哨兵，只处理一次，
            // 否则 1.5 会被乘 N 次（1.5^12 ≈ 130），模型直接变全白
            m.userData.baseColor = m.color.clone();
            m.color.multiplyScalar(CONFIG.modelBrightness);
            brightMats.push(m);
          }
          m.aoMapIntensity = 0.65;   // AO 压得太重会让蒙皮发闷

          if (m.transparent && !CONFIG.nativeModel) {
            m.depthWrite = false;
            m.side = THREE.FrontSide;
            m.alphaTest = 0.02;
          }
          m.needsUpdate = true;
        });

        if (o.material && o.material.transparent) o.renderOrder = 2;
      });

      scene.add(model);
      frameModel(model);
      applyUvMode(uvMode);

      // 10 秒空闲计时从"壁纸真正显示出来"开始算，而不是从页面加载开始
      lastInput = performance.now();

      finishLoading();
    },
    function (evt) {
      // 有真实总量就与自跑曲线取较大值，避免进度条回退
      if (evt && evt.total) setBar((evt.loaded / evt.total) * 0.98);
    },
      function (err) {
        loadFinished = true;
        loaderEl.style.display = 'none';
        errEl.style.display = 'flex';
        errEl.textContent = '模型加载失败：' + (err && err.message ? err.message : err) +
          '\n请确认 config.json 里的 modelFile 指向的文件存在，并通过 http(s) 打开页面（file:// 会被 CORS 拦截）。';
      }
    );
  }

  // ---------- Wallpaper Engine 用户属性 ----------
  window.wallpaperPropertyListener = {
    applyUserProperties: function (props) {
      if (props.cinematic) {
        CINE.enabled = !!props.cinematic.value;
      }
      if (props.vehicleheight) {
        // 高度偏移（%），用于修正模型不贴地 / 悬浮过高；相机会同步跟着重算焦点
        CONFIG.vehicleOffsetPct = parseFloat(props.vehicleheight.value) || 0;
        if (model) frameModel(model);
      }
      if (props.showclock) {
        if (clockEl) clockEl.classList.toggle('off', !props.showclock.value);
      }
      if (props.showname) {
        if (titleEl) titleEl.classList.toggle('off', !props.showname.value);
      }
      if (props.exposure) {
        CONFIG.exposure = parseFloat(props.exposure.value) || 0.8;
        renderer.toneMappingExposure = CONFIG.exposure;
      }
      if (props.lightintensity) {
        CONFIG.lightIntensity = parseFloat(props.lightintensity.value) || 1.0;
        if (model) frameModel(model);
      }
      if (props.modelbrightness) {
        applyModelBrightness(parseFloat(props.modelbrightness.value) || 1.35);
      }
      if (props.uvmode) {
        applyUvMode(props.uvmode.value);
      }
      if (props.rotate) {
        goal.theta += parseFloat(props.rotate.value) || 0;
      }
    }
  };

  // ---------- 左上角时钟 ----------
  var clockEl = document.getElementById('clock');
  var WEEK_EN = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function renderClock() {
    if (!clockEl) return;
    var d = new Date();
    var time = pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    var date = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
               ' ' + WEEK_EN[d.getDay()];
    var ts = clockEl.querySelectorAll('.time');
    var ds = clockEl.querySelectorAll('.date');
    for (var i = 0; i < ts.length; i++) ts[i].textContent = time;
    for (var j = 0; j < ds.length; j++) ds[j].textContent = date;
  }

  function startClock() {
    renderClock();
    if (clockEl) clockEl.classList.add('show');
    // 对齐到整秒再起 interval，避免刷新时刻逐秒漂移
    window.setTimeout(function () {
      renderClock();
      window.setInterval(renderClock, 1000);
    }, 1000 - (Date.now() % 1000));
  }

  startClock();

  // ---------- 启动：读取 config.json ----------
  function setVehicleName(name) {
    if (!titleEl) return;
    var front = titleEl.querySelector('.front');
    var back = titleEl.querySelector('.back');
    if (!name) { titleEl.classList.remove('show'); return; }
    if (front) front.textContent = name;
    if (back) back.textContent = name;      // 后层完全相同的文字，错位后作为阴影
    titleEl.classList.add('show');
  }

  (function boot() {
    fetch('config.json', { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .catch(function () { return {}; })
      .then(function (cfg) {
        cfg = cfg || {};
        var file = cfg.modelFile || 'j10c.glb';
        // 只写文件名时默认去 assets/ 找
        if (file.indexOf('/') === -1 && file.indexOf('\\') === -1) file = 'assets/' + file;
        CONFIG.url = file;
        setVehicleName(cfg.vehicleName || '');
        loadModel();
      });
  })();

  // ---------- 自动运镜 ----------
  function setFade(a) {
    CINE.opacity = Math.max(0, Math.min(1, a));
    if (fadeEl) fadeEl.style.opacity = CINE.opacity.toFixed(3);
  }

  function pickShot() {
    // 近机位（比手动默认 1.05L 更近）、随机仰角、随机起始方位、随机顺时针/逆时针
    var rr = CONFIG.radiusRange;
    CINE.radius = modelDim * (rr[0] + Math.random() * (rr[1] - rr[0]));

    var el = CONFIG.elevRange;
    // 三角分布：把采样拉向区间中段，让"平视"机位出现得多一些，极端俯仰少一些
    var te = (Math.random() + Math.random()) * 0.5;
    var elev = (el[0] + te * (el[1] - el[0])) * Math.PI / 180;
    CINE.phi = Math.PI / 2 - elev;

    CINE.theta0 = Math.random() * Math.PI * 2;
    CINE.dir = Math.random() < 0.5 ? -1 : 1;

    var sw = CONFIG.sweepRange;
    var sweepDeg = sw[0] + Math.random() * (sw[1] - sw[0]);
    CINE.sweep = sweepDeg * Math.PI / 180;

    // 预跑 0.25s：黑屏还没散开时镜头已经在动了，散开瞬间看不到"静止→启动"
    CINE.angle = (CONFIG.sweepSpeed * Math.PI / 180) * 0.25;
    CINE.hasShot = true;

    // 全黑时直接落位，用户看不到跳变
    state.theta = goal.theta = CINE.theta0 + CINE.dir * CINE.angle;
    state.phi = goal.phi = CINE.phi;
    state.radius = goal.radius = CINE.radius;
  }

  function abortCinematic() {
    lastInput = performance.now();
    if (CINE.phase === 'idle') return;
    CINE.phase = 'resume';
    CINE.fadeSpeed = 1 / 0.35;
    goal.theta = state.theta;
    goal.phi = state.phi;
    goal.radius = state.radius;
  }

  function updateCinematic(dt, now) {
    if (!CINE.enabled) {
      if (CINE.phase !== 'idle') { CINE.phase = 'idle'; setFade(0); }
      return;
    }
    var w = (CONFIG.sweepSpeed * Math.PI / 180) * dt;   // 本帧转过的角度

    if (CINE.phase === 'idle') {
      if (model && !dragging && now - lastInput > CONFIG.idleDelay) {
        CINE.phase = 'out';
        CINE.fadeSpeed = 1 / CONFIG.fadeOut;
      }
      return;
    }

    if (CINE.phase === 'orbit' || CINE.phase === 'out') {
      if (CINE.hasShot) {                     // 全程匀速，不缓动、不停顿
        CINE.angle += w;
        state.theta = goal.theta = CINE.theta0 + CINE.dir * CINE.angle;
        state.phi = goal.phi = CINE.phi;
        state.radius = goal.radius = CINE.radius;
      }
      if (CINE.phase === 'orbit') {
        if (CINE.opacity > 0) setFade(CINE.opacity - (1 / CONFIG.fadeIn) * dt);  // 淡入与运镜同时进行
        if (CINE.angle >= CINE.sweep) {
          CINE.phase = 'out';
          CINE.fadeSpeed = 1 / CONFIG.fadeOut;
        }
      } else {
        setFade(CINE.opacity + CINE.fadeSpeed * dt);
        if (CINE.opacity >= 1) {              // 全黑时换机位并立刻继续运动
          pickShot();
          CINE.phase = 'orbit';
        }
      }
      return;
    }

    if (CINE.phase === 'resume') {            // 用户接管后的快速淡入
      setFade(CINE.opacity - CINE.fadeSpeed * dt);
      if (CINE.opacity <= 0) CINE.phase = 'idle';
    }
  }

  // ---------- 主循环 ----------
  var clock = new THREE.Clock();
  placeCamera();

  function tick() {
    var dt = Math.min(clock.getDelta(), 0.05);
    var now = performance.now();

    updateCinematic(dt, now);
    syncZoomThumb();

    var k = 1 - Math.exp(-CONFIG.damping * dt);
    state.theta += (goal.theta - state.theta) * k;
    state.phi += (goal.phi - state.phi) * k;
    state.radius += (goal.radius - state.radius) * k;

    placeCamera();
    renderer.render(scene, camera);

    if (DBG.still && model) return;   // 截图模式：模型就绪后只渲染一帧
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

})();
