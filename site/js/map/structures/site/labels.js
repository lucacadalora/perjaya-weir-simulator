// Weir surroundings (lane b09): name labels with leader lines for the weir's parts. Drawn inside the three.js scene
// (so stills and films carry them): a thin leader from the part up to a point above it, and a label that keeps its
// size in screen pixels and always faces the viewer. Text comes from the caller (ctx.t) through setTexts().
//
// item: { id, x, y, z (anchor on the part, site frame), lift (m above the anchor where the label sits) }

const VERT = `
uniform vec2 uSize;      // label size in CSS pixels
uniform vec2 uViewport;  // drawing buffer size in device pixels
uniform float uRatio;    // device pixels per CSS pixel
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 c = projectionMatrix * modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  if (c.w <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 px = vec2((position.x - 0.5) * uSize.x, position.y * uSize.y + 3.0) * uRatio;
  c.xy += px * 2.0 / uViewport * c.w;
  gl_Position = c;
}`;
const FRAG = `
uniform sampler2D uMap;
varying vec2 vUv;
void main() { vec4 t = texture2D(uMap, vUv); if (t.a < 0.02) discard; gl_FragColor = t; }`;

function drawText(text) {
  const scale = 2, padX = 7, h = 22;
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  const font = `500 ${11 * scale}px "IBM Plex Mono", ui-monospace, monospace`;
  g.font = font;
  const w = Math.ceil(g.measureText(text).width / scale) + padX * 2;
  c.width = w * scale;
  c.height = h * scale;
  g.font = font;
  g.fillStyle = 'rgba(255,255,255,0.94)';
  g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = '#27313b';
  g.lineWidth = scale;
  g.strokeRect(scale / 2, scale / 2, c.width - scale, c.height - scale);
  g.fillStyle = '#1d2430';
  g.textBaseline = 'middle';
  g.fillText(text, padX * scale, (h * scale) / 2 + scale);
  return { canvas: c, w, h };
}

export function buildLabels(THREE, items) {
  const group = new THREE.Group();
  group.name = 'b09-labels';
  const quad = new THREE.BufferGeometry();
  quad.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0], 3));
  quad.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], 2));
  const lineMat = new THREE.LineBasicMaterial({ color: 0x27313b, transparent: true, opacity: 0.85, depthTest: false });
  const shared = { uViewport: { value: new THREE.Vector2(1, 1) }, uRatio: { value: 1 } };
  const labels = [];
  const hasDom = typeof document !== 'undefined';
  for (const it of items) {
    const top = [it.x, it.y + it.lift, it.z];
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute([it.x, it.y, it.z, ...top], 3));
    const line = new THREE.Line(lg, lineMat);
    line.renderOrder = 998;
    line.frustumCulled = false;
    group.add(line);
    if (!hasDom) { labels.push({ id: it.id, line, minZoom: it.minZoom || 0 }); continue; }
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthTest: false, depthWrite: false,
      uniforms: { uMap: { value: null }, uSize: { value: new THREE.Vector2(10, 10) }, ...shared },
    });
    const mesh = new THREE.Mesh(quad, mat);
    mesh.position.set(...top);
    mesh.renderOrder = 999;
    mesh.frustumCulled = false;
    mesh.onBeforeRender = (renderer) => {
      const gl = renderer.getContext();
      shared.uViewport.value.set(gl.drawingBufferWidth, gl.drawingBufferHeight);
      const cw = gl.canvas && gl.canvas.clientWidth;
      shared.uRatio.value = cw ? gl.drawingBufferWidth / cw : 1;
    };
    group.add(mesh);
    labels.push({ id: it.id, mesh, mat, line, minZoom: it.minZoom || 0 });
  }
  function setTexts(texts) {
    if (!hasDom) return;
    for (const L of labels) {
      if (!L.mat) continue;
      const text = String(texts[L.id] ?? L.id).toUpperCase();
      const d = drawText(text);
      const tex = new THREE.CanvasTexture(d.canvas);
      tex.minFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      if (L.mat.uniforms.uMap.value) L.mat.uniforms.uMap.value.dispose();
      L.mat.uniforms.uMap.value = tex;
      L.mat.uniforms.uSize.value.set(d.w, d.h);
    }
  }
  // show each label only from its own zoom up, so the far view is not crowded
  function setZoom(z) {
    for (const L of labels) {
      const on = !Number.isFinite(z) || z >= L.minZoom;
      L.line.visible = on;
      if (L.mesh) L.mesh.visible = on;
    }
  }
  return { group, setTexts, setZoom, triangles: labels.length * 2 };
}
