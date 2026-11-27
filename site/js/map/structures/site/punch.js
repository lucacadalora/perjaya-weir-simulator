// Weir surroundings (lane b09): a "hole" in the terrain's depth for works that lie below the ground surface.
//
// Why: MapLibre draws the terrain into the depth buffer before our custom layer (CONTRACT A3), and the terrain is
// a 30 m surface model whose surface over a canal or a settling basin sits at the bank top. A channel whose water is
// 3 to 6 m below that surface would be hidden. So each sunk work gets a LID: a flat surface at the top of its walls.
//   pass 1 (renderOrder -100): draw the lid with the normal depth test, no colour, no depth; the stencil becomes 1
//          where the lid is in front of the terrain and 0 where it is behind;
//   pass 2 (renderOrder -99): draw the lid again where the stencil is 1, writing the far depth (gl_FragDepth = 1)
//          and resetting the stencil to 0;
//   then the walls, floors and water of the work draw normally (renderOrder -50) and fill the hole they enclose.
// Everything drawn later (the weir, trees, other lanes' water) still depth-tests against our walls and water.

export function punchMeshes(THREE, geometry) {
  const mark = new THREE.MeshBasicMaterial({
    colorWrite: false, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
    stencilWrite: true, stencilRef: 1, stencilFunc: THREE.AlwaysStencilFunc,
    stencilZPass: THREE.ReplaceStencilOp, stencilZFail: THREE.ZeroStencilOp, stencilFail: THREE.ZeroStencilOp,
  });
  const clear = new THREE.ShaderMaterial({
    vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'void main() { gl_FragDepth = 1.0; gl_FragColor = vec4(0.0); }',
    colorWrite: false, depthWrite: true, depthTest: true, depthFunc: THREE.AlwaysDepth, side: THREE.DoubleSide,
    stencilWrite: true, stencilRef: 1, stencilFunc: THREE.EqualStencilFunc,
    stencilZPass: THREE.ZeroStencilOp, stencilZFail: THREE.ZeroStencilOp, stencilFail: THREE.KeepStencilOp,
  });
  const a = new THREE.Mesh(geometry, mark);
  const b = new THREE.Mesh(geometry, clear);
  a.renderOrder = -100;
  b.renderOrder = -99;
  a.frustumCulled = b.frustumCulled = false;
  a.name = 'b09-punch-mark';
  b.name = 'b09-punch-clear';
  return [a, b];
}

// Lid triangles collected as plain positions (no colour).
export class LidBuilder {
  constructor() { this.p = []; }
  tri(a, b, c) { this.p.push(...a, ...b, ...c); }
  quad(a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); }
  geometry(THREE) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    return g;
  }
  get triangles() { return this.p.length / 9; }
}
