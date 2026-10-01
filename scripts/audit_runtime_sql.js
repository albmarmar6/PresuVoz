import fs from 'node:fs';

const filesToInspect = [
  'src/db_service.js',
  'src/fiscal_service.js',
  'src/whatsapp_gateway.js',
  'src/identity_service.js',
  'src/appointment_scheduler.js'
];

console.log('=== AUDITORÍA DETALLADA DE SQL EJECUTABLE EN SERVICIOS DE RUNTIME ===\n');

for (const file of filesToInspect) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  
  const findings = [];
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    if (line.includes('company_phone') || line.includes('business_id')) {
      // Verificar si es parte de una query SQL
      if (line.includes('SELECT') || line.includes('INSERT') || line.includes('UPDATE') || line.includes('DELETE') || line.includes('prepare(') || line.includes('prepare(`')) {
        findings.push({ line: idx + 1, text: trimmed });
      }
    }
  });

  console.log(`Archivo: ${file} (Hallazgos SQL: ${findings.length})`);
  for (const f of findings) {
    console.log(`  Línea ${f.line}: ${f.text}`);
  }
  console.log('');
}
