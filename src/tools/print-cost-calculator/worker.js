// Reads either sliced G-code (weight and time as the slicer wrote them) or a 3D model (volume and area).
import { analyzeGcode } from '../../lib/gcode-info.js';
import { parseMesh } from '../../lib/mesh-io.js';
import { analyze } from '../../lib/mesh-analyze.js';

onmessage = async ({ data: { file } }) => {
  let last = -1;
  const onProgress = (fraction) => {
    const progress = Math.floor(fraction * 100);
    if (progress !== last) postMessage({ progress: (last = progress) });
  };
  try {
    let plates = null;
    if (/\.(gcode|gco|g|bgcode)$/i.test(file.name)) plates = await analyzeGcode(file, { onProgress });
    else if (/\.3mf$/i.test(file.name)) {
      // .gcode.3mf or a model .3mf: decided by whether the archive holds a sliced plate
      plates = await analyzeGcode(file, { onProgress }).catch((e) => {
        if (e.code !== 'no_plate') throw e;
        return null;
      });
    }
    if (plates) {
      const sum = { kind: 'gcode', g: 0, cm3: 0, seconds: 0 };
      for (const p of plates) {
        sum.g = sum.g == null || p.total.g == null ? null : sum.g + p.total.g;
        sum.cm3 += p.total.cm3;
        sum.seconds = sum.seconds == null || !p.time ? null : sum.seconds + p.time.seconds;
      }
      return postMessage(sum);
    }
    const mesh = await parseMesh(file, { name: file.name, onProgress });
    const a = analyze(mesh.triangles);
    postMessage({ kind: 'mesh', volumeCm3: a.volume / 1000, areaCm2: a.area / 100, watertight: a.watertight && !a.flipped, bad: mesh.bad });
  } catch (e) {
    postMessage({ error: { code: e.code || (e instanceof RangeError ? 'too_large' : undefined), data: e.data, message: e.message } });
  }
};
