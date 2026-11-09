const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode-terminal/vendor/QRCode');

const targetUrl = 'https://presuvoz.online/demo';
const qr = new QRCode(0, 1); // Level Q error correction
qr.addData(targetUrl);
qr.make();

const count = qr.modules.length;
const size = 1200; // High resolution 1200x1200 for print quality
const margin = 3; // modules of quiet zone
const totalModules = count + margin * 2;
const scale = size / totalModules;

let svgRects = '';
for (let r = 0; r < count; r++) {
  for (let c = 0; c < count; c++) {
    if (qr.isDark(r, c)) {
      const x = (c + margin) * scale;
      const y = (r + margin) * scale;
      svgRects += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${scale.toFixed(2)}" height="${scale.toFixed(2)}" fill="#000000"/>\n`;
    }
  }
}

const svgContent = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
  <rect width="${size}" height="${size}" fill="#ffffff" rx="40"/>
  ${svgRects}
</svg>`;

const outSvgPath = path.resolve('qr_tarjeta_demo.svg');
const outSvgDesktop = 'C:/Users/alber/Desktop/qr_tarjeta_demo.svg';

fs.writeFileSync(outSvgPath, svgContent);
fs.writeFileSync(outSvgDesktop, svgContent);
console.log('✅ QR SVG written to:', outSvgPath, 'and Desktop');

// Also generate PNG using @napi-rs/canvas if available
try {
  const { createCanvas } = require('C:/Users/alber/.gemini/antigravity/brain/19814725-5f2b-441c-961a-31cab0f75ff1/scratch/video_builder/node_modules/@napi-rs/canvas');
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Background white with slight rounded corners
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);

  ctx.fillStyle = '#000000';
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) {
        ctx.fillRect(
          Math.round((c + margin) * scale),
          Math.round((r + margin) * scale),
          Math.ceil(scale),
          Math.ceil(scale)
        );
      }
    }
  }

  const pngBuf = canvas.toBuffer('image/png');
  const outPngPath = path.resolve('qr_tarjeta_demo.png');
  const outPngDesktop = 'C:/Users/alber/Desktop/qr_tarjeta_demo.png';
  fs.writeFileSync(outPngPath, pngBuf);
  fs.writeFileSync(outPngDesktop, pngBuf);
  console.log('✅ High-res QR PNG written to:', outPngPath, 'and Desktop');
} catch (e) {
  console.warn('Canvas not loaded for PNG:', e.message);
}
