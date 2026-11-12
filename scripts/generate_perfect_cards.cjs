const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('C:/Users/alber/.gemini/antigravity/brain/19814725-5f2b-441c-961a-31cab0f75ff1/scratch/video_builder/node_modules/@napi-rs/canvas');
const QRCode = require('qrcode-terminal/vendor/QRCode');

const W = 1050; // Standard 85mm at ~315 DPI
const H = 600;  // Standard 55mm at ~315 DPI

const LOGO_PATH = 'C:/Users/alber/Desktop/PresuVoz/presuvoz_logo_oficial.jpg';

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function safeWrite(filePath, buffer) {
  try {
    fs.writeFileSync(filePath, buffer);
    console.log('Saved:', filePath);
  } catch (err) {
    if (err.code === 'UNKNOWN' || err.code === 'EBUSY' || err.code === 'EPERM') {
      const ext = path.extname(filePath);
      const base = path.basename(filePath, ext);
      const dir = path.dirname(filePath);
      const altPath = path.join(dir, `${base}_v2${ext}`);
      try {
        fs.writeFileSync(altPath, buffer);
        console.log('Saved to fallback (locked):', altPath);
      } catch (e) {
        console.warn('Could not save to alt path:', e.message);
      }
    } else {
      throw err;
    }
  }
}

async function renderFront(logoImg) {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Background dark gradient
  const bgGrad = ctx.createLinearGradient(0, 0, W, H);
  bgGrad.addColorStop(0, '#0a1224');
  bgGrad.addColorStop(0.5, '#070d1a');
  bgGrad.addColorStop(1, '#040812');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, W, H);

  // Subtle decorative sphere on the right (matching prototype)
  ctx.save();
  const sphereGrad = ctx.createRadialGradient(820, 260, 40, 820, 260, 420);
  sphereGrad.addColorStop(0, 'rgba(26, 49, 88, 0.55)');
  sphereGrad.addColorStop(0.5, 'rgba(16, 32, 62, 0.35)');
  sphereGrad.addColorStop(1, 'rgba(10, 18, 36, 0)');
  ctx.fillStyle = sphereGrad;
  ctx.beginPath();
  ctx.arc(820, 260, 420, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Subtle top-left glow for the logo
  ctx.save();
  const logoGlow = ctx.createRadialGradient(110, 95, 10, 110, 95, 140);
  logoGlow.addColorStop(0, 'rgba(16, 185, 129, 0.15)');
  logoGlow.addColorStop(1, 'rgba(16, 185, 129, 0)');
  ctx.fillStyle = logoGlow;
  ctx.beginPath();
  ctx.arc(110, 95, 140, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // DRAW THE OFFICIAL LOGO (High Resolution from presuvoz_logo_oficial.jpg)
  const lx = 65, ly = 55, lw = 84, lh = 84, lr = 20;
  ctx.save();
  ctx.shadowColor = 'rgba(16, 185, 129, 0.4)';
  ctx.shadowBlur = 22;
  ctx.shadowOffsetY = 2;
  roundRect(ctx, lx, ly, lw, lh, lr);
  ctx.fillStyle = '#08101e';
  ctx.fill();
  ctx.restore();

  // Clip image into rounded rectangle
  ctx.save();
  roundRect(ctx, lx, ly, lw, lh, lr);
  ctx.clip();
  ctx.drawImage(logoImg, lx, ly, lw, lh);
  ctx.restore();

  // Border outline for logo
  ctx.save();
  roundRect(ctx, lx, ly, lw, lh, lr);
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#10b981';
  ctx.stroke();
  ctx.restore();

  // Brand Name
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 38px "Segoe UI", Arial, sans-serif';
  ctx.fillText('PresuVoz', 170, 96);

  // Brand Slogan
  ctx.fillStyle = '#2dd4bf';
  ctx.font = 'bold 12px "Segoe UI", Arial, sans-serif';
  ctx.letterSpacing = '1.8px';
  ctx.fillText('TU NEGOCIO, MÁS FÁCIL DESDE WHATSAPP', 171, 124);

  // Main Value Proposition (Headline)
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 36px "Segoe UI", Arial, sans-serif';
  ctx.fillText('Menos papeleo.', 65, 230);
  ctx.fillText('Más tiempo para ti.', 65, 276);

  // Services / Features line (Positioned cleanly ABOVE the button, NO overlap!)
  const fx = 65, fy = 340;
  ctx.font = '600 16px "Segoe UI", Arial, sans-serif';
  
  const items = ['Presupuestos', 'Facturas', 'Visitas', 'Pagos'];
  let curX = fx;
  items.forEach((item, idx) => {
    ctx.fillStyle = '#cbd5e1';
    ctx.fillText(item, curX, fy);
    curX += ctx.measureText(item).width;
    if (idx < items.length - 1) {
      ctx.fillStyle = '#10b981';
      ctx.fillText('   ·   ', curX, fy);
      curX += ctx.measureText('   ·   ').width;
    }
  });

  // Action Button: "PRUÉBALO GRATIS"
  const bx = 65, by = 430, bw = 240, bh = 58, br = 29;
  ctx.save();
  ctx.shadowColor = 'rgba(16, 185, 129, 0.4)';
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 6;
  const btnGrad = ctx.createLinearGradient(bx, by, bx + bw, by + bh);
  btnGrad.addColorStop(0, '#10b981');
  btnGrad.addColorStop(1, '#059669');
  roundRect(ctx, bx, by, bw, bh, br);
  ctx.fillStyle = btnGrad;
  ctx.fill();
  ctx.restore();

  // Button Text
  ctx.fillStyle = '#022c22';
  ctx.font = '900 16px "Segoe UI", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('PRUÉBALO GRATIS', bx + bw / 2, by + 35);
  ctx.textAlign = 'left';

  // Subtext next to button
  ctx.fillStyle = '#94a3b8';
  ctx.font = '500 15px "Segoe UI", Arial, sans-serif';
  ctx.fillText('Escanea y descubre cómo funciona', bx + bw + 30, by + 35);

  return canvas;
}

function renderBack() {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Clean Light Executive Background
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, W, H);

  // Subtle border
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#e2e8f0';
  ctx.strokeRect(0, 0, W, H);

  // Top Section: Title & Subtitle
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 36px "Segoe UI", Arial, sans-serif';
  ctx.fillText('Hablemos de tu negocio', 65, 85);

  ctx.fillStyle = '#64748b';
  ctx.font = '500 16px "Segoe UI", Arial, sans-serif';
  ctx.fillText('Descubre cómo ahorrar tiempo en la gestión diaria.', 65, 120);

  // Divider line
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(65, 145);
  ctx.lineTo(W - 65, 145);
  ctx.stroke();

  // LEFT COLUMN: Alberto's Contact Details (ZERO EMOJIS, ZERO BOX GLYPHS)
  const lx = 65;
  
  // Name
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 24px "Segoe UI", Arial, sans-serif';
  ctx.fillText('Alberto Martín', lx, 195);

  // Phone (Clean number, NO emoji)
  ctx.fillStyle = '#334155';
  ctx.font = '600 17px "Segoe UI", Arial, sans-serif';
  ctx.fillText('601 022 367', lx, 238);

  // Email (Clean address, NO emoji)
  ctx.fillStyle = '#334155';
  ctx.font = '500 16px "Segoe UI", Arial, sans-serif';
  ctx.fillText('albertomartinmartin201@gmail.com', lx, 276);

  // Web (Clean domain, NO emoji)
  ctx.fillStyle = '#059669';
  ctx.font = 'bold 18px "Segoe UI", Arial, sans-serif';
  ctx.fillText('presuvoz.online', lx, 318);

  // Subtle sub-divider
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(lx, 350);
  ctx.lineTo(560, 350);
  ctx.stroke();

  // CORRECTED WHATSAPP LINE (No email in WhatsApp, NO emoji)
  ctx.fillStyle = '#0f172a';
  ctx.font = '600 14px "Segoe UI", Arial, sans-serif';
  ctx.fillText('PresuVoz · WhatsApp: 601 02 23 67', lx, 385);

  // Subtitle role
  ctx.fillStyle = '#64748b';
  ctx.font = '500 13px "Segoe UI", Arial, sans-serif';
  ctx.fillText('PresuVoz · Asistente para profesionales y autónomos', lx, 415);

  // Bottom value badge (clean text, NO emoji / NO lightning box)
  ctx.save();
  roundRect(ctx, lx, 460, 480, 46, 12);
  ctx.fillStyle = 'rgba(16, 185, 129, 0.08)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(16, 185, 129, 0.3)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = '#047857';
  ctx.font = 'bold 13px "Segoe UI", Arial, sans-serif';
  ctx.fillText('Presupuestos, mermas y firmas sin tocar un ordenador', lx + 20, 488);
  ctx.restore();

  // RIGHT COLUMN: High-Res Real Scannable QR Code
  const qrx = 640;
  const qry = 175;
  const qrw = 340;
  const qrh = 370;

  // QR Container Card with subtle shadow
  ctx.save();
  ctx.shadowColor = 'rgba(15, 23, 42, 0.08)';
  ctx.shadowBlur = 20;
  ctx.shadowOffsetY = 6;
  roundRect(ctx, qrx, qry, qrw, qrh, 20);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#e2e8f0';
  ctx.stroke();
  ctx.restore();

  // Render QR Code inside
  const qr = new QRCode(0, 1);
  qr.addData('https://presuvoz.online/demo');
  qr.make();
  const qCount = qr.modules.length;
  const qrInnerSize = 250;
  const qrMargin = 2;
  const totalMod = qCount + qrMargin * 2;
  const modScale = qrInnerSize / totalMod;
  const qrStartX = qrx + (qrw - qrInnerSize) / 2;
  const qrStartY = qry + 20;

  ctx.fillStyle = '#0f172a';
  for (let r = 0; r < qCount; r++) {
    for (let c = 0; c < qCount; c++) {
      if (qr.isDark(r, c)) {
        ctx.fillRect(
          Math.round(qrStartX + (c + qrMargin) * modScale),
          Math.round(qrStartY + (r + qrMargin) * modScale),
          Math.ceil(modScale),
          Math.ceil(modScale)
        );
      }
    }
  }

  // QR CTA (ZERO EMOJIS, ZERO BOX GLYPHS - CLEAN BOLD TEXT)
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 14px "Segoe UI", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('ESCANEA Y MIRA LA DEMO (1 MIN)', qrx + qrw / 2, qry + 300);

  ctx.fillStyle = '#059669';
  ctx.font = 'bold 12px "Segoe UI", Arial, sans-serif';
  ctx.fillText('Vídeo real de 60s en móvil', qrx + qrw / 2, qry + 325);
  ctx.textAlign = 'left';

  return canvas;
}

function renderMockup(frontCanvas, backCanvas) {
  const MW = 1200;
  const MH = 1450;
  const mCanvas = createCanvas(MW, MH);
  const mCtx = mCanvas.getContext('2d');

  // Studio dark background
  const bg = mCtx.createLinearGradient(0, 0, MW, MH);
  bg.addColorStop(0, '#0b0f19');
  bg.addColorStop(1, '#020617');
  mCtx.fillStyle = bg;
  mCtx.fillRect(0, 0, MW, MH);

  // Header Title
  mCtx.fillStyle = '#ffffff';
  mCtx.font = 'bold 36px "Segoe UI", Arial, sans-serif';
  mCtx.textAlign = 'center';
  mCtx.fillText('Tarjeta de Contacto Oficial — PresuVoz', MW / 2, 60);

  mCtx.fillStyle = '#34d399';
  mCtx.font = '600 16px "Segoe UI", Arial, sans-serif';
  mCtx.fillText('Prototipo Perfeccionado para Impresión (85 × 55 mm)', MW / 2, 95);
  mCtx.textAlign = 'left';

  // Front card label
  mCtx.fillStyle = '#94a3b8';
  mCtx.font = 'bold 14px "Segoe UI", Arial, sans-serif';
  mCtx.fillText('CARA DELANTERA (ANVERSO) • Con logotipo oficial', 75, 140);

  // Draw Front Card with shadow
  mCtx.save();
  mCtx.shadowColor = 'rgba(0, 0, 0, 0.6)';
  mCtx.shadowBlur = 35;
  mCtx.shadowOffsetY = 15;
  mCtx.drawImage(frontCanvas, 75, 160);
  mCtx.restore();

  // Back card label
  mCtx.fillStyle = '#94a3b8';
  mCtx.font = 'bold 14px "Segoe UI", Arial, sans-serif';
  mCtx.fillText('CARA TRASERA (REVERSO) • Sin emojis / Cuadros corregidos / QR activo', 75, 800);

  // Draw Back Card with shadow
  mCtx.save();
  mCtx.shadowColor = 'rgba(0, 0, 0, 0.6)';
  mCtx.shadowBlur = 35;
  mCtx.shadowOffsetY = 15;
  mCtx.drawImage(backCanvas, 75, 820);
  mCtx.restore();

  return mCanvas;
}

async function run() {
  console.log('Loading official logo from:', LOGO_PATH);
  const logoImg = await loadImage(LOGO_PATH);

  console.log('Rendering front card...');
  const front = await renderFront(logoImg);
  const frontBuf = front.toBuffer('image/png');
  safeWrite('C:/Users/alber/Desktop/tarjeta_presuvoz_anverso.png', frontBuf);
  safeWrite(path.resolve('tarjeta_presuvoz_anverso.png'), frontBuf);

  console.log('Rendering back card...');
  const back = renderBack();
  const backBuf = back.toBuffer('image/png');
  safeWrite('C:/Users/alber/Desktop/tarjeta_presuvoz_reverso.png', backBuf);
  safeWrite(path.resolve('tarjeta_presuvoz_reverso.png'), backBuf);

  console.log('Rendering combined mockup preview...');
  const mockup = renderMockup(front, back);
  const mockupBuf = mockup.toBuffer('image/png');
  safeWrite('C:/Users/alber/Desktop/tarjeta_presuvoz_maqueta_completa.png', mockupBuf);
  safeWrite(path.resolve('tarjeta_presuvoz_maqueta_completa.png'), mockupBuf);

  // Also copy to artifact directory
  const artDir = 'C:/Users/alber/.gemini/antigravity/brain/19814725-5f2b-441c-961a-31cab0f75ff1';
  try {
    fs.writeFileSync(path.join(artDir, 'tarjeta_presuvoz_anverso.png'), frontBuf);
    fs.writeFileSync(path.join(artDir, 'tarjeta_presuvoz_reverso.png'), backBuf);
    fs.writeFileSync(path.join(artDir, 'tarjeta_presuvoz_maqueta_completa.png'), mockupBuf);
  } catch (e) {
    console.warn('Artifact dir copy note:', e.message);
  }

  console.log('✅ ALL CARDS SUCCESSFULLY UPDATED AND SAVED!');
}

run().catch(err => {
  console.error('Error generating cards:', err);
  process.exit(1);
});
