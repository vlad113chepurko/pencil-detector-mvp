(() => {
  const W = 256,
    H = 256;

  const fileInput = document.getElementById("fileInput");
  const imageCanvas = document.getElementById("imageCanvas");
  const maskCanvas = document.getElementById("maskCanvas");
  const resultCanvas = document.getElementById("resultCanvas");
  const brushSizeInput = document.getElementById("brushSize");
  const brushSizeValue = document.getElementById("brushSizeValue");
  const modeSelect = document.getElementById("modeSelect");
  const algoSelect = document.getElementById("algoSelect");
  const clearMaskBtn = document.getElementById("clearMaskBtn");
  const inpaintBtn = document.getElementById("inpaintBtn");
  const downloadBtn = document.getElementById("downloadBtn");

  const imgCtx = imageCanvas.getContext("2d");
  const maskCtx = maskCanvas.getContext("2d");
  const resCtx = resultCanvas.getContext("2d");

  maskCtx.clearRect(0, 0, W, H);

  let isDrawing = false;
  let brushSize = parseInt(brushSizeInput.value, 10);
  brushSizeInput.addEventListener("input", () => {
    brushSize = parseInt(brushSizeInput.value, 10);
    brushSizeValue.textContent = String(brushSize);
  });

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  fileInput.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      imgCtx.clearRect(0, 0, W, H);
      imgCtx.drawImage(img, 0, 0, W, H);
      URL.revokeObjectURL(url);
      maskCtx.clearRect(0, 0, W, H);
      downloadBtn.disabled = true;
      resCtx.clearRect(0, 0, W, H);
    };
    img.src = url;
  });

  function getPos(evt) {
    const rect = maskCanvas.getBoundingClientRect();
    const x = ((evt.clientX - rect.left) / rect.width) * W;
    const y = ((evt.clientY - rect.top) / rect.height) * H;
    return {
      x: clamp(Math.round(x), 0, W - 1),
      y: clamp(Math.round(y), 0, H - 1),
    };
  }

  function paintAt(x, y, erase = false) {
    maskCtx.save();
    maskCtx.globalCompositeOperation = erase
      ? "destination-out"
      : "source-over";
    maskCtx.fillStyle = "rgba(255,0,0,1.0)";
    maskCtx.beginPath();
    maskCtx.arc(x, y, brushSize / 2, 0, Math.PI * 2);
    maskCtx.fill();
    maskCtx.restore();
  }

  maskCanvas.addEventListener("mousedown", (evt) => {
    isDrawing = true;
    const { x, y } = getPos(evt);
    const erase = modeSelect.value === "erase";
    paintAt(x, y, erase);
  });

  maskCanvas.addEventListener("mousemove", (evt) => {
    if (!isDrawing) return;
    const { x, y } = getPos(evt);
    const erase = modeSelect.value === "erase";
    paintAt(x, y, erase);
  });

  ["mouseup", "mouseleave"].forEach((ev) =>
    maskCanvas.addEventListener(ev, () => {
      isDrawing = false;
    })
  );

  clearMaskBtn.addEventListener("click", () => {
    maskCtx.clearRect(0, 0, W, H);
  });

  function collectMask() {
    const maskImg = maskCtx.getImageData(0, 0, W, H);
    const maskArr = new Uint8Array(W * H);
    const d = maskImg.data;
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      maskArr[p] = d[i + 3] > 0 ? 1 : 0;
    }
    return maskArr;
  }

  function laplaceInpaintClient(srcImageData, maskArr, opts = {}) {
    const { maxIters = 1500, tol = 0.8 } = opts;
    const w = srcImageData.width,
      h = srcImageData.height;
    const src = srcImageData.data;
    const res = new Uint8ClampedArray(src);

    for (let iter = 0; iter < maxIters; iter++) {
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

  function toGray(r, g, b) {
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function binaryWhiteFill(srcImageData, maskArr, opts = {}) {
    const {
      whiteThreshold = 200,
      connectivity = 4, 
      maxIters = 1024,
      fillResidual = true,белым
    } = opts;

    const w = srcImageData.width,
      h = srcImageData.height;
    const src = srcImageData.data;
    const res = new Uint8ClampedArray(src);

    const isWhite = new Uint8Array(w * h);
    for (let p = 0, i = 0; p < w * h; p++, i += 4) {
      const gray = toGray(src[i], src[i + 1], src[i + 2]);
      isWhite[p] = gray >= whiteThreshold ? 1 : 0;
    }

    const neighborOffsets =
      connectivity === 8
        ? [-w - 1, -w, -w + 1, -1, +1, +w - 1, +w, +w + 1]
        : [-w, +w, -1, +1];

    for (let iter = 0; iter < maxIters; iter++) {
      let changed = 0;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const p = y * w + x;
          if (maskArr[p] !== 1) continue; 
          if (isWhite[p] === 1) continue;
          let hasWhiteNeighbor = false;
          for (const off of neighborOffsets) {
            const q = p + off;
            if (q >= 0 && q < w * h && isWhite[q] === 1) {
              hasWhiteNeighbor = true;
              break;
            }
          }
          if (hasWhiteNeighbor) {
            isWhite[p] = 1;
            const i = p * 4;
            res[i] = 255;
            res[i + 1] = 255;
            res[i + 2] = 255;
            res[i + 3] = 255;
            changed++;
          }
        }
      }
      if (changed === 0) break; 
    }

    if (fillResidual) {
      for (let p = 0, i = 0; p < w * h; p++, i += 4) {
        if (maskArr[p] === 1 && isWhite[p] === 0) {
          isWhite[p] = 1;
          res[i] = 255;
          res[i + 1] = 255;
          res[i + 2] = 255;
          res[i + 3] = 255;
        }
      }
    }

    return new ImageData(res, w, h);
  }

  async function runInpaint() {
    const srcData = imgCtx.getImageData(0, 0, W, H);
    const maskArr = collectMask();

    let out;
    if (algoSelect.value === "binary") {
      out = binaryWhiteFill(srcData, maskArr, {
        whiteThreshold: 200,
        connectivity: 4,
        maxIters: 1024,
        fillResidual: true,
      });
    } else {
      out = laplaceInpaintClient(srcData, maskArr, {
        maxIters: 1500,
        tol: 0.8,
      });
    }

    resCtx.putImageData(out, 0, 0);
    downloadBtn.disabled = false;
  }

  inpaintBtn.addEventListener("click", runInpaint);

  downloadBtn.addEventListener("click", () => {
    const url = resultCanvas.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = url;
    a.download = "inpainted-256x256.png";
    a.click();
  });
})();
