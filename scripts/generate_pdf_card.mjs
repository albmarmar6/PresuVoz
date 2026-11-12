import PDFDocument from 'pdfkit';
import fs from 'fs';

const wPt = 85 * 2.83465;
const hPt = 55 * 2.83465;

const doc = new PDFDocument({ size: [wPt, hPt], margin: 0 });
const stream = fs.createWriteStream('C:/Users/alber/Desktop/tarjeta_presuvoz_imprenta_85x55mm.pdf');
doc.pipe(stream);

doc.image('C:/Users/alber/Desktop/tarjeta_presuvoz_anverso.png', 0, 0, { width: wPt, height: hPt });
doc.addPage({ size: [wPt, hPt], margin: 0 });
doc.image('C:/Users/alber/Desktop/tarjeta_presuvoz_reverso.png', 0, 0, { width: wPt, height: hPt });

doc.end();
stream.on('finish', () => console.log('✅ Print-ready PDF created at Desktop!'));
