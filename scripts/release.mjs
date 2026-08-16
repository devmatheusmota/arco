#!/usr/bin/env node
/**
 * Bump de versão + commit + tag + push. NÃO publica instaladores.
 *
 * Mantém em sincronia as 3 (4) fontes da versão:
 *   package.json · src-tauri/tauri.conf.json · src-tauri/Cargo.toml · src-tauri/Cargo.lock (bloco arco)
 *
 * Uso:
 *   npm run release            # patch:  1.2.0 -> 1.2.1  (o "último ponto")
 *   npm run release minor      #         1.2.0 -> 1.3.0
 *   npm run release major      #         1.2.0 -> 2.0.0
 *   npm run release 1.5.0      # versão explícita
 *   npm run release -- --dry-run   # mostra o que faria, sem escrever nem dar push
 *
 * O push da tag NÃO dispara build (o release.yml só roda via workflow_dispatch).
 * Para publicar os instaladores depois: npm run release:publish
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const bumpArg = args.find((a) => !a.startsWith('--')) ?? 'patch'

const PKG = 'package.json'
const TAURI = 'src-tauri/tauri.conf.json'
const CARGO = 'src-tauri/Cargo.toml'
const LOCK = 'src-tauri/Cargo.lock'

function sh(cmd) {
  return execSync(cmd, { stdio: 'pipe', encoding: 'utf8' }).trim()
}
function run(cmd) {
  console.log(`  $ ${cmd}`)
  if (!dryRun) execSync(cmd, { stdio: 'inherit' })
}
function fail(msg) {
  console.error(`\n✗ ${msg}\n`)
  process.exit(1)
}

// 1) Árvore limpa — o commit de release só pode conter o bump.
const dirty = sh('git status --porcelain')
if (dirty) fail(`Working tree sujo. Commite ou descarte antes de releasar:\n${dirty}`)

// 2) Versão atual (fonte: package.json).
const pkgRaw = readFileSync(PKG, 'utf8')
const cur = pkgRaw.match(/"version":\s*"(\d+)\.(\d+)\.(\d+)"/)
if (!cur) fail(`Não achei a versão em ${PKG}`)
const [major, minor, patch] = cur.slice(1).map(Number)
const current = `${major}.${minor}.${patch}`

// 3) Próxima versão.
let next
if (/^\d+\.\d+\.\d+$/.test(bumpArg)) next = bumpArg
else if (bumpArg === 'major') next = `${major + 1}.0.0`
else if (bumpArg === 'minor') next = `${major}.${minor + 1}.0`
else if (bumpArg === 'patch') next = `${major}.${minor}.${patch + 1}`
else fail(`Bump inválido: "${bumpArg}". Use: patch | minor | major | X.Y.Z`)

const tag = `v${next}`
console.log(`\n  ${current}  →  ${next}   (tag ${tag})\n`)

// 4) Reescreve a versão (primeira ocorrência) em cada arquivo.
function bumpFile(path, regex, label = path) {
  const raw = readFileSync(path, 'utf8')
  const m = raw.match(regex)
  if (!m) fail(`Versão não encontrada em ${path}`)
  const updated = raw.replace(regex, (full) => full.replace(m[1], next))
  console.log(`  ~ ${label}  (${m[1]} → ${next})`)
  if (!dryRun) writeFileSync(path, updated)
}
bumpFile(PKG, /"version":\s*"(\d+\.\d+\.\d+)"/)
bumpFile(TAURI, /"version":\s*"(\d+\.\d+\.\d+)"/)
bumpFile(CARGO, /version\s*=\s*"(\d+\.\d+\.\d+)"/)

// Cargo.lock: só o bloco do próprio crate (name = "arco").
const toAdd = [PKG, TAURI, CARGO]
if (existsSync(LOCK)) {
  bumpFile(LOCK, /name = "arco"\r?\nversion = "(\d+\.\d+\.\d+)"/, LOCK)
  toAdd.push(LOCK)
}

// 5) Commit + tag anotada + push (commit e tag), sem disparar release.
const branch = sh('git rev-parse --abbrev-ref HEAD')
run(`git add ${toAdd.join(' ')}`)
run(`git commit -m "chore(release): ${tag}"`)
run(`git tag -a ${tag} -m "${tag}"`)
run(`git push origin ${branch}`)
run(`git push origin ${tag}`)

console.log(`\n✓ ${tag} commitado, tagueado e enviado (branch ${branch}).`)
console.log('  Isso NÃO publicou instaladores — só marcou a versão no git.')
console.log('  Para publicar a release: npm run release:publish')
if (dryRun) console.log('\n(dry-run: nada foi escrito nem enviado)')
console.log('')
