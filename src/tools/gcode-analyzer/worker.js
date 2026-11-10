import { analyzeGcode } from '../../lib/gcode-info.js';

onmessage = async ({ data: { file } }) => {
  let last = -1;
  try {
    const plates = await analyzeGcode(file, {
      onProgress(fraction) {
        const progress = Math.floor(fraction * 100);
        if (progress !== last) postMessage({ progress: (last = progress) });
      },
    });
    postMessage({ plates });
  } catch (e) {
    postMessage({ error: { code: e.code || (e instanceof RangeError ? 'too_large' : undefined), message: e.message } });
  }
};
