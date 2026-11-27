# Vendored libraries (site/vendor)

Copied unchanged from the npm registry tarballs on 23 Nov 2026 (UTC) by lane t01. Never load these from a CDN.
Validated in a headless Chromium (software WebGL) prototype: terrain, water plane, draped image, true-scale weir.

| Name | Version | Licence | npm tarball | Files here |
|---|---|---|---|---|
| maplibre-gl | 5.24.1 (last 5.x; 6.x exists, not tested) | BSD-3-Clause (maplibre-gl/LICENSE.txt) | https://registry.npmjs.org/maplibre-gl/-/maplibre-gl-5.24.1.tgz | dist/maplibre-gl.js (UMD, sets window.maplibregl), dist/maplibre-gl.css |
| three | 0.187.0 | MIT (three/LICENSE) | https://registry.npmjs.org/three/-/three-0.187.0.tgz | build/three.module.js + build/three.core.js (ES modules); examples/jsm add-ons: loaders/GLTFLoader.js, loaders/DRACOLoader.js, utils/BufferGeometryUtils.js, utils/SkeletonUtils.js, environments/RoomEnvironment.js |
| draco decoder (shipped inside three) | as in three 0.187.0 | Apache-2.0 (see libs/draco/README.md) | same as three | three/examples/jsm/libs/draco/gltf/ (draco_decoder.js, .wasm, draco_wasm_wrapper.js) |

Tested in the prototype: maplibre-gl.js, maplibre-gl.css, three.module.js, three.core.js. The add-ons are copied
for model loading and are not yet exercised by a test.

Use (page head):

```html
<link rel="stylesheet" href="./vendor/maplibre-gl/maplibre-gl.css">
<script src="./vendor/maplibre-gl/maplibre-gl.js"></script>
<script type="importmap">{ "imports": {
  "three": "./vendor/three/build/three.module.js",
  "three/addons/": "./vendor/three/examples/jsm/" } }</script>
```
DRACOLoader: `new DRACOLoader().setDecoderPath('./vendor/three/examples/jsm/libs/draco/gltf/')`.

## SHA-256 of every file

```
ee5fc05a0677eaf69601d2c7db0d9ecd6cc27c3abc1d0733bc9ed34707cf8ef2  ./maplibre-gl/LICENSE.txt
ab1e70d59ec40465bae7e7030da2f3ccf28133fd502e62bd598eefbadfd7a732  ./maplibre-gl/maplibre-gl.css
a9c9e2aa36d4d5b63b131f27c1272f1a28883eeecc0eddd1e0dbfae4033bc7c9  ./maplibre-gl/maplibre-gl.js
613e370f76638fdef83926642bf256dc9615684922de1ce1f63a8583e5d78578  ./three/build/three.core.js
104f56145899722094556490d787aae0617cc2fc3382f31df02d724ea1aee341  ./three/build/three.module.js
55f466192cc84298755a424c5e040345006b2ee1455589b3b54126c2ea4123f4  ./three/examples/jsm/environments/RoomEnvironment.js
8625489da79a805f4f2a7d511c3e52d8b4085608a9d2a4d5f4f9de5db0aea04f  ./three/examples/jsm/libs/draco/gltf/draco_decoder.js
a680d927bed9cb864ddbd63521868891af2bfbe755092761b4837487618df8ac  ./three/examples/jsm/libs/draco/gltf/draco_decoder.wasm
8bb2952d2ba7d67e1414f8df819410cb0434a666be53f671fff75f68843d76f6  ./three/examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js
839850a67c93f6b26d3cc038a45bd8289e3cfdf15531e69339e8eb1282b4eb76  ./three/examples/jsm/libs/draco/README.md
344684542690b7381d86970bbc428a87c89293730f9e9ec8be592b9e5b3263a9  ./three/examples/jsm/loaders/DRACOLoader.js
532ac726e120039acbcd6cf54328c57acbf7b438176afaa6951257126d11bff1  ./three/examples/jsm/loaders/GLTFLoader.js
7bda2a8ba836b2bcf67cb938d4b9e1bb5d1b1bc616817103ed858c0b58296ce7  ./three/examples/jsm/utils/BufferGeometryUtils.js
b1632a703206c3d830de9fcbe515696770d04b71a15ee6b50afa6d2c3298c86f  ./three/examples/jsm/utils/SkeletonUtils.js
8b378ebe60e2fe500158cb0ac71cb5e8b7d92953c2abcc63a0eb90499653b5bc  ./three/LICENSE
```

Tarball SHA-256: maplibre-gl-5.24.1.tgz b84d7fdf7fba5922fd3fff9a92733936c7a03b99165afc6c84f41c311bdbfa9d, three-0.187.0.tgz ff540832ded0cfe919764d24a3d88f3e2a05f23303f876423e4f893841e90728.
npm integrity: maplibre-gl sha512-HyiYBwtsbk3L1n1EPLJHWqdoyMiF80n7tEYXFZyu2m1TjvaNx6KMLiFeDdmszt1/mq2zvsR1TJuX/NMu5BonXQ==, three sha512-Qiu7R+Cmh8CstZsY1uJOSWnVlfo7ZtNLV7mF8Jltk3LB3AtDu9cRZlcnRKkAk8Y4z6KKw35z7Y7Urd7jWY8etA==.
