// 3D view: one mesh, one highlight overlay, an optional build-volume outline. three.js is loaded only
// when a model is first shown. Renders on demand (no animation loop). Z is up, as on a printer.
const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.182.0/+esm'; // same URL as the splitter: one cached copy for both tools

export async function create(canvas) {
  const THREE = await import(THREE_URL);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x232532);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1000);
  camera.up.set(0, 0, 1);
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(1, 1, 2);
  camera.add(sun);
  scene.add(camera, new THREE.HemisphereLight(0xffffff, 0x3f424d, 1.5));
  const material = new THREE.MeshStandardMaterial({ color: 0x9397ab, roughness: 0.75, metalness: 0, flatShading: true, side: THREE.DoubleSide });

  let mesh = null, overlay = null, bed = null, frame = 0;
  let home = { c: new THREE.Vector3(), r: 1 };
  const o = { c: new THREE.Vector3(), r: 1, theta: -Math.PI / 4, phi: Math.PI / 3 }; // orbit state

  const draw = () => {
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      const s = Math.sin(o.phi);
      camera.position.set(o.c.x + o.r * s * Math.cos(o.theta), o.c.y + o.r * s * Math.sin(o.theta), o.c.z + o.r * Math.cos(o.phi));
      camera.near = o.r / 100;
      camera.far = o.r * 100;
      camera.lookAt(o.c);
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
    });
  };
  const frameOn = ({ c, r }) => {
    o.c.copy(c);
    o.r = (r / Math.sin((camera.fov * Math.PI) / 360)) * 1.15;
    draw();
  };
  const drop = (obj) => {
    if (!obj) return;
    scene.remove(obj);
    obj.geometry.dispose();
    if (obj.material !== material) obj.material.dispose();
  };
  const geometry = (positions) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.computeBoundingSphere();
    return g;
  };

  new ResizeObserver(() => {
    const w = canvas.parentElement.clientWidth, h = canvas.parentElement.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    draw();
  }).observe(canvas.parentElement);

  // Orbit: drag = rotate, shift/right drag = pan, wheel or pinch = zoom, arrow keys / + - / 0 on the keyboard.
  const zoom = (f) => {
    o.r = Math.min(Math.max(o.r * f, home.r * 0.01), home.r * 50);
    draw();
  };
  const rotate = (dx, dy) => {
    o.theta -= dx;
    o.phi = Math.min(Math.max(o.phi - dy, 0.01), Math.PI - 0.01);
    draw();
  };
  const pointers = new Map();
  let pinch = 0;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, e);
    pinch = 0;
  });
  canvas.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    pointers.set(e.pointerId, e);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (pinch) zoom(pinch / d);
      pinch = d;
    } else if (e.shiftKey || e.buttons & 2) {
      const k = (o.r * 0.0015 * 600) / canvas.clientHeight;
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
      o.c.addScaledVector(right, -(e.clientX - prev.clientX) * k).addScaledVector(up, (e.clientY - prev.clientY) * k);
      draw();
    } else {
      rotate((e.clientX - prev.clientX) * 0.008, (e.clientY - prev.clientY) * 0.008);
    }
  });
  for (const type of ['pointerup', 'pointercancel']) {
    canvas.addEventListener(type, (e) => {
      pointers.delete(e.pointerId);
      pinch = 0;
    });
  }
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoom(Math.exp(e.deltaY * 0.001));
  }, { passive: false });
  canvas.addEventListener('keydown', (e) => {
    const act = {
      ArrowLeft: () => rotate(0.15, 0), ArrowRight: () => rotate(-0.15, 0), ArrowUp: () => rotate(0, 0.15), ArrowDown: () => rotate(0, -0.15),
      '+': () => zoom(0.8), '=': () => zoom(0.8), '-': () => zoom(1.25), 0: () => api.reset(),
    }[e.key];
    if (!act) return;
    e.preventDefault();
    act();
  });

  const api = {
    /** positions: Float32Array (9 per triangle) or null to clear. */
    setMesh(positions) {
      drop(mesh);
      api.highlight(null);
      mesh = null;
      if (positions) {
        mesh = new THREE.Mesh(geometry(positions), material);
        scene.add(mesh);
        const s = mesh.geometry.boundingSphere;
        home = { c: s.center.clone(), r: s.radius || 1 };
        frameOn(home);
      }
      draw();
    },
    /** kind: 'lines' (segment pairs), 'strip' (one polyline) or 'tris'. Zooms to what is highlighted. */
    highlight(positions, kind) {
      drop(overlay);
      overlay = null;
      if (positions?.length) {
        const g = geometry(positions);
        overlay =
          kind === 'tris'
            ? new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xecc66b, side: THREE.DoubleSide, depthTest: false, transparent: true, opacity: 0.8 }))
            : new (kind === 'strip' ? THREE.Line : THREE.LineSegments)(g, new THREE.LineBasicMaterial({ color: 0xff9c9c, depthTest: false }));
        overlay.renderOrder = 1;
        scene.add(overlay);
        frameOn({ c: g.boundingSphere.center, r: Math.max(g.boundingSphere.radius, home.r * 0.03) });
      }
      draw();
    },
    /** Outline of a build volume [x, y, z] under the model, or null to remove it. */
    setBed(size) {
      drop(bed);
      bed = null;
      if (size && mesh) {
        const box = new THREE.Box3().setFromBufferAttribute(mesh.geometry.getAttribute('position'));
        bed = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(...size)), new THREE.LineBasicMaterial({ color: 0x75798c }));
        bed.position.set((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, box.min.z + size[2] / 2);
        scene.add(bed);
      }
      draw();
    },
    reset() {
      o.theta = -Math.PI / 4;
      o.phi = Math.PI / 3;
      frameOn(home);
    },
  };
  return api;
}
