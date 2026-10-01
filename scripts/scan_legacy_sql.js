import fs from 'node:fs';
import path from 'node:path';

const searchTerms = [
  'company_phone',
  'business_id',
  'cleanPhone',
  'businessId',
  'getCompany',
  'getCompanyById',
  'resolveLegacyBusinessId',
  'resolveCompanyTenant',
  'ensureCompanyTenant',
  'resolveCanonicalFiscalTenant'
];

const dirsToSearch = ['src', 'scripts'];
const results = [];

function searchDir(dir) {
  const files = fs.readdirSync(dir);
  for (const f of files) {
    const fullPath = path.join(dir, f);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      if (f !== 'node_modules' && f !== '.git') {
        searchDir(fullPath);
      }
    } else if (f.endsWith('.js') || f.endsWith('.mjs') || f.endsWith('.json')) {
      const content = fs.readFileSync(fullPath, 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        for (const term of searchTerms) {
          if (line.includes(term)) {
            results.push({
              file: fullPath.replace(/\\/g, '/'),
              line: idx + 1,
              term,
              text: line.trim()
            });
          }
        }
      });
    }
  }
}

for (const d of dirsToSearch) {
  if (fs.existsSync(d)) searchDir(d);
}

// Analizar y buscar patrones críticos de SQL ejecutable
const criticalSqlPatterns = [
  /WHERE\s+.*company_phone/i,
  /WHERE\s+.*business_id/i,
  /SET\s+.*company_phone/i,
  /SET\s+.*business_id/i,
  /INSERT\s+INTO\s+.*\bcompany_phone\b/i,
  /INSERT\s+INTO\s+.*\bbusiness_id\b/i
];

const criticalFindings = [];

for (const r of results) {
  // Excluir migraciones 001 a 014 (donde legítimamente se creaban o alteraban esas columnas)
  if (r.file.includes('src/migrations/0') && !r.file.includes('015')) {
    continue;
  }
  // Comprobar patrones SQL
  for (const pattern of criticalSqlPatterns) {
    if (pattern.test(r.text)) {
      criticalFindings.push({
        ...r,
        pattern: pattern.toString()
      });
    }
  }
}

console.log('======================================================================');
console.log('RESULTADOS DE BÚSQUEDA GLOBAL DE TÉRMINOS LEGACY');
console.log('======================================================================');
console.log(`Total de ocurrencias encontradas: ${results.length}`);
console.log(`Ocurrencias críticas en SQL de runtime: ${criticalFindings.length}`);

if (criticalFindings.length > 0) {
  console.log('\n🛑 HALLAZGOS CRÍTICOS ENCONTRADOS:');
  for (const c of criticalFindings) {
    console.log(`  - [${c.file}:${c.line}] (${c.term}): ${c.text}`);
  }
} else {
  console.log('\n✨ Cero consultas SQL de runtime detectadas con columnas legacy en WHERE/SET/INSERT (fuera de migraciones históricas).');
}

// Resumen por término y por fichero
const byFile = {};
for (const r of results) {
  byFile[r.file] = (byFile[r.file] || 0) + 1;
}

console.log('\nDesglose de menciones por fichero:');
for (const [f, count] of Object.entries(byFile).sort((a,b) => b[1] - a[1])) {
  console.log(`  - ${f}: ${count}`);
}
