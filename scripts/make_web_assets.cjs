const { createCanvas, loadImage } = require('C:/Users/alber/.gemini/antigravity/brain/19814725-5f2b-441c-961a-31cab0f75ff1/scratch/video_builder/node_modules/@napi-rs/canvas');
const fs = require('fs');

async function makeWebLogos() {
  const img = await loadImage('C:/Users/alber/Desktop/PresuVoz/presuvoz_logo_oficial.jpg');
  
  // 1. Logo Navbar (128x128 rounded with border)
  const navCanvas = createCanvas(128, 128);
  const nctx = navCanvas.getContext('2d');
  nctx.beginPath();
  nctx.arc(64, 64, 60, 0, Math.PI * 2);
  nctx.clip();
  nctx.drawImage(img, 0, 0, 128, 128);
  
  const navBuf = navCanvas.toBuffer('image/png');
  fs.writeFileSync('C:/Users/alber/Desktop/PresuVoz/logo_web_nav.png', navBuf);
  console.log('✅ Created logo_web_nav.png');

  // 2. Favicon (64x64)
  const favCanvas = createCanvas(64, 64);
  const fctx = favCanvas.getContext('2d');
  fctx.beginPath();
  fctx.arc(32, 32, 30, 0, Math.PI * 2);
  fctx.clip();
  fctx.drawImage(img, 0, 0, 64, 64);
  fs.writeFileSync('C:/Users/alber/Desktop/PresuVoz/favicon.png', favCanvas.toBuffer('image/png'));
  console.log('✅ Created favicon.png');

  // 3. OpenGraph Social Share Card Image (1200x630)
  const ogCanvas = createCanvas(1200, 630);
  const ogCtx = ogCanvas.getContext('2d');

  // Dark gradient bg
  const bg = ogCtx.createLinearGradient(0, 0, 1200, 630);
  bg.addColorStop(0, '#0a1224');
  bg.addColorStop(0.5, '#070d1a');
  bg.addColorStop(1, '#040812');
  ogCtx.fillStyle = bg;
  ogCtx.fillRect(0, 0, 1200, 630);

  // Glow
  const glow = ogCtx.createRadialGradient(950, 315, 20, 950, 315, 380);
  glow.addColorStop(0, 'rgba(16, 185, 129, 0.25)');
  glow.addColorStop(1, 'rgba(10, 18, 36, 0)');
  ogCtx.fillStyle = glow;
  ogCtx.beginPath();
  ogCtx.arc(950, 315, 380, 0, Math.PI * 2);
  ogCtx.fill();

  // Draw Logo on the right
  ogCtx.save();
  ogCtx.beginPath();
  ogCtx.arc(950, 315, 180, 0, Math.PI * 2);
  ogCtx.clip();
  ogCtx.drawImage(img, 770, 135, 360, 360);
  ogCtx.restore();

  // Draw Logo border
  ogCtx.beginPath();
  ogCtx.arc(950, 315, 180, 0, Math.PI * 2);
  ogCtx.lineWidth = 4;
  ogCtx.strokeStyle = '#10b981';
  ogCtx.stroke();

  // Left side content
  // Pill badge
  ogCtx.fillStyle = 'rgba(16, 185, 129, 0.12)';
  ogCtx.fillRect(80, 110, 420, 42);
  ogCtx.strokeStyle = 'rgba(16, 185, 129, 0.35)';
  ogCtx.lineWidth = 1.5;
  ogCtx.strokeRect(80, 110, 420, 42);
  ogCtx.fillStyle = '#34d399';
  ogCtx.font = 'bold 15px sans-serif';
  ogCtx.fillText('ASISTENTE DE PRESUPUESTOS POR WHATSAPP', 98, 137);

  // Title
  ogCtx.fillStyle = '#ffffff';
  ogCtx.font = 'bold 54px sans-serif';
  ogCtx.fillText('De nota de voz a', 80, 220);
  ogCtx.fillStyle = '#10b981';
  ogCtx.fillText('presupuesto firmado.', 80, 285);

  // Subtitle
  ogCtx.fillStyle = '#94a3b8';
  ogCtx.font = '500 24px sans-serif';
  ogCtx.fillText('En menos de 20 segundos, directo en WhatsApp.', 80, 350);
  ogCtx.fillText('Presupuestos · Materiales · Firma digital · Facturas', 80, 390);

  // Footer badge
  ogCtx.fillStyle = '#e2e8f0';
  ogCtx.font = 'bold 22px sans-serif';
  ogCtx.fillText('presuvoz.online', 80, 520);
  ogCtx.fillStyle = '#64748b';
  ogCtx.font = '500 18px sans-serif';
  ogCtx.fillText('Para autónomos y empresas de reformas en España', 80, 550);

  fs.writeFileSync('C:/Users/alber/Desktop/PresuVoz/og_image.jpg', ogCanvas.toBuffer('image/jpeg'));
  console.log('✅ Created og_image.jpg for social SEO!');
}

makeWebLogos().catch(console.error);
