#!/usr/bin/env node
/**
 * Audits logger.* and console.* message strings for:
 * - colon (:) anywhere in the message
 * - missing terminal sentence punctuation (. ! ?)
 *
 * Usage: node scripts/audit-log-messages.js
 * Exit code 1 if any violations remain.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['commands', 'events', 'utils'];
const SCAN_FILES = [
  'index.js',
  'bot.js',
  'deploy-commands.js',
  'config.js',
  'logger.js'
];

const CALL_RE = /(?:logger\.(?:info|warn|error|debug)|console\.(?:log|error|warn|info))\(\s*/g;

function walkJsFiles() {
  const files = [];
  for (const rel of SCAN_FILES) {
    const p = path.join(ROOT, rel);
    if (fs.existsSync(p)) files.push(p);
  }
  for (const dir of SCAN_DIRS) {
    const base = path.join(ROOT, dir);
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.js')) {
        files.push(path.join(base, entry.name));
      }
    }
  }
  return files;
}

function extractStringLiteral(source, startIndex) {
  const quote = source[startIndex];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;

  let i = startIndex + 1;
  let value = '';
  let hasExpression = false;

  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      if (quote === '`' && source[i + 1] === '$' && source[i + 2] === '{') {
        hasExpression = true;
        i += 3;
        let depth = 1;
        while (i < source.length && depth > 0) {
          if (source[i] === '{') depth++;
          else if (source[i] === '}') depth--;
          i++;
        }
        value += '${…}';
        continue;
      }
      value += source[i + 1] || '';
      i += 2;
      continue;
    }
    if (ch === quote) {
      return { value, end: i + 1, hasExpression, quote };
    }
    value += ch;
    i++;
  }
  return null;
}

function findFirstArgString(content, callStart) {
  let i = callStart;
  while (i < content.length && content[i] !== '(') i++;
  i++;
  while (i < content.length && /\s/.test(content[i])) i++;
  if (content[i] === "'" || content[i] === '"' || content[i] === '`') {
    return extractStringLiteral(content, i);
  }
  return null;
}

function isHelpContext(relPath, msg, raw) {
  const trimmed = msg.trim();
  const line = raw || '';
  if (!trimmed || trimmed === 'n') return true;
  if (/^Usage:|^Key format:|^Examples:|^namespace:|^section:|^\s*-\s/.test(trimmed)) return true;
  if (/^Error: Key cannot|^Error: Value cannot/.test(trimmed)) return true;
  if (/^  \d\.|^     (gosu|chmod|node )/.test(line)) return true;
  if (/^   (Namespace|Section|Key|Full Key|Value|Type|Searched|Expected|Owner|Current|Pretty-printed|sqlite3|File|Previous|Running as)/.test(line)) return true;
  if (/^If running in a container|^Database file information/.test(trimmed)) return true;
  if (/^Solutions:|^Recommendation:|^The keys exist|^Other tables|^This could mean|^To verify|^To perform the deletion|^Unnecessary \/ obsolete|^  \[DELETE\]|^=== |^Database Path:|^Mode:|^Analysis Results:|^Keys to (KEEP|DELETE)|^Analyzing |^No unnecessary|^Database size optimized|^Successfully |^Value for |^Found \d|^Key "|^Database file does not|^Current process uid|^Sample keys|^Pretty-printed/.test(trimmed)) return true;
  if (/^Found \d+ value|^Namespace:|^ \$\{label\}:|^Reading a single key/.test(trimmed)) return true;
  if (relPath === 'config.js' && /^Set the following/.test(trimmed)) return true;
  return false;
}

function auditFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const rel = path.relative(ROOT, filePath).replace(/\\/g, '/');
  const lines = content.split('\n');
  const violations = [];

  let match;
  CALL_RE.lastIndex = 0;
  while ((match = CALL_RE.exec(content)) !== null) {
    const parenIndex = match[0].indexOf('(');
    const callStart = match.index + (parenIndex >= 0 ? parenIndex : match[0].length - 1);
    const extracted = findFirstArgString(content, callStart);
    if (!extracted || extracted.hasExpression) {
      if (extracted?.hasExpression) {
        const line = content.slice(0, match.index).split('\n').length;
        const raw = lines[line - 1]?.trim() || '';
        if (raw.includes(':')) {
          violations.push({
            file: rel,
            line,
            msg: extracted.value,
            issues: ['colon', 'template'],
            raw,
            skipHelp: isHelpContext(rel, extracted.value, raw)
          });
        } else if (!/[.!?]$/.test(extracted.value.trim())) {
          violations.push({
            file: rel,
            line,
            msg: extracted.value,
            issues: ['no-punct', 'template'],
            raw,
            skipHelp: isHelpContext(rel, extracted.value, raw)
          });
        }
      }
      continue;
    }

    const msg = extracted.value;
    const line = content.slice(0, match.index).split('\n').length;
    const raw = lines[line - 1]?.trim() || '';
    const issues = [];
    if (msg.includes(':')) issues.push('colon');
    if (!/[.!?]$/.test(msg.trim())) issues.push('no-punct');
    if (issues.length === 0) continue;

    violations.push({
      file: rel,
      line,
      msg,
      issues,
      raw: lines[line - 1]?.trim() || '',
      skipHelp: isHelpContext(rel, msg, raw)
    });
  }

  return violations;
}

function main() {
  const files = walkJsFiles();
  const all = [];
  for (const f of files) {
    all.push(...auditFile(f));
  }

  const operational = all.filter((v) => !v.skipHelp);
  const helpOnly = all.filter((v) => v.skipHelp);

  console.log(`Scanned ${files.length} files`);
  console.log(`Operational violations: ${operational.length}`);
  console.log(`Help/structural (ignored): ${helpOnly.length}\n`);

  const byFile = {};
  for (const v of operational) {
    if (!byFile[v.file]) byFile[v.file] = [];
    byFile[v.file].push(v);
  }

  for (const [file, items] of Object.entries(byFile).sort()) {
    console.log(`${file}:`);
    for (const v of items) {
      console.log(`  L${v.line} [${v.issues.join(', ')}] ${JSON.stringify(v.msg)}`);
    }
  }

  if (operational.length > 0) {
    process.exit(1);
  }
  console.log('\nAll operational log messages pass audit.');
}

main();
