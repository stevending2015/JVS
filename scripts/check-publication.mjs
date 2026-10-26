/** Scan tracked files only; never read browser profiles or private exports. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const errors = [];
const privateFile = /(?:^|\/)(?:\.env(?:\..*)?|backups|exports|private|\.verify)(?:\/|$)|\.(?:db(?:-.*)?|sqlite\d?(?:-.*)?|jvsbackup|gedcom?|pem|key|png|jpe?g|webp|pdf|zip)$/i;
const secret = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}|\bAKIA[A-Z0-9]{16}\b/;
for (const file of files) {
  if (privateFile.test(file) && file !== '.env.example') errors.push(`${file}: private artifact`);
  if (/\.(?:mp3|woff2?|ttf|wasm)$/.test(file)) continue;
  const text = readFileSync(file, 'utf8');
  if (secret.test(text)) errors.push(`${file}: possible credential`);
  if (/public\/word-data\/entry-\d+\.json$/.test(file)) {
    const entries = JSON.parse(text);
    if (!Array.isArray(entries) || entries.some((row) => typeof row.w !== 'string' || 'birth_date' in row || 'body_md' in row || 'target_date' in row)) {
      errors.push(`${file}: unexpected public word data`);
    }
  }
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else console.log(`Publication scan passed: ${files.length} tracked files. Manual review still required for personal content.`);
