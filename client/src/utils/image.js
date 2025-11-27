// client/src/utils/image.js
// In-browser image compression using Canvas 2D.
// - No cloud, no accounts, runs on the user's device (grandma-friendly).
// - Tries WebP; falls back to JPEG automatically.
// - Limits the longest side (default 1600px) and quality (default ~0.82).
// - Low CPU: at most 1–2 encode passes per image.

export async function compressImageFile(file, {
  maxSide = 1600,
  mimeType = 'image/webp',
  quality = 0.82,
  targetBytes = 600 * 1024 // ~600KB target (base64 overhead ~33–37%)
} = {}) {
  const createImage = (blobUrl) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = blobUrl;
  });

  const blobUrl = URL.createObjectURL(file);
  try {
    // Optional fast decode path (createImageBitmap) when available:
    // we still use <img> for compatibility if this fails.
    let imgEl;
    try {
      if ('createImageBitmap' in window) {
        const bmp = await createImageBitmap(file);
        // draw bitmap directly for speed
        const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
        const outW = Math.max(1, Math.round(bmp.width * scale));
        const outH = Math.max(1, Math.round(bmp.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = outW;
        canvas.height = outH;
        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bmp, 0, 0, outW, outH);
        let q = quality;
        let dataUrl = canvas.toDataURL(mimeType, q);
        if (dataUrl.length > targetBytes * 1.37) {
          q = Math.max(0.6, quality - 0.12);
          dataUrl = canvas.toDataURL(mimeType, q);
        }
        if (!dataUrl || dataUrl.length === 0) {
          dataUrl = canvas.toDataURL('image/jpeg', 0.82);
        }
        try { bmp.close?.(); } catch {}
        return dataUrl;
      }
    } catch {
      // fallthrough to <img> path
    }

    imgEl = await createImage(blobUrl);
    const { width, height } = imgEl;
    const scale = Math.min(1, maxSide / Math.max(width, height));
    const outW = Math.max(1, Math.round(width * scale));
    const outH = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(imgEl, 0, 0, outW, outH);

    let q = quality;
    let dataUrl = canvas.toDataURL(mimeType, q);
    if (dataUrl.length > targetBytes * 1.37) {
      q = Math.max(0.6, quality - 0.12);
      dataUrl = canvas.toDataURL(mimeType, q);
    }
    if (!dataUrl || dataUrl.length === 0) {
      dataUrl = canvas.toDataURL('image/jpeg', 0.82);
    }
    return dataUrl;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

export async function compressFiles(fileList, limit = 5, options) {
  const files = Array.from(fileList).slice(0, limit);
  const out = [];
  for (const f of files) {
    try {
      // Skip tiny images - they’re already small enough
      if (f.size <= 150 * 1024) {
        out.push(await fileToDataUrl(f));
      } else {
        out.push(await compressImageFile(f, options));
      }
    } catch {
      // Fallback: raw data URL if compression fails for this file
      out.push(await fileToDataUrl(f));
    }
    // Yield to keep UI responsive on low-end devices
    await new Promise(requestAnimationFrame);
  }
  return out;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
