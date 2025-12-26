const express = require("express");
const { createCanvas, loadImage } = require("canvas");

function laplaceInpaintServer(imageData, maskArr, w, h, opts = {}) {
  const { maxIters = 1500, tol = 0.8 } = opts;
  const src = imageData.data;
  const res = new Uint8ClampedArray(src);

  let iter = 0;
  for (; iter < maxIters; iter++) {
    let maxDelta = 0;
    const yStart = iter % 2 === 0 ? 1 : h - 2;
    const yEnd = iter % 2 === 0 ? h - 1 : 0;
    const yStep = iter % 2 === 0 ? 1 : -1;

    for (let y = yStart; y !== yEnd; y += yStep) {
      for (let x = 1; x < w - 1; x++) {
        const p = y * w + x;
        if (maskArr[p] !== 1) continue;
        const i = p * 4;

        const pL = p - 1,
          pR = p + 1,
          pU = p - w,
          pD = p + w;
        const iL = pL * 4,
          iR = pR * 4,
          iU = pU * 4,
          iD = pD * 4;

        for (let c = 0; c < 3; c++) {
          const newVal =
            0.25 * (res[iL + c] + res[iR + c] + res[iU + c] + res[iD + c]);
          const delta = Math.abs(newVal - res[i + c]);
          if (delta > maxDelta) maxDelta = delta;
          res[i + c] = newVal;
        }
        res[i + 3] = 255;
      }
    }
    if (maxDelta < tol) break;
  }

  return new ImageData(res, w, h);
}

function buildRouter() {
  const router = express.Router();

  router.post("/api/inpaint", async (req, res) => {
    try {
      const { image, width = 256, height = 256, mask = [] } = req.body || {};
      if (!image) {
        return res.status(400).json({ error: "Missing image (data URL)" });
      }
      if (!Array.isArray(mask) || mask.length !== width * height) {
        return res
          .status(400)
          .json({ error: "Mask must be an array of length width*height" });
      }

      const img = await loadImage(image);
      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);

      const srcData = ctx.getImageData(0, 0, width, height);
      const maskArr = new Uint8Array(mask);

      const out = laplaceInpaintServer(srcData, maskArr, width, height, {
        maxIters: 1500,
        tol: 0.8,
      });
      ctx.putImageData(out, 0, 0);

      const resultDataUrl = canvas.toDataURL("image/png");

      return res.json({ resultDataUrl });
    } catch (err) {
      console.error("Inpaint error:", err);
      return res
        .status(500)
        .json({ error: "Internal error", details: String(err) });
    }
  });

  return router;
}

module.exports = { buildRouter };
